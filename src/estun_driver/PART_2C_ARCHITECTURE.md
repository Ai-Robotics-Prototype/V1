# Part 2c — Program Execution Architecture (B1: Lua Sync + Save via HTTP)

Provenance: HAR capture `data/estun_captures/estun_moves_20260720.har`
(29,838 WS frames on `ws://…:9000`, three complete run cycles), plus
targeted source mining from the factory UI bundle chunk
`assets_entry_as-D2dla8D6.js` (925 KB).

Marker meaning throughout:
- **CAPTURED** — full request+response frames observed on the wire.
- **SOURCE-ONLY** — verb + shape read from the factory UI JS bundle; not
  exercised in the HAR because the program errored before the operator
  could exercise the code path. Must be validated live.

---

## 1. Chosen architecture: B1

We generate Estun Lua 5.3 from our taught programs, persist the source
+ named-points library to the controller over HTTP, then run/step/stop
via the `project/*` WS verb family.

```
Taught program (our IR)
    │
    ├─► Lua codegen (movJ / movL against named points)   ─┐
    ├─► Named points table (varspoint)                     ├─► HTTP save
    └─► Project metadata (projectlist entry)              ─┘
                     │
                     ▼
              Controller HTTP  ─── file persisted
                     │
                     ▼
              project/setBreakpoint → project/setStartLine
                     │
                     ▼
              project/run  ──── runs autonomously, no client keepalive
                     │
              publish/ProjectState  (state=2 running / 0 idle)
              publish/Error         (~3 Hz reflood — DEDUP)
                     │
              project/pause | project/stop  (from our stop layer)
                     │
              System/ClearError  (unlatch error state after any fault)
```

Why B1 over generating Tree (block) programs: (a) codegen is one target,
(b) the run/step/save WS+HTTP verbs we're binding are already the same
across `tree`/`lua` (only the URL segment changes), and (c) Lua exposes
the full `movJ` / `movL` / `movP` primitive set without going through
the block-graph → Lua re-emitter the factory UI would do at save time.

---

## 2. Verb catalog

### 2.1 Confirmed (CAPTURED) — programs already speak these

All shapes below are as observed on the wire in the HAR capture. Every
send is a JSON envelope `{"ty":"<verb>", "db":<data>, "id":"<rid>"}` and
the controller ACKs the same `id` with `{"id":"<rid>","ty":"<verb>","db":<result>}`.

