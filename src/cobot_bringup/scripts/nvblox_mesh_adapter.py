#!/usr/bin/env python3
"""Convert /nvblox_node/mesh (nvblox_msgs/Mesh) into the JSON payload
the dashboard /ws/mesh already understands.

nvblox publishes the mesh as an INCREMENTAL block-based update — each
message only contains blocks that have changed since the last publish.
We maintain a cache of (block_index → block geometry) and republish the
union to /reconstruction/mesh_json after every update. Triangle indices
inside each MeshBlock are LOCAL; we offset them per block when
flattening into a single mesh.

Per-vertex colour comes from a height-band palette (matches the previous
CPU reconstruction look), with a vivid green overlay on vertices within
object_highlight_radius_m of any LiDAR-detected object centroid.

If pyfqmr is installed the mesh is decimated to max_triangles_json with
quadric edge collapse; otherwise we fall back to random face sampling
+ vertex remap.
"""
import json
import math

import numpy as np
import rclpy
from rclpy.node import Node
from std_msgs.msg import String
from vision_msgs.msg import Detection3DArray

try:
    from nvblox_msgs.msg import Mesh as NvbloxMesh
except ImportError as e:
    NvbloxMesh = None
    _NVBLOX_IMPORT_ERROR = str(e)

try:
    import pyfqmr
except ImportError:
    pyfqmr = None


# ── helpers (mirror local_reconstruction.py) ──────────────────────────

def _height_color_arr(zs: np.ndarray) -> np.ndarray:
    cols = np.empty((zs.shape[0], 3), dtype=np.float32)
    a = zs < 0.1
    b = (~a) & (zs < 0.8)
    c = (~a) & (~b) & (zs < 1.5)
    d = ~(a | b | c)
    cols[a] = (0.753, 0.769, 0.800)
    cols[b] = (0.576, 0.773, 0.992)
    cols[c] = (0.525, 0.937, 0.675)
    cols[d] = (0.992, 0.902, 0.541)
    return cols


def _filter_triangles(verts: np.ndarray, faces: np.ndarray,
                      min_area: float = 1e-7, max_area: float = 0.01):
    if faces.shape[0] == 0:
        return faces
    v0 = verts[faces[:, 0]]; v1 = verts[faces[:, 1]]; v2 = verts[faces[:, 2]]
    areas = 0.5 * np.linalg.norm(np.cross(v1 - v0, v2 - v0), axis=1)
    return faces[(areas > min_area) & (areas < max_area)]


# ── node ──────────────────────────────────────────────────────────────

