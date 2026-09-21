# §396 Follow-up — Mesh Convex-Hull Self-Collision Model

## Status

Queued. Deferred behind the 2026-07-31 operator directive that
disabled the warn-zone jog gate and shrank the hard-stop threshold
to 15 mm. Those two changes are TEMPORARY — the guard's authority
can only come back when the model stops lying.

## The problem the current model has

The capsule-based self-collision model (`config/self_collision_capsules.yaml`)
represents each URDF link as a single cylinder-with-hemispherical-endcaps
fit around the link's mesh. The fit is padded 12 mm above the raw
maximum radius to leave a safety margin.

For links with rectangular / flat-ended geometry — specifically
`link3_forearm` and `link5_wrist2` on the Estun S10-140 — a single
cylindrical fit **over-approximates the true clearance by 30–50 mm**
at every arm pose, including HOME. The mesh clearance at those
poses is a designed 46.8 mm; the capsule model reports 0 or negative
distances.

The link3↔link5 pair is already handled via a mesh-mesh evaluator
(`mesh_pairs:` in the YAML), but every OTHER pair still uses
capsules. Any operator jog near a bend pose walks straight into
the same over-approximation on those pairs and gets denied.

Field evidence (2026-07-31):
- `guard_pair: [link3_forearm, link5_wrist2]`
- `guard_min_mm: 48.87` — the mesh-mesh pair, correctly reporting
  the designed 46.8 mm floor plus tiny FK noise.
- Operator physically verified the arm was in a safe pose. Jogs
  were being throttled by the driver's warn-zone escape cap (6%
  speed even in the warn band) — that's the immediate blocker
  the operator directive removed.

The mesh-mesh evaluator solves link3↔link5 today. But its cost
scales with pair count × vertex count, and expanding it to every
pair on every tick is too expensive.

## The follow-up

Replace the capsule-per-link representation with a **convex hull
per link**, computed from the viewer GLB meshes. Convex hulls
give:

1. **Tight geometric bound** — a convex hull of a flat-ended link
   is a flat-ended convex polyhedron, not a cylinder-with-hemispheres.
   No 30-50 mm phantom slab.
2. **Fast collision queries** — GJK / EPA on convex hulls is
   O(m + n) per pair where m, n are vertex counts, and vertex
   counts are ~30-100 per hull. Well within the 200 ms sweep budget.
3. **Same source of truth as the 3D viewer** — the operator sees
   what the guard is checking. When the operator can see the arm's
   real shape in the 3D twin AND the guard uses that same shape,
   the "the model is lying" trust break can't recur.

## Implementation sketch

1. **Extract hulls from GLBs.** Add a `scripts/build_link_hulls.py`
   that reads each link's viewer GLB, runs `scipy.spatial.ConvexHull`
   over the vertex cloud, and writes the hull vertices + faces to
   `config/self_collision_hulls/<link>.npz`. Emit at build time
   OR on first run when the file is missing.

2. **Extend the collision evaluator** (`src/estun_driver/estun_driver/collision.py`)
   with a `HullPair` variant that runs GJK per pair per tick. The
   existing `MeshPair` used for link3↔link5 gives a working reference
   for the pair-evaluator plugin shape.

3. **Deprecate `capsules:`** in the YAML in favor of `hulls:` for
   every arm-link pair. Keep the ground-plane pseudo-body as a
   half-space test (no hull needed). Keep the config's
   `pair_thresholds:` override mechanism.

4. **Grow the thresholds back.** Once every pair reports the true
   clearance (measured against 10k FK sweep + a physical
   validation set), lift the stop threshold from the current
   15 mm back to something like 25-30 mm — a real margin, not a
   compensation for model padding.

5. **Re-enable the jog gate in the warn band** — carefully. The
   directive that killed it was justified by "the model was lying
   30 mm"; when the model doesn't lie, a light warn-zone throttle
   (say cap at 60% while dist ≤ 50 mm) may be worth re-adding.
   Operator decides.

6. **Re-enable warnings by default.** The current default-OFF for
   the warn banner is a trust decision; when the guard stops
   crying wolf, the operator can flip it back to default-ON.

## Acceptance criteria

- Every arm-link pair reports mesh-accurate distances (±1 mm vs
  the mesh-mesh evaluator on a 10k random-pose sweep).
- Sweep runtime stays under 200 ms per tick on the Jetson.
- Field test: operator confirms no phantom stop across the
  cell's standard teach envelope.
- Doctrine D10 stays satisfied — the guard's copy still names
  what it can/can't observe.

## Not in scope

- Environment obstacles (LiDAR zones) — those already use raw
  point-cloud arithmetic and aren't part of the capsule problem.
- Ground-plane guard — half-space, no hull.
- Direction-aware suppression math (the "opening projection"
  logic) — that carries over unchanged.

## Prior art

- `config/self_collision_capsules.yaml` — the model this replaces,
  including the `mesh_pairs:` list that proved the mesh approach
  works for link3↔link5.
- `scripts/fit_capsules.py` / `scripts/fit_multi_capsules.py` —
  the current fitters. The new `build_link_hulls.py` follows their
  file conventions.
- `src/estun_driver/estun_driver/collision.py` — the runtime
  evaluator with `MeshPair` and `CapsulePair` variants side by side.
  `HullPair` plugs into the same interface.

## Sequencing note

Ship this when the operator says "next time we sit down with the
cell". Not urgent — the 15 mm threshold + operator override is
adequate cover. But every doctrine day at reduced guard authority
is a day the invariant "the screen never asserts state it can't
back with a real measurement" is running on a temporary allowance.
