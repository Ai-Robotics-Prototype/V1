# UI Truthfulness Audit — 2026-07-30

Motivated by five consecutive UI-lies incidents today:
1. `waitCondition(false,N)` shown as a legal emission in the verb reference — wasn't.
2. System Check "green because nothing to compare" while served bundle was stale.
3. `computeLineMap` treating each step as one Lua line — codegen emits many.
4. "MOVE LINEAR" tag shown for a step the invariant emits as `movJ`.
5. Codegen staleness caught in every run manifest, surfaced nowhere the operator looked.

The three patterns:

- **PATTERN 1 — duplicate resolvers**: the frontend re-derives what the backend
  already resolves.  Any "own copy" is a latent lie.
- **PATTERN 2 — labels that diverge**: user-visible strings computed from step
  type / cached state / absence-of-data instead of the authoritative value.
- **PATTERN 3 — controls that don't exist/don't act**: fields the operator
  can't reach OR reaches but nothing binds/persists/takes effect.

Severities:
- **LIES** — the UI asserts a false thing right now.  Fix in-session.
- **STALE** — the UI is correct most of the time but has a divergence window.
  Fix once LIES are cleared.
- **MISSING** — the operator can't set/see something they need to.  Queue.

---

## PATTERN 1 — Duplicate resolvers

### #P1-1 · LIES · `computeLineMap` claims 1 line per step; codegen emits many
**File**: `src/cobot_dashboard/frontend/src/lib/runState.js:190`

`computeLineMap` returns one `emittedLine` per step, incrementing by 1.  Real
codegen (`estun_driver/program_ops.py`) emits variable line counts per step:
`setSpeedJ/setSpeedL/setAccL` preludes, `-- motion_check ADAPTED` comments,
`-- WRIST-LOCK FALLBACK` comments, seeded-IK descent-split intermediates.

**Impact**: the `StepPreviewPanel` highlights the WRONG step during any run
that touches motion-vocab modal state (i.e., every real program).

**Fix**: replace `computeLineMap` with a call that consumes the SAME line
mapping codegen produces.  Concretely: expose `codegen_lua_from_program`'s
`step_index_by_line` (which the code already builds internally via the walker)
via a new endpoint `GET /api/programs/{id}/line_map`, and have
`stepIndexForLine` fetch/cache it.  Delete the frontend's parallel walker.

### #P1-2 · LIES · Taught-count forked three ways
**Files**:
- `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx:3090`
  (`untaughtCount = steps.filter((s) => isTeachable(s) && !s.taught).length`)
- `src/cobot_dashboard/frontend/src/components/RunProgramModal.jsx:77`
  (`point_name→joints[6] OR taught_joints[6]`)
- `src/cobot_dashboard/frontend/src/pages/MonitorDashboard.jsx:899`
  (identical to RunProgramModal, duplicated)

Backend truth (`dashboard_server.py:_has_taught_poses`, exposed on GET
`/api/programs/{id}` as `has_taught_poses`) counts a step taught when any of:
(a) `point_name`→`points[pn].joints.length===6`,
(b) 6-el `taught_joints` with `taught:True`,
(c) `derived_from` role that's inline-taught elsewhere in the program,
(d) non-motion actions (set_io/wait/loop/gripper/…),
(e) legacy `type:'gripper'`.

**Impact**: Editor overcounts untaught steps (marks (c) and (d) as untaught).
Run/Monitor undercount by missing (c) — a program with a derived approach can
render "0 taught" and the Run button greys itself out even though codegen would
happily emit it.

**Fix**: Create `src/cobot_dashboard/frontend/src/lib/programTruth.js` with a
single `isStepRunnable(step, points)` mirroring backend `_has_taught_poses`
step-by-step, plus `runnableStepCount(program)` and `untaughtStepIds(program)`.
Editor, Run modal, Monitor all import these.  Update `useStore` hydrator to
consume server's `has_taught_poses` when present.

### #P1-3 · STALE · `hasPositionData` accepts any-length arrays
**File**: `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx:441`

Renders "View position data" for any step with a truthy-length
`taught_joints` / `taught_tcp` / `joints` / `position` / `taught_at`.  Codegen
respects only 6-element arrays; showing a partial array as "position data"
lets the operator believe malformed teach data is captured.

**Fix**: same helper as #P1-2, `hasFullTaughtPose(step)` returns True only
for 6-el arrays.  Rename the drawer to hide when there's no valid pose.

