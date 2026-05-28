#!/usr/bin/env python3
"""Single-shot AprilTag extrinsic calibration for cam0 + cam1.

Operator workflow:
    1. Print /opt/cobot/calibration/apriltag_36h11_id0.png at 100% scale
       and tape it to a flat surface in view of BOTH cameras.
    2. Run: ros2 launch cobot_bringup calibrate.launch.py
       (or invoke this script directly with cameras already up).
    3. The script averages ~30 frames per camera, then writes
       /opt/cobot/calibration/extrinsics.yaml and exits.

The tag is treated as the workspace origin: its centre is (0,0,0) and its
axes are the workspace axes (x right, y up, z out of the tag face). The
script publishes nothing — a separate tf_broadcaster.py reads the YAML on
startup and broadcasts static TFs.

Defaults assume tag36h11 ID 0 at 0.10 m edge length (matches the
generated PNG when printed at 100% on a normal printer); override with
--tag-id / --tag-size if needed.
"""
import argparse
import os
import sys
import time

import numpy as np
import rclpy
import yaml
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from scipy.spatial.transform import Rotation as R
from sensor_msgs.msg import CameraInfo, Image


# --- AprilTag detector ------------------------------------------------------
# We use dt-apriltags (works on aarch64). pupil-apriltags's wheel build
# fails on this Jetson, and the official `apriltag` package's pose
# estimator is brittle for our case.
try:
    from dt_apriltags import Detector as _ATDetector
except ImportError:
    _ATDetector = None


CAL_DIR    = "/opt/cobot/calibration"
OUT_PATH   = os.path.join(CAL_DIR, "extrinsics.yaml")
DEFAULT_ID = 0
DEFAULT_SIZE_M = 0.10
DEFAULT_FRAMES = 30


def _rgb_image_to_gray(msg) -> np.ndarray:
    """Decode sensor_msgs/Image to a HxW uint8 grayscale numpy array."""
    raw = bytes(msg.data)
    n = msg.width * msg.height * 3
    if msg.encoding == "mono8":
        return np.frombuffer(raw, np.uint8)[:msg.width * msg.height] \
                 .reshape(msg.height, msg.width)
    if msg.encoding == "rgb8":
        arr = np.frombuffer(raw, np.uint8)[:n].reshape(msg.height, msg.width, 3)
    elif msg.encoding == "bgr8":
        arr = np.frombuffer(raw, np.uint8)[:n].reshape(msg.height, msg.width, 3)[:, :, ::-1]
    else:
        raise ValueError(f"unsupported encoding {msg.encoding!r}")
    return (0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1]
            + 0.114 * arr[:, :, 2]).astype(np.uint8)


def _avg_pose(R_list, t_list):
    """Average rotations via quaternion mean (Markley's eigendecomposition)
    and translations by simple arithmetic mean. Inputs are lists of 3x3
    and 3-vectors. Returns (R, t)."""
    qs = np.array([R.from_matrix(Rm).as_quat() for Rm in R_list])  # xyzw
    # Force consistent hemisphere — flip any q with negative dot product
    # against the first.
    flips = np.sign((qs @ qs[0])).reshape(-1, 1)
    flips[flips == 0] = 1
    qs = qs * flips
    M = (qs.T @ qs) / len(qs)
    evals, evecs = np.linalg.eigh(M)
    q_mean = evecs[:, -1]                       # largest-eigenvalue eigenvector
    q_mean = q_mean / np.linalg.norm(q_mean)
    Rm_mean = R.from_quat(q_mean).as_matrix()
    t_mean = np.mean(np.array(t_list), axis=0)
    return Rm_mean, t_mean


def _Rt_to_quat_trans(Rm: np.ndarray, t: np.ndarray):
    q = R.from_matrix(Rm).as_quat()              # xyzw
    return {
        "translation": [float(x) for x in t.tolist()],
        "rotation":    [float(x) for x in q.tolist()],  # qx, qy, qz, qw
    }


def _T_inverse(Rm: np.ndarray, t: np.ndarray):
    Ri = Rm.T
    ti = -Ri @ t
    return Ri, ti


