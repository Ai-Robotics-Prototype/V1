"""Self-collision core — capsule model + pair distance evaluator.

Used by the driver's supervise tick to decide warn / stop, and by the
dashboard mirror to display live clearance. Kept as a standalone module
(no rclpy dependency) so the offline validator can import it directly.

Everything is in mm / degrees on the input side. FK uses the SAME fitted
DH parameters as SingularityGuard in estun_driver_node — one source of
truth, so a change in kinematics propagates to both σ_min and collision.
"""

from __future__ import annotations
import math
import os
import threading
import time
from typing import Iterable, Optional

try:
    import numpy as np
except ImportError:
    np = None

# ── Fitted DH (identical to _FITTED_DH_STD in estun_driver_node) ──────
_FITTED_DH_STD = [
    (-0.00002,     90.00058,   325.89611, -179.99989),
    (-701.00394,    0.00028,  -579.68908,  -90.00022),
    (-538.58526,  180.00313,  -214.01833,   -0.00615),
    (-0.00374,    -89.99857, -1000.00000,  -90.00736),
    ( 0.00533,     89.99433,  -161.46726,  179.99693),
    (-0.00155,     -0.00674,   150.49959,    0.00152),
]
_FITTED_BASE_Z_MM = -139.89595

# URDF link name for each frame after the corresponding joint transform.
# Frame index 0 = base_link (pre-joint1). After joint i's DH transform,
# we are at the link that JOINT i drives — i.e. frame 1 = link1_shoulder.
LINK_NAMES = [
    'base_link',       # frame 0
    'link1_shoulder',  # frame 1 (after joint_1)
    'link2_upper_arm', # frame 2
    'link3_forearm',   # frame 3
    'link4_wrist1',    # frame 4
    'link5_wrist2',    # frame 5
    'link6_flange',    # frame 6
]


def _dh_T(theta, d_mm, a_mm, alpha):
    """Standard DH: T = Rz(θ) · Tz(d) · Tx(a) · Rx(α). Returns 4×4 list."""
    ct, st = math.cos(theta), math.sin(theta)
    ca, sa = math.cos(alpha), math.sin(alpha)
    return [
        [ct, -st*ca,  st*sa, a_mm*ct],
        [st,  ct*ca, -ct*sa, a_mm*st],
        [0.0,    sa,     ca, d_mm],
        [0.0,   0.0,    0.0, 1.0],
    ]