### #P1-4 · STALE · Speed derivation copied five ways
**Files**: `pages/MonitorDashboard.jsx:1410, 1454, 1565, 1624`;
`components/RunProgramModal.jsx:95`.

All compute `capPct = Math.max(1, Math.min(100, Math.round(capFrac * 100)))`
plus `effectivePct = Math.max(1, Math.min(capPct, req))`.  Identical logic,
identical values as of today — but any drift (e.g., a 5% floor added in one
place only) would silently mismatch the confirm modal from the outer button.

**Fix**: `lib/speedTruth.js` — `effectivePct({operatorCapFrac, requestedPct})`.
All five sites import from there.  Zero behavior change today; kills future drift.

### #P1-5 · STALE · IO port name display uses shared helper (GOOD)
**File**: `src/cobot_dashboard/frontend/src/lib/ioPortmap.js`

`portmapLabels(pm)` is the single derivation.  `ProgramEditor.detailLine`'s
`ioName()` closes around `ioLabels` from `useIOPortmap`.  Also used by the
`IOPortMap.jsx` panel.  No fork detected.  *No fix.*

### #P1-6 · STALE · Payload display via `readPayload` (GOOD)
**File**: `src/cobot_dashboard/frontend/src/lib/payload.js`

Both `MonitorDashboard.jsx:1793` and `RunProgramModal.jsx:210` consume the
same `readPayload(program)` helper.  *No fix.*

---

## PATTERN 2 — Labels that diverge from reality

### #P2-1 · LIES · `TypeChip` label from step.action, not emitted verb
**Files**:
- `src/cobot_dashboard/frontend/src/components/ProgramPanel.jsx:35-46, 84`
  (TypeChip receives `step.type` which is `'move'` for every motion action)
- `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx:21`
  (`{ value: 'move_linear', label: 'Move Linear', tag: 'MOVE' }`)

Displays "MOVE LINEAR" for `action:'move_linear'` — but codegen emits `movJ`
when: analyzer rule 2e (awkward_wrist_transit, wrist Δ>30°); the step is a
derived retreat (joint-space by design under the columns-cartesian
invariant); path-feasibility fallback; wrist-lock guard.  See today's
`46d55fe` commit and `docs/estun_lua_reference.md`.

**Impact**: operator reads "linear" but the arm arcs 200mm through joint space.

**Fix**: expose the emitted-verb table alongside `has_taught_poses` on
GET `/api/programs/{id}`.  Backend already computes it during codegen — just
persist the last-computed table (short-lived cache keyed by program id + rev).
Frontend TypeChip / detailLine consume `verbForStep(program, idx)` from
`lib/programTruth.js`, which reads that table when present and falls back to
`step.action` with an "expected" qualifier when the program hasn't been
codegen'd yet.

### #P2-2 · LIES · `doneCount` counts `steps.filter(s => s.status === 'done')` — nothing ever sets it
**Files**:
- `src/cobot_dashboard/frontend/src/components/ProgramPanel.jsx:324`
- `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx:3218`

Grep for `status: 'done'` / `.status =` anywhere in the store or event
handlers: **zero writes**.  Both progress bars are always at 0 during a real
run.  The visible "0 / N" is a silent lie.

