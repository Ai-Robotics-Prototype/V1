import json
import rclpy
from rclpy.node import Node
from std_msgs.msg import Float32, String, Bool
from std_srvs.srv import Trigger
from sensor_msgs.msg import JointState


class SafetyMonitorNode(Node):
    def __init__(self):
        super().__init__('safety_monitor_node')

        self.declare_parameter('watchdog_timeout_s', 1.0)
        self.declare_parameter('estop_latch', True)
        self.declare_parameter('speed_green', 1.0)
        self.declare_parameter('speed_yellow', 0.25)
        self.declare_parameter('speed_red', 0.0)
        self.declare_parameter('zone_green_m', 1.2)
        self.declare_parameter('zone_yellow_m', 0.6)
        self.declare_parameter('zone_red_m', 0.3)

        self.watchdog_timeout = self.get_parameter('watchdog_timeout_s').value
        self.estop_latch_enabled = self.get_parameter('estop_latch').value
        self.speed_green = self.get_parameter('speed_green').value
        self.speed_yellow = self.get_parameter('speed_yellow').value
        self.speed_red = self.get_parameter('speed_red').value

        self._proximity = 5.0
        self._zone = 'GREEN'
        self._estop = True
        self._latched = False
        self._watchdog_ok = False
        self._green_since = None
        self._last_proximity_time = None
        self._start_time = self.get_clock().now()
        self._uptime_start = self._start_time

        self._green_hold_required = 2.0

        self.speed_pub = self.create_publisher(Float32, '/safety/speed_scale', 10)
        self.estop_pub = self.create_publisher(Bool, '/safety/estop', 10)
        self.status_pub = self.create_publisher(String, '/safety/status', 10)

        self.create_subscription(Float32, '/safety/human_proximity', self._proximity_cb, 10)
        self.create_subscription(String, '/safety/zone', self._zone_cb, 10)
        self.create_subscription(JointState, '/joint_states', self._joint_cb, 10)

        self.create_service(Trigger, '/safety/reset_estop', self._reset_estop_cb)

        self.create_timer(0.02, self._control_loop)
        self.create_timer(0.1, self._publish_status)

        self.get_logger().info('Safety monitor warming up — ESTOP held')

    def _proximity_cb(self, msg: Float32):
        self._proximity = msg.data
        self._last_proximity_time = self.get_clock().now()
        self._watchdog_ok = True
        self._update_zone_from_proximity()

    def _update_zone_from_proximity(self):
        d = self._proximity
        zone_green = self.get_parameter('zone_green_m').value
        zone_yellow = self.get_parameter('zone_yellow_m').value
        if d > zone_green:
            self._zone = 'GREEN'
        elif d > zone_yellow:
            self._zone = 'YELLOW'
        else:
            self._zone = 'RED'

    def _zone_cb(self, msg: String):
        self._zone = msg.data

    def _joint_cb(self, msg: JointState):
        pass

    def _control_loop(self):
        now = self.get_clock().now()
        uptime = (now - self._uptime_start).nanoseconds / 1e9

        # Startup hold: 3 seconds
        startup_elapsed = (now - self._start_time).nanoseconds / 1e9
        if startup_elapsed < 3.0:
            self._estop = True
            self._publish_outputs()
            return

        # Watchdog check
        if self._last_proximity_time is None:
            self._watchdog_ok = False
            self._estop = True
            self.get_logger().warn('WATCHDOG: proximity timeout — ESTOP triggered', throttle_duration_sec=5.0)
            self._publish_outputs()
            return

        watchdog_elapsed = (now - self._last_proximity_time).nanoseconds / 1e9
        if watchdog_elapsed > self.watchdog_timeout:
            self._watchdog_ok = False
            self._estop = True
            self.get_logger().warn('WATCHDOG: proximity timeout — ESTOP triggered', throttle_duration_sec=5.0)
            self._publish_outputs()
            return

        self._watchdog_ok = True

        # Zone logic
        if self._zone == 'RED':
            self._estop = True
            if self.estop_latch_enabled:
                self._latched = True
            self._green_since = None
        elif self._zone == 'GREEN':
            if not self._latched:
                self._estop = False
            else:
                if self._green_since is None:
                    self._green_since = now
                green_elapsed = (now - self._green_since).nanoseconds / 1e9
                if green_elapsed >= self._green_hold_required:
                    pass  # Still latched until manual reset
        elif self._zone == 'YELLOW':
            if not self._latched:
                self._estop = False
            self._green_since = None

        self._publish_outputs()

    def _publish_outputs(self):
        now = self.get_clock().now()
        uptime = (now - self._uptime_start).nanoseconds / 1e9

        if self._estop:
            speed = self.speed_red
        elif self._zone == 'YELLOW':
            speed = self.speed_yellow
        else:
            speed = self.speed_green

        s_msg = Float32()
        s_msg.data = float(speed)
        self.speed_pub.publish(s_msg)

        e_msg = Bool()
        e_msg.data = bool(self._estop)
        self.estop_pub.publish(e_msg)

    def _publish_status(self):
        now = self.get_clock().now()
        uptime = (now - self._uptime_start).nanoseconds / 1e9

        if self._estop:
            speed = self.speed_red
        elif self._zone == 'YELLOW':
            speed = self.speed_yellow
        else:
            speed = self.speed_green

        status = {
            'zone': self._zone,
            'proximity_m': round(self._proximity, 3),
            'speed_scale': round(speed, 3),
            'estop': bool(self._estop),
            'latched': bool(self._latched),
            'watchdog_ok': bool(self._watchdog_ok),
            'uptime_s': round(uptime, 1),
        }
        msg = String()
        msg.data = json.dumps(status)
        self.status_pub.publish(msg)

    def _reset_estop_cb(self, request, response):
        if self._zone != 'GREEN':
            response.success = False
            response.message = f'Cannot reset: zone is {self._zone}, must be GREEN'
            return response
        self._latched = False
        self._estop = False
        self._green_since = None
        response.success = True
        response.message = 'ESTOP latch cleared'
        self.get_logger().info('ESTOP latch cleared by service call')
        return response


def main(args=None):
    rclpy.init(args=args)
    node = SafetyMonitorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
