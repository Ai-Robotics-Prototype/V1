import math
import rclpy
from rclpy.node import Node
from rclpy.time import Duration
from std_msgs.msg import Float32, String
from sensor_msgs.msg import Image, JointState
from visualization_msgs.msg import MarkerArray, Marker
from geometry_msgs.msg import Point
import message_filters

try:
    from cv_bridge import CvBridge
    CV_BRIDGE_AVAILABLE = True
except ImportError:
    CV_BRIDGE_AVAILABLE = False

try:
    import mediapipe as mp
    MP_AVAILABLE = True
except ImportError:
    MP_AVAILABLE = False

try:
    from tf2_ros import Buffer, TransformListener
    TF2_AVAILABLE = True
except ImportError:
    TF2_AVAILABLE = False


class HumanSafetyNode(Node):
    def __init__(self):
        super().__init__('human_safety_node')

        self.declare_parameter('zone_green_m', 1.2)
        self.declare_parameter('zone_yellow_m', 0.6)
        self.declare_parameter('zone_red_m', 0.3)
        self.declare_parameter('skeleton_model', 'mediapipe')
        self.declare_parameter('tcp_frame', 'tool0')
        self.declare_parameter('publish_rate_hz', 50.0)
        self.declare_parameter('no_detection_safe_distance', 5.0)

        self.zone_green = self.get_parameter('zone_green_m').value
        self.zone_yellow = self.get_parameter('zone_yellow_m').value
        self.zone_red = self.get_parameter('zone_red_m').value
        self.tcp_frame = self.get_parameter('tcp_frame').value
        self.no_det_dist = self.get_parameter('no_detection_safe_distance').value
        rate = self.get_parameter('publish_rate_hz').value

        if TF2_AVAILABLE:
            self.tf_buffer = Buffer()
            self.tf_listener = TransformListener(self.tf_buffer, self)
        else:
            self.tf_buffer = None

        self.bridge = CvBridge() if CV_BRIDGE_AVAILABLE else None

        if MP_AVAILABLE:
            self.pose_cam0 = mp.solutions.pose.Pose(
                static_image_mode=False, min_detection_confidence=0.5)
            self.pose_cam1 = mp.solutions.pose.Pose(
                static_image_mode=False, min_detection_confidence=0.5)
        else:
            self.get_logger().warn('mediapipe not available — skeleton detection disabled')
            self.pose_cam0 = None
            self.pose_cam1 = None

        self.proximity_pub = self.create_publisher(Float32, '/safety/human_proximity', 10)
        self.zone_pub = self.create_publisher(String, '/safety/zone', 10)
        self.marker_pub = self.create_publisher(MarkerArray, '/safety/skeleton_markers', 10)

        if CV_BRIDGE_AVAILABLE:
            cam0_sub = message_filters.Subscriber(self, Image, '/cam0/cam0/color/image_raw')
            cam1_sub = message_filters.Subscriber(self, Image, '/cam1/cam1/color/image_raw')
            self.sync = message_filters.ApproximateTimeSynchronizer(
                [cam0_sub, cam1_sub], queue_size=5, slop=0.1)
            self.sync.registerCallback(self.image_callback)
        else:
            self.get_logger().warn('cv_bridge not available — image processing disabled')

        self.create_subscription(JointState, '/joint_states', self._joint_cb, 10)

        self._current_proximity = self.no_det_dist
        self._last_detection_time = self.get_clock().now()
        self._no_detect_timeout = 0.5

        self.create_timer(1.0 / rate, self._publish_proximity)
        self.create_timer(0.1, self._publish_zone)
        self.create_timer(0.1, self._publish_markers)

        self._last_keypoints: list = []
        self._last_log = self.get_clock().now()
        self.get_logger().info('human_safety_node started')

    def _joint_cb(self, msg: JointState):
        pass

    def _get_tcp_position(self):
        if self.tf_buffer is None:
            return (0.0, 0.0, 0.5)
        try:
            t = self.tf_buffer.lookup_transform(
                'base_link', self.tcp_frame,
                rclpy.time.Time(), timeout=Duration(seconds=0.1))
            tx = t.transform.translation
            return (tx.x, tx.y, tx.z)
        except Exception:
            return (0.0, 0.0, 0.5)

    def image_callback(self, cam0_msg: Image, cam1_msg: Image):
        if not MP_AVAILABLE or self.bridge is None:
            return

        min_dist = self.no_det_dist
        all_keypoints = []

        for msg, pose_solver in [(cam0_msg, self.pose_cam0), (cam1_msg, self.pose_cam1)]:
            try:
                img = self.bridge.imgmsg_to_cv2(msg, 'rgb8')
            except Exception as e:
                self.get_logger().warn(f'cv_bridge error: {e}')
                continue

            results = pose_solver.process(img)
            if results.pose_landmarks is None:
                continue

            h, w = img.shape[:2]
            tcp_pos = self._get_tcp_position()

            for lm in results.pose_landmarks.landmark:
                px = lm.x * w
                py = lm.y * h
                # Estimate depth from landmark visibility; use a heuristic scale
                est_depth = 1.0 / max(lm.visibility, 0.1)
                kp_x = (px - w / 2) * est_depth / 500.0
                kp_y = (py - h / 2) * est_depth / 500.0
                kp_z = est_depth
                d = math.sqrt(
                    (kp_x - tcp_pos[0]) ** 2 +
                    (kp_y - tcp_pos[1]) ** 2 +
                    (kp_z - tcp_pos[2]) ** 2)
                if d < min_dist:
                    min_dist = d
                all_keypoints.append((kp_x, kp_y, kp_z))

        if all_keypoints:
            self._current_proximity = min_dist
            self._last_detection_time = self.get_clock().now()
            self._last_keypoints = all_keypoints

    def _publish_proximity(self):
        elapsed = (self.get_clock().now() - self._last_detection_time).nanoseconds / 1e9
        if elapsed > self._no_detect_timeout:
            self._current_proximity = self.no_det_dist

        msg = Float32()
        msg.data = float(self._current_proximity)
        self.proximity_pub.publish(msg)

    def _publish_zone(self):
        d = self._current_proximity
        if d > self.zone_green:
            zone = 'GREEN'
        elif d > self.zone_yellow:
            zone = 'YELLOW'
        else:
            zone = 'RED'
        msg = String()
        msg.data = zone
        self.zone_pub.publish(msg)

        now = self.get_clock().now()
        dt = (now - self._last_log).nanoseconds / 1e9
        if dt >= 1.0:
            self.get_logger().info(f'Zone: {zone}, proximity: {d:.2f}m')
            self._last_log = now

    def _publish_markers(self):
        if not self._last_keypoints:
            return
        ma = MarkerArray()
        for i, (x, y, z) in enumerate(self._last_keypoints):
            m = Marker()
            m.header.frame_id = 'cam0_link'
            m.header.stamp = self.get_clock().now().to_msg()
            m.ns = 'skeleton'
            m.id = i
            m.type = Marker.SPHERE
            m.action = Marker.ADD
            m.pose.position = Point(x=x, y=y, z=z)
            m.scale.x = m.scale.y = m.scale.z = 0.05
            m.color.r = 0.0
            m.color.g = 1.0
            m.color.b = 0.0
            m.color.a = 0.8
            m.lifetime.sec = 1
            ma.markers.append(m)
        self.marker_pub.publish(ma)


def main(args=None):
    rclpy.init(args=args)
    node = HumanSafetyNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
