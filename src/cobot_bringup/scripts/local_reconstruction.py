#!/usr/bin/env python3
"""Local TSDF/occupancy reconstruction from the dense LiDAR cloud.

Two-zone variable-resolution voxel grid:
    near zone  (||p|| <= near_radius_m, default 0.5 m): 5 mm voxels
    far  zone (||p|| >  near_radius_m, out to far_half_extent_m, default
               1.5 m → 3 m cube):                        2 cm voxels

Each zone has its own EMA-occupancy grid, decay step, isolated-voxel
cull, and small-cluster filter. Surfaces are extracted via
scikit-image marching_cubes; spurious triangles (area > 1 cm² or
< 1e-7 m²) are discarded; meshes from the two zones are concatenated.

Per-vertex height-band colours come from `_height_color_arr`. If any
LiDAR detections are within 5 cm of a vertex, that vertex turns bright
green to visually mark detected objects.

Published:
    /reconstruction/mesh       visualization_msgs/Marker (TRIANGLE_LIST)
    /reconstruction/mesh_json  std_msgs/String JSON for the dashboard /ws/mesh
"""
import json
import math
import struct

import numpy as np
import rclpy
from geometry_msgs.msg import Point
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from scipy import ndimage
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import ColorRGBA, String
from vision_msgs.msg import Detection3DArray
from visualization_msgs.msg import Marker

try:
    from skimage.measure import marching_cubes
except ImportError:
    marching_cubes = None

try:
    import pyfqmr   # quadric edge-collapse decimation
except ImportError:
    pyfqmr = None


# ── helpers ──────────────────────────────────────────────────────────

def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ('x', 'y', 'z')):
        return np.empty((0, 3), dtype=np.float32)
    step = msg.point_step
    if step <= 0:
        return np.empty((0, 3), dtype=np.float32)
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)
    ox, oy, oz = fields['x'].offset, fields['y'].offset, fields['z'].offset
    if oy == ox + 4 and oz == ox + 8:
        arr = np.frombuffer(data, dtype=np.uint8).reshape(n, step)
        return arr[:, ox:ox + 12].copy().view(np.float32).reshape(n, 3)
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


def _height_color(z: float):
    if z < 0.1: return (0.753, 0.769, 0.800)
    if z < 0.8: return (0.576, 0.773, 0.992)
    if z < 1.5: return (0.525, 0.937, 0.675)
    return        (0.992, 0.902, 0.541)


def _height_color_arr(zs: np.ndarray) -> np.ndarray:
    cols = np.empty((zs.shape[0], 3), dtype=np.float32)
    a = zs < 0.1
    b = (~a) & (zs < 0.8)
    c = (~a) & (~b) & (zs < 1.5)
    d = ~(a | b | c)
    cols[a] = (0.753, 0.769, 0.800)
    cols[b] = (0.576, 0.773, 0.992)
    cols[c] = (0.525, 0.937, 0.675)
    cols[d] = (0.992, 0.902, 0.541)
    return cols


def _filter_triangles(verts: np.ndarray, faces: np.ndarray,
                      min_area: float = 1e-7, max_area: float = 0.01):
    """Drop degenerate or oversized triangles (noise artefacts)."""
    if faces.shape[0] == 0:
        return faces
    v0 = verts[faces[:, 0]]; v1 = verts[faces[:, 1]]; v2 = verts[faces[:, 2]]
    cross = np.cross(v1 - v0, v2 - v0)
    areas = 0.5 * np.linalg.norm(cross, axis=1)
    keep = (areas > min_area) & (areas < max_area)
    return faces[keep]


# ── node ─────────────────────────────────────────────────────────────

