#!/usr/bin/env python3
"""Compute the cam0->lidar offset by pairing a detected object with its
LiDAR cluster.

The operator places a single isolated, easily visible object (e.g. a
bottle) in view of both cam0 and the LiDAR. The script averages N
measurements of:
    p_obj_cam    centre of the cam0 detection (already in livox_frame
                 if sensor_tf_publisher is running with the *current*
                 offset)
    p_obj_lidar  centre of the nearest LiDAR cluster

The difference is the correction to apply to cam0_to_lidar.translation
in sensor_transforms.yaml. The rotation is NOT corrected — for that,
run the AprilTag calibration (calibrate_extrinsics.py).

Usage:
    ros2 launch cobot_bringup full_stack.launch.py    # or have lidar,
                                                       # cameras, depth-
                                                       # segment all up
    python3 src/cobot_bringup/scripts/measure_transform.py
"""
import sys
import time

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2
from vision_msgs.msg import Detection3DArray

N_FRAMES = 5


def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ('x', 'y', 'z')):
        return np.empty((0, 3), dtype=np.float32)
    step = msg.point_step
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)
    ox = fields['x'].offset
    arr = np.frombuffer(data, dtype=np.uint8).reshape(n, step)
    block = arr[:, ox:ox + 12].copy()
    return block.view(np.float32).reshape(n, 3)


class Measure(Node):
    def __init__(self):
        super().__init__('measure_transform')
        self._dets = []
        self._lidar = []
        self.create_subscription(Detection3DArray, '/perception/detections_3d',
                                 self._on_dets, qos_profile_sensor_data)
        self.create_subscription(PointCloud2, '/lidar/points_dense',
                                 self._on_cloud, qos_profile_sensor_data)

    def _on_dets(self, msg):
        if not msg.detections:
            return
        # Pick the closest-to-origin (camera frame) detection — assume that's
        # the only object on the table.
        best = None
        best_d = float('inf')
        for d in msg.detections:
            p = d.bbox.center.position
            r = (p.x * p.x + p.y * p.y + p.z * p.z) ** 0.5
            if r < best_d:
                best_d = r
                best = (float(p.x), float(p.y), float(p.z))
        if best is not None:
            self._dets.append(best)

    def _on_cloud(self, msg):
        xyz = _decode_xyz(msg)
        if xyz.size == 0:
            return
        # Look only above the floor (z > 0.02 m in lidar frame) and within 2 m.
        r = np.linalg.norm(xyz, axis=1)
        mask = (xyz[:, 2] > 0.02) & (r < 2.0)
        cluster = xyz[mask]
        if cluster.shape[0] < 30:
            return
        # Centroid of the densest cluster — for a single object this is fine.
        self._lidar.append(cluster.mean(axis=0).tolist())


def main(args=None):
    rclpy.init(args=args)
    node = Measure()
    print('Place a single object on the table where both cam0 and the LiDAR '
          'can see it. Collecting samples...')
    deadline = time.time() + 30.0
    while rclpy.ok() and time.time() < deadline:
        rclpy.spin_once(node, timeout_sec=0.2)
        if len(node._dets) >= N_FRAMES and len(node._lidar) >= N_FRAMES:
            break

    if len(node._dets) < N_FRAMES or len(node._lidar) < N_FRAMES:
        print(f'timed out (dets={len(node._dets)} lidar={len(node._lidar)})',
              file=sys.stderr)
        node.destroy_node(); rclpy.shutdown(); sys.exit(2)

    p_cam   = np.mean(np.array(node._dets[-N_FRAMES:]),  axis=0)
    p_lidar = np.mean(np.array(node._lidar[-N_FRAMES:]), axis=0)
    delta = p_lidar - p_cam

    print(f'cam centre   (livox frame, applied with current offset): {p_cam.tolist()}')
    print(f'lidar centre (livox frame):                              {p_lidar.tolist()}')
    print(f'delta to add to cam0_to_lidar.translation: '
          f'[{delta[0]:+.3f}, {delta[1]:+.3f}, {delta[2]:+.3f}]')
    print('Apply via scripts/align_sensors.py or edit '
          'src/cobot_bringup/config/sensor_transforms.yaml directly.')
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