class NvbloxMeshAdapter(Node):
    def __init__(self):
        super().__init__('nvblox_mesh_adapter')

        self.declare_parameter('mesh_topic',                  '/nvblox_node/mesh')
        self.declare_parameter('output_topic',                '/reconstruction/mesh_json')
        self.declare_parameter('detections_topic',            '/perception/lidar_detections')
        self.declare_parameter('max_triangles_json',          10000)
        self.declare_parameter('max_triangle_area_m2',        0.01)
        self.declare_parameter('mesh_radius_m',               2.0)
        self.declare_parameter('object_highlight_radius_m',   0.05)
        self.declare_parameter('frame_id',                    'livox_frame')
        self.declare_parameter('publish_min_interval_s',      0.2)

        mesh_topic        = self.get_parameter('mesh_topic').value
        det_topic         = self.get_parameter('detections_topic').value
        out_topic         = self.get_parameter('output_topic').value
        self.max_tri      = int(self.get_parameter('max_triangles_json').value)
        self.max_area     = float(self.get_parameter('max_triangle_area_m2').value)
        self.mesh_radius  = float(self.get_parameter('mesh_radius_m').value)
        self.hi_radius    = float(self.get_parameter('object_highlight_radius_m').value)
        self.frame_id     = str(self.get_parameter('frame_id').value)
        self.min_interval = float(self.get_parameter('publish_min_interval_s').value)

        # block_index (x, y, z) -> (verts Nx3 float32, tris Mx3 int32)
        self._blocks: dict = {}
        self._object_centroids = np.empty((0, 3), dtype=np.float32)
        self._last_publish = 0.0
        self._update_count = 0

        if NvbloxMesh is None:
            self.get_logger().fatal(
                f'nvblox_msgs not available: {_NVBLOX_IMPORT_ERROR}')
            raise SystemExit(1)

        self.create_subscription(NvbloxMesh, mesh_topic, self._on_mesh, 5)
        self.create_subscription(Detection3DArray, det_topic,
                                  self._on_detections, 5)
        self._pub = self.create_publisher(String, out_topic, 2)

        if pyfqmr is None:
            self.get_logger().info('pyfqmr not available — decimation uses random subsample')
        self.get_logger().info(
            f'nvblox_mesh_adapter: {mesh_topic} -> {out_topic} '
            f'(max_tri={self.max_tri}, radius={self.mesh_radius}m, '
            f'min_interval={self.min_interval}s)')

    # ── callbacks ────────────────────────────────────────────────────

    def _on_detections(self, msg: Detection3DArray):
        cents = []
        for det in msg.detections:
            p = det.bbox.center.position
            cents.append((float(p.x), float(p.y), float(p.z)))
        self._object_centroids = (np.array(cents, dtype=np.float32)
                                  if cents else np.empty((0, 3), dtype=np.float32))

    def _on_mesh(self, msg):
        # Update the cache: each block in `msg.blocks` is the FULL new
        # geometry for the corresponding block_index. An empty block
        # (no vertices, no triangles) means the block was cleared.
        for i, bidx in enumerate(msg.block_indices):
            key = (int(bidx.x), int(bidx.y), int(bidx.z))
            block = msg.blocks[i]
            if not block.vertices or not block.triangles:
                self._blocks.pop(key, None)
                continue
            # Vectorised conversion of Point32 list -> Nx3 float32
            n_v = len(block.vertices)
            verts = np.empty((n_v, 3), dtype=np.float32)
            for j, p in enumerate(block.vertices):
                verts[j, 0] = p.x; verts[j, 1] = p.y; verts[j, 2] = p.z
            tris_flat = np.asarray(block.triangles, dtype=np.int32)
            # nvblox sends a flat int32 array; reshape to (M, 3).
            n_t = tris_flat.size // 3
            tris = tris_flat[: n_t * 3].reshape(n_t, 3)
            self._blocks[key] = (verts, tris)

        self._update_count += 1
        now = self.get_clock().now().nanoseconds * 1e-9
        if now - self._last_publish < self.min_interval:
            return
        self._last_publish = now
        self._publish()

    # ── flatten + emit ───────────────────────────────────────────────

    def _flatten(self):
        if not self._blocks:
            return np.zeros((0, 3), dtype=np.float32), np.zeros((0, 3), dtype=np.int32)
        v_parts, t_parts = [], []
        offset = 0
        for verts, tris in self._blocks.values():
            v_parts.append(verts)
            if tris.size:
                t_parts.append(tris + offset)
            offset += verts.shape[0]
        all_v = np.concatenate(v_parts, axis=0)
        all_t = (np.concatenate(t_parts, axis=0) if t_parts
                 else np.zeros((0, 3), dtype=np.int32))
        return all_v, all_t

    def _decimate(self, verts, faces, target):
        if faces.shape[0] <= target:
            return verts, faces
        if pyfqmr is not None:
            try:
                simp = pyfqmr.Simplify()
                simp.setMesh(verts.astype(np.float64), faces.astype(np.int32))
                simp.simplify_mesh(target_count=target, preserve_border=True,
                                    aggressiveness=7, verbose=False)
                v2, f2, _ = simp.getMesh()
                if v2.size and f2.size:
                    return v2.astype(np.float32), f2.astype(np.int32)
            except Exception as e:
                self.get_logger().warn(
                    f'pyfqmr failed ({e}); subsample fallback',
                    throttle_duration_sec=10)
        sel = np.random.choice(faces.shape[0], target, replace=False)
        sel_f = faces[sel]
        used = np.unique(sel_f.ravel())
        remap = -np.ones(verts.shape[0], dtype=np.int64)
        remap[used] = np.arange(used.size)
        return verts[used], remap[sel_f].astype(np.int32)

    def _compute_colors(self, verts):
        if verts.shape[0] == 0:
            return np.empty((0, 3), dtype=np.float32)
        cols = _height_color_arr(verts[:, 2])
        cents = self._object_centroids
        if cents.shape[0] > 0:
            diff = verts[:, None, :] - cents[None, :, :]
            d2 = (diff * diff).sum(axis=2)
            nearest = np.sqrt(d2.min(axis=1))
            mask = nearest < self.hi_radius
            if mask.any():
                cols[mask] = (0.31, 0.78, 0.47)
        return cols

    def _publish(self):
        verts, faces = self._flatten()
        if verts.size == 0:
            self._emit(verts, faces)
            return

        # Crop to mesh_radius around origin
        r = np.linalg.norm(verts, axis=1)
        keep_v = r < self.mesh_radius
        if not keep_v.all():
            keep_idx = np.where(keep_v)[0]
            remap = -np.ones(verts.shape[0], dtype=np.int64)
            remap[keep_idx] = np.arange(keep_idx.size)
            if faces.size:
                tri_keep = keep_v[faces].all(axis=1)
                faces = remap[faces[tri_keep]].astype(np.int32)
            verts = verts[keep_idx]

        if faces.size:
            faces = _filter_triangles(verts, faces, max_area=self.max_area)
        verts, faces = self._decimate(verts, faces, self.max_tri)
        self._emit(verts, faces)

    def _emit(self, verts, faces):
        if faces.shape[0] > 0:
            used = np.unique(faces.ravel())
            remap = -np.ones(verts.shape[0], dtype=np.int64)
            remap[used] = np.arange(used.size)
            v_out = verts[used]
            t_out = remap[faces]
        else:
            v_out = verts
            t_out = faces
        if v_out.shape[0] > 0:
            cols = self._compute_colors(v_out)
            colors_json = [[round(float(c), 2) for c in v] for v in cols.tolist()]
        else:
            colors_json = []
        payload = {
            'frame_id':   self.frame_id,
            'n_vertices': int(v_out.shape[0]),
            'n_tris':     int(t_out.shape[0]),
            'n_blocks':   len(self._blocks),
            'n_objects':  int(self._object_centroids.shape[0]),
            'vertices':   [[round(float(v), 3) for v in p] for p in v_out.tolist()],
            'triangles':  t_out.astype(np.int32).tolist(),
            'colors':     colors_json,
        }
        msg = String(); msg.data = json.dumps(payload)
        self._pub.publish(msg)
        if self._update_count % 10 == 0:
            self.get_logger().info(
                f'mesh updates={self._update_count} blocks={len(self._blocks)} '
                f'verts={v_out.shape[0]} tris={t_out.shape[0]} '
                f'objects={self._object_centroids.shape[0]}')


def main(args=None):
    rclpy.init(args=args)
    node = NvbloxMeshAdapter()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
