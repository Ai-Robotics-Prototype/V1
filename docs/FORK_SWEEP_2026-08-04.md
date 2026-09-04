# Fork sweep — 2026-08-04

**Trigger:** §465 fork-1 (`validatePalletFrame` frontend duplication of
`pallet_geometry.compute_frame`). Post-incident directive: fork
detection becomes a standing gate, not a reactive patch.

**Method:** `tools/fork_lint.py` — registry mode + heuristic mode.
Registry patterns fail the gate; heuristic hits require triage.

## Registry-mode results (gate)

`python3 tools/fork_lint.py`
→ **0 findings**, exit 0.

Every capability in `tools/fork_registry.yaml` (12 entries) resolves
to its canonical owner, and no forbidden-path pattern fires. Details:

| # | Capability | Canonical | Enforcement |
|---|---|---|---|
| 1 | `pallet_frame_geometry` | `programming_by_demonstration.pallet_geometry` + `POST /api/pallet/validate_frame` | 6 forbidden patterns on frontend |
| 2 | `motion_verb_catalogue` | `estun_driver.program_ops.motion_verbs` + `luaenginelib.json` | Hard-coded verb-list patterns |
| 3 | `program_selection_write` | `POST /api/estun/program/run` + `dashboard_server:5491` | `action:'load'` retirement + single-writer |
| 4 | `load_outcome_operator_copy` | `frontend/src/lib/loadOutcome.js` | Parallel-switch patterns |
| 5 | `toast_rendering` | `frontend/src/components/ToastContainer.jsx` | Manual title+detail concatenation |
| 6 | `run_state_derivation` | `frontend/src/lib/runState.js` | Parallel state-kind classification |
| 7 | `load_must_push` | `MonitorDashboard.jsx:onSelectProgram` | `action:'load'` in any frontend file |
| 8 | `pending_pose_gate` | `estun_driver.program_ops.check_program_pending_poses` | Parallel taught-check scans |
| 9 | `mov_arity_gate` | `program_ops.lint_lua_source` matchers | Parallel token-count on mov* |
| 10 | `codegen_line_map` | `codegen_lua_from_program` + `_compute_and_save_line_map` | Frontend Lua re-parsing |
| 11 | `pallet_frame_status` | `frontend/src/lib/programTruth.js:palletFrameStatus` | Parallel taught-booleans |
| 12 | `estun_axis_sign_inversion` | `estun_driver_node` sign helpers | Bare `joints[2] = -joints[2]` outside canonical |

## Heuristic-sweep results

`python3 tools/fork_lint.py --heuristic-only --report`
→ **0 findings**, exit 0.

The frontend does no numeric math on domain identifiers (`corner_tcp`,
`taught_joints`, `taught_tcp`, `jp`, `cp`, `part_tcp`, etc). This is
the state IMMEDIATELY POST §465 fork-1 kill — the pallet frame fork
was the only site.

Grandfathered files (see `heuristic_sweep.known_ok`):

- `src/cobot_dashboard/frontend/src/lib/orient.js` — wrist orientation
  math (SE(3) general, not pallet/TCP; backend does not own).
  Owner: robot-driver.
- `src/cobot_dashboard/frontend/src/components/IKGizmo.jsx` — 3D-viewer
  IK preview gizmo (visualization only, no operator verdict / motion
  decision). Owner: perception-ui.

Manual grep on the full frontend for `Math.(acos|hypot|sqrt)` +
domain-identifier co-occurrence confirms zero hits outside the two
grandfathered files.

## Triage

- **Criticals (fixed in-commit before this sweep):** 0. The §465
  fork-1 fix at `3ae0760` cleared the only critical hit.
- **Cosmetics (registry known-debt):** 0.
- **Grandfathered:** 2 (see above).

## Gate wiring

- Local: `python3 tools/fork_lint.py` (exit 1 on any registry hit).
- Pre-commit: `.githooks/pre-commit` (installed via
  `scripts/install_git_hooks.sh`).
- Auto-deploy: `scripts/deploy.sh` runs the lint before the doctrine
  gate. Failure emits a `phase="lint_failed"` entry to
  `/opt/cobot/deploy_log.jsonl` and exits non-zero — a fork
  literally cannot deploy.

## Lesson 180 (the reason this file exists)

Tooling enforces. Documentation describes. The registry IS the
documentation; the linter IS the enforcement. Both land in the same
commit so they never drift out of sync. When a new fork emerges,
the fix is a registry entry + a canonical owner — not a bug ticket
and a promise.
