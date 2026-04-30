import struct
import time
import rclpy
from rclpy.node import Node
from rclpy.time import Duration
import message_filters
from sensor_msgs.msg import PointCloud2, PointField
import numpy as np

from perception_fusion.cuda_fusion import (
    concat_clouds, range_filter, voxel_downsample,
    estimate_normals, get_backend, CUPY_AVAILABLE,
)

try:
    from tf2_ros import Buffer, TransformListener
    import tf2_sensor_msgs  # noqa: F401
    TF2_AVAILABLE = True
except ImportError:
    TF2_AVAILABLE = False


# ── PointCloud2 ↔ numpy helpers ───────────────────────────────────────────────

def pc2_to_numpy(msg: PointCloud2) -> np.ndarray:
    """Extract XYZ(+intensity) into (N,3) or (N,4) float32 array."""
    n = msg.width * msg.height
    if n == 0:
        return np.zeros((0, 3), dtype=np.float32)

    fields = {f.name: f for f in msg.fields}
    has_i  = 'intensity' in fields
    cols   = 4 if has_i else 3
    pts    = np.frombuffer(bytes(msg.data), dtype=np.uint8)

    step   = msg.point_step
    off_x  = fields['x'].offset
    off_y  = fields['y'].offset
    off_z  = fields['z'].offset
    off_i  = fields['intensity'].offset if has_i else 0

    out = np.empty((n, cols), dtype=np.float32)
    raw = np.frombuffer(bytes(msg.data), dtype=np.uint8).reshape(n, step)

    out[:, 0] = np.frombuffer(raw[:, off_x:off_x+4].tobytes(), dtype=np.float32)
    out[:, 1] = np.frombuffer(raw[:, off_y:off_y+4].tobytes(), dtype=np.float32)
    out[:, 2] = np.frombuffer(raw[:, off_z:off_z+4].tobytes(), dtype=np.float32)
    if has_i:
        out[:, 3] = np.frombuffer(raw[:, off_i:off_i+4].tobytes(), dtype=np.float32)

    # Drop NaN/Inf
    mask = np.isfinite(out[:, :3]).all(axis=1)
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

        self.fused_pub = self.create_publisher(PointCloud2, '/perception/fused_cloud', 10)

        lidar_sub = message_filters.Subscriber(self, PointCloud2, '/lidar/points')
        cam0_sub  = message_filters.Subscriber(self, PointCloud2, '/cam0/depth/points')
        cam1_sub  = message_filters.Subscriber(self, PointCloud2, '/cam1/depth/points')

        self.sync = message_filters.ApproximateTimeSynchronizer(
            [lidar_sub, cam0_sub, cam1_sub], queue_size=10, slop=0.05)
        self.sync.registerCallback(self.fusion_callback)

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

    def fusion_callback(self, lidar_msg, cam0_msg, cam1_msg):
        t0 = time.monotonic()

        lidar_t = self._try_transform(lidar_msg)
        cam0_t  = self._try_transform(cam0_msg)
        cam1_t  = self._try_transform(cam1_msg)

        pts_lidar = pc2_to_numpy(lidar_t)
        pts_cam0  = pc2_to_numpy(cam0_t)
        pts_cam1  = pc2_to_numpy(cam1_t)

        # GPU concat → range filter → voxel downsample
        merged   = concat_clouds([pts_lidar, pts_cam0, pts_cam1])
        filtered = range_filter(merged, self.min_range, self.max_range)
        voxeled  = voxel_downsample(filtered, self.voxel_size)

        if self.do_normals and len(voxeled) > 0:
            estimate_normals(voxeled)  # result discarded here; wire to pub if needed

        out_msg = numpy_to_pc2(
            voxeled, self.target_frame, self.get_clock().now().to_msg())
        self.fused_pub.publish(out_msg)

        self._hz_count += 1
        now = self.get_clock().now()
        dt  = (now - self._last_log).nanoseconds / 1e9
        if dt >= 1.0:
            ms  = (time.monotonic() - t0) * 1e3
            hz  = self._hz_count / dt
            self.get_logger().info(
                f'Fused cloud: {len(voxeled)} pts at {hz:.1f} Hz | {ms:.1f} ms/frame '
                f'({get_backend()})')
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
