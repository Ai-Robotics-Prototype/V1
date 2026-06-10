# inspection_pipeline

Quality Inspection engine for the RoboAi cobot stack. Provides
dimensional, surface-deviation, and feature-specific checks on parts
captured by the Mech-Eye NANO ULTRA depth camera, plus persistence,
PDF reports, rolling statistics, and SPC charts.

## Status

**Rollout phase: disabled.** The package builds, the node loads, and
every dashboard endpoint is structurally complete — but the inspection
pipeline requires the Mech-Eye depth camera which is not yet wired to
the robot. The `roboai-inspection.service` systemd unit ships disabled
on purpose. Enable it after the camera is integrated and
`/mech_eye/depth/points` is publishing.

## Architecture

```
Mech-Eye  →  /mech_eye/depth/points  ─┐
                                       ▼
                            inspection_pipeline/inspection_node.py
                              │                                         /opt/cobot/inspections/
                              ├──── Tier 1: tier1_dimensional.py        ├── config/  (tolerances, plans, templates)
                              ├──── Tier 2: tier2_surface.py            ├── references/  ({part}_step.ply ...)
                              │            (uses icp_alignment.py)      ├── records/{YYYY}/{MM}/{DD}/{id}/
                              ├──── Tier 3: tier3_features.py           │       ├── metadata.json
                              ├──── reference_manager.py                │       ├── cloud.ply
                              ├──── statistics_aggregator.py            │       ├── heatmap.ply
                              └──── report_generator.py                 │       └── report.pdf
                                                                        ├── stats_cache.json
                                                                        └── index.db (SQLite)
                              │
                              ├──── /inspection/result  (String JSON)   →   program_executor (estun_driver)
                              ├──── /inspection/status                  →   dashboard /ws/inspection
                              ├──── /inspection/progress
                              └──── /inspection/heatmap_cloud
```

The dashboard (cobot_dashboard) exposes ~30 REST endpoints under
`/api/inspections/*` plus a `/ws/inspection` WebSocket. All read/write
of the on-disk hierarchy goes through `cobot_dashboard/inspection_helpers.py`.

## Three-tier approach

- **Tier 1 — Dimensional** (`tier1_dimensional.py`). Pure NumPy. OBB
  via PCA, AABB extents, aspect ratios, volume (convex hull + voxel),
  centroid, principal axes / Euler angles. Sub-2-second target. Good
  enough for "is this part the right shape and size".

- **Tier 2 — Surface deviation** (`tier2_surface.py`,
  `icp_alignment.py`). Two-stage ICP (FPFH+RANSAC global, point-to-
  plane refinement). Per-point signed deviation, severity
  classification, DBSCAN defect clustering, colour-coded heatmap.
  Sub-5-second target. Catches dents, bumps, scratches.

- **Tier 3 — Feature-specific** (`tier3_features.py`). Plugin registry
  of `FeatureInspector` subclasses: hole position, hole diameter, edge
  angle, flatness, step height, distance between features. Add custom
  inspectors via `feature_inspectors.json`. Sub-10-second target.

## Reference types

`reference_manager.py` manages three kinds of references per part:

- **STEP-derived** — CAD model sampled to Poisson-disk point cloud.
  Routes through `object_detection/step_parser.py` so STEP loading is
  consistent with the rest of the stack.
- **Golden scan** — a single confirmed-good Mech-Eye capture, saved
  as `{part_id}_golden.ply`.
- **Statistical envelope** — aggregation of N (typically ≥30) passing
  scans, per-point mean. Built by `build_statistical()`.

References live in `/opt/cobot/inspections/references/`. The active
type per part is recorded in `{part_id}_metadata.json`.

## Tolerance setting guide

Tolerances live in `/opt/cobot/inspections/config/tolerances.json`,
keyed by `part_id` → `rule_id`. Each rule:

