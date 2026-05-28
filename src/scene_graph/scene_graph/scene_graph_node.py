import json
import math
import time
import uuid
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from vision_msgs.msg import Detection3DArray
import numpy as np

_PATH_HISTORY_LEN  = 50    # ring buffer length (≈5 s at 10 Hz)
_VELOCITY_WINDOW   = 5     # samples used to estimate velocity
_MOVING_SPEED_MPS  = 0.005 # below this we call the track stationary

def _quat_to_euler_deg(qx, qy, qz, qw):
    """xyzw quaternion -> (roll, pitch, yaw) in degrees, gimbal-safe."""
    r20 = 2.0 * (qx * qz - qw * qy)
    r21 = 2.0 * (qy * qz + qw * qx)
    r22 = 1.0 - 2.0 * (qx * qx + qy * qy)
    r10 = 2.0 * (qx * qy + qw * qz)
    r00 = 1.0 - 2.0 * (qy * qy + qz * qz)
    pitch = math.asin(max(-1.0, min(1.0, -r20)))
    if abs(abs(pitch) - math.pi / 2) < 1e-3:
        roll = math.atan2(-2.0 * (qx * qy - qw * qz), 1.0 - 2.0 * (qx * qx + qz * qz))
        yaw  = 0.0
    else:
        roll = math.atan2(r21, r22)
        yaw  = math.atan2(r10, r00)
    return [math.degrees(roll), math.degrees(pitch), math.degrees(yaw)]

try:
    from filterpy.kalman import KalmanFilter
    FILTERPY_AVAILABLE = True
except ImportError:
    FILTERPY_AVAILABLE = False


class Track:
    def __init__(self, class_id: str, position: tuple, confidence: float, frame_id: str,
                 quat=(0.0, 0.0, 0.0, 1.0), size=(0.05, 0.05, 0.05)):
        self.track_id = str(uuid.uuid4())
        self.class_id = class_id
        self.confidence = confidence
        self.frame_id = frame_id
        self.last_seen = time.time()
        self.created_at = self.last_seen
        # Motion + orientation state
        self.path_history: list = [[float(position[0]), float(position[1]),
                                    float(position[2]), self.last_seen]]
        self.size = tuple(float(v) for v in size)
        self.quat = tuple(float(v) for v in quat)
        self.is_moving = False
        self._velocity_xyz = [0.0, 0.0, 0.0]
        self._speed = 0.0

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

    def update(self, position: tuple, confidence: float,
               quat=None, size=None):
        self.confidence = confidence
        self.last_seen = time.time()
        if FILTERPY_AVAILABLE:
            self.kf.update(np.array(position).reshape(3, 1))
        else:
            self._pos = np.array(position, dtype=float)
        # Ring-buffered position history with absolute timestamps.
        self.path_history.append([float(position[0]), float(position[1]),
                                  float(position[2]), self.last_seen])
        if len(self.path_history) > _PATH_HISTORY_LEN:
            self.path_history.pop(0)
        # Velocity estimate over the last _VELOCITY_WINDOW samples.
        if len(self.path_history) >= _VELOCITY_WINDOW:
            recent = self.path_history[-_VELOCITY_WINDOW:]
            dt = recent[-1][3] - recent[0][3]
            if dt > 1e-3:
                dx = recent[-1][0] - recent[0][0]
                dy = recent[-1][1] - recent[0][1]
                dz = recent[-1][2] - recent[0][2]
                self._velocity_xyz = [dx / dt, dy / dt, dz / dt]
                self._speed = (dx * dx + dy * dy + dz * dz) ** 0.5 / dt
                self.is_moving = self._speed > _MOVING_SPEED_MPS
        if quat is not None:
            self.quat = tuple(float(v) for v in quat)
        if size is not None:
            self.size = tuple(float(v) for v in size)

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
        # Prefer the position-history estimate (independent of Kalman tuning).
        return tuple(self._velocity_xyz)

    @property
    def speed(self):
        return float(self._speed)

    def to_dict(self):
        pos = self.position
        vel = self.velocity
        age = time.time() - self.created_at
        euler = _quat_to_euler_deg(*self.quat)
        # Downsample path history to 20 points for the WS payload while
        # preserving newest + oldest endpoints. JSON is "list of [x, y, z]"
        # (timestamps dropped — frontend just needs the line).
        hist = self.path_history
        if len(hist) > 20:
            stride = len(hist) / 20.0
            sampled = [hist[int(i * stride)] for i in range(19)] + [hist[-1]]
        else:
            sampled = hist
        path_xyz = [[round(p[0], 4), round(p[1], 4), round(p[2], 4)] for p in sampled]
        return {
            'track_id':   self.track_id,
            'class_id':   self.class_id,
            'confidence': round(self.confidence, 3),
            'position':   {'x': round(pos[0], 4), 'y': round(pos[1], 4), 'z': round(pos[2], 4)},
            'size':       [round(self.size[0], 4), round(self.size[1], 4), round(self.size[2], 4)],
            'velocity':   {'x': round(vel[0], 4), 'y': round(vel[1], 4), 'z': round(vel[2], 4)},
            'speed_mps':  round(self._speed, 4),
            'is_moving':  bool(self.is_moving),
            'quat':       [round(q, 4) for q in self.quat],
            'orientation_deg': [round(e, 1) for e in euler],
            'path':       path_xyz,
            'last_seen':  round(self.last_seen, 3),
            'age_s':      round(age, 2),
            'frame_id':   self.frame_id,
        }


