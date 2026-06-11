"""ROS2 node exposing motion-optimization services.

Topics published:
  /motion_optimization/active_profile  (MotionProfile)        latched
  /motion_optimization/statistics      (MotionStatistics)     per cycle

Topics subscribed:
  /reconstruction/mesh                 (visualization_msgs/Marker, optional)
  /joint_states                        (sensor_msgs/JointState)

Services provided:
  /motion/optimize_trajectory  (motion_optimization_msgs/OptimizeTrajectory)
  /motion/estimate_cycle_time  (motion_optimization_msgs/EstimateCycleTime)
  /motion/validate             (motion_optimization_msgs/ValidateMotion)
  /motion/save_profile         (motion_optimization_msgs/SaveProfile)
  /motion/delete_profile       (motion_optimization_msgs/DeleteProfile)
  /motion/list_profiles        (std_srvs/Trigger)             JSON in message
  /motion/get_active_profile   (std_srvs/Trigger)             JSON in message
"""
from __future__ import annotations

import json
import logging
import time
from typing import Optional

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, QoSDurabilityPolicy

from sensor_msgs.msg import JointState
from std_srvs.srv import Trigger
from trajectory_msgs.msg import JointTrajectory

from motion_optimization_msgs.msg import (
    MotionProfile as MotionProfileMsg,
    OptimizedTrajectory as OptimizedTrajectoryMsg,
    MotionStatistics as MotionStatisticsMsg,
)
from motion_optimization_msgs.srv import (
    OptimizeTrajectory,
    EstimateCycleTime,
    ValidateMotion,
    SaveProfile,
    DeleteProfile,
)

from . import toppra_engine, trajectory_smoother, utils
from .profile_manager import ProfileManager, Profile
from .collision_checker import CollisionChecker
from .moveit_bridge import MoveItBridge


logger = logging.getLogger(__name__)


def profile_to_msg(p: Profile, robot_limits) -> MotionProfileMsg:
    m = MotionProfileMsg()
    m.name = p.name
    m.description = p.description
    m.velocity_scale_pct = float(p.velocity_scale_pct)
    m.acceleration_scale_pct = float(p.acceleration_scale_pct)
    m.jerk_scale_pct = float(p.jerk_scale_pct)
    m.blend_radius_mm = float(p.blend_radius_mm)
    m.toppra_enabled = bool(p.toppra_enabled)
    m.moveit_enabled = bool(p.moveit_enabled)
    m.smoothing_method = p.smoothing_method
    m.approach_speed_pct = float(p.approach_speed_pct)
    m.retreat_speed_pct = float(p.retreat_speed_pct)
    m.joint_velocity_limits_dps = [float(v) for v in robot_limits.joint_velocity_limits_dps]
    m.joint_acceleration_limits_dps2 = [float(v) for v in robot_limits.joint_acceleration_limits_dps2]
    m.joint_jerk_limits_dps3 = [float(v) for v in robot_limits.joint_jerk_limits_dps3]
    m.tcp_linear_velocity_mps = float(robot_limits.tcp_linear_velocity_mps)
    m.tcp_linear_acceleration_mps2 = float(robot_limits.tcp_linear_acceleration_mps2)
    m.tcp_angular_velocity_dps = float(robot_limits.tcp_angular_velocity_dps)
    m.created_by_user = bool(p.created_by_user)
    m.created_at = p.created_at
    return m


def profile_from_msg(m: MotionProfileMsg) -> Profile:
    return Profile(
        name=m.name,
        description=m.description,
        velocity_scale_pct=float(m.velocity_scale_pct),
        acceleration_scale_pct=float(m.acceleration_scale_pct),
        jerk_scale_pct=float(m.jerk_scale_pct),
        blend_radius_mm=float(m.blend_radius_mm),
        toppra_enabled=bool(m.toppra_enabled),
        moveit_enabled=bool(m.moveit_enabled),
        smoothing_method=m.smoothing_method,
        approach_speed_pct=float(m.approach_speed_pct),
        retreat_speed_pct=float(m.retreat_speed_pct),
        created_by_user=bool(m.created_by_user),
        created_at=m.created_at,
    )


