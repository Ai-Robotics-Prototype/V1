import os
import struct
import threading
import time

import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from rclpy.time import Duration
import message_filters
from sensor_msgs.msg import PointCloud2, PointField

from perception_fusion.cuda_fusion import (
    concat_clouds, range_filter, voxel_downsample,
    estimate_normals, get_backend, CUPY_AVAILABLE,
)


# Search paths for the camera-extrinsics yaml. Same list as
# sensor_tf_publisher.py uses so behaviour stays consistent.
_TF_YAML_CANDIDATES = [
    '/home/teddy/cobot_ws/install/cobot_bringup/share/cobot_bringup/config/sensor_transforms.yaml',
    '/home/teddy/cobot_ws/src/cobot_bringup/config/sensor_transforms.yaml',
]
_OPTICAL_TO_ROS_Q = (0.5, -0.5, 0.5, -0.5)


def _quat_to_R(qx: float, qy: float, qz: float, qw: float) -> np.ndarray:
    """Quaternion (x, y, z, w) -> 3x3 rotation matrix (float32)."""
    return np.array([
        [1 - 2*(qy*qy + qz*qz), 2*(qx*qy - qz*qw),     2*(qx*qz + qy*qw)    ],
        [2*(qx*qy + qz*qw),     1 - 2*(qx*qx + qz*qz), 2*(qy*qz - qx*qw)    ],
        [2*(qx*qz - qy*qw),     2*(qy*qz + qx*qw),     1 - 2*(qx*qx + qy*qy)],
    ], dtype=np.float32)


def _rpy_to_R(roll_deg: float, pitch_deg: float, yaw_deg: float) -> np.ndarray:
    """Intrinsic ZYX (yaw, pitch, roll) Euler angles (deg) -> 3x3 matrix.
    Same convention used by ros2 and most robotics tooling: a vector is
    rotated first by roll about X, then pitch about Y, then yaw about Z."""
    r = np.deg2rad(roll_deg);  p = np.deg2rad(pitch_deg);  y = np.deg2rad(yaw_deg)
    cr, sr = np.cos(r), np.sin(r)
    cp, sp = np.cos(p), np.sin(p)
    cy, sy = np.cos(y), np.sin(y)
    Rx = np.array([[1, 0, 0], [0, cr, -sr], [0, sr,  cr]], dtype=np.float32)
    Ry = np.array([[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]], dtype=np.float32)
    Rz = np.array([[cy, -sy, 0], [sy, cy, 0], [0,  0, 1]], dtype=np.float32)
    return Rz @ Ry @ Rx


def _load_cam_transforms():
    """Return {'cam0': (R, t), 'cam1': (R, t)} read from the yaml.
    The full rotation is R_rpy @ R_base — base optical->ROS quaternion,
    then a small Euler-angle trim from `rpy_correction` for camera tilt.
    Falls back to identity translation + standard optical->ROS rotation
    when the yaml is missing."""
    cfg = {}
    for path in _TF_YAML_CANDIDATES:
        if os.path.isfile(path):
            try:
                with open(path) as f:
                    cfg = yaml.safe_load(f) or {}
                break
            except Exception:
                continue
    out = {}
    for key, label in [('cam0_to_lidar', 'cam0'), ('cam1_to_lidar', 'cam1')]:
        block = cfg.get(key) or {}
        trans = block.get('translation')    or [0.0, 0.0, 0.0]
        rot   = block.get('rotation')       or list(_OPTICAL_TO_ROS_Q)
        rpy   = block.get('rpy_correction') or [0.0, 0.0, 0.0]
        R_base = _quat_to_R(*rot)
        R_trim = _rpy_to_R(*rpy)
        out[label] = (
            (R_trim @ R_base).astype(np.float32, copy=False),
            np.asarray(trans, dtype=np.float32),
        )
    return out

try:
    from tf2_ros import Buffer, TransformListener
    import tf2_sensor_msgs  # noqa: F401
    TF2_AVAILABLE = True
except ImportError:
    TF2_AVAILABLE = False


# ── PointCloud2 ↔ numpy helpers ───────────────────────────────────────────────