class SceneGraphNode(Node):
    def __init__(self):
        super().__init__('scene_graph_node')

        self.declare_parameter('max_track_age_s',        5.0)
        self.declare_parameter('association_distance_m', 0.15)
        self.declare_parameter('min_confidence',         0.2)
        self.declare_parameter('publish_rate_hz',        10.0)
        # Now prefers the LiDAR-primary detection topic (positions are
        # ground-truth in livox_frame). The old '/perception/detections'
        # default was never connected to any current publisher.
        self.declare_parameter('detections_topic',
                                '/perception/lidar_detections')

        self.max_age    = self.get_parameter('max_track_age_s').value
        self.assoc_dist = self.get_parameter('association_distance_m').value
        self.min_conf   = self.get_parameter('min_confidence').value
        rate            = self.get_parameter('publish_rate_hz').value
        det_topic       = str(self.get_parameter('detections_topic').value)

        self.tracks: list[Track] = []

        self.create_subscription(Detection3DArray, det_topic,
                                 self._detection_cb, 10)
        self.get_logger().info(f'subscribing to {det_topic}')
        self.graph_pub = self.create_publisher(String, '/perception/scene_graph', 10)
        self.create_timer(1.0 / rate, self._publish_graph)

        self._last_log = self.get_clock().now()
        if not FILTERPY_AVAILABLE:
            self.get_logger().warn('filterpy not available — using simple position tracking')
        self.get_logger().info('scene_graph_node started')

    def _detection_cb(self, msg: Detection3DArray):
        now = time.time()

        for track in self.tracks:
            track.predict()

        matched = set()
        for det in msg.detections:
            if not det.results:
                continue
            result = det.results[0]
            cls_id = result.hypothesis.class_id
            conf = result.hypothesis.score
            if conf < self.min_conf:
                continue

            pos = det.bbox.center.position
            det_pos = (pos.x, pos.y, pos.z)
            frame = msg.header.frame_id
            ori = det.bbox.center.orientation
            det_quat = (float(ori.x), float(ori.y), float(ori.z), float(ori.w))
            sz = det.bbox.size
            det_size = (float(sz.x), float(sz.y), float(sz.z))

            # Note: an earlier "z > 0" gate was removed — the LiDAR
            # detector publishes positions in livox_frame where the
            # table sits at z ≈ 0 (sometimes slightly negative).
            # Filtering on Z dropped every real object on the table.

            best_track = None
            best_dist = self.assoc_dist
            for i, track in enumerate(self.tracks):
                if i in matched:
                    continue
                tp = track.position
                dist = np.linalg.norm(np.array(det_pos) - np.array(tp))
                if dist < best_dist:
                    best_dist = dist
                    best_track = i

            if best_track is not None:
                self.tracks[best_track].update(det_pos, conf,
                                                quat=det_quat, size=det_size)
                matched.add(best_track)
            else:
                self.tracks.append(Track(cls_id, det_pos, conf, frame,
                                          quat=det_quat, size=det_size))

        self.tracks = [t for t in self.tracks if (now - t.last_seen) < self.max_age]

    def _publish_graph(self):
        graph = {t.track_id: t.to_dict() for t in self.tracks}
        msg = String()
        msg.data = json.dumps(graph)
        self.graph_pub.publish(msg)

        now = self.get_clock().now()
        dt = (now - self._last_log).nanoseconds / 1e9
        if dt >= 0.5:
            class_counts: dict = {}
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