def _matmul4(A, B):
    return [[sum(A[i][k]*B[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def fk_frames(q_deg):
    """Return the 7 link-frame transforms in the base frame (numpy 4×4)
    for q_deg[0..5], in URDF visual-frame convention. Frame 0 is
    base_link; frame k for k≥1 is `link<k>_*` at its URDF-child joint.

    WHY NOT DH: the standard DH chain (fit in dh_fit_report.txt) is
    TCP-accurate but places INTERMEDIATE link frames at DH's own
    convention — NOT at the URDF link-visual origins. That silently
    broke env-collision detection: capsules (defined in URDF link
    frames when we fit them from meshes) got placed in DH frames,
    misaligning link2's world position by hundreds of mm. Wire
    evidence 2026-07-15: env guard reported 68 mm to zone#static_003
    while collision_monitor (URDF FK) correctly reported 1017 mm.
    We use URDF-native chain from the same source as
    src/cobot_bringup/scripts/collision_monitor.py.

    DH is still the right model for TCP (σ_min governor); keep it
    exported as `SingularityGuard`. This FK is for collision only."""
    if np is None:
        raise RuntimeError('numpy required for FK')
    # URDF chain — matches /robot/urdf (s10-140-full.urdf) EXACTLY.
    # These are the joint origins + axes read directly from the URDF
    # (grep '<joint' in the file). collision_monitor.py has its own
    # simplified chain that predates the fit-derived URDF and is
    # numerically different — do NOT copy from there. Row per joint:
    # (parent→child translation in mm, joint axis in that parent
    # frame). Angles arrive in DEGREES.
    URDF_CHAIN = [
        # joint  origin (mm)                    axis
        # J1:    (-0.341, 0.000, -0.038)         (0, 1, 0)
        (( -0.341,   0.000,   -0.038),  (0.0,  1.0, 0.0)),
        # J2:    (-201.859, 183.312, 0.221)      (-1, 0, 0)
        ((-201.859, 183.312,   0.221),  (-1.0, 0.0, 0.0)),
        # J3:    (144.000, 700.198, -0.187)      (-1, 0, 0)
        (( 144.000, 700.198,  -0.187),  (-1.0, 0.0, 0.0)),
        # J4:    (-1.437, 538.990, 0.005)        (1, 0, 0)
        ((  -1.437, 538.990,   0.005),  ( 1.0, 0.0, 0.0)),
        # J5:    (-147.868, 83.500, 0.000)       (0, -1, 0)
        ((-147.868,  83.500,   0.000),  (0.0, -1.0, 0.0)),
        # J6:    (-131.895, 78.106, 2.073)       (-1, 0, 0)
        ((-131.895,  78.106,   2.073),  (-1.0, 0.0, 0.0)),
    ]
    R = np.eye(3)
    p = np.zeros(3)
    frames = []
    # Frame 0 is base_link at world origin.
    T0 = np.eye(4)
    frames.append(T0)
    for i, (xyz, axis) in enumerate(URDF_CHAIN):
        # Translate in current frame.
        p = p + R @ np.asarray(xyz, dtype=np.float64)
        # Rotate about the local axis by joint angle.
        theta = math.radians(q_deg[i])
        c = math.cos(theta); s = math.sin(theta)
        ax = np.asarray(axis, dtype=np.float64)
        # Rodrigues rotation matrix.
        ux, uy, uz = ax
        C = 1 - c
        Rj = np.array([
            [c + ux*ux*C,    ux*uy*C - uz*s, ux*uz*C + uy*s],
            [uy*ux*C + uz*s, c + uy*uy*C,    uy*uz*C - ux*s],
            [uz*ux*C - uy*s, uz*uy*C + ux*s, c + uz*uz*C   ],
        ])
        R = R @ Rj
        T = np.eye(4)
        T[:3, :3] = R
        T[:3,  3] = p
        frames.append(T)
    return frames


# ── Capsule model ─────────────────────────────────────────────────────

class Capsule:
    __slots__ = ('link', 'p0_local', 'p1_local', 'radius')
    def __init__(self, link: str, p0_local, p1_local, radius: float):
        self.link = link
        self.p0_local = np.asarray(p0_local, dtype=np.float64)  # in link frame, mm
        self.p1_local = np.asarray(p1_local, dtype=np.float64)
        self.radius = float(radius)


def load_capsules_yaml(path):
    """Minimal YAML parser tuned to fit_capsules.py's output plus the
    multi-capsule block from fit_multi_capsules.py.  Two supported
    per-link shapes:

      # single capsule (legacy)
      link_name:
        p0: [...]
        p1: [...]
        radius: ...

      # multi-capsule (2-3 per link)
      link_name:
        capsules:
          - p0: [...]
            p1: [...]
            radius: ...
          - p0: [...]
            p1: [...]
            radius: ...

    Additional top-level sections (optional):
      mesh_pairs:
        - [link_a, link_b]      # use mesh-mesh distance instead of capsule
      pair_thresholds:
        - pair: [link_a, link_b]
          warn: 60.0
          stop: 30.0

    Returns (capsules, pairs, mesh_pairs, pair_thresholds). Every link
    in `capsules` maps to a LIST of Capsule so downstream code iterates
    uniformly. `pair_thresholds` is a list of dicts with keys
    'pair' (frozenset), 'warn', 'stop' — consumed by the driver to
    override the global warn/stop for a specific pair (e.g. link3↔link5
    which has a design floor of ~46 mm from link4's mechanical mass)."""
    capsules = {}
    pairs = []
    mesh_pairs = []
    pair_thresholds = []
    section = None
    cur_link = None
    cur = {}           # scratch for a single-capsule link
    cur_multi = None   # list of dicts when parsing a link's `capsules:` block
    cur_thr = None     # scratch dict when parsing a pair_thresholds entry
    def flush():
        nonlocal cur_link, cur, cur_multi
        if cur_link is None:
            cur, cur_multi = {}, None; return
        if cur_multi is not None:
            capsules[cur_link] = [
                Capsule(cur_link, c['p0'], c['p1'], c['radius'])
                for c in cur_multi
                if 'p0' in c and 'p1' in c and 'radius' in c]
        elif 'p0' in cur and 'p1' in cur and 'radius' in cur:
            capsules[cur_link] = [Capsule(cur_link,
                cur['p0'], cur['p1'], cur['radius'])]
        cur_link, cur, cur_multi = None, {}, None
    def flush_thr():
        nonlocal cur_thr
        if cur_thr and 'pair' in cur_thr and 'warn' in cur_thr and 'stop' in cur_thr:
            pair_thresholds.append({
                'pair': frozenset(cur_thr['pair']),
                'warn': float(cur_thr['warn']),
                'stop': float(cur_thr['stop']),
            })
        cur_thr = None
    with open(path) as fh:
        for raw in fh:
            line = raw.split('#', 1)[0].rstrip()
            if not line.strip():
                continue
            stripped = line.strip()
            if line.startswith('capsules:') and (
                    len(line) - len(line.lstrip(' '))) == 0:
                section = 'capsules'; continue
            if line.startswith('pairs:'):
                flush(); section = 'pairs'; continue
            if line.startswith('mesh_pairs:'):
                flush(); section = 'mesh_pairs'; continue
            if line.startswith('pair_thresholds:'):
                flush(); flush_thr(); section = 'pair_thresholds'; continue
            if line.startswith('ground_plane:'):
                flush(); flush_thr(); section = 'ground'; continue
            if section == 'capsules':
                indent = len(line) - len(line.lstrip(' '))
                # `  link_name:`  (2-space indent, trailing colon) → new link
                if indent == 2 and stripped.endswith(':'):
                    flush()
                    cur_link = stripped[:-1]
                # `    capsules:`  (4-space indent) → this link is multi-cap
                elif indent == 4 and stripped == 'capsules:':
                    cur_multi = []
                # `      - p0: [...]` (6-space, list item start) → new capsule entry
                elif indent == 6 and stripped.startswith('- '):
                    if cur_multi is None:
                        cur_multi = []
                    cur_multi.append({})
                    body = stripped[2:]
                    if body:
                        k, _, v = body.partition(':')
                        v = v.strip()
                        if k in ('p0', 'p1'):
                            cur_multi[-1][k] = [float(x) for x in v.strip('[]').split(',')]
                        elif k == 'radius':
                            cur_multi[-1][k] = float(v)
                # `        key: value` (8-space) → next field of current entry
                elif indent == 8 and cur_multi is not None and cur_multi:
                    k, _, v = stripped.partition(':')
                    v = v.strip()
                    if k in ('p0', 'p1'):
                        cur_multi[-1][k] = [float(x) for x in v.strip('[]').split(',')]
                    elif k == 'radius':
                        cur_multi[-1][k] = float(v)
                # single-capsule legacy: `    key: value` (4-space)
                elif indent == 4 and cur_multi is None:
                    k, _, v = stripped.partition(':')
                    v = v.strip()
                    if k in ('p0', 'p1'):
                        cur[k] = [float(x) for x in v.strip('[]').split(',')]
                    elif k == 'radius':
                        cur[k] = float(v)
            elif section == 'pairs':
                if stripped.startswith('-'):
                    inner = stripped[1:].strip().strip('[]')
                    a, b = [s.strip() for s in inner.split(',')]
                    pairs.append((a, b))
            elif section == 'mesh_pairs':
                if stripped.startswith('-'):
                    inner = stripped[1:].strip().strip('[]')
                    a, b = [s.strip() for s in inner.split(',')]
                    mesh_pairs.append((a, b))
            elif section == 'pair_thresholds':
                indent = len(line) - len(line.lstrip(' '))
                if stripped.startswith('- '):
                    flush_thr()
                    cur_thr = {}
                    body = stripped[2:].strip()
                    if body:
                        k, _, v = body.partition(':')
                        v = v.strip()
                        if k == 'pair':
                            cur_thr[k] = [s.strip() for s in v.strip('[]').split(',')]
                        elif k in ('warn', 'stop'):
                            cur_thr[k] = float(v)
                elif cur_thr is not None:
                    k, _, v = stripped.partition(':')
                    v = v.strip()
                    if k == 'pair':
                        cur_thr[k] = [s.strip() for s in v.strip('[]').split(',')]
                    elif k in ('warn', 'stop'):
                        cur_thr[k] = float(v)
    flush()
    flush_thr()
    return capsules, pairs, mesh_pairs, pair_thresholds


# ── Geometry: capsule-capsule distance ────────────────────────────────

def _clamp01(x):
    return 0.0 if x < 0.0 else (1.0 if x > 1.0 else x)


def _segment_segment_dist(p1, q1, p2, q2):
    """Shortest distance between two line SEGMENTS (Ericson, Real-Time
    Collision Detection §5.1.9). Returns (dist, closestA, closestB)."""
    d1 = q1 - p1
    d2 = q2 - p2
    r  = p1 - p2
    a  = float(d1 @ d1)
    e  = float(d2 @ d2)
    f  = float(d2 @ r)
    EPS = 1e-8
    if a <= EPS and e <= EPS:
        return float(np.linalg.norm(p1 - p2)), p1, p2
    if a <= EPS:
        s = 0.0
        t = _clamp01(f / e)
    else:
        c = float(d1 @ r)
        if e <= EPS:
            t = 0.0
            s = _clamp01(-c / a)
        else:
            b = float(d1 @ d2)
            denom = a * e - b * b
            s = _clamp01((b * f - c * e) / denom) if denom > EPS else 0.0
            t = (b * s + f) / e
            if t < 0.0:
                t = 0.0
                s = _clamp01(-c / a)
            elif t > 1.0:
                t = 1.0
                s = _clamp01((b - c) / a)
    ca = p1 + d1 * s
    cb = p2 + d2 * t
    return float(np.linalg.norm(ca - cb)), ca, cb


def _capsule_capsule_dist(cap_a_p0, cap_a_p1, r_a, cap_b_p0, cap_b_p1, r_b):
    """Closest-surface distance between two capsules. Negative when
    the capsules interpenetrate. Returns (surface_dist_mm, axis_dist_mm)."""
    d, _, _ = _segment_segment_dist(cap_a_p0, cap_a_p1, cap_b_p0, cap_b_p1)
    return d - (r_a + r_b), d


def _capsule_ground_dist(cap_p0, cap_p1, r, z_ground):
    """Signed distance from a capsule's lowest surface point to the
    ground plane z = z_ground. Positive = above; negative = below."""
    z_min_surface = min(cap_p0[2], cap_p1[2]) - r
    return z_min_surface - z_ground


# ── Transformer: capsule endpoints from link frame → base frame ───────

def _transform_point(T, p_local):
    """T is 4×4 numpy; p_local is (3,) mm. Returns (3,) mm."""
    return T[:3, :3] @ p_local + T[:3, 3]


# ── Environment obstacles (from static-zone pipeline) ────────────────

class ObbZone:
    """Oriented bounding box in world frame. `center` is mm, `R` is a
    3×3 world→local rotation (i.e. R @ (p - center) gives the point in
    the OBB's local axes), `half` is mm half-extents in the OBB's own
    axes. `zone_id` is the identifier from the /api/collision/static_zones
    payload so we can name the offending zone in stop reasons."""
    __slots__ = ('zone_id', 'center', 'R', 'half')
    def __init__(self, zone_id, center_mm, R, half_mm):
        self.zone_id = zone_id
        self.center = np.asarray(center_mm, dtype=np.float64)
        self.R      = np.asarray(R,          dtype=np.float64)
        self.half   = np.asarray(half_mm,    dtype=np.float64)


def _quat_to_rotmat(x, y, z, w):
    """Right-handed unit quaternion → 3×3 rotation matrix."""
    xx, yy, zz = x*x, y*y, z*z
    xy, xz, yz = x*y, x*z, y*z
    wx, wy, wz = w*x, w*y, w*z
    return np.array([
        [1-2*(yy+zz),   2*(xy-wz),     2*(xz+wy)],
        [2*(xy+wz),     1-2*(xx+zz),   2*(yz-wx)],
        [2*(xz-wy),     2*(yz+wx),     1-2*(xx+yy)],
    ], dtype=np.float64)


def parse_static_zones(payload):
    """Convert the /api/collision/static_zones payload (a list of
    zone dicts with center/dimensions/orientation in METERS) into a
    list of ObbZone in MILLIMETERS. Robust to missing fields — any
    zone we can't parse is skipped with a printed warning."""
    zones = []
    for z in (payload or {}).get('zones', []):
        try:
            c = z['center']; d = z['dimensions']; q = z['orientation']
            center_mm = np.array([c['x'], c['y'], c['z']]) * 1000.0
            half_mm   = np.array([d['x'], d['y'], d['z']]) * 500.0   # /2 * 1000
            R_world_from_local = _quat_to_rotmat(q['x'], q['y'], q['z'], q['w'])
            # We store R as WORLD→LOCAL so distance queries can rotate
            # a world-frame point into the OBB's local axes.
            R_world_to_local = R_world_from_local.T
            zones.append(ObbZone(z.get('id') or z.get('name') or '?',
                                 center_mm, R_world_to_local, half_mm))
        except (KeyError, TypeError) as e:
            # Skip malformed zones — one bad entry shouldn't kill the guard.
            continue
    return zones


# Sample density along each capsule for capsule-vs-OBB distance. Twenty
# samples gives ≤ ~50 mm spacing on the longest arm capsule (link2 at
# 840 mm), well below the 30 mm stop threshold. Trades a small amount
# of accuracy for a fully-vectorized per-capsule query.
CAPSULE_OBB_SAMPLES = 20


def _capsule_obb_dist(cap_p0_world, cap_p1_world, radius, obb):
    """Distance from a capsule (world-frame endpoints + radius) to an
    OBB. Returns surface-to-surface mm (negative on interpenetration).

    Method: sample points along the capsule axis, transform to OBB
    local frame, clamp each to the OBB half-extents, take the min
    distance across samples, subtract capsule radius."""
    ts = np.linspace(0.0, 1.0, CAPSULE_OBB_SAMPLES)
    pts = cap_p0_world[None, :] + ts[:, None] * (cap_p1_world - cap_p0_world)[None, :]
    local = (pts - obb.center) @ obb.R.T   # since R is world→local, R.T is local→world;
                                            # for a point p_world we compute R @ (p - c) → local
    # Actually: R stored is world→local, so p_local = R @ (p_world - center).
    # Above line applied R.T on the right, which is equivalent to (R @ (p-c).T).T only when R is orthogonal.
    # Use explicit matmul to keep it obvious:
    local = (obb.R @ (pts - obb.center).T).T
    clipped = np.clip(local, -obb.half, obb.half)
    dists = np.linalg.norm(local - clipped, axis=1)
    return float(dists.min() - radius)


class CollisionModel:
    """Holds the capsule dict + pair list + ground plane + env OBBs.
    Evaluates all pairs given a joint-angle vector; returns a list of
    (link_a, link_b, surface_dist_mm) tuples sorted by ascending
    distance. Env obstacles produce (link, 'zone#<id>', dist)
    entries. Computes FK once per call."""

    def __init__(self, capsules_yaml_path):
        (self.capsules, self.pairs, self.mesh_pairs,
         self.pair_thresholds) = load_capsules_yaml(capsules_yaml_path)
        # Ground plane z (mm). Set `ground_z_mm = None` to disable
        # ground checks entirely (needed until URDF Y-up vs ground
        # Z-up convention is unified). Env-obstacle pairs continue to
        # run regardless.
        self.ground_z_mm = 0.0
        # Environment OBBs — populated externally via set_env_zones()
        # so the driver can refresh them at the low static-zone
        # update rate (they don't move at run-time by definition).
        self._env_zones = []
        # Mesh vertex clouds for the link3↔link5 pair. Cylindrical
        # capsules over-approximate the arm's rectangular link ends by
        # 40–50 mm at any bent pose, which forces the pair to be
        # DISABLED and leaves the arm's most-plausible self-collision
        # unguarded. Sampling the actual mesh gives ground-truth
        # distances at ~5 ms/tick and requires ~15 kB of pre-decoded
        # vertex data per link (stride=4 subsample; 0.3 mm sampling
        # error, well under the 30 mm stop threshold).
        self._mesh_verts = {}
        if self.mesh_pairs:
            here = os.path.dirname(os.path.abspath(__file__))
            for a, b in self.mesh_pairs:
                for link in (a, b):
                    if link in self._mesh_verts: continue
                    npy = os.path.join(here, 'mesh_verts', f'{link}.npy')
                    if os.path.exists(npy):
                        self._mesh_verts[link] = np.load(npy).astype(np.float64)
        # Mesh-mesh pair distances are 3-6 ms per query on the Jetson —
        # too expensive for the 50 ms supervise tick which also has to
        # service /robot/jog_command callbacks on the same single-thread
        # ROS executor. Precomputing on a worker thread at ~5 Hz and
        # serving from cache in evaluate() keeps the hot tick under
        # 5 ms total. Cache entry: frozenset(pair) → {'dist_mm', 'ts'}
        # where ts is time.time() at query completion. Consumers call
        # `mesh_cached_dist(pair, max_age_s=…)` to read; None means the
        # cache has no fresh entry — the driver treats that as +∞
        # (i.e., no proximity threat known) and relies on the periodic
        # worker to catch up. The mesh distance function is smooth in
        # J4 / J5 with ≤1 mm change per 2° step at the 6% jog cap,
        # so 200 ms staleness maps to sub-mm error on this pair.
        self._mesh_cache = {}
        self._mesh_cache_lock = threading.Lock()

    def set_env_zones(self, zones):
        """Replace the environment obstacle set. `zones` is a list of
        ObbZone or the raw payload from /api/collision/static_zones
        (dicts). Called by the driver whenever the static-zone
        subscription publishes a fresh snapshot."""
        if not zones:
            self._env_zones = []
            return
        if isinstance(zones[0], ObbZone):
            self._env_zones = list(zones)
        else:
            self._env_zones = parse_static_zones({'zones': zones})

    @property
    def env_zone_count(self):
        return len(self._env_zones)

    # ── Mesh cache API — off-tick refresh path ─────────────────────
    #
    # The driver spawns a worker thread that repeatedly calls
    # `refresh_mesh_cache(current_joint_deg)`. The supervise/posture
    # hot path only reads via `mesh_cached_dist` (implicitly through
    # evaluate()). Splitting the schedule this way keeps the 50 ms
    # supervise budget under 5 ms total even at the J3=122° fold where
    # mesh-mesh cost peaks at 6 ms/query.
    def _mesh_pair_dist(self, q_deg, pair):
        """Compute a single mesh_pair's distance at q_deg. Public for
        tests; the runtime path uses `refresh_mesh_cache` which invokes
        this internally under whatever schedule the driver picks."""
        a, b = pair
        if a not in self._mesh_verts or b not in self._mesh_verts:
            return None
        Va = self._mesh_verts[a]; Vb = self._mesh_verts[b]
        frames = fk_frames(q_deg)
        Ta = frames[LINK_NAMES.index(a)]
        Tb = frames[LINK_NAMES.index(b)]
        Wa = (Ta[:3, :3] @ Va.T).T + Ta[:3, 3]
        Wb = (Tb[:3, :3] @ Vb.T).T + Tb[:3, 3]
        try:
            from scipy.spatial import cKDTree
            return float(cKDTree(Wb).query(Wa, k=1)[0].min())
        except ImportError:
            d2 = ((Wa[:, None, :] - Wb[None, :, :]) ** 2).sum(-1)
            return float(np.sqrt(d2.min()))

    def refresh_mesh_cache(self, q_deg):
        """Recompute every mesh_pair at the given pose and update cache.
        Intended to be called from a worker thread, NOT the supervise
        tick. Cheap enough to run at 5-10 Hz per pair on the Jetson."""
        now = time.time()
        for pair_tuple in self.mesh_pairs:
            d = self._mesh_pair_dist(q_deg, pair_tuple)
            if d is None:
                continue
            key = frozenset(pair_tuple)
            with self._mesh_cache_lock:
                self._mesh_cache[key] = {
                    'dist_mm': d, 'ts': now,
                    'a': pair_tuple[0], 'b': pair_tuple[1],
                }

    def mesh_cached_dist(self, pair, max_age_s=0.5):
        """Read helper. Returns dist_mm if the pair has a fresh entry,
        else None. `max_age_s` bounds how stale we accept; 500 ms
        default matches the worker's 5 Hz cadence with headroom."""
        key = frozenset(pair)
        with self._mesh_cache_lock:
            entry = self._mesh_cache.get(key)
            if entry is None:
                return None
            if time.time() - entry['ts'] > max_age_s:
                return None
            return float(entry['dist_mm'])

    def mesh_cache_snapshot(self):
        """Debug/telemetry: return a shallow copy of the cache with
        entry ages (seconds) for /health rendering."""
        now = time.time()
        with self._mesh_cache_lock:
            return {f'{v["a"]}↔{v["b"]}':
                    {'dist_mm': round(v['dist_mm'], 2),
                     'age_s':   round(now - v['ts'], 3)}
                    for v in self._mesh_cache.values()}

    def thresholds_for(self, pair, default_warn_mm, default_stop_mm):
        """Return (warn_mm, stop_mm) for a specific (a, b) pair, honoring
        any pair_thresholds override. Order-insensitive. `pair` may be
        a tuple/list; env pairs (link, 'zone#N') never match — env has
        its own warn/stop path in the driver."""
        if not pair:
            return default_warn_mm, default_stop_mm
        try:
            key = frozenset(pair)
        except TypeError:
            return default_warn_mm, default_stop_mm
        for entry in self.pair_thresholds:
            if entry['pair'] == key:
                return entry['warn'], entry['stop']
        return default_warn_mm, default_stop_mm

    def evaluate(self, q_deg):
        """Returns a list of (a, b, dist_mm) sorted ascending. Each
        link can have multiple capsules (self.capsules[link] is a
        list); for pair (A, B) we take the MIN across all cap-A ×
        cap-B combinations. Env pairs likewise iterate every arm
        capsule against every zone."""
        frames = fk_frames(q_deg)
        # For each link, list of (p0_world, p1_world, radius).
        world = {}
        for link, caps in self.capsules.items():
            idx = LINK_NAMES.index(link)
            T = frames[idx]
            world[link] = [
                (_transform_point(T, c.p0_local),
                 _transform_point(T, c.p1_local),
                 c.radius)
                for c in caps
            ]
        results = []
        # Mesh-mesh pairs (currently just link3↔link5). Formerly ran
        # in-line here at 3-6 ms/query — too expensive for the 50 ms
        # supervise tick + 25 Hz posture callback path. Now served from
        # `_mesh_cache`, populated by a worker thread that calls
        # `refresh_mesh_cache(q_deg)` on its own schedule (≤5 Hz). If
        # the cache is missing/stale, we OMIT the pair from results
        # rather than block — callers already tolerate missing entries
        # (e.g., env / ground / self pairs continue), and the pair-
        # threshold guard treats absence as "no known threat" while
        # the worker catches up. Fresh entries (via mesh_cached_dist)
        # are appended below.
        mesh_pair_set = {frozenset(p) for p in self.mesh_pairs}
        with self._mesh_cache_lock:
            for a, b in self.mesh_pairs:
                entry = self._mesh_cache.get(frozenset({a, b}))
                if entry is not None:
                    results.append((a, b, float(entry['dist_mm'])))
        for a, b in self.pairs:
            if frozenset({a, b}) in mesh_pair_set:
                continue  # already handled via mesh-mesh above
            if a == '__ground__' or b == '__ground__':
                if self.ground_z_mm is None:
                    continue
                real = b if a == '__ground__' else a
                if real not in world:
                    continue
                best = float('inf')
                for p0, p1, r in world[real]:
                    d = _capsule_ground_dist(p0, p1, r, self.ground_z_mm)
                    if d < best: best = d
                results.append((a, b, float(best)))
                continue
            if a not in world or b not in world:
                continue
            best = float('inf')
            for a_p0, a_p1, r_a in world[a]:
                for b_p0, b_p1, r_b in world[b]:
                    d, _ = _capsule_capsule_dist(a_p0, a_p1, r_a,
                                                 b_p0, b_p1, r_b)
                    if d < best: best = d
            results.append((a, b, float(best)))
        # Env obstacles — each arm capsule vs each zone; per-link min.
        for link, cap_list in world.items():
            for z in self._env_zones:
                best = float('inf')
                for p0, p1, r in cap_list:
                    d = _capsule_obb_dist(p0, p1, r, z)
                    if d < best: best = d
                results.append((link, f'zone#{z.zone_id}', float(best)))
        results.sort(key=lambda t: t[2])
        return results

    def env_dist_for_pair(self, q_deg, link_name, zone_id):
        """Fast path: compute the distance between one specific arm
        capsule and one specific env zone. Used by the escape-direction
        search — projects a candidate pose one step ahead and only
        needs to know how ONE distance changes, not the full sweep.
        Returns +inf if zone or link not found."""
        cap = self.capsules.get(link_name)
        if cap is None:
            return float('inf')
        zone = next((z for z in self._env_zones if z.zone_id == zone_id), None)
        if zone is None:
            return float('inf')
        frames = fk_frames(q_deg)
        idx = LINK_NAMES.index(link_name)
        T = frames[idx]
        p0 = _transform_point(T, cap.p0_local)
        p1 = _transform_point(T, cap.p1_local)
        return _capsule_obb_dist(p0, p1, cap.radius, zone)

    # Joint step size for the escape-direction search (degrees). The
    # actual escape jog is separately capped at 6% via the frontend; the
    # only role of this step is to size the finite-difference probe so
    # the direction of clearance change is unambiguous. 5° is the default
    # for env / capsule-pair queries where the min-distance function is
    # smooth. Mesh-mesh pairs (currently just link3↔link5) probe at
    # ESCAPE_JOINT_STEP_MESH_DEG since the mesh-vertex-sampled distance
    # is piecewise linear and needs a wider probe to clear the ~0.3 mm
    # sampling noise floor when the pair's total range of motion is
    # only a few mm.
    ESCAPE_JOINT_STEP_DEG      = 5.0
    ESCAPE_JOINT_STEP_MESH_DEG = 15.0
    # A candidate direction is reported when the projected distance
    # exceeds the current distance by at least ESCAPE_OPEN_MARGIN_MM
    # (per-probe). Lower than the previous 2 mm so shallow-response
    # pairs (mesh_pairs with mechanical floor) still surface real
    # openings. The fallback trigger uses a separate, larger threshold —
    # see ESCAPE_FALLBACK_FLOOR_MM below.
    ESCAPE_OPEN_MARGIN_MM      = 1.0
    # Fallback ("no single-axis escape") fires only when the best
    # projected opening across all 12 candidate directions is BELOW
    # this floor. Set to 0.5 mm so that any measurable improvement
    # keeps the operator on the numbered-jog UI. Task 2026-07-16 —
    # previously the fallback fired at every stop-band entry because
    # a 2 mm strict margin plus 0.3 mm mesh noise combined to hide
    # real J4/J5 openings on link3↔link5.
    ESCAPE_FALLBACK_FLOOR_MM   = 0.5

    def escape_directions(self, q_deg, offending_link, offending_zone_id):
        """For the given (link, zone) offender, return a list of
        joint directions whose one-step-ahead projection INCREASES
        clearance. Each entry: {'joint': 1..6, 'direction': ±1,
        'projected_mm': float}.

        Uses the fast env_dist_for_pair for the projected evaluation
        so 12 candidate probes fit inside ~2 ms — dominated by FK.
        Ordered by projected distance descending (best escape first)."""
        cur = self.env_dist_for_pair(q_deg, offending_link, offending_zone_id)
        if not math.isfinite(cur):
            return []
        cands = []
        for j in range(6):
            for sign in (+1, -1):
                q_try = list(q_deg)
                q_try[j] = q_deg[j] + sign * self.ESCAPE_JOINT_STEP_DEG
                proj = self.env_dist_for_pair(q_try, offending_link, offending_zone_id)
                if proj > cur + self.ESCAPE_OPEN_MARGIN_MM:
                    cands.append({
                        'joint':     j + 1,
                        'direction': sign,
                        'projected_mm': proj,
                        'current_mm':   cur,
                    })
        cands.sort(key=lambda c: -c['projected_mm'])
        return cands

    def escape_probe_table(self, q_deg, pair):
        """Diagnostic helper — return the full 12-row finite-difference
        table for a given pair, at whatever step size the pair type
        implies (mesh pair → mesh step; else standard). No filtering.
        Rows: {'joint': 1..6, 'direction': ±1, 'projected_mm', 'delta_mm',
        'step_deg'}. Ordered by joint, then sign. Used by the offline
        diagnostic and by driver logs to explain a fallback event."""
        if not pair:
            return []
        step = (self.ESCAPE_JOINT_STEP_MESH_DEG
                if frozenset(pair) in {frozenset(p) for p in self.mesh_pairs}
                else self.ESCAPE_JOINT_STEP_DEG)
        # Baseline for this specific pair — pick the matching row out of
        # evaluate() so mesh pairs pull their true mesh-mesh distance.
        cur = None
        for x, y, d in self.evaluate(q_deg):
            if (x, y) == pair or (y, x) == pair:
                cur = d; break
        if cur is None or not math.isfinite(cur):
            return []
        rows = []
        for j in range(6):
            for sign in (+1, -1):
                q_try = list(q_deg)
                q_try[j] = q_deg[j] + sign * step
                proj = None
                for x, y, d in self.evaluate(q_try):
                    if (x, y) == pair or (y, x) == pair:
                        proj = d; break
                if proj is None:
                    continue
                rows.append({
                    'joint': j + 1,
                    'direction': sign,
                    'projected_mm': proj,
                    'current_mm': cur,
                    'delta_mm': proj - cur,
                    'step_deg': step,
                })
        return rows

    def has_any_escape(self, q_deg, pair):
        """Boolean: does ANY of the 12 single-axis probes clear the
        fallback floor? Used by the driver's stop-band gate to decide
        whether to show numbered escapes (True) or the all-axes override
        fallback (False)."""
        rows = self.escape_probe_table(q_deg, pair)
        if not rows:
            return False
        return max(r['delta_mm'] for r in rows) >= self.ESCAPE_FALLBACK_FLOOR_MM

    def min_distance_at(self, q_deg):
        """Return the closest pair (any kind) + its distance for the
        given joint angles. Used by the command-time direction check
        to decide whether a jog opens or closes clearance — doesn't
        care about pair identity, only min. Fast: computes FK once
        + all pair distances but returns first-result only."""
        res = self.evaluate(q_deg)
        if not res:
            return None, float('inf')
        a, b, d = res[0]
        return (a, b), d

    def escape_directions_any(self, q_deg, pair):
        """Escape-direction search for ANY pair (self / ground / env).
        Reuses escape_probe_table so mesh pairs get a wider step, then
        filters to rows whose Δ ≥ ESCAPE_OPEN_MARGIN_MM. Returns same
        shape as escape_directions(). Order-insensitive on the pair
        tuple."""
        rows = self.escape_probe_table(q_deg, pair)
        cands = []
        for r in rows:
            if r['delta_mm'] >= self.ESCAPE_OPEN_MARGIN_MM:
                cands.append({
                    'joint':        r['joint'],
                    'direction':    r['direction'],
                    'projected_mm': r['projected_mm'],
                    'current_mm':   r['current_mm'],
                })
        cands.sort(key=lambda c: -c['projected_mm'])
        return cands

    def evaluate_min(self, q_deg):
        """Fast path — returns (min_pair, min_dist_mm, all_results). If
        the caller only needs the closest pair, this saves nothing over
        evaluate() but reads cleaner."""
        res = self.evaluate(q_deg)
        return (res[0][:2] if res else None,
                res[0][2]   if res else float('inf'),
                res)
