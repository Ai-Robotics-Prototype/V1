#!/usr/bin/env python3
"""Near/far rolling-window PointCloud2 accumulator.

The Livox MID-360 is non-repetitive — each frame is sparse, but several
frames overlap to densify the scene. The Estun robot's workspace lives
within ~1 m of the sensor, so we accumulate aggressively there:

    near (||p|| <= near_range_m): last 20 frames + 5 mm voxel dedup
    far  (||p|| >  near_range_m): last  5 frames + 30 mm voxel dedup

The two halves are concatenated and republished on /lidar/points_dense.

Params (all overridable from a launch file or service unit):
    input_topic              /lidar/points
    output_topic             /lidar/points_dense
    near_range_m             1.0
    near_accumulate_frames   50
    far_accumulate_frames    5
    near_voxel_m             0.005
    far_voxel_m              0.03
    publish_hz               10.0
    frame_id                 ''        (empty -> inherit from latest input)
"""
import collections
import struct

import numpy as np
import rclpy
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2, PointField


def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    """Vectorised PointCloud2 → Nx3 float32 (X, Y, Z) decode."""
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
    ox, oy, oz = fields['x'].offset, fields['y'].offset, fields['z'].offset
    if oy == ox + 4 and oz == ox + 8:
        arr = np.frombuffer(data, dtype=np.uint8).reshape(n, step)
        block = arr[:, ox:ox + 12].copy()
        return block.view(np.float32).reshape(n, 3)
    out = np.empty((n, 3), dtype=np.float32)
    for i in range(n):
        base = i * step
        out[i, 0] = struct.unpack_from('f', data, base + ox)[0]
        out[i, 1] = struct.unpack_from('f', data, base + oy)[0]
        out[i, 2] = struct.unpack_from('f', data, base + oz)[0]
    return out


def _voxel_downsample(xyz: np.ndarray, voxel: float) -> np.ndarray:
    """Hash-keyed unique-per-voxel downsample. One point per occupied voxel."""
    if xyz.size == 0:
        return xyz
    keys = np.floor(xyz / voxel).astype(np.int64)
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

        self.declare_parameter('input_topic',            '/lidar/points')
        self.declare_parameter('output_topic',           '/lidar/points_dense')
        self.declare_parameter('near_range_m',           1.0)
        self.declare_parameter('near_accumulate_frames', 50)
        self.declare_parameter('far_accumulate_frames',  5)
        self.declare_parameter('near_voxel_m',           0.005)
        self.declare_parameter('far_voxel_m',            0.03)
        self.declare_parameter('publish_hz',             10.0)
        self.declare_parameter('frame_id',               '')

        input_topic  = self.get_parameter('input_topic').value
        output_topic = self.get_parameter('output_topic').value
        self._near_range = float(self.get_parameter('near_range_m').value)
        n_near = max(1, int(self.get_parameter('near_accumulate_frames').value))
        n_far  = max(1, int(self.get_parameter('far_accumulate_frames').value))
        self._near_voxel = float(self.get_parameter('near_voxel_m').value)
        self._far_voxel  = float(self.get_parameter('far_voxel_m').value)
        rate = float(self.get_parameter('publish_hz').value)
        self._frame_override = str(self.get_parameter('frame_id').value)

        self._near_buf = collections.deque(maxlen=n_near)
        self._far_buf  = collections.deque(maxlen=n_far)
        self._latest_stamp = None
        self._latest_frame_id = 'livox_frame'

        self.create_subscription(PointCloud2, input_topic, self._on_cloud,
                                 qos_profile_sensor_data)
        self._pub = self.create_publisher(PointCloud2, output_topic, 5)
        self.create_timer(1.0 / max(rate, 1.0), self._publish)

        self.get_logger().info(
            f'pointcloud_accumulator: {input_topic} -> {output_topic} '
            f'| near<= {self._near_range}m [{n_near} frames @ '
            f'{self._near_voxel}m voxel] '
            f'| far [{n_far} frames @ {self._far_voxel}m voxel] '
            f'| {rate}Hz')

    def _on_cloud(self, msg: PointCloud2):
        xyz = _decode_xyz(msg)
        if xyz.size == 0:
            return
        # Split by distance to origin (LiDAR centre).
        r = np.linalg.norm(xyz, axis=1)
        near_mask = r <= self._near_range
        self._near_buf.append(xyz[near_mask])
        self._far_buf.append(xyz[~near_mask])
        self._latest_stamp = msg.header.stamp
        if msg.header.frame_id:
            self._latest_frame_id = msg.header.frame_id

    def _publish(self):
        if self._latest_stamp is None:
            return
        near_pts = (np.concatenate(list(self._near_buf), axis=0)
                    if len(self._near_buf) else np.empty((0, 3), dtype=np.float32))
        far_pts  = (np.concatenate(list(self._far_buf),  axis=0)
                    if len(self._far_buf)  else np.empty((0, 3), dtype=np.float32))
        near_down = _voxel_downsample(near_pts, self._near_voxel)
        far_down  = _voxel_downsample(far_pts,  self._far_voxel)
        merged = np.vstack([near_down, far_down]) if (near_down.size or far_down.size) \
                 else np.empty((0, 3), dtype=np.float32)
        frame = self._frame_override or self._latest_frame_id
        self._pub.publish(_make_pc2(merged, self._latest_stamp, frame))


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
