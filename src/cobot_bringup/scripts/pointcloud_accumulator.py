#!/usr/bin/env python3
"""Rolling-window PointCloud2 accumulator with voxel downsample.

Livox MID-360 uses a non-repetitive scan pattern — a single 100ms frame is
sparse (~20k points), but overlaying several consecutive frames densely
fills the scene. This node keeps the last N frames in a ring buffer,
concatenates them, voxel-downsamples (one point per occupied voxel) to
strip duplicates, and republishes the result.

Params:
  input_topic         (default: /lidar/points)
  output_topic        (default: /lidar/points_accumulated)
  window_size         (default: 5) number of frames retained
  voxel_size_m        (default: 0.02) downsample voxel edge length
  publish_rate_hz     (default: 10.0)
  frame_id            (default: empty -> inherit from latest input)
"""

import collections
import struct

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2, PointField


def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    fields = {f.name: f for f in msg.fields}
    if not all(k in fields for k in ('x', 'y', 'z')):
        return np.empty((0, 3), dtype=np.float32)
    step = msg.point_step
    if step <= 0:
        return np.empty((0, 3), dtype=np.float32)
    data = bytes(msg.data)
    n = len(data) // step
    if n == 0:
        return np.empty((0, 3), dtype=np.float32)
    # Single-pass numpy view via structured dtype keeps this O(N) without
    # a Python loop. Assumes x/y/z are contiguous little-endian float32 —
    # true for every driver we use (Livox + RealSense + nvblox).
    ox, oy, oz = fields['x'].offset, fields['y'].offset, fields['z'].offset
    if oy == ox + 4 and oz == ox + 8:
        arr = np.frombuffer(data, dtype=np.uint8).reshape(n, step)
        block = arr[:, ox:ox + 12].copy()
        xyz = block.view(np.float32).reshape(n, 3)
        return xyz
    # Fallback: slow path
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


def _voxel_downsample(xyz: np.ndarray, voxel: float) -> np.ndarray:
    if xyz.size == 0:
        return xyz
    keys = np.floor(xyz / voxel).astype(np.int64)
    # Pack 3 ints into a single uint64 key — survives the unique() collapse.
    packed = (keys[:, 0].astype(np.uint64) * 73856093) \
        ^ (keys[:, 1].astype(np.uint64) * 19349663) \
        ^ (keys[:, 2].astype(np.uint64) * 83492791)
    _, idx = np.unique(packed, return_index=True)
    return xyz[idx]


def _make_pc2(xyz: np.ndarray, stamp, frame_id: str) -> PointCloud2:
    msg = PointCloud2()
    msg.header.stamp = stamp
    msg.header.frame_id = frame_id
    msg.height = 1
    msg.width = int(xyz.shape[0])
    msg.is_dense = True
    msg.is_bigendian = False
    msg.point_step = 12
    msg.row_step = msg.point_step * msg.width
    msg.fields = [
        PointField(name='x', offset=0, datatype=PointField.FLOAT32, count=1),
        PointField(name='y', offset=4, datatype=PointField.FLOAT32, count=1),
        PointField(name='z', offset=8, datatype=PointField.FLOAT32, count=1),
    ]
    msg.data = xyz.astype(np.float32).tobytes()
    return msg


class PointCloudAccumulator(Node):
    def __init__(self):
        super().__init__('pointcloud_accumulator')

        self.declare_parameter('input_topic',     '/lidar/points')
        self.declare_parameter('output_topic',    '/lidar/points_accumulated')
        self.declare_parameter('window_size',     5)
        self.declare_parameter('voxel_size_m',    0.02)
        self.declare_parameter('publish_rate_hz', 10.0)
        self.declare_parameter('frame_id',        '')

        input_topic  = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self._window = int(self.get_parameter('window_size').value)
        self._voxel  = float(self.get_parameter('voxel_size_m').value)
        rate         = float(self.get_parameter('publish_rate_hz').value)
        self._frame_override = str(self.get_parameter('frame_id').value)

        self._buf = collections.deque(maxlen=max(1, self._window))
        self._latest_stamp = None
        self._latest_frame_id = 'livox_frame'

        self.create_subscription(PointCloud2, input_topic, self._on_cloud, qos_profile_sensor_data)
        self._pub = self.create_publisher(PointCloud2, output_topic, 5)
        self.create_timer(1.0 / max(rate, 1.0), self._publish)

        self.get_logger().info(
            f'pointcloud_accumulator: {input_topic} -> {output_topic} '
            f'window={self._window} voxel={self._voxel}m rate={rate}Hz')

    def _on_cloud(self, msg: PointCloud2):
        xyz = _decode_xyz(msg)
        if xyz.size == 0:
            return
        self._buf.append(xyz)
        self._latest_stamp = msg.header.stamp
        if msg.header.frame_id:
            self._latest_frame_id = msg.header.frame_id

    def _publish(self):
        if not self._buf or self._latest_stamp is None:
            return
        combined = np.concatenate(list(self._buf), axis=0)
        downsampled = _voxel_downsample(combined, self._voxel)
        frame = self._frame_override or self._latest_frame_id
        self._pub.publish(_make_pc2(downsampled, self._latest_stamp, frame))


def main(args=None):
    rclpy.init(args=args)
    node = PointCloudAccumulator()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