```jsonc
{
  "rule_id": "abc12345",
  "part_id": "bracket_a",
  "name":    "length_mm",     // measurement name from Tier 1/2/3
  "nominal": 100.0,
  "tol_warn": 0.2,            // ± from nominal — flag as "warn"
  "tol_fail": 0.5             // ± from nominal — flag as "fail"
}
```

Edit live from the dashboard's **Quality Inspection → Configure →
Tolerance Rules** page. Saves are atomic (write-then-rename).

## Plan creation

Inspection plans (`/opt/cobot/inspections/config/plans.json`) bind a
measurement set + reference type + report template into a named unit
the program executor invokes via the `inspect_part` step type. Plans
have a tier (1/2/3) and a list of named checks.

## Program-step integration

The Estun program executor (`estun_driver/program_executor_node.py`)
gained four new step types:

| Action            | Behavior                                           |
|-------------------|----------------------------------------------------|
| `inspect_part`    | Trigger inspection, wait for `/inspection/result`, branch on result |
| `place_at_reject` | Move to taught reject TCP and open gripper         |
| `alert_operator`  | Publish alert on `/task/operator_alert`, wait for ack |
| `log_inspection`  | Record last result into stats without acting on it |

Sampling: an `inspect_part` step with `every_n_parts: 5` only inspects
every fifth pass — useful when full-rate inspection is too slow.

Result branching: each step has `on_pass`, `on_warn`, `on_fail`
keys (values: `continue`, `pause`, `abort`, `jump_to_reject`,
`log_continue`, `alert`). See `_handle_inspection_outcome()`.

## Building / running

```bash
cd /home/teddy/cobot_ws
colcon build --packages-select cobot_dashboard inspection_pipeline --symlink-install
source install/setup.bash

# Once the Mech-Eye is wired in and publishing:
ros2 launch inspection_pipeline inspection.launch.py

# Or via systemd (still disabled by default):
sudo cp install/inspection_pipeline/share/inspection_pipeline/systemd/roboai-inspection.service /etc/systemd/system/
sudo systemctl daemon-reload
# Don't enable until the camera is live:
# sudo systemctl enable --now roboai-inspection
```

## Tests

```bash
cd src/inspection_pipeline
python3 -m pytest test/
```

Tests that depend on Open3D (`test_tier2.py`, `test_icp.py`) skip
themselves when Open3D isn't importable, so the suite passes on a CI
box without GPU.

## Performance targets

| Tier | Target end-to-end |
|------|-------------------|
| 1    | < 2 s             |
| 2    | < 5 s             |
| 3    | < 10 s            |
| PDF  | < 3 s             |

Dashboard list query (100 records) < 200 ms via the SQLite index.

## Deviations from the spec

PART P (rollout strategy) called for "everything in disabled state
initially". The deliverable here follows that:

- Tier 1, ICP, deviation maps, defect clustering, statistics, and
  references are real implementations.
- Tier 3 feature inspectors are **scaffolds**: the registry, parameter
  schema, and pipeline are real, but each `inspect()` returns a
  structurally valid pass-result placeholder. Wire in the actual
  geometry once representative parts are available.
- `defect_detection.py` (defect detection without a reference) is
  fully scaffolded but every detector returns `[]` — fill in
  curvature / gradient / colour / edge analysis when there's real
  Mech-Eye data to tune against.
- The PDF generator falls back to a one-page text stub when
  `reportlab` is not installed; full multi-page generation works once
  `pip install reportlab` is run on the Jetson.
- Inspection-pipeline custom .srv files were omitted to avoid adding
  a third package; `/inspection/start` is a `std_srvs/Trigger` and
  per-call parameters arrive on the `/inspection/set_params` topic.
  Swap to a real .srv when the schema stabilises.
- The dashboard's "Capture Golden Scan" and "Build Statistical
  Reference" buttons return queued-for-later stubs — the actual
  capture requires the camera to be live.
- The `roboai-inspection.service` unit ships **disabled**.