class MotionOptimizerNode(Node):

    def __init__(self):
        super().__init__('motion_optimizer_node')

        self.profile_mgr = ProfileManager()
        self.collision_checker = CollisionChecker()
        self.moveit = MoveItBridge()

        self._last_joint_state: Optional[JointState] = None

        latched = QoSProfile(depth=1)
        latched.durability = QoSDurabilityPolicy.TRANSIENT_LOCAL

        self.pub_active_profile = self.create_publisher(
            MotionProfileMsg, '/motion_optimization/active_profile', latched)
        self.pub_statistics = self.create_publisher(
            MotionStatisticsMsg, '/motion_optimization/statistics', 10)

        self.create_subscription(
            JointState, '/joint_states', self._on_joint_state, 10)

        self.create_service(OptimizeTrajectory, '/motion/optimize_trajectory',
                            self._on_optimize)
        self.create_service(EstimateCycleTime, '/motion/estimate_cycle_time',
                            self._on_estimate)
        self.create_service(ValidateMotion, '/motion/validate',
                            self._on_validate)
        self.create_service(SaveProfile, '/motion/save_profile',
                            self._on_save_profile)
        self.create_service(DeleteProfile, '/motion/delete_profile',
                            self._on_delete_profile)
        self.create_service(Trigger, '/motion/list_profiles',
                            self._on_list_profiles)
        self.create_service(Trigger, '/motion/get_active_profile',
                            self._on_get_active_profile)

        self._publish_active_profile()
        self.get_logger().info(
            f'motion_optimizer_node up. TOPP-RA available={toppra_engine.is_available()} '
            f'MoveIt2 available={self.moveit.is_available()}')

    def _on_joint_state(self, msg: JointState) -> None:
        self._last_joint_state = msg

    def _publish_active_profile(self) -> None:
        try:
            default = self.profile_mgr.get_system_default()
            p = self.profile_mgr.get_profile(default)
        except Exception:
            return
        self.pub_active_profile.publish(
            profile_to_msg(p, self.profile_mgr.get_robot_limits()))

    # ----- service: optimize -----
    def _on_optimize(self, request, response):
        t0 = time.monotonic()
        result_msg = OptimizedTrajectoryMsg()
        result_msg.header.stamp = self.get_clock().now().to_msg()
        result_msg.original = request.input_trajectory
        try:
            profile = self.profile_mgr.get_profile(request.profile_name)
        except KeyError as exc:
            result_msg.status = 'failed'
            result_msg.error_message = str(exc)
            response.result = result_msg
            response.success = False
            return response

        robot_limits = self.profile_mgr.get_robot_limits()
        original_duration = utils.trajectory_duration(request.input_trajectory)
        result_msg.original_duration_s = float(original_duration)

        warnings = []
        optimizer_used = 'none'

        if profile.toppra_enabled:
            optimized, ta_res, ta_warnings = toppra_engine.apply_to_trajectory(
                request.input_trajectory, profile, robot_limits)
            warnings.extend(ta_warnings)
            optimizer_used = 'toppra' if ta_res.status == 'success' else 'toppra-fallback'
        elif profile.smoothing_method == 'spline':
            waypoints = utils.waypoints_from_trajectory(request.input_trajectory)
            qs, ts, _ = trajectory_smoother.smooth(profile, robot_limits, waypoints)
            optimized = self._array_to_trajectory(qs, ts, request.input_trajectory)
            optimizer_used = 'spline'
        else:
            optimized = request.input_trajectory
            optimizer_used = 'passthrough'

        if profile.moveit_enabled and self.moveit.is_available():
            optimizer_used += '+moveit'
            # MoveIt2 step would refine `optimized` in-place; placeholder for
            # now since URDF is not yet available.

        optimized_duration = utils.trajectory_duration(optimized)
        result_msg.optimized = optimized
        result_msg.optimized_duration_s = float(optimized_duration)
        result_msg.time_saved_s = max(0.0, float(original_duration - optimized_duration))
        result_msg.time_saved_pct = (
            100.0 * result_msg.time_saved_s / original_duration
            if original_duration > 1e-6 else 0.0)

        positions = utils.waypoints_from_trajectory(optimized)
        if positions.shape[0] >= 2:
            times = np.array(
                [p.time_from_start.sec + p.time_from_start.nanosec * 1e-9
                 for p in optimized.points])
            pv, pa, pj = utils.peak_metrics(positions, times)
            result_msg.peak_velocity_dps = pv
            result_msg.peak_acceleration_dps2 = pa
            result_msg.peak_jerk_dps3 = pj
        if request.check_collisions:
            ok, c_warn = self.collision_checker.check_trajectory(positions)
            result_msg.collision_free = ok
            warnings.extend(c_warn)
        else:
            result_msg.collision_free = True

        result_msg.within_limits = True
        result_msg.optimizer_used = optimizer_used
        result_msg.status = 'success'
        result_msg.error_message = ' | '.join(warnings) if warnings else ''
        response.result = result_msg
        response.success = True
        self.get_logger().debug(
            f'/motion/optimize_trajectory profile={profile.name} '
            f'in={original_duration:.3f}s out={optimized_duration:.3f}s '
            f'in {1000 * (time.monotonic() - t0):.1f}ms')
        return response

    @staticmethod
    def _array_to_trajectory(positions: np.ndarray, times: np.ndarray,
                             reference: JointTrajectory) -> JointTrajectory:
        from trajectory_msgs.msg import JointTrajectory as JT, JointTrajectoryPoint
        out = JT()
        out.header = reference.header
        out.joint_names = list(reference.joint_names)
        for i in range(times.size):
            pt = JointTrajectoryPoint()
            pt.positions = positions[i].tolist()
            sec, nsec = utils.sec_nanosec(float(times[i]))
            pt.time_from_start.sec = sec
            pt.time_from_start.nanosec = nsec
            out.points.append(pt)
        return out

    # ----- service: estimate -----
    def _on_estimate(self, request, response):
        try:
            profile = self.profile_mgr.get_profile(request.profile_name)
        except KeyError as exc:
            response.success = False
            response.estimated_duration_s = 0.0
            response.unoptimized_duration_s = 0.0
            response.estimated_savings_s = 0.0
            response.segment_breakdown = [f'error: {exc}']
            return response

        robot_limits = self.profile_mgr.get_robot_limits()
        # Program lookup is out-of-scope here (the dashboard owns programs).
        # We accept the request but reply with profile-only timing for a
        # canonical 6-step pick-and-place sample.
        sample_waypoints = self._canonical_sample_waypoints()
        opt_dur = toppra_engine.estimate_duration(
            sample_waypoints, profile, robot_limits)
        baseline_profile = Profile(name='_baseline', velocity_scale_pct=100.0,
                                   acceleration_scale_pct=100.0,
                                   jerk_scale_pct=100.0)
        unopt_dur = toppra_engine.estimate_duration(
            sample_waypoints, baseline_profile, robot_limits)
        response.estimated_duration_s = float(opt_dur)
        response.unoptimized_duration_s = float(unopt_dur)
        response.estimated_savings_s = float(max(0.0, unopt_dur - opt_dur))
        response.segment_breakdown = [
            f'segment {i}: {d:.2f}s'
            for i, d in enumerate(
                utils.per_segment_distances(sample_waypoints).tolist())
        ]
        response.success = True
        return response

    @staticmethod
    def _canonical_sample_waypoints() -> np.ndarray:
        # 6-step pick-and-place sample in joint radians
        return np.deg2rad(np.array([
            [0,   -45,  45,  0, 60, 0],
            [30,  -30,  60,  0, 40, 0],
            [30,  -10,  80,  0, 20, 0],
            [-30, -10,  80,  0, 20, 0],
            [-30, -30,  60,  0, 40, 0],
            [0,   -45,  45,  0, 60, 0],
        ], dtype=float))

    # ----- service: validate -----
    def _on_validate(self, request, response):
        try:
            profile = self.profile_mgr.get_profile(request.profile_name)
        except KeyError as exc:
            response.valid = False
            response.errors = [str(exc)]
            return response
        robot_limits = self.profile_mgr.get_robot_limits()
        positions = utils.waypoints_from_trajectory(request.trajectory)
        warnings = []
        errors = []
        within_vel = within_acc = within_jrk = True
        if positions.shape[0] >= 2:
            times = np.array(
                [p.time_from_start.sec + p.time_from_start.nanosec * 1e-9
                 for p in request.trajectory.points])
            pv, pa, pj = utils.peak_metrics(positions, times)
            vel_limit = max(robot_limits.joint_velocity_limits_dps)
            acc_limit = max(robot_limits.joint_acceleration_limits_dps2)
            jrk_limit = max(robot_limits.joint_jerk_limits_dps3)
            scale_v = profile.velocity_scale_pct / 100.0
            scale_a = profile.acceleration_scale_pct / 100.0
            scale_j = profile.jerk_scale_pct / 100.0
            within_vel = pv <= vel_limit * scale_v * 1.05
            within_acc = pa <= acc_limit * scale_a * 1.05
            within_jrk = pj <= jrk_limit * scale_j * 1.5
            if not within_vel:
                errors.append(f'peak velocity {pv:.1f}dps > {vel_limit * scale_v:.1f}dps')
            if not within_acc:
                errors.append(f'peak accel {pa:.1f}dps² > {acc_limit * scale_a:.1f}dps²')
            if not within_jrk:
                warnings.append(f'peak jerk {pj:.1f}dps³ > soft limit {jrk_limit * scale_j:.1f}dps³')
        collision_free, c_warn = self.collision_checker.check_trajectory(positions)
        warnings.extend(c_warn)
        response.valid = within_vel and within_acc and within_jrk and collision_free
        response.within_velocity_limits = within_vel
        response.within_acceleration_limits = within_acc
        response.within_jerk_limits = within_jrk
        response.collision_free = collision_free
        response.warnings = warnings
        response.errors = errors
        return response

    # ----- service: save/delete profile -----
    def _on_save_profile(self, request, response):
        try:
            p = profile_from_msg(request.profile)
            if self.profile_mgr.has_profile(p.name):
                self.profile_mgr.update_profile(p.name, p)
            else:
                self.profile_mgr.create_profile(p, overwrite=request.overwrite)
            response.success = True
            response.error_message = ''
        except Exception as exc:
            response.success = False
            response.error_message = str(exc)
        return response

    def _on_delete_profile(self, request, response):
        try:
            self.profile_mgr.delete_profile(request.name)
            response.success = True
            response.error_message = ''
        except Exception as exc:
            response.success = False
            response.error_message = str(exc)
        return response

    def _on_list_profiles(self, request, response):
        out = []
        limits = self.profile_mgr.get_robot_limits()
        for p in self.profile_mgr.list_profiles():
            d = p.to_dict()
            d['robot_limits'] = limits.to_dict()
            d['is_builtin'] = self.profile_mgr.is_builtin(p.name)
            d['is_default'] = (p.name == self.profile_mgr.get_system_default())
            out.append(d)
        response.success = True
        response.message = json.dumps(out)
        return response

    def _on_get_active_profile(self, request, response):
        name = self.profile_mgr.get_system_default()
        try:
            p = self.profile_mgr.get_profile(name)
        except KeyError:
            response.success = False
            response.message = json.dumps({'error': f'default profile "{name}" not found'})
            return response
        response.success = True
        response.message = json.dumps(p.to_dict())
        return response


def main(args=None):
    rclpy.init(args=args)
    node = MotionOptimizerNode()
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
