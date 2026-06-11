"""ROS2 node wiring the LiDAR identifier pipeline.

Pipeline stages (per the spec, Part E):
  1 Preprocessing  → workspace crop in base_link
  2 Ground extract → RANSAC plane
  3 Workspace mask → optional polygon filter
  4 Clustering     → Euclidean clusters
  5 Shape analysis → OBB + descriptors per cluster
  6 Parts match    → score vs cached library entries
  7 Persistence    → multi-frame confirmation

Outputs:
  /lidar_objects/identified      (IdentifiedObjectArray)
  /lidar_objects/visualization   (visualization_msgs/MarkerArray)
  /lidar_objects/stats           (ObjectIdentificationStats)
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import List

import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data, QoSProfile, QoSDurabilityPolicy

from sensor_msgs.msg import PointCloud2
from std_msgs.msg import Header
from visualization_msgs.msg import Marker, MarkerArray

from lidar_object_identifier_msgs.msg import (
    IdentifiedObject as IdentifiedObjectMsg,
    IdentifiedObjectArray as IdentifiedObjectArrayMsg,
    ObjectIdentificationStats as ObjectIdentificationStatsMsg,
)

from . import utils
from .ground_extractor import GroundExtractor
from .object_clusterer import ObjectClusterer, Cluster
from .shape_analyzer import analyze
from .parts_matcher import PartsMatcher
from .persistence_tracker import PersistenceTracker
from .confidence_scorer import combined_confidence, CONFIDENT, TENTATIVE


logger = logging.getLogger(__name__)

LIDAR_CONFIG_DIR = '/opt/cobot/lidar/config'
WORKSPACE_MASK_PATH = os.path.join(LIDAR_CONFIG_DIR, 'workspace_mask.yaml')
IGNORE_LIST_PATH = os.path.join(LIDAR_CONFIG_DIR, 'ignore_list.json')


class IdentifierNode(Node):

    def __init__(self):
        super().__init__('lidar_object_identifier')
        os.makedirs(LIDAR_CONFIG_DIR, exist_ok=True)

        # ---- parameters ----
        p = self.declare_parameter
        p('input_topic', '/lidar/points_filtered')
        p('output_topic', '/lidar_objects/identified')
        p('visualization_topic', '/lidar_objects/visualization')
        p('stats_topic', '/lidar_objects/stats')
        p('base_frame', 'base_link')
        p('process_rate_hz', 5.0)

        for k, v in (('workspace_xmin', -3.0), ('workspace_xmax', 3.0),
                     ('workspace_ymin', -3.0), ('workspace_ymax', 3.0),
                     ('workspace_zmin', 0.0),  ('workspace_zmax', 2.0)):
            p(k, v)

        p('ground_ransac_distance_m', 0.015)
        p('ground_ransac_iterations', 1000)
        p('ground_normal_max_tilt_deg', 15.0)

        p('cluster_tolerance_m', 0.02)
        p('cluster_min_points', 50)
        p('cluster_max_points', 50000)
        p('cluster_min_volume_m3', 1.0e-6)
        p('cluster_max_volume_m3', 2.0)
        p('cluster_max_aspect_ratio', 50.0)
        p('cluster_min_density_per_m3', 100.0)

        p('size_tolerance_pct', 25.0)
        p('volume_tolerance_pct', 30.0)
        p('score_weights_size', 0.35)
        p('score_weights_volume', 0.25)
        p('score_weights_shape', 0.30)
        p('score_weights_persistence', 0.10)

        p('confidence_confirmed', 0.8)
        p('confidence_tentative', 0.5)
        p('confidence_detected', 0.3)

        p('persistence_buffer_len', 10)
        p('persistence_match_xy_m', 0.05)
        p('persistence_confirm_streak', 5)
        p('persistence_lost_after', 3)
        p('persistence_drop_after', 10)

        gp = lambda name: self.get_parameter(name).value
        self._base_frame = str(gp('base_frame'))
        self._workspace = (
            float(gp('workspace_xmin')), float(gp('workspace_xmax')),
            float(gp('workspace_ymin')), float(gp('workspace_ymax')),
            float(gp('workspace_zmin')), float(gp('workspace_zmax')),
        )

        # ---- pipeline components ----
        self._ground = GroundExtractor(
            distance_threshold_m=float(gp('ground_ransac_distance_m')),
            max_iterations=int(gp('ground_ransac_iterations')),
            max_tilt_deg=float(gp('ground_normal_max_tilt_deg')),
        )
        self._clusterer = ObjectClusterer(
            tolerance_m=float(gp('cluster_tolerance_m')),
            min_points=int(gp('cluster_min_points')),
            max_points=int(gp('cluster_max_points')),
            min_volume_m3=float(gp('cluster_min_volume_m3')),
            max_volume_m3=float(gp('cluster_max_volume_m3')),
            max_aspect_ratio=float(gp('cluster_max_aspect_ratio')),
            min_density_per_m3=float(gp('cluster_min_density_per_m3')),
        )
        self._matcher = PartsMatcher(
            size_tolerance_pct=float(gp('size_tolerance_pct')),
            volume_tolerance_pct=float(gp('volume_tolerance_pct')),
            weight_size=float(gp('score_weights_size')),
            weight_volume=float(gp('score_weights_volume')),
            weight_shape=float(gp('score_weights_shape')),
            weight_persistence=float(gp('score_weights_persistence')),
            shape_feature_weights=self._load_shape_weights(),
        )
        self._matcher.refresh_library(force=True)
        self._tracker = PersistenceTracker(
            buffer_len=int(gp('persistence_buffer_len')),
            match_xy_m=float(gp('persistence_match_xy_m')),
            confirm_streak=int(gp('persistence_confirm_streak')),
            lost_after=int(gp('persistence_lost_after')),
            drop_after=int(gp('persistence_drop_after')),
        )
        self._conf_thresholds = (
            float(gp('confidence_confirmed')),
            float(gp('confidence_tentative')),
            float(gp('confidence_detected')),
        )
        self._persistence_weight = float(gp('score_weights_persistence'))

        # ---- ROS plumbing ----
        latched = QoSProfile(depth=1)
        latched.durability = QoSDurabilityPolicy.TRANSIENT_LOCAL

        self.create_subscription(
            PointCloud2, str(gp('input_topic')),
            self._on_cloud, qos_profile_sensor_data)
        self.pub_objects = self.create_publisher(
            IdentifiedObjectArrayMsg, str(gp('output_topic')), 5)
        self.pub_markers = self.create_publisher(
            MarkerArray, str(gp('visualization_topic')), 5)
        self.pub_stats = self.create_publisher(
            ObjectIdentificationStatsMsg, str(gp('stats_topic')), 5)

        process_dt = 1.0 / max(float(gp('process_rate_hz')), 1.0)
        self._latest_cloud: np.ndarray = np.empty((0, 3), dtype=np.float32)
        self._latest_stamp = None
        self.create_timer(process_dt, self._tick)
        self.create_timer(5.0, self._refresh_library_periodic)

        self._known_today = set()
        self._false_positives = 0
        self._identifications_window = []  # timestamps

        self.get_logger().info(
            f'lidar_object_identifier ready. '
            f'input={str(gp("input_topic"))} base_frame={self._base_frame} '
            f'parts_in_library={self._matcher.known_parts()}'
        )

    # ------------------------------------------------------------------
    # Config helpers
    # ------------------------------------------------------------------

    def _load_shape_weights(self):
        try:
            from ament_index_python.packages import get_package_share_directory
            share = get_package_share_directory('lidar_object_identifier')
            path = os.path.join(share, 'config', 'shape_features.yaml')
            if not os.path.isfile(path):
                return None
            with open(path) as f:
                doc = yaml.safe_load(f) or {}
            features = (doc.get('features') or {})
            return {k: (float(v.get('weight', 1.0)), float(v.get('tolerance', 0.25)))
                    for k, v in features.items()}
        except Exception:
            return None

    def _load_workspace_mask(self):
        if not os.path.isfile(WORKSPACE_MASK_PATH):
            return None
        try:
            with open(WORKSPACE_MASK_PATH) as f:
                doc = yaml.safe_load(f) or {}
        except Exception:
            return None
        verts = doc.get('polygon') or []
        if len(verts) < 3:
            return None
        return np.array([[float(v[0]), float(v[1])] for v in verts], dtype=float)

    def _load_ignore_list(self):
        if not os.path.isfile(IGNORE_LIST_PATH):
            return []
        try:
            with open(IGNORE_LIST_PATH) as f:
                return list(json.load(f) or [])
        except Exception:
            return []

    # ------------------------------------------------------------------
    # ROS callbacks
    # ------------------------------------------------------------------

    def _on_cloud(self, msg: PointCloud2):
        xyz = utils.decode_pointcloud2_xyz(msg)
        if xyz.size == 0:
            return
        self._latest_cloud = xyz
        self._latest_stamp = msg.header.stamp
        if msg.header.frame_id and msg.header.frame_id != self._base_frame:
            # The cloud's frame may differ from base_link; for now we trust
            # the upstream accumulator publishes in livox_frame / base_link.
            # When TF is wired up here we'll do the transform; for now log
            # at debug and continue.
            self.get_logger().debug(
                f'cloud frame {msg.header.frame_id} != base_frame '
                f'{self._base_frame}; treating as base_frame')

    def _refresh_library_periodic(self):
        self._matcher.refresh_library(force=False)

    # ------------------------------------------------------------------
    # Main processing tick
    # ------------------------------------------------------------------

    def _tick(self):
        if self._latest_stamp is None:
            return
        cloud = self._latest_cloud
        t0 = time.monotonic()

        cropped = utils.crop_to_box(cloud, *self._workspace)
        ground_pts, above_pts, _coeffs = self._ground.extract(cropped)

        polygon = self._load_workspace_mask()
        if polygon is not None and above_pts.shape[0]:
            mask = utils.points_inside_polygon(above_pts[:, :2], polygon)
            above_pts = above_pts[mask]

        ignore_regions = self._load_ignore_list()

        clusters: List[Cluster] = []
        if above_pts.shape[0]:
            clusters = self._clusterer.cluster(above_pts)

        scored_observations = []
        for cl in clusters:
            if self._cluster_inside_ignore(cl, ignore_regions):
                self._false_positives += 1
                continue
            feats = analyze(cl.points)
            match = self._matcher.match(feats, persistence_score=0.0)
            scored_observations.append({
                'cluster': cl,
                'features': feats,
                'match': match,
                'center': feats.center,
                'dimensions': feats.dimensions_m,
                'part_id': match.part_id,
                'confidence': match.overall_score,
            })

        tracks = self._tracker.step(scored_observations)
        track_by_id = {t.track_id: t for t in tracks}

        out_objects: List[IdentifiedObjectMsg] = []
        markers = MarkerArray()
        confident = tentative = unknown = 0
        for idx, obs in enumerate(scored_observations):
            tid = obs.get('track_id')
            if tid is None or tid not in track_by_id:
                continue
            track = track_by_id[tid]
            persistence = self._tracker.stability_score(track)
            score = combined_confidence(
                obs['match'].overall_score, persistence,
                weight_persistence=self._persistence_weight)
            if score.confidence < self._conf_thresholds[2]:
                # Filter out below-detection-threshold clusters from publish
                continue
            if score.bucket == CONFIDENT:
                confident += 1
            elif score.bucket == TENTATIVE:
                tentative += 1
            else:
                unknown += 1

            msg = self._build_identified_object_msg(
                obs, track, score.confidence, persistence)
            out_objects.append(msg)
            markers.markers.extend(self._cluster_markers(idx, obs, score))

            if obs['match'].part_id:
                self._known_today.add(obs['match'].part_id)
            self._identifications_window.append(time.time())

        # Trim identification rate window to last 60s
        cutoff = time.time() - 60.0
        self._identifications_window = [
            t for t in self._identifications_window if t >= cutoff]

        out_array = IdentifiedObjectArrayMsg()
        out_array.header.stamp = self.get_clock().now().to_msg()
        out_array.header.frame_id = self._base_frame
        out_array.objects = out_objects
        out_array.total_identified = len(out_objects)
        out_array.confident_identifications = confident
        out_array.tentative_identifications = tentative
        out_array.unknown_objects = unknown
        out_array.total_clusters_processed = len(scored_observations)
        out_array.processing_time_ms = float(
            1000.0 * (time.monotonic() - t0))
        self.pub_objects.publish(out_array)
        if markers.markers:
            self.pub_markers.publish(markers)

        stats = ObjectIdentificationStatsMsg()
        stats.header = out_array.header
        confidences = [o.identification_confidence for o in out_objects]
        stats.avg_confidence = float(np.mean(confidences)) if confidences else 0.0
        stats.identification_rate_per_sec = float(
            len(self._identifications_window) / 60.0)
        stats.known_parts_in_library = int(self._matcher.known_parts())
        stats.unique_objects_today = len(self._known_today)
        stats.false_positives_filtered = self._false_positives
        self.pub_stats.publish(stats)

    # ------------------------------------------------------------------
    # Output helpers
    # ------------------------------------------------------------------

    def _build_identified_object_msg(self, obs, track, confidence,
                                     persistence) -> IdentifiedObjectMsg:
        feats = obs['features']
        match = obs['match']
        m = IdentifiedObjectMsg()
        m.header.stamp = self.get_clock().now().to_msg()
        m.header.frame_id = self._base_frame
        m.id = int(track.track_id)
        m.identified_as = match.part_id or 'unknown'
        m.identified_name = match.part_name or 'unknown'
        m.identification_confidence = float(confidence)

        m.center.x = float(feats.center[0])
        m.center.y = float(feats.center[1])
        m.center.z = float(feats.center[2])
        m.dimensions.x = float(feats.dimensions_m[0])
        m.dimensions.y = float(feats.dimensions_m[1])
        m.dimensions.z = float(feats.dimensions_m[2])
        qx, qy, qz, qw = utils.quat_from_matrix(feats.rotation)
        m.orientation.x = qx
        m.orientation.y = qy
        m.orientation.z = qz
        m.orientation.w = qw

        m.volume_m3 = float(feats.volume_m3)
        m.surface_area_m2 = float(feats.surface_area_m2)
        m.point_count = float(feats.point_count)
        m.cluster_density = float(feats.density_per_m3)
        m.aspect_ratio_lw = float(feats.dimensions_m[0]
                                  / max(feats.dimensions_m[1], 1e-6))
        m.aspect_ratio_lh = float(feats.dimensions_m[0]
                                  / max(feats.dimensions_m[2], 1e-6))
        m.aspect_ratio_wh = float(feats.dimensions_m[1]
                                  / max(feats.dimensions_m[2], 1e-6))
        m.sphericity = float(feats.sphericity)
        m.flatness = float(feats.flatness)

        m.size_match_score = float(match.size_match_score)
        m.shape_match_score = float(match.shape_match_score)
        m.overall_match_score = float(match.overall_score)
        m.match_method = match.method

        m.frames_observed = int(track.frames_observed)
        m.stability_score = float(persistence)
        # Time stamps
        from builtin_interfaces.msg import Time
        first = Time()
        first.sec = int(track.first_seen)
        first.nanosec = int((track.first_seen - int(track.first_seen)) * 1e9)
        m.first_seen = first
        last = Time()
        last.sec = int(track.last_seen)
        last.nanosec = int((track.last_seen - int(track.last_seen)) * 1e9)
        m.last_seen = last

        m.alternative_matches = [name for (name, _s) in match.alternatives]
        m.alternative_scores = [float(s) for (_n, s) in match.alternatives]
        return m

    def _cluster_markers(self, idx, obs, score):
        feats = obs['features']
        markers = []
        color = {
            CONFIDENT: (0.13, 0.78, 0.40, 1.0),
            TENTATIVE: (0.92, 0.69, 0.04, 1.0),
        }.get(score.bucket, (0.6, 0.6, 0.6, 0.9))

        box = Marker()
        box.header.stamp = self.get_clock().now().to_msg()
        box.header.frame_id = self._base_frame
        box.ns = 'lidar_objects'
        box.id = idx * 2
        box.type = Marker.CUBE
        box.action = Marker.ADD
        box.pose.position.x = float(feats.center[0])
        box.pose.position.y = float(feats.center[1])
        box.pose.position.z = float(feats.center[2])
        qx, qy, qz, qw = utils.quat_from_matrix(feats.rotation)
        box.pose.orientation.x = qx
        box.pose.orientation.y = qy
        box.pose.orientation.z = qz
        box.pose.orientation.w = qw
        box.scale.x = max(0.01, float(feats.dimensions_m[0]))
        box.scale.y = max(0.01, float(feats.dimensions_m[1]))
        box.scale.z = max(0.01, float(feats.dimensions_m[2]))
        box.color.r, box.color.g, box.color.b, box.color.a = color
        # Translucent so the box edges read through
        box.color.a *= 0.35
        markers.append(box)

        label = Marker()
        label.header = box.header
        label.ns = 'lidar_object_labels'
        label.id = idx * 2 + 1
        label.type = Marker.TEXT_VIEW_FACING
        label.action = Marker.ADD
        label.pose.position.x = float(feats.center[0])
        label.pose.position.y = float(feats.center[1])
        label.pose.position.z = float(feats.center[2] + max(feats.dimensions_m[2] * 0.6, 0.05))
        label.scale.z = 0.05
        label.color.r, label.color.g, label.color.b = color[:3]
        label.color.a = 1.0
        label.text = (f'{obs["match"].part_name} '
                      f'({score.confidence:.0%})')
        markers.append(label)
        return markers

    @staticmethod
    def _cluster_inside_ignore(cl: Cluster, ignore_regions) -> bool:
        if not ignore_regions:
            return False
        c = cl.centroid
        for region in ignore_regions:
            try:
                cx, cy = region.get('center', [None, None])
                radius = float(region.get('radius', 0.0))
                if cx is None or cy is None or radius <= 0:
                    continue
                if (cx - c[0]) ** 2 + (cy - c[1]) ** 2 <= radius ** 2:
                    return True
            except Exception:
                continue
        return False


def main(args=None):
    rclpy.init(args=args)
    node = IdentifierNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        try:
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == '__main__':
    main()
