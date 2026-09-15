# OEM Parity — Phase 0 Takeover Roadmap

Working strategic doc that drives the next several build cycles. Goal:
**NeuRobots owns every operator- and integrator-facing function; the
Estun controller is a commodity motion-execution endpoint we drive
over the wire; the factory UI is never opened in normal operation.**

Provenance: the verb inventory (§2) is extracted from the shipped
factory UI bundle at `/tmp/estun_ui_js/*.js` (10 chunks, ~2.4 MB
minified). Status per verb is cross-referenced against the HAR at
`data/estun_captures/estun_moves_20260720.har` (29,838 WS frames,
2026-07-20) and against the live driver + dashboard code on the
`feature/estun-write-path` branch at the commit listed below.

---

## Executive summary

**Owned today: ~35–45% of the operator-facing functions** the factory
UI exposes — measured as "user-visible controls the operator can drive
from our Monitor / Program / Configure screens with wire-proven or
source-only-implemented backing" (denominator: 62 relevant WS verbs +
HTTP endpoints in tracks A–G, excluding welder/*, viproject/*,
calib/*, upload/*, chat/*, projmanager/* which are non-goals for the
pick/place cell — those account for a further ~35 verbs we
deliberately will not clone). The teach-jog-run-recover-monitor loop
is intact and wire-proven at 10% end-to-end (commits `162e2c4`,
`020d277`, `a3dc756`, `d059207`, `a40ebee`, `b78ae6a`); the Monitor
Run button drives the real arm through the ladder pipeline; the
provenance and speed-truth surfaces are in place.

**What remains: three focused capture sessions and roughly four build
cycles** — one for authoring polish (point tables + tool/coord
frames), one for motion completeness (movL/movC/movP + blend), one
for I/O + gripper (the block after Monitor Run gets a real end-effector
task), one for pause/resume/breakpoint validation + runtime variables.
Diagnostics (System/GetLog, publish/Log, publish/Time, Error catalog)
sits alongside — small effort, high operator payoff. Safety writes stay
on the controller **by business choice** (see track F); we own
read+display+enforce with our own supervisor.

**Endpoint estimate: 4 capture sessions × ~30 min each + ~4 build
cycles → the factory UI is retired from normal operation.**

---

## §1 · Verb inventory summary

WS verbs by namespace (bundle-extracted counts):

| Namespace | Verbs | Track | Purpose |
|---|---:|---|---|
| `Robot/*` | 18 | A/B/C | Single-arm motion + power + config |
| `RobotCommand/*` | 10 | — | Multi-arm equivalents (not applicable to this S10-140) |
| `project/*` | 9 | A/E | Program lifecycle: run/stop/pause/step/breakpoint/setStartLine |
| `System/*` | 5 | G | Config read, log fetch, error clear, warning hide |
| `publish/*` | 5+ | A/G | Async streams (Log, RobotGhost, RobotPosture, RobotStatus, Error, ProjectState, RobotCoordinate, Time, VarUpdate, web) |
| `IOManager/*` | 1 | D | I/O tree info |
| `ModbusTcp/*` | 1 | D | Modbus config |
| `Palletizer/*` | 2 | B | Palletize-pattern helpers (we author our own, not clone) |
| `globalVar/*` | 2 | E | Program variables |
| `additionalAxis/*` | 4 | — | External axis (not present on this cell) |
| `RobotInfo/*` | 1 | — | Multi-arm activation info (not applicable) |
| `common/*` | 3 | G | Generic param get/set + language |
| `user/*` | 3 | — | Auth (we run without their auth) |
| `viproject/*`, `projmanager/*`, `projexecute/*`, `chat/*`, `upload/*`, `calib/*`, `camera/*`, `welder/*`, `report/*` | ~35 | — | Vision-block-project system, welder pack, chat, uploads, calibration — **out of scope for this cell** |

HTTP endpoints (bundle-extracted):

| Family | Purpose | Track |
|---|---|---|
| `POST/GET /api/robotjson/project<lang>/…/projectlist/` | Program registry | A |
| `POST/GET /api/robotjson/project<lang>_<prid>/…/project/` | Task registry | A |
| `POST/GET /api/robotjson/project<lang>_<prid>/…/varspoint/` | Named-point library | A |
| `POST/GET /api/robotjson/project<lang>_<prid>/…/varsproject/` | Program variables | E |
| `POST/GET /api/robotcode/project<lang>_<prid>_<lang>/…/<tkid>/` | Lua source | A |
| `POST/GET /api/robotjson/projectconfig/…/projectconfig/` | Global project config | G |
| `POST/GET /api/robotjson/projectgroup_…/` (list, per-group JSON) | Program groups/folders | B |
| `POST /api/robotcode/projectgroup_…_lua/update/…lua/` | Grouped Lua sources | B |
| `POST /api/asaifile/manage/copy/`, `/api/asaizip/manage/post/`, `/api/asailog/manage/*` | Asset management (import/export/logs) | G |
| `GET /api/init/code/` | RSA key exchange for their auth | — |
| `POST /api/asaichannel/{file,json,sqlite}` | Channel storage (their app framework) | — |

Full per-verb inventory (occurrence counts + one-line context) archived
at `/tmp/verb_inventory.txt` (165 lines) so the operator can drill
into any single verb without re-running the extraction.

---

## §2 · Track A — DONE (teach-jog-run-recover-monitor)

Wire-proven and shipped. This is our operator-independence baseline.

| Function | Verb/endpoint(s) | Status | Commit |
|---|---|---|---|
| Read robot posture (joints + TCP) | `publish/RobotPosture` (rx) | VALIDATED | pre-branch |
| Read robot status (mode/state/moving/rates) | `publish/RobotStatus` (rx) | VALIDATED | pre-branch |
| Continuous jog (joint + cartesian) | `Robot/jog`, `Robot/jogHeartbeat`, `Robot/stopJog` | VALIDATED — deadman-proven | `162e2c4` (0.3s deadman revert), `effd11b` (broadcast throttle) |
| Incremental (angle-bounded) jog | `Robot/jog` w/ short pulses + driver stop-timer | VALIDATED | pre-branch |
| Power enable/disable/clear alarm | `Robot/switchOn`, `Robot/switchOff`, `System/ClearError` | VALIDATED | pre-branch |
| Mode switch to Auto / Manual | `Robot/toAuto`, `Robot/toManual` | VALIDATED (ladder rungs 1–3) | `d059207` |
| Auto-run speed cap | `Robot/setAutoMoveRate` | VALIDATED — SOURCE-ONLY flag lifted rung 2 (ACK db=null, RTT ~19 ms, run at 10% completed) | `d059207` |
| Manual-jog speed cap | `Robot/setManualMoveRate` | VALIDATED | pre-branch |
| Lua source + varspoint save (HTTP) | `POST /api/robotcode/project<lang>_<id>_<lang>/update/<tkid>/`, `POST /api/robotjson/project<lang>_<id>/update/{varspoint,project}/`, `POST /api/robotjson/project<lang>/update/projectlist/` | VALIDATED — round-trip GETs match | `d059207`, `a40ebee` |
| Program registry (list, GET, PUT, DELETE) | `/api/programs/…` (our HTTP surface) | VALIDATED — used by Monitor + Program screens | pre-branch + `b78ae6a` (provenance) |
| Program run | `project/run` | VALIDATED (rung 3 full run at 10%, 9.46 s) | `d059207` |
| Program stop | `project/stop` | VALIDATED (rung 1: state 2→3→0, stop-ACK 214 ms) | `d059207` |
| Single-step + start-line + breakpoints | `project/runStep` (both wire forms), `project/setStartLine`, `project/clearStartLine`, `project/setBreakpoint {task:[]}` | VALIDATED (rung 2: initial + advance) | `d059207` |
| Program-state indicator | `publish/ProjectState` (rx) → `STATE.robot.program.{state,line,is_step,task,project_id}` | VALIDATED | `a40ebee` |
| Alarm mirror + banner + guided recovery modal | `publish/Error` (rx) + `System/ClearError` | VALIDATED — 3 Hz reflood deduped by (code, unix_ts) | `a40ebee` |
| Confirm-before-real-motion modal | UI-only | VALIDATED | `a40ebee` |
| Editable speed input with cap-truth display | UI-only | VALIDATED | `b78ae6a` |
| Provenance stamp + accurate description | `source` field + read-time inference + `has_taught_poses` derived flag | VALIDATED | `b78ae6a` |
| Move-path gate | `allow_move` + `ESTUN_ALLOW_MOVE` + monitor_only master | VALIDATED — gate-closed proof: 15 ops → 15 rejects → 0 wire leaks | `a3dc756`, `a40ebee` |

**Not-yet-validated in track A (marked SOURCE-ONLY in code and modal
tooltip):** `project/pause`, `project/resume`, `project/clearBreakpoint`.
These wait on capture session **CS-3** (§4).

---

## §3 · Track B — AUTHORING (points, program library, tool/coord frames)

The operator-authoring path from our teach flow into the controller's
project artifacts. Most of the plumbing is already in place (varspoint
POST is proven); this track fleshes out the surface.

| Function | Verb/endpoint | Status | Where captured / mined |
|---|---|---|---|
| Read controller-side program list | `GET /api/robotjson/project<lang>/select/projectlist/` | CAPTURED — used by save-merge | ladder session |
| Save program (source + varspoint + project + list) | `POST /api/robotcode + /api/robotjson` (4 endpoints) | VALIDATED | ladder |
| **Named-point library CRUD** (add/rename/delete/reorder) | `POST /api/robotjson/project<lang>_<id>/update/varspoint/` (whole-table overwrite) | CAPTURED — our current save does a whole-table PUT; per-point CRUD would live in our UI, not the wire | ladder |
| **Program folders / groups** | `GET/POST /api/robotjson/projectgroup_<lang>/select|update/projectlist/`, `.../projectgroup_<lang>/select|update/project/`, `POST /api/robotcode/projectgroup_<lang>_lua/update/<name>.lua/` | SOURCE-ONLY — not captured, not implemented (we have our own folder index at `/opt/cobot/programs/_folders.json` — do not need to clone controller groups) | source only |
| **Tool/coord-frame selection at jog time** | `Robot/jog` `coorType` + `coorId` fields (already sent by our driver — coorType=0 base, 1 tool) | IMPLEMENTED+VALIDATED for base; tool-frame *definition* not yet | HAR shows `coorType:0, coorId:0` |
| **Tool/coord-frame authoring** (define, save, activate) | `Robot/GetRobotParameter` (read Tool/Payload/Coordinate arrays) + `Robot/SaveRobotParameter` (write full parameter block) + `Robot/GetProductConfiguration` (arm DH) | SOURCE-ONLY, not captured. Verbs mined from bundle (`Robot/SaveRobotParameter db=n.parameter`) | source only |
| **Point-value helpers**: FK/IK conversions used by our teach UI to preview reach | `Robot/cpostoapos` (cart→joint), `Robot/calculateRelativePose` (offset math) | SOURCE-ONLY, not captured — potentially handy if we ever need controller-side IK instead of our own | source only |
| **Robot 3D-model URL** (for their twin — we use our own STL/URDF) | `Robot/Get3DModelName` | SOURCE-ONLY, non-blocking — we don't need this; ours is authoritative | source only |
| Runtime mode indicator (Actual vs Simulation) | `Robot/toActual`, `Robot/toSimulation` | SOURCE-ONLY — probably not needed; our sim is separate | source only |
| Rescue-mode entry (out-of-range recovery) | `Robot/switchOnRescue`, `Robot/switchOnRescue` variant | SOURCE-ONLY — the AlarmRecoveryModal already guides the operator; capture-and-wire when a real out-of-range occurs | source only |
| Palletize-pattern helpers (their side) | `Palletizer/getTemplate`, `Palletizer/setPalletCounts` | SOURCE-ONLY — **do not clone**. Our PBD flow + PalletConfigEditor authors this on our side; we emit Lua that hits waypoints directly. | source only |

**Track B priority within this track:** tool/coord-frame authoring
first (unblocks accurate cartesian jog and cart-mode movJ targets in
non-base frames), then per-point CRUD polish in our UI (already
achievable — the wire is done).

---

## §4 · Track C — MOTION COMPLETENESS (movL/movC/movP + blend)

Our codegen today emits only `movJ(pN)`. The controller's Lua
primitives support linear, circular, and blended motion.

| Function | Verb/format | Status | Notes |
|---|---|---|---|
| Joint interpolation | `movJ(p1)` in Lua | VALIDATED | current codegen |
| Linear (Cartesian straight-line) | `movL(p1, spd, acc, blend)` in Lua | **not-in-codegen** | Lua semantics known from generic Estun docs; needs a captured example to nail the exact arg order + defaults |
| Circular (three-point arc) | `movC(mid, end, spd, acc, blend)` in Lua | **not-in-codegen** | same as movL |
| Continuous / point-through-point | `movP(via, target, spd, acc)` in Lua | **not-in-codegen** | source: bundle references it in vision-flow but not exercised in HAR |
| Blend / smoothing between segments | `blend` param on move primitives | **not-in-codegen** | The demo Lua on the controller uses `movJ(p1)\r\nmovL(p1)` with no args — defaults probably safe. Confirm by capturing an operator authoring a two-segment blended move. |
| Web-controlled direct pose move | `Robot/moveTo` (`db.type` 1/2/3/5 seen) + `Robot/moveToHeartbeat` (deadman) | SOURCE-ONLY — the wire form is fully mined; behavior needs a capture. Interesting for our "return to home" button and future gizmo-drag reach preview. |

**Track C priority:** movL is the most-asked-for one-block motion type
(operator-obvious "move in a straight line to X"). Capture session **CS-2**
(§4) covers movL + movC + blend defaults.

---

## §5 · Track D — I/O + PERIPHERALS

The gripper, digital I/O, analog I/O, Modbus RTU/TCP if the cell uses
them. The factory UI has an I/O tab; we don't yet.

| Function | Verb/endpoint | Status | Notes |
|---|---|---|---|
| I/O tree info (what pins/ports the controller has) | `IOManager/GetIOInfo` `db:""` | SOURCE-ONLY (mined from bundle) | request shape known; response shape needs capture |
| Digital output write | Lua primitive `IO.set(port, value)` — unclear from bundle; possibly wrapped in a WS verb OR direct Lua only | UNKNOWN | needs I/O tab capture |
| Digital input read | either `publish/…` topic OR polled `System/CallFunction` variant | UNKNOWN | needs I/O tab capture |
| Analog I/O | ditto | UNKNOWN | needs I/O tab capture |
| Modbus TCP config | `ModbusTcp/getConfig` `db:""` | SOURCE-ONLY | request shape known; if cell doesn't use Modbus this can stay deferred |
| Modbus RTU/RS485 | not found in bundle grep — controller may not expose | UNKNOWN | out-of-band |
| Gripper control | controller-side is I/O-driven (their gripper block writes to an I/O port from Lua). Our side has an existing `/robot/io_command` topic (hard-rejected in the driver today) waiting to be wired. | IMPLEMENTED-REJECTED (driver rejects the /estun/io + /robot/io_command topics until we implement) | needs I/O capture |
| Digital IO read stream (for state) | probably a `publish/…` topic emitted every N ms — needs to be discovered | UNKNOWN | needs capture |

**Track D priority:** this unblocks anything with an end-effector. The
Monitor Run at 10% only completes end-to-end because our test program
is all `movJ` — the moment we add "close gripper here, wait for
part-sensed input", we need this track.

---

## §6 · Track E — PRODUCTION CONTROL (pause, resume, breakpoints, vars)

Runtime program-control surface. Mostly source-only today; small verbs
each, big operator payoff.

| Function | Verb | Status | Notes |
|---|---|---|---|
| Pause running program | `project/pause` | SOURCE-ONLY (coded in driver, tooltip'd in UI) | Rung-2 test showed a project/pause ACK during setup but did not exercise it against a running motion. **Capture CS-3.** |
| Resume paused program | `project/resume` | SOURCE-ONLY (coded, ambiguous — during rung 2 the resume-during-step-mode ran the *whole* remainder, not one step) | **CS-3** |
| Clear all breakpoints (dedicated verb) | `project/clearBreakpoint` | SOURCE-ONLY | equivalent to `setBreakpoint {task:[]}` (validated) but a cleaner global verb; low priority |
| Set start line | `project/setStartLine db:<int>` | VALIDATED | ladder |
| Clear start line | `project/clearStartLine` | VALIDATED | ladder |
| Set breakpoints (per task, line list) | `project/setBreakpoint db:{taskId:[lines...]}` | VALIDATED (empty case in ladder); non-empty case still needs one capture | ladder + one more |
| Read all program variables | `globalVar/getVars db:""` | SOURCE-ONLY (mined from bundle) | needed for runtime var monitoring |
| Watch project-variable updates | `globalVar/GetProjectVarUpdate` + subscribed `publish/VarUpdate` (rx) | SOURCE-ONLY | live var-value stream during a run |
| Persist project variables | `POST /api/robotjson/project<lang>_<id>/update/varsproject/` | SOURCE-ONLY | mirror of varspoint, for scalars/dicts |

**Track E priority:** pause/resume live proof (CS-3) is the highest-
value item — turns our Stop-only surface into a full Play/Pause/Resume
control panel.

---

## §7 · Track F — SAFETY (READ + ENFORCE; writes stay on controller)

**Explicit business-policy decision documented here so future
reviewers understand it as a positioning choice, not a gap:**

The controller ships with certified safety functions — safety zones,
joint-limit envelopes, safety I/O mapping, safe-torque-off wiring. We
**deliberately do not clone the write path** for any of these. Reasons:

1. **Certification liability.** The certified stop category (Cat 0/1)
   + safe-limited-speed + safe-monitored-position on the controller
   are TÜV/IEC-approved. Rewriting them on our side would move us into
   a certification role we do not want; keeping the reads while
   deferring writes to the controller lets us position our stack as a
   commercial layer that CONSUMES a certified safety controller,
   not one that REPLACES it.
2. **Integrator handoff.** Cell integrators / safety engineers already
   configure zones + limits via the controller's own pendant; those
   flows have their own audit trails and sign-offs.
3. **Our supervisor still enforces.** We read the certified limits +
   apply our own margin math (deadman jog chain, collision guards
   self/ground/env, escape-guaranteed stops, LiDAR keep-outs). Any
   supervisor stop we emit fires BEFORE the certified controller would
   need to — belt + braces, both layers active.

What we WILL own (READ + DISPLAY + ENFORCE via our supervisor):

| Function | Verb | Status | Notes |
|---|---|---|---|
| Read robot parameter block (limits, DH, tools) | `Robot/GetRobotParameter` | SOURCE-ONLY | one-shot at connect + on config-change |
| Read product configuration (DH + safety block) | `Robot/GetProductConfiguration` | CAPTURED — used at connect | already in HAR |
| Joint limits + soft-limit margin | derived from `Robot/GetRobotParameter` | IMPLEMENTED via YAML (needs to become auto-refreshed from wire) | today the YAML `joint_limit_deg` is hand-copied; a small task to read+cache |
| Alarm catalog (code → human text + recovery) | `publish/Error` payload text + `System/GetLog` | PARTIALLY VALIDATED — we mirror the current alarm; the full catalog for the recovery modal to key off is unmapped | ~50 alarm codes seen so far, unknown total |
| Safety zone status (which zone crossed, distance) | needs discovery — probably a topic under `publish/…` or a `System/CallFunction` variant | UNKNOWN | needs capture |

**We do NOT implement:** `Robot/SaveRobotParameter` writes to the
certified block, safety-zone edit endpoints, safety-I/O mapping writes,
speed-monitor thresholds. Any operator or integrator who needs to
change certified safety configuration goes to the controller's pendant.
This gap is intentional and documented.

---

## §8 · Track G — DIAGNOSTICS

The "what happened / what's the arm doing" surface.

| Function | Verb | Status | Notes |
|---|---|---|---|
| Robot log (rolling backlog) | `System/GetLog db:<count>` + `publish/Log` (rx) | SOURCE-ONLY | trivial to wire; big operator win |
| Controller time (for absolute-timestamped events) | `publish/Time` (rx) | SOURCE-ONLY | needed to render `publish/Error[2]` (unix_ts) as a wall-clock string; also useful for absolute-vs-relative alarm timelines |
| Robot ghost / trajectory preview | `publish/RobotGhost` (rx, joint array) | SOURCE-ONLY | Estun's own preview stream; ours is superior (see §10 Superiority Layer) — kept for completeness only |
| Alarm hide (dismiss on their UI's banner) | `System/HideWarning` | SOURCE-ONLY | not needed — our ProgramErrorModal handles it |
| Config read (settings tree, rules, presets) | `System/ReadConfig` | CAPTURED (3 frames in HAR) | needed for their-side product-config visualization; we currently display our own |
| Generic param read/write | `common/getparam`, `common/setparam` | SOURCE-ONLY (7 send-hits) | thin wrapper around System/CallFunction — used to write single scalar settings |
| Function-invoke gateway | `System/CallFunction` | SOURCE-ONLY (4 send-hits) | the escape hatch for arbitrary controller calls; document but do not clone unless we hit a specific need |
| Free-drive query family (present on torque-sensor arms) | `Robot/DisableDrag`, `Robot/GetDragMode`, `Robot/ExistTorqueSensor` | CAPTURED — this arm reports no torque sensor. Setter verbs NOT in current bundle. | Track B (defer) — needs a fresh capture on a torque-sensor arm |

**Track G priority:** `System/GetLog` + `publish/Log` + `publish/Time`
subscription is the highest-payoff quick-win — moves alarm troubleshooting
from "SSH into the Jetson and grep" to "open Monitor → Diagnostics tab".

---

## §9 · Capture shopping list (grouped into minimum sessions)

Every not-yet-ours verb in tracks B–E + G, packed into the fewest
factory-UI sessions the operator can realistically run.

### CS-1 · "Program authoring + program-config"  (~20 min)

**Open Chrome DevTools → Network → WS filter on the controller UI at
`ws://<controller>:9000/` BEFORE each recipe.** Save a HAR at the end.
Filter TX by `type: send` and copy the `_webSocketMessages` block.

Recipes:

1. **Create a tool frame.** In the factory UI go to Configure → Robot
   Parameters → Tool. Add a new tool, define TCP offset numerically,
   Save. Captures: `Robot/GetRobotParameter` (initial read),
   `Robot/SaveRobotParameter` (write). *Tracks B, F-read*
2. **Create a user coord frame.** Same tab, Coordinate section, define a
   3-point or numeric coord frame, Save. Captures: another
   `Robot/SaveRobotParameter` with a Coordinate block populated.
3. **Read product configuration.** Configure → About / Product. Captures:
   `Robot/GetProductConfiguration` full response with DH + serial. *Track F-read*
4. **Save + reload a program with grouped folders.** Program tab → New Group,
   drag a project into it, Save, then switch groups. Captures:
   `projmanager/*` + `/api/robotjson/projectgroup_*` GET/POST. *Track B (may skip if we keep our own folder index)*

### CS-2 · "Motion completeness — movL / movC / movP + blend"  (~15 min)

The current controller-stored `projectluademo` has `movJ(p1)` on line 1
and `movL(p1)` on line 2. We know the base verbs work; we need the
exact arg conventions.

Recipes:

1. **Edit projectluademo, add movL with explicit args.** In the Lua editor
   type `movL(p1, 10, 1, 5)` (speed, acc, blend arbitrary). Save + Run.
   Captures: source stored in `POST /api/robotcode/…lua/` (we already
   capture this); observe the successful state=2 → line advance → state=0
   trajectory. *Confirms movL default arg names + valid ranges.*
2. **Author a three-point movC.** Add a p3, then `movC(p2, p3)`. Save + Run.
   Confirms circular-motion primitive.
3. **Author a two-segment blended movJ→movL.** `movJ(p1, 10, 1, 5)\r\nmovL(p2, 10, 1, 5)`.
   Watch RobotPosture for the visible blend/no-blend difference at the p1
   waypoint. *Confirms blend param behavior — pass-through vs stop-at.*
4. **Try Robot/moveTo direct-pose (web-controlled).** In the "Move To" side
   panel type a joint target and click Move. Captures: `Robot/moveTo` +
   `Robot/moveToHeartbeat` frames — nails down the four db.type values
   (1/2/3/5) mined from bundle context.

### CS-3 · "Production control — pause / resume / breakpoint runtime"  (~15 min)

**Precondition:** a program with at least one motion that takes 2+
seconds so pause/resume has something to interrupt.

Recipes:

1. **Pause mid-motion.** Run projectluademo (or a modified one with a
   long movJ), and 1 s in click Pause. Observe ProjectState transitions
   (does state stay at 2 with isMoving:0, or does it flip to 3?).
   Confirm the arm actually holds (motor power stays on).
2. **Resume from pause.** From the paused state, click Resume. Observe
   motion continue from where it paused (not restart from line 1).
3. **Breakpoint hit + resume.** Add a breakpoint on line 2 via the
   editor's gutter click, Run. Program stops at line 2 (state?).
   Click Resume — should execute line 2 and complete.
4. **`project/clearBreakpoint` explicit vs empty-map equivalence.** Set
   two breakpoints then click "Clear all breakpoints" if their UI has
   the button (otherwise send `project/clearBreakpoint` from the
   protocol console). Confirm the map goes empty AND behavior matches
   sending `setBreakpoint {task:[]}`.
5. **Program variable inspection.** Open Configure → Variables (or
   the equivalent tab), add a `count` int variable and modify it in a
   Lua program, run once, watch its live value. Captures:
   `globalVar/getVars`, `globalVar/GetProjectVarUpdate`, `publish/VarUpdate`.

### CS-4 · "I/O + gripper"  (~25 min)

**Precondition:** a physical I/O test target — a signal LED on a
digital output, or the actual gripper wired to a DO. Without a real
target the reads/writes are meaningless.

Recipes:

1. **Read I/O tree.** Open the I/O tab. Captures: `IOManager/GetIOInfo`
   response (this is the "what pins does this controller have" answer).
2. **Toggle a digital output from the I/O tab.** Sets DO#1 on then off.
   Captures: whatever WS verb OR API call the UI uses (may be a
   `System/CallFunction` variant; may be a Lua-inline
   `IO.set(...)` if their UI doesn't have a direct DO toggle).
3. **Watch a digital input in the I/O tab.** Trigger a physical input
   change (press a button wired to DI#1). Captures: the DI status
   stream — likely a `publish/…` topic emitted every ~100 ms.
4. **Gripper open/close from the Robot tab's gripper button.** Captures:
   whatever the UI sends — likely two `System/CallFunction` calls or a
   preset I/O pattern.
5. **Modbus config read.** If the cell uses Modbus TCP, open the Modbus
   tab. Captures: `ModbusTcp/getConfig` response shape (empty on this
   cell → skip).

### CS-5 · "Diagnostics — log + time + config"  (~5 min, opportunistic)

Can be done during any other session — no dedicated bench time needed.

Recipes:

1. Just observe: `System/GetLog` + `publish/Log` fire on every operator
   session. Grab any HAR that has 30 s of factory-UI idle after an
   alarm — that's the alarm-log stream.
2. Observe `publish/Time` cadence (likely 1 Hz) — one capture is enough.
3. Observe `System/ReadConfig` — fires on connect; we already have 3
   frames in the current HAR.

**Total: 3–4 dedicated sessions ~20 min each + one opportunistic (~5 min).**

---

## §10 · Recommended build order

Priority order by "operator independence unlocked per unit effort",
respecting dependencies.

| Order | Track | Rationale | Depends on |
|---|---|---|---|
| 1 | **G · Diagnostics quick-wins** — `publish/Log` + `System/GetLog` + `publish/Time` | Small wire work; huge operator-troubleshooting payoff. Also unblocks absolute-time rendering for the alarm modal (currently unix_ts is displayed raw). | CS-5 (opportunistic) |
| 2 | **E · Pause/Resume validation** — validate `project/pause` + `project/resume`; lift SOURCE-ONLY flags in the UI; deprecate the tooltip note. | Small verb work, already coded. Just needs the capture + one live test. | CS-3 |
| 3 | **D · Gripper + basic I/O** — subscribe to I/O tree, wire the currently-rejected `/robot/io_command` topic; add gripper open/close ops on the Monitor page. | This is what makes the Monitor Run go from "3 movJs" to "actual pick/place". Highest external value of any track. | CS-4 |
| 4 | **C · movL + blend in codegen** — add movL emission when steps carry a `motion_type: linear` field; add blend from `blend_mm` if set. | Modest codegen work. Blocks any authoring that wants straight-line motion (e.g. approach vectors above pick points, blended weld paths). | CS-2 |
| 5 | **B · Tool + coord-frame authoring** | Requires our own Configure-tab UI + the `Robot/GetRobotParameter` + `Robot/SaveRobotParameter` verbs. Medium build. Blocks accurate cartesian jog in non-base frames + any tool-relative motion. | CS-1 |
| 6 | **E · Program variables + runtime monitoring** — `globalVar/getVars`, `publish/VarUpdate`, `varsproject` HTTP save. | Feature-add for palletize counters / conditional programs. Modest build. | CS-3 |
| 7 | **F-read · Safety catalog + zone read** | Read + display + supervisor enforcement. **Explicit non-goal: writes.** Depends on discovering the safety-zone status topic. | CS-1 has partial (product config) |
| 8 | **C · movC / movP + `Robot/moveTo`** — direct-pose move for gizmo drag + return-to-home. | Nice-to-have. movC is rare in pick/place; moveTo is useful for a "reach preview" gizmo. | CS-2 |
| 9 | **Track A polish** — replace the stale-error display bug in the modal (from ladder rung 1) with a proper (code, ts) transition-only path; add `Robot/setAutoMoveRate` ACK-RTT to the health screen. | Small tidy-up. | — |

**First capture to run: CS-5 (opportunistic, ~5 min)** — it's free, and
its outputs unblock item 1 immediately.
**First dedicated session to schedule: CS-4 (I/O + gripper).** It's
the biggest external-value unlock, and it needs a physical test
target so it has to be booked with the cell.

**Endpoint after CS-1, CS-2, CS-3, CS-4 + the four build cycles: the
factory UI is retired from normal operator use.** The remaining
factory-UI territory (welder pack, vision-block projects, integrator-only
calibration flows) is out of scope for the pick/place cell and stays
with the controller.

---

## §11 · Superiority layer (what our stack has that the factory UI does NOT)

The material that separates us from a factory-UI clone. This is what
lets us position as OEM-in-front-of-Estun, not a lookalike.

### Safety chain we own end-to-end
- **Wire-proven 0.3 s jog freshness deadman** with a live GIL-tolerance
  measurement (median 60 ms, p99 96 ms at 60 s hold; commit `162e2c4`).
  The factory UI has NO jog deadman — a browser tab freeze leaves the
  arm running until the controller's own ~1 s heartbeat catches it.
- **Explicit stop-first behavior on release** — every jog release
  publishes `Robot/stopJog` immediately (not waiting for the deadman);
  the factory UI's own jog release is entirely deadman-driven.
- **Layered safety gates** — `monitor_only` master + `allow_jog` +
  `allow_power` + `allow_move`, all env-file-driven per session. The
  factory UI has one gate: physical E-stop.

### Collision + environment guards
- **Self-collision guard** — 7 capsule-vs-capsule pairs on every
  supervise tick, at speed-scaled margins. Amber/red tinting in the
  digital twin.
- **Environment obstacle guard** — polygon keep-out zones fed by
  LiDAR-identified objects; auto-stop with escape-direction hint.
- **Ground plane guard** — separate keep-out from self-collision so
  operators can raise/lower it per cell.
- **Speed-scaled margins** — limit clamp, collision stop, sigma
  governor all recompute their thresholds from the current speed_frac,
  so a fast jog gets a bigger stopping distance while a slow jog gets
  tight margins. Factory UI: single fixed threshold at manufacturer
  default.

### Guided recovery
- **Alarm recovery modal** with phase derivation (out_of_range →
  back_in_range → cleared → enabled_confirm) and a mini timeline of
  what happened. Factory UI shows a red banner + reset button.
- **Obstacle escape modal** with hysteresis + escape-direction rendering.
- **Deadman + stop-then-safe sequencing** on disable (a jog in flight
  auto-stops before switchOff hits the wire).

### Digital twin + observability
- **URDF-driven 3D twin** running at browser frame-rate, overlaid with
  the taught program's step-by-step targets and live joint positions.
  Factory UI has a 3D preview but not step-overlay.
- **Camera streams (cam0, cam1) with detection + skeleton overlays**
  in-page — no context-switch.
- **LiDAR point cloud + identified objects** rendered live in the
  twin. Factory UI: none.

### Authoring layer we uniquely own
- **Program-from-Demonstration wizard** — voice-narrated demo → LLM
  intent extraction → editable draft → operator-teach-poses save. No
  equivalent on the factory UI (they have block programming, which
  requires the same skill set as writing Lua).
- **Explicit provenance stamp on every stored program** (source ∈
  {demonstration, manual, imported}) with a Monitor badge. Factory UI:
  everything looks the same after save.
- **Live has-taught-poses derivation** — stale "poses pending
  perception" caveats are auto-stripped when the operator finishes
  teaching. Factory UI: whatever text you saved is what you see forever.
- **Editable speed input with truth-in-UI capping** — operator sees
  exactly what the driver will honor ("effective 25% (driver cap
  25%)"). Factory UI: silent capping.
- **Confirm-before-real-motion modal** with fresh source_hash on every
  Run press so the operator sees when two consecutive runs shipped
  different code. Factory UI: no re-upload confirmation.

### Auth / policy layer
- **Env-file drop-in gates** for every write path (jog, power, move).
  A cell can be brought up as monitor-only, then jog-only, then full,
  in three env-file edits without a rebuild.
- **Move-gate wire-proof** — 15 ops → 15 rejects → 0 wire leaks (this
  session). Factory UI has no equivalent of "prove nothing escaped."

### Observability + ops
- **Bundle fingerprinting** — every commit's frontend build has a
  sha256[:12] in the source that lands in the run-confirm modal so
  the operator can see which build they're staring at.
- **Rejection ring buffer** on `/estun/rejected` — every driver refusal
  ends up in `STATE.robot.rejected` with reason string, timestamp,
  payload head. Factory UI: silent when it refuses.
- **`ws_log_raw`** — every WS frame (tx + rx) to a rotated JSONL file
  at `/opt/cobot/logs/estun_ws_<ts>.jsonl`. Ground-truth debugging.

### Motion optimization
- **TOPP-RA-based time-optimal trajectory planning** (motion_optimization
  package) with per-profile speed scaling. Factory UI: fixed
  trapezoidal profile.
- **Motion profile switching** at program-run time (Conservative /
  Balanced / Aggressive / custom).

**Pitch-deck line:** "Estun ships a certified motion controller. We
ship the cell — safety supervisor, digital twin, PBD authoring,
guided recovery, and the operator surface. Their pendant becomes a
setup-only tool that gets bolted to the panel and never opened again."

---

## §12 · Glossary

- **Ladder** — the wire-validation sequence run 2026-07-20: stop → single-step → full run at 10%. Commit `d059207`.
- **PBD** — Programming by Demonstration. Voice-narrated demo + LLM → editable draft.
- **SOURCE-ONLY** — a verb whose shape has been mined from the factory UI JS bundle but whose behavior has not been proven on the wire. Deliberately labeled in code + UI until validation lifts the flag.
- **CAPTURED** — a verb observed in a HAR (`data/estun_captures/*.har`) with request+response frames. Shape and behavior both evidence-backed.
- **VALIDATED** — CAPTURED + implemented in our stack + exercised in an operator flow.
- **Gate** — a driver-side monitor_only / allow_* boolean. Closed gate → the driver rejects the family before any wire frame is sent.
- **CS-N** — capture session N; the numbered recipes in §9.
