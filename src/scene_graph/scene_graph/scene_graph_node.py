import json
import time
import uuid
from typing import Dict, List
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
import numpy as np

try:
    from filterpy.kalman import KalmanFilter
    FILTERPY_AVAILABLE = True
except ImportError:
    FILTERPY_AVAILABLE = False


class Track:
    def __init__(self, class_id: str, position: tuple, confidence: float, frame_id: str):
        self.track_id = str(uuid.uuid4())
        self.class_id = class_id
        self.confidence = confidence
        self.frame_id = frame_id
        self.last_seen = time.time()
        self.created_at = self.last_seen

        if FILTERPY_AVAILABLE:
            self.kf = KalmanFilter(dim_x=6, dim_z=3)
            dt = 0.1
            self.kf.F = np.array([
                [1, 0, 0, dt, 0, 0],
                [0, 1, 0, 0, dt, 0],
                [0, 0, 1, 0, 0, dt],
                [0, 0, 0, 1, 0, 0],
                [0, 0, 0, 0, 1, 0],
                [0, 0, 0, 0, 0, 1],
            ])
            self.kf.H = np.array([
                [1, 0, 0, 0, 0, 0],
                [0, 1, 0, 0, 0, 0],
                [0, 0, 1, 0, 0, 0],
            ])
            self.kf.Q = np.eye(6) * 0.1
            self.kf.R = np.eye(3) * 0.5
            self.kf.P *= 10
            self.kf.x[:3] = np.array(position).reshape(3, 1)
        else:
            self._pos = np.array(position, dtype=float)
            self._vel = np.zeros(3)

    def update(self, position: tuple, confidence: float):
        self.confidence = confidence
        self.last_seen = time.time()
        if FILTERPY_AVAILABLE:
            self.kf.update(np.array(position).reshape(3, 1))
        else:
            self._pos = np.array(position, dtype=float)

    def predict(self):
        if FILTERPY_AVAILABLE:
            self.kf.predict()

    @property
    def position(self):
        if FILTERPY_AVAILABLE:
            return tuple(float(v) for v in self.kf.x[:3].flatten())
        return tuple(float(v) for v in self._pos)

    @property
    def velocity(self):
        if FILTERPY_AVAILABLE:
            return tuple(float(v) for v in self.kf.x[3:].flatten())
        return (0.0, 0.0, 0.0)

    def to_dict(self):
        pos = self.position
        vel = self.velocity
        age = time.time() - self.created_at
        return {
            'track_id': self.track_id,
            'class_id': self.class_id,
            'confidence': round(self.confidence, 3),
            'position': {'x': round(pos[0], 4), 'y': round(pos[1], 4), 'z': round(pos[2], 4)},
            'velocity': {'x': round(vel[0], 4), 'y': round(vel[1], 4), 'z': round(vel[2], 4)},
            'last_seen': round(self.last_seen, 3),
            'age_s': round(age, 2),
            'frame_id': self.frame_id,
        }


class SceneGraphNode(Node):
    def __init__(self):
        super().__init__('scene_graph_node')

        self.declare_parameter('max_track_age_s', 5.0)
        self.declare_parameter('association_distance_m', 0.3)
        self.declare_parameter('min_confidence', 0.4)
        self.declare_parameter('publish_rate_hz', 10.0)

        self.max_age = self.get_parameter('max_track_age_s').value
        self.assoc_dist = self.get_parameter('association_distance_m').value
        self.min_conf = self.get_parameter('min_confidence').value
        rate = self.get_parameter('publish_rate_hz').value

        self.tracks: List[Track] = []

        self.create_subscription(String, '/perception/detections',
                                 self._detection_cb, 10)
        self.graph_pub = self.create_publisher(String, '/perception/scene_graph', 10)
        self.create_timer(1.0 / rate, self._publish_graph)

        self._last_log = self.get_clock().now()
        if not FILTERPY_AVAILABLE:
            self.get_logger().warn('filterpy not available — using simple position tracking')
        self.get_logger().info('scene_graph_node started')

    def _detection_cb(self, msg: String):
        try:
            data = json.loads(msg.data)
        except Exception:
            return
        dets = data.get('detections', [])
        now = time.time()

        for track in self.tracks:
            track.predict()

        matched = set()
        for det in dets:
            cls_id = det.get('class_name', str(det.get('class_id', 'unknown')))
            conf   = float(det.get('score', 0.0))
            if conf < self.min_conf:
                continue
            pos_3d = det.get('pos_3d')
            if not pos_3d or len(pos_3d) < 3:
                continue
            det_pos = (float(pos_3d[0]), float(pos_3d[1]), float(pos_3d[2]))

            best_track = None
            best_dist = self.assoc_dist
            for i, track in enumerate(self.tracks):
                if i in matched:
                    continue
                tp = track.position
                dist = float(np.linalg.norm(np.array(det_pos) - np.array(tp)))
                if dist < best_dist:
                    best_dist = dist
                    best_track = i

            if best_track is not None:
                self.tracks[best_track].update(det_pos, conf)
                matched.add(best_track)
            else:
                self.tracks.append(Track(cls_id, det_pos, conf, 'cam0_link'))

        self.tracks = [t for t in self.tracks if (now - t.last_seen) < self.max_age]

    def _publish_graph(self):
        graph = {t.track_id: t.to_dict() for t in self.tracks}
        msg = String()
        msg.data = json.dumps(graph)
        self.graph_pub.publish(msg)

        now = self.get_clock().now()
        dt = (now - self._last_log).nanoseconds / 1e9
        if dt >= 0.5:
            class_counts: Dict[str, int] = {}
            for t in self.tracks:
                class_counts[t.class_id] = class_counts.get(t.class_id, 0) + 1
            self.get_logger().info(f'Tracking {len(self.tracks)} objects: {class_counts}')
            self._last_log = now


def main(args=None):
    rclpy.init(args=args)
    node = SceneGraphNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