**Fix**: derive `doneCount` from `robot.program.line` via `stepIndexForLine`
(once #P1-1 is fixed) OR from `task.program_step` (executor sim path).
Same helper both progress bars import.

### #P2-3 · LIES · System Check "Software" returned green when built dist absent
**File**: `src/cobot_dashboard/cobot_dashboard/dashboard_server.py:3464-3468`
(fixed at commit `6d70920` earlier today — now returns amber "Cannot verify").

Recorded here so the pattern is not repeated: **never return green when the
comparison is impossible**.

### #P2-4 · STALE · `saveStatus === 'saved'` masks legitimate 'unsaved'
**File**: `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx:3822-3824`

`{saveStatus === 'saved' ? 'Saved' : unsaved ? 'Save' : 'Saved'}` — the
final fallback is `'Saved'` regardless of whether a save has ever happened
this session.  Fresh-load with clean form shows "Saved".  Cosmetic but
misleading.

**Fix**: fall-through to `''` (empty state) rather than `'Saved'` when no
save has occurred; only assert "Saved" when a save round-trip succeeded.

### #P2-5 · STALE · AlarmRecoveryModal fall-through 'Ready' label
**File**: `src/cobot_dashboard/frontend/src/components/AlarmRecoveryModal.jsx:119`

`enabled_confirm` phase ends with unconditional `'Ready'`.  Correct in the
happy path; if `robot.enabled` flaps between the message being computed and
render, the label lies for one frame.  Low-severity race.

**Fix**: guard the label on `robot.enabled === true` at render time.

### #P2-6 · STALE · Loop-count implied by `action:'loop'` but not surfaced
**File**: `src/cobot_dashboard/frontend/src/components/ProgramEditor.jsx` (search: `action: 'loop'`)

`step.count` (loop iteration count) is set by the wizard but not shown in
the editor's step row.  Program with `count:5` renders as "LOOP" — operator
has no way to know it's a 5-cycle loop vs continuous vs 1-cycle no-op.
Codegen emits three different Lua shapes per count.

**Fix**: add `count` to `detailLine` — "LOOP · 5×" / "LOOP · continuous".

---

## PATTERN 3 — Controls that don't exist or don't act

| Control | Backend endpoint | Frontend UI | Persists? | Takes effect? | Verdict |
|---|---|---|---|---|---|
| Motion profile (per-program) | ✓ `PUT /api/programs/{id}/motion_profile` (name, motion_optimization_enabled, motion_profile_override_enabled) | **NONE** after wizard | — | — | **MISSING** |
| Adaptations on/off (per-program) | Read via GET, honored by codegen (`adaptations_enabled`) | **NONE** | — | — | **MISSING** |
| Payload (per-program) | ✓ POST/PUT `/api/programs/{id}` | Wizard only | ✓ | ✓ | STALE (need editor field) |
| Jog style STEP/CONTINUOUS | client state only | JogControls toolbar buttons | in-memory only (comment: no localStorage) | ✓ | OK but non-persistent (documented) |
| Speed-cap (operator) | Driver-owned, read via `/estun/mode` | Read-only display | — | — | READ-ONLY (correct) |
| System Check panel | `/api/systemcheck` | Configure sub-section | — | ✓ | OK |
| Cell activate/delete | ✓ | ConfigureLayout | ✓ | ✓ | OK |
| Deploy/restart services | ✓ (limited allowlist) | `scripts/deploy.sh` (CLI); System Check has `/service/restart` for dashboard only | — | ✓ | OK |
| Descent gentle-mode (per-program) | Read via codegen config; no direct endpoint | **NONE** | — | — | MISSING |
| Blend preset (fine/medium/smooth) | Read via codegen config | **NONE** | — | — | MISSING |

**Impact of MISSING items**: today the operator can't switch a program
from Balanced to Aggressive without re-running the wizard or hand-editing
the JSON.  They can't turn analyzer adaptations off on a specific program
if the auto-forced motion_profile is wrong for their scene.

### #P3-1 · MISSING · Motion profile selector
`PUT /api/programs/{id}/motion_profile` exists and takes `profile_name`,
`motion_optimization_enabled`, `motion_profile_override_enabled`.  Add a
"Motion" section to the Program editor.  Estimated: 1 component, ~40 lines
JSX + 1 store action.

### #P3-2 · MISSING · Adaptations on/off
Same section as #P3-1 (they belong together).

### #P3-3 · MISSING · Blend preset / descent gentle-mode
Deferred until #P3-1 lands — same section.

---

## Fix order (severity × operator impact)

Fix now (this session, LIES only):
1. **#P1-2 taught-count unification** — the today-bug.  Blocks all others.
2. **#P1-1 line map** — fetch from backend, retire the frontend walker.
3. **#P2-1 emitted-verb chip** — depends on #P1-1 landing the endpoint.
4. **#P2-2 doneCount source** — derive from `robot.program.line` +
   step-index lookup once #P1-1 lands.

Queued (STALE + MISSING):
5. #P1-3 six-element enforcement
6. #P1-4 speedTruth extraction
7. #P2-4 saveStatus empty state
8. #P2-6 loop-count in detail line
9. #P3-1..#P3-3 motion profile / adaptations / blend UI

## Permanent guard

Add ESLint / vitest rule (see `frontend/scripts/no-fork-truth.mjs`
below) that fails CI when a component under `src/components/` or
`src/pages/` references `taught_joints`, `move_linear`/`move_home`, or
`emittedLine` directly *without* importing from `lib/programTruth.js`
(the shared resolver).  New code physically can't fork the truth again.
