#!/usr/bin/env python3
"""Local TSDF/occupancy reconstruction from the dense LiDAR cloud.

A 3D occupancy voxel grid (150³ at 2 cm by default, 3 m cube centred on
the sensor) accumulates evidence over time. Each accepted point bumps
its voxel toward 1.0 via an exponential moving average; voxels with no
fresh evidence decay slowly. Periodically the surface is extracted via
scikit-image marching_cubes and published two ways:

    /reconstruction/mesh       visualization_msgs/Marker (TRIANGLE_LIST)
    /reconstruction/mesh_json  std_msgs/String — JSON with vertices and
                               triangle indices for the dashboard WS

JSON output is capped (max triangles + vertex remap) so the WebSocket
isn't saturated. Heights drive vertex colours: blue floor, green low,
yellow mid, red high.
"""
import json
import math
import struct

import numpy as np
import rclpy
from geometry_msgs.msg import Point
from rclpy.node import Node
from rclpy.qos import qos_profile_sensor_data
from sensor_msgs.msg import PointCloud2
from std_msgs.msg import ColorRGBA, String
from visualization_msgs.msg import Marker

try:
    from skimage.measure import marching_cubes
except ImportError:
    marching_cubes = None


def _decode_xyz(msg: PointCloud2) -> np.ndarray:
    """Same vectorised decode as the accumulator — kept inline to avoid
    importing across packages."""
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


def _height_color(z: float):
    if z < 0.1: return (0.15, 0.35, 0.85)   # blue
    if z < 0.5: return (0.15, 0.75, 0.50)   # green
    if z < 1.0: return (0.85, 0.75, 0.10)   # yellow
    return        (0.85, 0.25, 0.15)        # red