class LocalReconstruction(Node):
    def __init__(self):
        super().__init__('local_reconstruction')

        self.declare_parameter('input_topic',         '/lidar/points_dense')
        self.declare_parameter('detections_topic',    '/perception/lidar_detections')
        self.declare_parameter('near_radius_m',       0.5)
        self.declare_parameter('near_voxel_m',        0.005)
        self.declare_parameter('far_half_extent_m',   1.5)
        self.declare_parameter('far_voxel_m',         0.02)
        self.declare_parameter('occupancy_threshold', 0.7)
        self.declare_parameter('decay_rate',          0.995)
        self.declare_parameter('update_rate',         0.2)
        self.declare_parameter('publish_hz',          1.0)
        self.declare_parameter('max_triangles_json',  10000)
        self.declare_parameter('max_triangle_area_m2', 0.01)
        self.declare_parameter('mesh_radius_m',       1.5)
        self.declare_parameter('min_neighbours',      3)
        self.declare_parameter('min_cluster_voxels',  20)
        self.declare_parameter('object_highlight_radius_m', 0.05)
        self.declare_parameter('frame_id',            'livox_frame')

        input_topic    = self.get_parameter('input_topic').value
        det_topic      = self.get_parameter('detections_topic').value
        self.near_r    = float(self.get_parameter('near_radius_m').value)
        near_v         = float(self.get_parameter('near_voxel_m').value)
        far_h          = float(self.get_parameter('far_half_extent_m').value)
        far_v          = float(self.get_parameter('far_voxel_m').value)
        self.occ_thr   = float(self.get_parameter('occupancy_threshold').value)
        self.decay     = float(self.get_parameter('decay_rate').value)
        self.upd_rate  = float(self.get_parameter('update_rate').value)
        self.max_tri   = int(self.get_parameter('max_triangles_json').value)
        self.max_area  = float(self.get_parameter('max_triangle_area_m2').value)
        self.mesh_radius = float(self.get_parameter('mesh_radius_m').value)
        self.min_nb    = int(self.get_parameter('min_neighbours').value)
        self.min_clu   = int(self.get_parameter('min_cluster_voxels').value)
        self.hi_radius = float(self.get_parameter('object_highlight_radius_m').value)
        self.frame_id  = str(self.get_parameter('frame_id').value)
        rate           = float(self.get_parameter('publish_hz').value)

        # Two zones. Each zone is a centred cube; we only feed it the
        # points that belong to its distance band. The grids' overlap in
        # space doesn't cause double-rendering because far_grid stays
        # empty in the inner region (no points get routed there).
        n_near = int(round(2 * self.near_r / near_v))
        n_far  = int(round(2 * far_h  / far_v))
        self._zones = [
            {'name': 'near', 'grid': np.zeros((n_near,) * 3, dtype=np.float32),
             'voxel': near_v, 'half': self.near_r, 'n': n_near},
            {'name': 'far',  'grid': np.zeros((n_far,) * 3,  dtype=np.float32),
             'voxel': far_v,  'half': far_h,        'n': n_far},
        ]
        self._frames_seen = 0
        self._object_centroids = np.empty((0, 3), dtype=np.float32)

        self.create_subscription(PointCloud2, input_topic, self._on_cloud,
                                 qos_profile_sensor_data)
        self.create_subscription(Detection3DArray, det_topic,
                                 self._on_detections, 5)
        self._marker_pub = self.create_publisher(Marker, '/reconstruction/mesh', 2)
        self._json_pub   = self.create_publisher(String, '/reconstruction/mesh_json', 2)
        self.create_timer(1.0 / max(rate, 0.25), self._publish)

        if marching_cubes is None:
            self.get_logger().warn(
                "skimage not available — mesh extraction falls back to "
                "surface-voxel point output. pip3 install scikit-image")
        if pyfqmr is None:
            self.get_logger().info("pyfqmr not available — decimation uses random subsample")
        near_mb = self._zones[0]['grid'].nbytes / 1024 / 1024
        far_mb  = self._zones[1]['grid'].nbytes / 1024 / 1024
        self.get_logger().info(
            f'local_reconstruction: near={n_near}³ @ {near_v}m ({near_mb:.1f}MB), '
            f'far={n_far}³ @ {far_v}m ({far_mb:.1f}MB) | thr={self.occ_thr} '
            f'rate={rate}Hz max_tri={self.max_tri}')

    # ── callbacks ────────────────────────────────────────────────────

    def _on_detections(self, msg: Detection3DArray):
        cents = []
        for det in msg.detections:
            p = det.bbox.center.position
            cents.append((float(p.x), float(p.y), float(p.z)))
        self._object_centroids = (np.array(cents, dtype=np.float32)
                                  if cents else np.empty((0, 3), dtype=np.float32))

    def _on_cloud(self, msg: PointCloud2):
        xyz = _decode_xyz(msg)
        if xyz.size == 0:
            return
        # Route points by distance from origin (sphere split).
        r = np.linalg.norm(xyz, axis=1)
        near_pts = xyz[r <= self.near_r]
        far_pts  = xyz[r >  self.near_r]
        self._update_zone(self._zones[0], near_pts)
        self._update_zone(self._zones[1], far_pts)
        self._frames_seen += 1

    def _update_zone(self, zone, pts: np.ndarray):
        grid  = zone['grid']
        voxel = zone['voxel']
        half  = zone['half']
        n     = zone['n']
        # Decay everything — fresh evidence gets weighted in via EMA.
        grid *= self.decay
        if pts.size == 0:
            return
        idx = np.floor((pts + half) / voxel).astype(np.int32)
        in_range = ((idx >= 0) & (idx < n)).all(axis=1)
        idx = idx[in_range]
        if idx.size == 0:
            return
        i, j, k = idx[:, 0], idx[:, 1], idx[:, 2]
        grid[i, j, k] = (1.0 - self.upd_rate) * grid[i, j, k] + self.upd_rate
        # Isolated-voxel cull and small-cluster filter, applied per zone.
        occ = grid > self.occ_thr
        if occ.any():
            n_count = ndimage.uniform_filter(occ.astype(np.float32), size=3) * 27.0
            isolated = (grid > 0.0) & (n_count < (self.min_nb + 1))
            grid[isolated] = 0.0
            if self.min_clu > 1:
                occ = grid > self.occ_thr
                if occ.any():
                    labeled, n_lbl = ndimage.label(occ, structure=np.ones((3, 3, 3)))
                    if n_lbl > 0:
                        counts = np.bincount(labeled.ravel())
                        too_small = counts < self.min_clu
                        too_small[0] = False
                        if too_small.any():
                            grid[too_small[labeled]] = 0.0

    # ── mesh extraction ──────────────────────────────────────────────

    def _extract_zone(self, zone):
        """Marching cubes on one zone's grid. Returns (verts, faces) in
        world coordinates (livox_frame). Falls back to surface-voxel
        points if skimage is unavailable."""
        grid  = zone['grid']
        voxel = zone['voxel']
        half  = zone['half']
        if marching_cubes is None:
            occ = grid > self.occ_thr
            if not occ.any():
                return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
            coords = np.argwhere(occ)
            verts = coords.astype(np.float32) * voxel - half + voxel * 0.5
            return verts, np.zeros((0, 3), dtype=np.int32)
        try:
            verts, faces, _, _ = marching_cubes(
                grid, level=self.occ_thr, spacing=(voxel, voxel, voxel))
        except (ValueError, RuntimeError):
            return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
        verts = verts.astype(np.float32) - half
        faces = faces.astype(np.int32)
        return verts, faces

    def _extract_mesh(self):
        """Marching cubes on each zone, crop to mesh_radius, drop bad
        triangles, then concatenate the per-zone meshes (no shared
        vertices since zones are disjoint in 3-space)."""
        all_v = []
        all_f = []
        offset = 0
        for zone in self._zones:
            v, f = self._extract_zone(zone)
            if v.size == 0:
                continue
            # Crop to mesh_radius.
            r = np.linalg.norm(v, axis=1)
            keep_v = r < self.mesh_radius
            if not keep_v.all():
                keep_idx = np.where(keep_v)[0]
                remap = -np.ones(v.shape[0], dtype=np.int64)
                remap[keep_idx] = np.arange(keep_idx.size)
                if f.shape[0] > 0:
                    tri_keep = keep_v[f].all(axis=1)
                    f = remap[f[tri_keep]].astype(np.int32)
                v = v[keep_idx]
            # Triangle filter — drop slivers and outsize artefacts.
            if f.shape[0] > 0:
                f = _filter_triangles(v, f, max_area=self.max_area)
            if v.size == 0:
                continue
            all_v.append(v)
            all_f.append(f + offset if f.size else f)
            offset += v.shape[0]

        if not all_v:
            return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
        verts = np.concatenate(all_v, axis=0)
        faces = np.concatenate(all_f, axis=0) if all_f and all_f[0].size or (
            len(all_f) > 1 and all_f[1].size) else np.zeros((0, 3), dtype=np.int32)
        return verts, faces

    # ── decimation ──────────────────────────────────────────────────

    def _decimate(self, verts: np.ndarray, faces: np.ndarray, target: int):
        """Reduce triangle count to ~target. Prefers quadric edge collapse
        (pyfqmr) for shape-preserving output; falls back to random
        sampling + vertex remap when pyfqmr is unavailable or fails."""
        if faces.shape[0] <= target:
            return verts, faces
        if pyfqmr is not None:
            try:
                simp = pyfqmr.Simplify()
                simp.setMesh(verts.astype(np.float64), faces.astype(np.int32))
                simp.simplify_mesh(target_count=target, preserve_border=True,
                                   aggressiveness=7, verbose=False)
                v2, f2, _ = simp.getMesh()
                if v2.size and f2.size:
                    return v2.astype(np.float32), f2.astype(np.int32)
            except Exception as e:
                self.get_logger().warn(f'pyfqmr failed ({e}); falling back to subsample',
                                        throttle_duration_sec=10)
        # Random subsample + vertex remap.
        sel = np.random.choice(faces.shape[0], target, replace=False)
        sel_faces = faces[sel]
        used = np.unique(sel_faces.ravel())
        remap = -np.ones(verts.shape[0], dtype=np.int64)
        remap[used] = np.arange(used.size)
        return verts[used], remap[sel_faces].astype(np.int32)

    # ── publishing ──────────────────────────────────────────────────

    def _publish(self):
        verts, faces = self._extract_mesh()
        verts, faces = self._decimate(verts, faces, self.max_tri)
        n_occ = int(sum((z['grid'] > self.occ_thr).sum() for z in self._zones))
        self._publish_marker(verts, faces)
        self._publish_json(verts, faces, n_occ)
        if self._frames_seen and self._frames_seen % 10 == 0:
            self.get_logger().info(
                f'frames={self._frames_seen}  occupied={n_occ}  '
                f'mesh={verts.shape[0]}v/{faces.shape[0]}t  '
                f'objects={self._object_centroids.shape[0]}')

    def _compute_vertex_colors(self, verts: np.ndarray) -> np.ndarray:
        """Height-band colours, with bright green overlay for vertices
        within hi_radius of any LiDAR-detected object centroid."""
        if verts.shape[0] == 0:
            return np.empty((0, 3), dtype=np.float32)
        cols = _height_color_arr(verts[:, 2])
        cents = self._object_centroids
        if cents.shape[0] > 0:
            # Per-vertex closest-centroid distance via broadcast (cheap for
            # small numbers of centroids).
            diff = verts[:, None, :] - cents[None, :, :]   # (V, C, 3)
            d2 = (diff * diff).sum(axis=2)                  # (V, C)
            nearest_d = np.sqrt(d2.min(axis=1))             # (V,)
            mask = nearest_d < self.hi_radius
            if mask.any():
                cols[mask] = (0.31, 0.78, 0.47)             # vivid green
        return cols

    def _publish_marker(self, verts, faces):
        m = Marker()
        m.header.stamp = self.get_clock().now().to_msg()
        m.header.frame_id = self.frame_id
        m.ns = 'reconstruction'
        m.id = 0
        m.type = Marker.TRIANGLE_LIST
        m.action = Marker.ADD
        m.scale.x = m.scale.y = m.scale.z = 1.0
        m.pose.orientation.w = 1.0
        m.color.r = m.color.g = m.color.b = 0.6; m.color.a = 0.7
        if faces.size == 0:
            self._marker_pub.publish(m)
            return
        # rviz Marker is verbose; only ship the first max_tri triangles to
        # keep it responsive.
        if faces.shape[0] > self.max_tri:
            sel = np.random.choice(faces.shape[0], self.max_tri, replace=False)
            faces = faces[sel]
        cols = self._compute_vertex_colors(verts)
        pts, color_msgs = [], []
        for tri in faces:
            for vi in tri:
                v = verts[vi]
                pt = Point(); pt.x = float(v[0]); pt.y = float(v[1]); pt.z = float(v[2])
                pts.append(pt)
                rc, gc, bc = cols[vi]
                cmsg = ColorRGBA(); cmsg.r = float(rc); cmsg.g = float(gc)
                cmsg.b = float(bc); cmsg.a = 0.7
                color_msgs.append(cmsg)
        m.points = pts
        m.colors = color_msgs
        self._marker_pub.publish(m)

    def _publish_json(self, verts, faces, n_occ):
        if faces.shape[0] > 0:
            used = np.unique(faces.ravel())
            remap = -np.ones(verts.shape[0], dtype=np.int64)
            remap[used] = np.arange(used.size)
            verts_out = verts[used]
            tris_out = remap[faces]
        else:
            verts_out = verts
            tris_out = faces

        if verts_out.shape[0] > 0:
            cols = self._compute_vertex_colors(verts_out)
            colors_json = [[round(float(c), 2) for c in v] for v in cols.tolist()]
        else:
            colors_json = []

        payload = {
            'frame_id':    self.frame_id,
            'n_vertices':  int(verts_out.shape[0]),
            'n_tris':      int(tris_out.shape[0]),
            'n_occupied':  int(n_occ),
            'n_objects':   int(self._object_centroids.shape[0]),
            'vertices':    [[round(float(v), 3) for v in p] for p in verts_out.tolist()],
            'triangles':   tris_out.astype(np.int32).tolist(),
            'colors':      colors_json,
        }
        s = String(); s.data = json.dumps(payload)
        self._json_pub.publish(s)


def main(args=None):
    rclpy.init(args=args)
    node = LocalReconstruction()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