def pc2_to_numpy(msg: PointCloud2) -> np.ndarray:
    """Extract XYZ into an (N, 3) float32 array. Drops intensity/rgb/etc.
    so heterogeneous sources (LiDAR with intensity, RealSense with rgb)
    can be concatenated without shape mismatches downstream."""
    n = msg.width * msg.height
    if n == 0:
        return np.zeros((0, 3), dtype=np.float32)

    fields = {f.name: f for f in msg.fields}
    step   = msg.point_step
    off_x  = fields['x'].offset
    off_y  = fields['y'].offset
    off_z  = fields['z'].offset

    out = np.empty((n, 3), dtype=np.float32)
    raw = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(n, step)

    out[:, 0] = np.frombuffer(raw[:, off_x:off_x+4].tobytes(), dtype=np.float32)
    out[:, 1] = np.frombuffer(raw[:, off_y:off_y+4].tobytes(), dtype=np.float32)
    out[:, 2] = np.frombuffer(raw[:, off_z:off_z+4].tobytes(), dtype=np.float32)

    # Drop NaN/Inf
    mask = np.isfinite(out).all(axis=1)
    return out[mask]


def numpy_to_pc2(pts: np.ndarray, frame_id: str, stamp) -> PointCloud2:
    """Convert (N,3+) float32 numpy array to PointCloud2."""
    n = len(pts)
    msg = PointCloud2()
    msg.header.frame_id = frame_id
    msg.header.stamp    = stamp
    msg.height = 1
    msg.width  = n
    msg.is_dense     = True
    msg.is_bigendian = False

    has_i = pts.shape[1] >= 4
    if has_i:
        msg.fields = [
            PointField(name='x', offset=0,  datatype=PointField.FLOAT32, count=1),
            PointField(name='y', offset=4,  datatype=PointField.FLOAT32, count=1),
            PointField(name='z', offset=8,  datatype=PointField.FLOAT32, count=1),
            PointField(name='intensity', offset=12, datatype=PointField.FLOAT32, count=1),
        ]
        msg.point_step = 16
    else:
        msg.fields = [
            PointField(name='x', offset=0, datatype=PointField.FLOAT32, count=1),
            PointField(name='y', offset=4, datatype=PointField.FLOAT32, count=1),
            PointField(name='z', offset=8, datatype=PointField.FLOAT32, count=1),
        ]
        msg.point_step = 12

    msg.row_step = msg.point_step * n
    msg.data     = pts[:, :4 if has_i else 3].astype(np.float32).tobytes()
    return msg


# ── Node ─────────────────────────────────────────────────────────────────────