| Verb | Direction | db shape | Example (from HAR) |
|---|---|---|---|
| `project/run` | send | `{id, task}` | `{"db":{"id":"projectluademo","task":"taskluademo"}}` |
| `project/setStartLine` | send | int (line #) | `{"db":1}` |
| `project/clearStartLine` | send | — (no db) | `{"ty":"project/clearStartLine","id":"…"}` |
| `project/setBreakpoint` | send | `{[taskId]:[lines...]}` or `{}` | `{"db":{"taskluademo":[]}}` — empties |
| `Robot/toAuto` | send | — | Ack `{"db":null}` |
| `Robot/toManual` | send | — | Ack `{"db":null}` |
| `Robot/setManualMoveRate` | send | int (percent) | `{"db":15}` |
| `System/ClearError` | send | — | Latches off the error refloods |
| `publish/ProjectState` | recv (pub) | `{id, type, state, isStep, scripts?:{[task]:{line}}}` | `state:2` running, `state:0` idle |
| `publish/Error` | recv (pub) | list of `[level, code, ts, msg]` | ~3 Hz reflood — see §4 |

### 2.2 Mined (SOURCE-ONLY) — needed for B1, unvalidated

From `assets_entry_as-D2dla8D6.js`:

```js
// useProjectWs()
runProject:   ()  => wsApi({ty:"project/run",    db:{id:prid, task:tkid}})
runStep:      (e=1) => wsApi({ty:"project/runStep", db:{id:prid, task:tkid}})  // single-step
runResume:    ()  => wsApi({ty:"project/resume"})
pauseProject: ()  => wsApi({ty:"project/pause"})
stopProject:  ()  => wsApi({ty:"project/stop"})
// useLuaEditorBreakPoints()
clearBreak:   ()  => wsApi({ty:"project/clearBreakpoint"})
```

The `wsApi` wrapper generates the `id` field. All the no-db shapes match
the captured no-db shape family (Robot/toAuto, project/clearStartLine,
System/ClearError), so shape confidence is high; the outstanding
question is behavior:

| Verb | SOURCE shape | Confidence | First-live-test to run |
|---|---|---|---|
| `project/stop` | `{ty:"project/stop"}` | shape ✓ / behavior ✗ | See §5 |
| `project/pause` | `{ty:"project/pause"}` | shape ✓ / behavior ✗ | Send during state=2, expect state stays 2 with isMoving falling to 0 |
| `project/resume` | `{ty:"project/resume"}` | shape ✓ / behavior ✗ | Send after pause, expect motion to continue |
| `project/runStep` | `{ty:"project/runStep", db:{id,task}}` | shape ✓ / behavior ✗ | Expect state=2 with `isStep:true` in ProjectState |
| `project/clearBreakpoint` | `{ty:"project/clearBreakpoint"}` | shape ✓ / behavior ✗ | Send after setBreakpoint, expect the map to empty |

### 2.3 Not a WS verb: `project/save`

There is NO `project/save` verb. Save is HTTP:

```
POST /api/robotcode/project<lang>_<prid>_<lang>/update/<tkid>/
  body: <Lua source, raw text>

POST /api/robotjson/project<lang>/update/projectlist/
  body: <projectslist map — registers project with prid>

POST /api/robotjson/project<lang>_<prid>/update/project/
  body: <project metadata>

POST /api/robotjson/project<lang>_<prid>/update/varsproject/
  body: <project-local variables>

POST /api/robotjson/project<lang>_<prid>/update/varspoint/
  body: <named-point library — THIS IS THE SYNC TARGET FOR TAUGHT POSES>
```

`<lang>` = `"lua"` for us. `<prid>`/`<tkid>` are stable string ids we
generate (the HAR shows `projectluademo` / `taskluademo`).

Source: `useProjectSave` composable in the bundle; four `apiPost` calls
(`useProjectSave` → `p()` → `t.apisys.apiPost("/api/robotcode/…")` and
similar for `/api/robotjson/…`).

---

## 3. Codegen: our IR → Lua 5.3

Runs on the dashboard side, before the HTTP save.

- Named points library (map `pointName → {x,y,z,a,b,c,mode}` in the
  controller's Cartesian frame) is emitted into `varspoint` and posted
  once, then referenced by name in the Lua body.
- Each taught pose gets a stable `p<N>` id (or a user-chosen name).
- Motion primitives:

  ```lua
  movJ(p1, speed=0.25, acc=0.5, blend=0)
  movL(p2, speed=0.15, acc=0.3, blend=0)
  movP(via, target, speed=0.20, acc=0.4)
  ```

  Speeds are the fraction our motion profile currently authorizes
  (Conservative / Balanced / Aggressive) — the same scaling the
  `motion_optimization` executor already applies to `/estun/move`.

- Gripper / IO calls emit as `IO.set(portName, value)` or the vendor
  primitive the controller supports (deferred — the HAR run was a pure
  motion demo; IO verbs weren't exercised).

- Wait / delay: `sys.sleep(seconds)` — Lua stdlib.

The generated file is what we POST to `/api/robotcode/…/update/<tkid>/`.

---

## 4. Error handling — dedup requirement

`publish/Error` is a 3 Hz keepalive stream, not an event stream.
Measured in the HAR:

- **4,373 `publish/Error` frames over 1,457 s** (median inter-arrival
  0.333 s ≈ 3 Hz, p95 0.490 s).
- Two distinct db shapes: empty `[]` (no error, 4,122 frames) and
  a single-entry list `[[level, code, unix_ts, message]]` (251 frames).
- When an error latches (HAR: `10006 "Program <lua-main> execution
  error, line: 1, error: invalid target point."`), the exact same tuple
  refloods identically at 3 Hz **until `System/ClearError` is sent** —
  245 consecutive identical frames in the longest burst captured.

Implementation rules:

1. Dedup by tuple `(code, unix_ts)` — the ts is the fault timestamp, not
   the publish timestamp, so it stays constant across the reflood. First
   appearance is the event; every subsequent identical tuple is a
   keepalive and must not re-notify the operator.
2. The empty `[]` frame is the "no active error" heartbeat. Treat any
   non-empty → empty transition as a clear (the controller cleared it
   on its own, e.g. after `System/ClearError`).
3. Latched errors that persist across a run cycle must still be
   surfaced once at the START of the run so the operator sees why
   `project/run` refuses to progress past line 1.
4. `System/ClearError` is used both to clear operator-visible errors
   AND to unblock the next `project/run` — the HAR shows the operator
   sending `System/ClearError` between the second and third run
   attempts, immediately after which the `10006` reflood stops.

---

## 5. Stop-verb validation plan (first live test)

The 07:52 capture missed `project/stop` and `project/pause` because the
demo program errored on line 1 before those buttons were pressed. The
first thing we must validate against a running program is stop
behavior — because:

- The controller runs autonomously after `project/run`. There is no
  client keepalive. If we can't stop it via `project/stop`, our only
  fallbacks are `Robot/switchOff` (drops motor power, harsh) or E-stop.
- Our stop-on-disconnect strategy DEPENDS on `project/stop` firing
  correctly — a stalled dashboard cannot rely on the controller
  timing out.

Test procedure:

1. Load a program that dwells (`movJ(p1); sys.sleep(30); movJ(p2)`) —
   long enough to send stop mid-flight but not so long that a stuck
   test is dangerous.
2. Enter AUTO (`Robot/toAuto`).
3. `project/setBreakpoint {db:{taskA:[]}}` → `project/setStartLine {db:1}`
   → `project/run {db:{id:projA, task:taskA}}`.
4. Wait until `publish/ProjectState.state == 2` AND `publish/RobotStatus.isMoving == 1`.
5. Send `project/stop`.
6. **Passing behavior**: within ~500 ms
   - `publish/RobotStatus.isMoving` → 0
   - `publish/ProjectState.state` → 0 (or state=2 with no `scripts` — check both)
   - The controller stays in AUTO / doesn't fault
7. **Failing behavior**: motion continues; state stays 2. In that case
   fall back to `Robot/switchOff` immediately and do NOT ship B1 until
   we've mined the correct stop verb from a different source (Estun's
   OEM controller docs, or a fresh capture that includes the button
   press).

Repeat step 5 with `project/pause` and observe whether the motion
holds vs. hard-stops. `project/resume` after `project/pause` should
continue from the hold point.

---

## 6. State inference from `publish/ProjectState`

From the HAR, the state field carries the meaning:

| state | Meaning |
|---|---|
| 0 | idle — no program active |
| 2 | running — `scripts.{taskId}.line` gives current line, `isStep` is `true` for single-step |

The `id` field on the FIRST state=2 frame carries the project id being
run; on subsequent frames within the same run, `id` is `""`. Don't rely
on `id` alone to identify the current program — cache it on the state=0→2
transition.

Three complete run cycles were observed in the HAR (t≈460, 678, 695
into the capture). Each cycle: state=0 → state=2 (with project id) →
state=2 (with `scripts.{task}.line`) → state=0. The demo hit line 1
"invalid target point" every cycle and immediately returned to state=0,
which is why the run→pause→stop path itself was never exercised.

---

## 7. Interaction with our existing motion stack

- `motion_optimization` continues to own trajectory planning at our
  layer — TOPP-RA + smoother, per-profile speed scaling. Its output
  becomes the sequence of `movJ`/`movL` calls we emit; it does NOT
  bypass the controller's own trajectory generator on the Lua side.
- The Estun-side profile is set once via `Robot/setManualMoveRate` for
  manual jogs and `Robot/setAutoMoveRate` for program execution
  (SOURCE-ONLY — visible in the JS bundle as a companion to
  `Robot/setManualMoveRate` but not in the HAR).
- The estun_driver (this package) stays exactly what it is today: WS
  telemetry mirror + jog write path + power gating. Program running
  and program save are dashboard-side responsibilities that hit the
  controller directly over its WS + HTTP. The driver observes program
  state via `publish/ProjectState` and surfaces it on `/estun/status`
  for the safety layer to consume.

---

## 8. Deferred / out-of-scope for B1

- **Free-drive family (track B).** HAR-confirmed query shapes:
  `Robot/ExistTorqueSensor` (`db:""` → returns bool),
  `Robot/GetDragMode` (`db:""` → returns int),
  `Robot/DisableDrag` (`db:""` → returns bool). This arm reports
  `ExistTorqueSensor:false`, `GetDragMode:0`. **The corresponding
  setter verbs** (EnableDrag / SetDragMode-with-nonzero) are NOT in
  the current factory UI bundle — either lazily loaded from a chunk
  we didn't capture, or Estun doesn't expose free-drive on this SKU.
  Track B starts with getting a capture of the factory UI's
  "free drive" button being pressed on a torque-sensor-equipped arm.
- **`Robot/moveTo` / `Robot/moveToHeartbeat`** — direct pose-target
  motion outside the program interpreter. Present in the JS bundle,
  not exercised in the HAR. Interesting for our jog/nudge write path
  eventually but not needed for B1.
- **Vision projects (`viproject/*`)** — separate track; the JS bundle
  contains `viproject/execute`, `viproject/run`, `viproject/stop`,
  `projexecute/resume`, gated behind `covision` WS, unrelated to the
  Lua motion project family.

---

## 9. Open questions for the next capture

Ordered by how much they block B1:

1. **Actual `project/stop` behavior** (see §5). Blocks ship.
2. **Whether `Robot/setAutoMoveRate` behaves symmetrically to
   `setManualMoveRate`** — the JS bundle references it but the HAR
   never sends it.
3. **How the controller reports save success/failure** on the HTTP
   POSTs — the HAR captured no HTTP-level saves.
4. **Which `publish/*` topics fire on run failure vs run completion** —
   we know `publish/Error` reflows on fault, but a clean-completion
   frame (if any) isn't in the demo.
5. **The setter side of the free-drive family** (for track B).