class LocalReconstruction(Node):
    def __init__(self):
        super().__init__('local_reconstruction')

        self.declare_parameter('input_topic',        '/lidar/points_dense')
        self.declare_parameter('grid_resolution_m',  0.02)
        self.declare_parameter('grid_half_extent_m', 1.5)
        self.declare_parameter('occupancy_threshold', 0.5)
        self.declare_parameter('decay_rate',         0.995)
        self.declare_parameter('update_rate',        0.2)     # one-shot weight per point
        self.declare_parameter('publish_hz',         2.0)
        self.declare_parameter('max_triangles_json', 5000)
        self.declare_parameter('frame_id',           'livox_frame')

        input_topic           = self.get_parameter('input_topic').value
        self.res              = float(self.get_parameter('grid_resolution_m').value)
        self.half             = float(self.get_parameter('grid_half_extent_m').value)
        self.occ_thresh       = float(self.get_parameter('occupancy_threshold').value)
        self.decay            = float(self.get_parameter('decay_rate').value)
        self.update_rate      = float(self.get_parameter('update_rate').value)
        self.max_tri_json     = int(self.get_parameter('max_triangles_json').value)
        self.frame_id         = str(self.get_parameter('frame_id').value)
        rate                  = float(self.get_parameter('publish_hz').value)

        n = int(round(2 * self.half / self.res))
        self._n = n
        self._grid = np.zeros((n, n, n), dtype=np.float32)
        self._frames_seen = 0

        self.create_subscription(PointCloud2, input_topic, self._on_cloud,
                                 qos_profile_sensor_data)
        self._marker_pub = self.create_publisher(Marker, '/reconstruction/mesh', 2)
        self._json_pub   = self.create_publisher(String, '/reconstruction/mesh_json', 2)
        self.create_timer(1.0 / max(rate, 0.5), self._publish)

        if marching_cubes is None:
            self.get_logger().warn(
                "skimage not available — mesh extraction falls back to "
                "surface-voxel point output. Run: pip3 install scikit-image")
        self.get_logger().info(
            f'local_reconstruction: grid={n}³ @ {self.res}m '
            f'({2*self.half}m cube), thr={self.occ_thresh}, '
            f'decay={self.decay}, max_tri_json={self.max_tri_json}, '
            f'rate={rate}Hz')

    # ── Accumulation ──────────────────────────────────────────────────

    def _on_cloud(self, msg: PointCloud2):
        xyz = _decode_xyz(msg)
        if xyz.size == 0:
            return
        # Decay everything first — voxels with no fresh evidence shrink.
        self._grid *= self.decay
        # World → voxel indices.
        idx = np.floor((xyz + self.half) / self.res).astype(np.int32)
        in_range = (
            (idx[:, 0] >= 0) & (idx[:, 0] < self._n) &
            (idx[:, 1] >= 0) & (idx[:, 1] < self._n) &
            (idx[:, 2] >= 0) & (idx[:, 2] < self._n)
        )
        idx = idx[in_range]
        if idx.size == 0:
            return
        # EMA bump toward 1.0. Using fancy indexing — duplicate (i,j,k)
        # entries from multiple points hitting the same voxel collapse
        # to a single bump per timer fire, which is what we want.
        i, j, k = idx[:, 0], idx[:, 1], idx[:, 2]
        cur = self._grid[i, j, k]
        self._grid[i, j, k] = (1.0 - self.update_rate) * cur + self.update_rate
        self._frames_seen += 1

    # ── Mesh extraction ───────────────────────────────────────────────

    def _extract_mesh(self):
        """Return (verts[N,3], tris[M,3]) in world coordinates. Falls back to
        surface-voxel centres + empty tris if skimage is unavailable or
        the level set is degenerate."""
        if marching_cubes is None:
            occupied = self._grid > self.occ_thresh
            if not occupied.any():
                return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
            coords = np.argwhere(occupied)
            verts = coords.astype(np.float32) * self.res - self.half + self.res * 0.5
            return verts, np.zeros((0, 3), dtype=np.int32)
        try:
            verts, faces, _, _ = marching_cubes(
                self._grid, level=self.occ_thresh,
                spacing=(self.res, self.res, self.res),
            )
        except (ValueError, RuntimeError):
            return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
        # marching_cubes returns coordinates in (i*res, j*res, k*res) — shift
        # to world frame.
        verts = verts.astype(np.float32) - self.half
        return verts, faces.astype(np.int32)

    # ── Publishing ────────────────────────────────────────────────────

    def _publish(self):
        verts, tris = self._extract_mesh()
        n_tri = int(tris.shape[0])
        n_vert = int(verts.shape[0])
        n_occ = int(np.sum(self._grid > self.occ_thresh))
        self._publish_marker(verts, tris)
        self._publish_json(verts, tris, n_occ)
        if self._frames_seen and self._frames_seen % 20 == 0:
            self.get_logger().info(
                f'occupied={n_occ} mesh={n_vert}v/{n_tri}t')

    def _publish_marker(self, verts, tris):
        m = Marker()
        m.header.stamp = self.get_clock().now().to_msg()
        m.header.frame_id = self.frame_id
        m.ns = 'reconstruction'
        m.id = 0
        m.type = Marker.TRIANGLE_LIST
        m.action = Marker.ADD
        m.scale.x = 1.0; m.scale.y = 1.0; m.scale.z = 1.0
        m.pose.orientation.w = 1.0
        m.color.r = 0.6; m.color.g = 0.6; m.color.b = 0.6; m.color.a = 0.6
        if tris.size == 0:
            # Marker with empty geometry — still publish so subscribers
            # know the topic is alive.
            self._marker_pub.publish(m)
            return
        # Use per-vertex colour via the colors array (one ColorRGBA per
        # triangle vertex, height-based).
        pts, cols = [], []
        # Limit Marker triangle count similarly to JSON to keep rviz happy.
        if tris.shape[0] > self.max_tri_json * 3:
            sel = np.random.choice(tris.shape[0], self.max_tri_json * 3, replace=False)
            tris = tris[sel]
        for tri in tris:
            for vi in tri:
                v = verts[vi]
                pt = Point(); pt.x = float(v[0]); pt.y = float(v[1]); pt.z = float(v[2])
                pts.append(pt)
                r, g, b = _height_color(float(v[2]))
                c = ColorRGBA(); c.r = float(r); c.g = float(g); c.b = float(b); c.a = 0.6
                cols.append(c)
        m.points = pts
        m.colors = cols
        self._marker_pub.publish(m)

    def _publish_json(self, verts, tris, n_occ):
        # Cap triangles aggressively for the WebSocket. Random-sample if
        # we exceed the cap, then collect just the vertices those
        # triangles reference and remap.
        if tris.shape[0] > self.max_tri_json:
            sel = np.random.choice(tris.shape[0], self.max_tri_json, replace=False)
            tris = tris[sel]
        if tris.shape[0] > 0:
            used = np.unique(tris.ravel())
            remap = -np.ones(verts.shape[0], dtype=np.int64)
            remap[used] = np.arange(used.size)
            verts_out = verts[used]
            tris_out = remap[tris]
        else:
            verts_out = verts
            tris_out = tris

        payload = {
            'frame_id':   self.frame_id,
            'n_vertices': int(verts_out.shape[0]),
            'n_tris':     int(tris_out.shape[0]),
            'n_occupied': int(n_occ),
            # Round to mm; full float would double the payload size.
            'vertices':   [[round(float(v), 3) for v in p] for p in verts_out.tolist()],
            'triangles':  tris_out.astype(np.int32).tolist(),
        }
        s = String()
        s.data = json.dumps(payload)
        self._json_pub.publish(s)


def main(args=None):
    rclpy.init(args=args)
    node = LocalReconstruction()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