class SensorFusionNode(Node):
    def __init__(self):
        super().__init__('sensor_fusion_node')

        self.declare_parameter('voxel_size',    0.025)
        self.declare_parameter('max_range',     5.0)
        self.declare_parameter('min_range',     0.2)
        self.declare_parameter('target_frame',  'base_link')
        self.declare_parameter('estimate_normals', False)

        self.voxel_size     = self.get_parameter('voxel_size').value
        self.max_range      = self.get_parameter('max_range').value
        self.min_range      = self.get_parameter('min_range').value
        self.target_frame   = self.get_parameter('target_frame').value
        self.do_normals     = self.get_parameter('estimate_normals').value

        if TF2_AVAILABLE:
            self.tf_buffer   = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
        else:
            self.tf_buffer = None
            self.get_logger().warn('tf2_ros not available — transforms disabled')

        # Camera extrinsics are read from sensor_transforms.yaml directly
        # rather than relying on the TF tree. The static_transform_broadcaster
        # used by sensor_tf_publisher.py publishes once at boot, and any node
        # that joins later (e.g. this one after a restart) often misses the
        # /tf_static message via DDS. Loading the yaml here bypasses that
        # entirely for the static camera mounts.
        self._cam_tf = _load_cam_transforms()
        for name, (R, t) in self._cam_tf.items():
            self.get_logger().info(
                f'cam extrinsic loaded: {name} t={t.tolist()} '
                f'R[0]={R[0].tolist()}')

        self.fused_pub = self.create_publisher(PointCloud2, '/perception/fused_cloud', 10)

        self._lock      = threading.Lock()
        self._lidar_msg = None
        self._cam0_msg  = None
        self._cam1_msg  = None

        # cam0 publishes /cam0/cam0/depth/color/points when
        # pointcloud__neon_.enable=true; cam1 is symmetric.
        self.create_subscription(PointCloud2, '/lidar/points',                  self._on_lidar, 10)
        self.create_subscription(PointCloud2, '/cam0/cam0/depth/color/points',  self._on_cam0,  10)
        self.create_subscription(PointCloud2, '/cam1/cam1/depth/color/points',  self._on_cam1,  10)

        self.create_timer(1.0 / 15.0, self._fuse_and_publish)

        self._hz_count  = 0
        self._last_log  = self.get_clock().now()

        self.get_logger().info(
            f'sensor_fusion_node started | backend={get_backend()} '
            f'voxel={self.voxel_size}m normals={"on" if self.do_normals else "off"}')

    def _try_transform(self, msg: PointCloud2) -> PointCloud2:
        if self.tf_buffer is None or msg.header.frame_id == self.target_frame:
            return msg
        try:
            tf = self.tf_buffer.lookup_transform(
                self.target_frame, msg.header.frame_id,
                rclpy.time.Time(), timeout=Duration(seconds=0.1))
            import tf2_sensor_msgs as tf2sm
            return tf2sm.do_transform_cloud(msg, tf)
        except Exception as e:
            self.get_logger().warn(
                f'TF {msg.header.frame_id}→{self.target_frame}: {e}',
                throttle_duration_sec=2.0)
            return msg

    def _cam_to_lidar(self, pts: np.ndarray, cam: str) -> np.ndarray:
        """Apply the static camera->lidar transform loaded from yaml.
        pts is (N, 3) in the camera optical frame; returns (N, 3) in
        livox_frame. Bypasses the TF tree so we're robust to the
        /tf_static late-join issue."""
        if pts.shape[0] == 0:
            return pts
        R, t = self._cam_tf[cam]
        return (pts @ R.T + t).astype(np.float32, copy=False)

    def _on_lidar(self, msg: PointCloud2):
        with self._lock:
            self._lidar_msg = msg

    def _on_cam0(self, msg: PointCloud2):
        with self._lock:
            self._cam0_msg = msg

    def _on_cam1(self, msg: PointCloud2):
        with self._lock:
            self._cam1_msg = msg

    def _fuse_and_publish(self):
        with self._lock:
            lidar_msg = self._lidar_msg
            cam0_msg  = self._cam0_msg
            cam1_msg  = self._cam1_msg

        if lidar_msg is None:
            return

        t0 = time.monotonic()

        clouds = [pc2_to_numpy(self._try_transform(lidar_msg))]
        n_lidar = len(clouds[0])
        n_cam0 = n_cam1 = 0
        if cam0_msg is not None:
            c = self._cam_to_lidar(pc2_to_numpy(cam0_msg), 'cam0')
            n_cam0 = len(c)
            clouds.append(c)
        if cam1_msg is not None:
            c = self._cam_to_lidar(pc2_to_numpy(cam1_msg), 'cam1')
            n_cam1 = len(c)
            clouds.append(c)
        self._dbg_counts = (n_lidar, n_cam0, n_cam1)

        merged   = concat_clouds(clouds)
        filtered = range_filter(merged, self.min_range, self.max_range)
        voxeled  = voxel_downsample(filtered, self.voxel_size)

        if self.do_normals and len(voxeled) > 0:
            estimate_normals(voxeled)

        out_msg = numpy_to_pc2(
            voxeled, self.target_frame, self.get_clock().now().to_msg())
        self.fused_pub.publish(out_msg)

        self._hz_count += 1
        now = self.get_clock().now()
        dt  = (now - self._last_log).nanoseconds / 1e9
        if dt >= 1.0:
            ms  = (time.monotonic() - t0) * 1e3
            hz  = self._hz_count / dt
            cams = sum(1 for m in (cam0_msg, cam1_msg) if m is not None)
            counts = getattr(self, '_dbg_counts', (0, 0, 0))
            self.get_logger().info(
                f'Fused cloud: {len(voxeled)} pts at {hz:.1f} Hz | {ms:.1f} ms/frame '
                f'({get_backend()}) cams={cams}/2 '
                f'pre-voxel: lidar={counts[0]} cam0={counts[1]} cam1={counts[2]}')
            self._hz_count = 0
            self._last_log = now


def main(args=None):
    rclpy.init(args=args)
    node = SensorFusionNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