class CalibrateExtrinsics(Node):
    def __init__(self, tag_id: int, tag_size_m: float, n_frames: int):
        super().__init__("calibrate_extrinsics")

        if _ATDetector is None:
            self.get_logger().fatal(
                "dt_apriltags not installed. Run: pip3 install dt-apriltags")
            raise SystemExit(1)

        self.tag_id = tag_id
        self.tag_size = tag_size_m
        self.n_frames = n_frames

        self._detector = _ATDetector(families="tag36h11", nthreads=2,
                                     quad_decimate=1.0, refine_edges=True)

        # latest intrinsics + accumulated poses per camera
        self._K   = {0: None, 1: None}
        self._R   = {0: [],  1: []}
        self._t   = {0: [],  1: []}

        for cam in (0, 1):
            color = f"/cam{cam}/cam{cam}/color/image_raw"
            info  = f"/cam{cam}/cam{cam}/color/camera_info"
            self.create_subscription(Image, color,
                                     self._make_cb(cam), qos_profile_sensor_data)
            self.create_subscription(CameraInfo, info,
                                     self._make_info_cb(cam), qos_profile_sensor_data)

        self._t_log_count = 0
        self.create_timer(0.5, self._tick_log)

        self.get_logger().info(
            f"calibrate_extrinsics: tag_id={tag_id} size={tag_size_m}m "
            f"target_frames={n_frames} per camera")

    def _make_info_cb(self, cam: int):
        def cb(msg: CameraInfo):
            k = msg.k
            if k[0] > 0 and k[4] > 0:
                self._K[cam] = (float(k[0]), float(k[4]),
                                float(k[2]), float(k[5]))  # fx, fy, cx, cy
        return cb

    def _make_cb(self, cam: int):
        def cb(msg: Image):
            if self._K[cam] is None:
                return
            if len(self._R[cam]) >= self.n_frames:
                return
            try:
                gray = _rgb_image_to_gray(msg)
            except Exception as e:
                self.get_logger().warn(f"cam{cam} decode failed: {e}", once=True)
                return
            detections = self._detector.detect(
                gray, estimate_tag_pose=True,
                camera_params=self._K[cam], tag_size=self.tag_size,
            )
            for det in detections:
                if det.tag_id != self.tag_id:
                    continue
                Rm = np.array(det.pose_R, dtype=np.float64)
                t  = np.array(det.pose_t, dtype=np.float64).reshape(3)
                self._R[cam].append(Rm)
                self._t[cam].append(t)
                break
        return cb

    def _tick_log(self):
        self._t_log_count += 1
        if self._t_log_count % 4 == 0:
            self.get_logger().info(
                f"cam0 frames={len(self._R[0])}/{self.n_frames} "
                f"cam1 frames={len(self._R[1])}/{self.n_frames}")

    def done(self) -> bool:
        return (len(self._R[0]) >= self.n_frames
                and len(self._R[1]) >= self.n_frames)

    def write_yaml(self):
        R_c0_tag, t_c0_tag = _avg_pose(self._R[0], self._t[0])
        R_c1_tag, t_c1_tag = _avg_pose(self._R[1], self._t[1])
        R_tag_c1, t_tag_c1 = _T_inverse(R_c1_tag, t_c1_tag)

        # T_cam0_cam1 = T_cam0_tag * inv(T_cam1_tag)
        R_c0_c1 = R_c0_tag @ R_tag_c1
        t_c0_c1 = R_c0_tag @ t_tag_c1 + t_c0_tag

        out = {
            "cam0_to_workspace": _Rt_to_quat_trans(R_c0_tag, t_c0_tag),
            "cam0_to_cam1":      _Rt_to_quat_trans(R_c0_c1,  t_c0_c1),
            "cam0_to_lidar": {
                # MANUAL placeholder — measure mechanically and edit. Identity
                # means the LiDAR will overlap the camera origin; correct it
                # once you have a tape measure or run a separate LiDAR/cam
                # extrinsic procedure.
                "translation": [0.0, 0.0, 0.0],
                "rotation":    [0.0, 0.0, 0.0, 1.0],
                "_note":       "placeholder — edit with measured offset",
            },
            "workspace_to_robot_base": {
                # Filled in during eye-hand calibration once the arm is wired up.
                "translation": [0.0, 0.0, 0.0],
                "rotation":    [0.0, 0.0, 0.0, 1.0],
                "_note":       "placeholder — fill in during eye-hand calibration",
            },
            "metadata": {
                "tag_family":  "tag36h11",
                "tag_id":      self.tag_id,
                "tag_size_m":  self.tag_size,
                "n_frames":    self.n_frames,
                "timestamp_s": time.time(),
            },
        }

        os.makedirs(CAL_DIR, exist_ok=True)
        with open(OUT_PATH, "w") as f:
            yaml.safe_dump(out, f, default_flow_style=False, sort_keys=False)
        self.get_logger().info(f"wrote {OUT_PATH}")
        print(yaml.safe_dump(out, default_flow_style=False, sort_keys=False))


def main(args=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag-id",     type=int,   default=DEFAULT_ID)
    parser.add_argument("--tag-size",   type=float, default=DEFAULT_SIZE_M)
    parser.add_argument("--frames",     type=int,   default=DEFAULT_FRAMES)
    parser.add_argument("--timeout-s",  type=float, default=60.0)
    cli, _ = parser.parse_known_args()

    rclpy.init(args=args)
    node = CalibrateExtrinsics(cli.tag_id, cli.tag_size, cli.frames)
    start = time.time()
    try:
        while rclpy.ok() and not node.done():
            rclpy.spin_once(node, timeout_sec=0.2)
            if time.time() - start > cli.timeout_s:
                node.get_logger().error(
                    f"timeout after {cli.timeout_s}s — got "
                    f"cam0={len(node._R[0])}, cam1={len(node._R[1])} "
                    "frames. Is the tag visible in BOTH cameras?")
                sys.exit(2)
        node.write_yaml()
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    main()
