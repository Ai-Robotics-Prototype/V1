import rclpy
from rclpy.node import Node
from rclpy.time import Duration
import message_filters
from sensor_msgs.msg import PointCloud2
import numpy as np
import time

try:
    import open3d as o3d
    OPEN3D_AVAILABLE = True
except ImportError:
    OPEN3D_AVAILABLE = False

try:
    from tf2_ros import Buffer, TransformListener
    import tf2_sensor_msgs  # noqa: F401 registers the do_transform_cloud function
    TF2_AVAILABLE = True
except ImportError:
    TF2_AVAILABLE = False


class SensorFusionNode(Node):
    def __init__(self):
        super().__init__('sensor_fusion_node')

        self.declare_parameter('voxel_size', 0.025)
        self.declare_parameter('max_range', 5.0)
        self.declare_parameter('min_range', 0.2)
        self.declare_parameter('lidar_frame', 'lidar_link')
        self.declare_parameter('cam0_frame', 'cam0_link')
        self.declare_parameter('cam1_frame', 'cam1_link')
        self.declare_parameter('target_frame', 'base_link')

        self.voxel_size = self.get_parameter('voxel_size').value
        self.max_range = self.get_parameter('max_range').value
        self.min_range = self.get_parameter('min_range').value
        self.target_frame = self.get_parameter('target_frame').value

        if TF2_AVAILABLE:
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
        else:
            self.get_logger().warn('tf2_ros not available — transforms disabled')
            self.tf_buffer = None

        self.fused_pub = self.create_publisher(PointCloud2, '/perception/fused_cloud', 10)

        lidar_sub = message_filters.Subscriber(self, PointCloud2, '/lidar/points')
        cam0_sub = message_filters.Subscriber(self, PointCloud2, '/cam0/depth/points')
        cam1_sub = message_filters.Subscriber(self, PointCloud2, '/cam1/depth/points')

        self.sync = message_filters.ApproximateTimeSynchronizer(
            [lidar_sub, cam0_sub, cam1_sub], queue_size=10, slop=0.05
        )
        self.sync.registerCallback(self.fusion_callback)

        self._msg_count = 0
        self._last_log = self.get_clock().now()
        self._last_hz_time = time.monotonic()
        self._hz_count = 0

        if not OPEN3D_AVAILABLE:
            self.get_logger().warn('open3d not available — voxel downsampling disabled')

        self.get_logger().info('sensor_fusion_node started')

    def _try_transform(self, cloud: PointCloud2, target_frame: str) -> PointCloud2:
        if self.tf_buffer is None:
            return cloud
        try:
            transform = self.tf_buffer.lookup_transform(
                target_frame,
                cloud.header.frame_id,
                rclpy.time.Time(),
                timeout=Duration(seconds=1.0),
            )
            import tf2_sensor_msgs as tf2sm
            return tf2sm.do_transform_cloud(cloud, transform)
        except Exception as e:
            self.get_logger().warn(f'TF unavailable ({cloud.header.frame_id} → {target_frame}): {e}')
            return cloud

    def _pc2_to_o3d(self, msg: PointCloud2):
        import struct
        points = []
        point_step = msg.point_step
        data = bytes(msg.data)
        for i in range(msg.width * msg.height):
            offset = i * point_step
            x, y, z = struct.unpack_from('fff', data, offset)
            if not (x == x and y == y and z == z):
                continue
            points.append([x, y, z])
        pcd = o3d.geometry.PointCloud()
        pcd.points = o3d.utility.Vector3dVector(np.array(points, dtype=np.float32))
        return pcd

    def _o3d_to_pc2(self, pcd, frame_id: str) -> PointCloud2:
        import struct
        from sensor_msgs.msg import PointField
        pts = np.asarray(pcd.points, dtype=np.float32)
        msg = PointCloud2()
        msg.header.frame_id = frame_id
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.height = 1
        msg.width = len(pts)
        msg.fields = [
            PointField(name='x', offset=0, datatype=PointField.FLOAT32, count=1),
            PointField(name='y', offset=4, datatype=PointField.FLOAT32, count=1),
            PointField(name='z', offset=8, datatype=PointField.FLOAT32, count=1),
        ]
        msg.is_bigendian = False
        msg.point_step = 12
        msg.row_step = 12 * len(pts)
        msg.is_dense = True
        data = bytearray(msg.row_step)
        for i, pt in enumerate(pts):
            struct.pack_into('fff', data, i * 12, float(pt[0]), float(pt[1]), float(pt[2]))
        msg.data = bytes(data)
        return msg

    def _concat_and_filter(self, clouds):
        if OPEN3D_AVAILABLE:
            merged_pts = []
            for pcd in clouds:
                pts = np.asarray(pcd.points)
                if len(pts):
                    merged_pts.append(pts)
            if not merged_pts:
                return o3d.geometry.PointCloud()
            all_pts = np.vstack(merged_pts)
            mask = (all_pts[:, 2] >= self.min_range) & (all_pts[:, 2] <= self.max_range)
            filtered = all_pts[mask]
            combined = o3d.geometry.PointCloud()
            combined.points = o3d.utility.Vector3dVector(filtered)
            return combined.voxel_down_sample(self.voxel_size)
        return clouds[0] if clouds else None

    def fusion_callback(self, lidar_msg: PointCloud2, cam0_msg: PointCloud2, cam1_msg: PointCloud2):
        lidar_t = self._try_transform(lidar_msg, self.target_frame)
        cam0_t = self._try_transform(cam0_msg, self.target_frame)
        cam1_t = self._try_transform(cam1_msg, self.target_frame)

        if OPEN3D_AVAILABLE:
            pcd_lidar = self._pc2_to_o3d(lidar_t)
            pcd_cam0 = self._pc2_to_o3d(cam0_t)
            pcd_cam1 = self._pc2_to_o3d(cam1_t)
            fused = self._concat_and_filter([pcd_lidar, pcd_cam0, pcd_cam1])
            out_msg = self._o3d_to_pc2(fused, self.target_frame)
            n_points = len(np.asarray(fused.points))
        else:
            out_msg = lidar_t
            out_msg.header.stamp = self.get_clock().now().to_msg()
            n_points = lidar_msg.width * lidar_msg.height

        self.fused_pub.publish(out_msg)
        self._hz_count += 1

        now = self.get_clock().now()
        dt = (now - self._last_log).nanoseconds / 1e9
        if dt >= 1.0:
            hz = self._hz_count / dt
            self.get_logger().info(f'Fused cloud: {n_points} points at {hz:.1f} Hz')
            self._last_log = now
            self._hz_count = 0


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
