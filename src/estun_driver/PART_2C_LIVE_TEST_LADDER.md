# Part 2c — Operator live-test ladder

**Preconditions confirmed by this branch:**

- Gate-closed proof: PASS. With `allow_move=false`, all 15 `/estun/program`
  ops on this build are rejected (`family=program`, reason `allow_move
  gate closed`) and produce **zero program-family TX frames** on the
  WS raw log. See §A below.

- Save-only save round-trip: PASS. The 4-POST save sequence
  (`/api/robotcode/... `Lua source` + varspoint + project.json +
  projectlist`) returns HTTP 200 / `{"code":909,"data":"ok"}` on all
  four calls. Round-trip GETs confirm bytes stored verbatim on the
  controller. Existing projects are NOT clobbered — projectlist merges.
  See §B below.

- The saved test program is `roboaitest` with task `main`, both points
  are on the arm's CURRENT posture ±1° on J1 (see §B). Nothing has
  been RUN yet — no `project/run` frame has hit the wire on this
  branch.

The rest of this document is the operator's script for the FIRST live
run — stop-verb validation first, then single-step, then full run at
10%. **Do not skip rungs.**

---

## Prerequisites for the live test

Run these once at the top of the session and re-check between rungs.

- Driver up: `systemctl is-active roboai-estun` → active
- Move gate + connectivity:
  ```
  ros2 topic echo --once /estun/mode | grep -oE '"allow_move":true|"connected":true'
  ```
  Both must show. If `allow_move` is false, add `ESTUN_ALLOW_MOVE=1` to
  `/etc/default/roboai-estun` and restart the unit.
- Arm powered (state=2 "Enabled"):
  ```
  ros2 topic echo --once /estun/status | grep -oE '"state_name":"Enabled"'
  ```
- Emergency stop within physical reach.
- The workspace is clear along the J1 arc between p1 and p2
  (a 1° J1 rotation from current pose). If there's ANY chance of
  contact — abort, jog back to a safe pose, re-teach p1 and p2, save
  again, restart at rung 1.

---

## Rung 1 — Stop-verb validation (SOURCE-ONLY behavior probe)

**Purpose:** confirm `project/stop` actually stops an autonomously-
running program before we trust it as our stop-on-disconnect fallback.
This is why the ladder starts here.

**Setup a dwell-heavy trivial program.** Publish this to save first —
the arm will barely move if run to completion (both points are the
current pose), but the 5s sleep in between gives us a clean stop
window. Substitute the current joint values from
`ros2 topic echo --once /estun/status | grep joints_deg` if the arm
has been jogged since the save-only test.

```bash
CURRENT=$(ros2 topic echo --once /estun/status | tr ',' '\n' | grep -oE '"joints_deg":\s*\[[^]]+\]' | grep -oE '\[.*\]')
# Or paste the numbers manually.

ros2 topic pub -1 /estun/program std_msgs/String "{data: '$(python3 <<PYEOF
import json, sys
joints = [-34.908, 15.663, 65.156, -38.675, 93.967, -21.136]  # <-- REPLACE with current
lua = (
  "-- rung 1: stop-verb probe (5s dwell between two current-pose movJ)\r\n"
  "movJ(p1)\r\n"
  "sys.sleep(5)\r\n"
  "movJ(p1)\r\n"
  "--Lua version 5.3\r\n"
)
print(json.dumps({
  "op":"save", "program_id":"stopprobe", "task_id":"main",
  "name":"Stop Probe", "task_name":"main",
  "points":{"p1":{"joint":joints}},
  "lua_source": lua,
}))
PYEOF
)'}"
```

Expect: `/estun/program_status` reports 4 POST responses, all HTTP 200
code 909. If not, STOP and diagnose — don't proceed.

**Now run it and stop it within ~1 s:**

```bash
# 1. Force AUTO mode.
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"to_auto\"}"}'
sleep 0.5

# 2. Watch program_status in a second terminal.
#    In terminal B, BEFORE step 3:
#    ros2 topic echo /estun/program_status

# 3. Set breakpoints empty + start line 1 + run.
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_breakpoint\",\"task_id\":\"main\",\"lines\":[]}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_start_line\",\"line\":1}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"run\",\"program_id\":\"stopprobe\",\"task_id\":\"main\"}"}'

# 4. Immediately (within ~1 s of run) — send stop.
sleep 1.0
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"stop\"}"}'
```

**Passing behavior — all three of:**

1. Terminal B shows a `state: 2 → 0` transition on `/estun/program_status`
   within ~500 ms of the stop publish.
2. `ros2 topic echo --once /estun/status | grep isMoving` reports `false`
   after the stop.
3. The Enabled state stays intact (`state_name: "Enabled"`) — stop
   didn't drop motor power.

**Failing behavior — any of:**

- program_status stays at `state: 2` for > 1 s after `stop`
- `isMoving` stays true
- The arm continues past the sleep and executes the second `movJ`
- The controller faults (state → Alarm, publish/Error fires)

If ANY failure: send `project/pause` immediately. If that also fails,
send `Robot/switchOff` via the power path (`/robot/power_command
{"action":"disable"}`). Do not proceed to rung 2 until `project/stop`
is wire-proven.

---

## Rung 2 — Single-step through the 2-point program

**Purpose:** exercise `setStartLine` + `project/runStep` semantics
(SOURCE-ONLY) with real motion, one line at a time, so the operator
retains stop control after every step.

Uses the `roboaitest` program that's already saved on the controller
(see §B). p1 is the current pose from the save test; p2 is p1 with
+1° on J1. If the arm has moved since that save, re-teach and re-save
before this rung (or accept that step 1's motion may be large).

```bash
# Set breakpoints empty, start at line 1, use setAutoMoveRate at 10%.
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"to_auto\"}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_auto_rate\",\"pct\":10}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_breakpoint\",\"task_id\":\"main\",\"lines\":[]}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_start_line\",\"line\":1}"}'

# STEP 1: expected to be a near-no-op (p1 = current pose).
ros2 topic pub -1 /estun/program std_msgs/String \
  '{data: "{\"op\":\"step\",\"program_id\":\"roboaitest\",\"task_id\":\"main\"}"}'
# Watch program_status — expect state 2 → line advances → state 0 in <2 s.

# STEP 2: J1 rotates +1° at 10% speed.
# Physical J1 axis, current − 34.9° → −33.9°.
ros2 topic pub -1 /estun/program std_msgs/String \
  '{data: "{\"op\":\"step\",\"program_id\":\"roboaitest\",\"task_id\":\"main\"}"}'
# Watch. If it does not stop cleanly at the end, STOP.
```

**Between steps, verify:**

- `/estun/program_status` shows `state: 2` briefly during motion, then
  `state: 0` — a clean idle transition means the controller's
  interpreter honored the step boundary.
- `is_step: true` on ProjectState frames during step motion.
- `line` advances monotonically.

---

## Rung 3 — Full run at 10% speed

**Purpose:** the actual B1 goal — a program executes end-to-end
autonomously and comes back to idle cleanly.

Only run this after rungs 1 and 2 pass.

```bash
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"to_auto\"}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_auto_rate\",\"pct\":10}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"clear_start_line\"}"}'
ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"set_breakpoint\",\"task_id\":\"main\",\"lines\":[]}"}'
ros2 topic pub -1 /estun/program std_msgs/String \
  '{data: "{\"op\":\"run\",\"program_id\":\"roboaitest\",\"task_id\":\"main\"}"}'

# During the run: keep a stop terminal ready.
#   ros2 topic pub -1 /estun/program std_msgs/String '{data: "{\"op\":\"stop\"}"}'
```

Expected `/estun/program_status` trajectory:
```
{state:0, ...}                       ← before run
{state:2, project_id:"roboaitest"}   ← first frame after run
{state:2, task:"main", line:1}       ← line-tick
{state:2, task:"main", line:2}       ← line-tick
{state:0, ...}                       ← run complete, back to idle
```

If the controller re-emits `publish/Error` with non-empty db mid-run,
the deduped `event: "error_new"` fires ONCE on `/estun/program_status`
— send `{"op":"clear_error"}` and re-teach if needed.

**Not tested this session:**

- Multi-point programs (>2 waypoints).
- Programs with gripper/IO calls (the codegen currently skips
  non-`taught_joints` steps with a comment).
- movL / movP / blend parameters (only movJ is emitted).
- setAutoMoveRate behavior across runs (SOURCE-ONLY — first exercise
  in rung 2 is also its wire proof).

---

## Appendix A — Gate-closed proof (verbatim from this branch)

```
== driver mode ==
   monitor_only: False
   allow_jog: True
   allow_move: False              ← gate CLOSED
   allow_move_source: 'param'
   allow_power: True
   connected: True
   ws_log_path: '/opt/cobot/logs/estun_ws_20260720_093004.jsonl'
   program_state: 0

== publishing 15 ops ==
   rejects seen: 15 (expected 15)
   post-test size delta: 28731 bytes (all telemetry receives)

== program-family TX frames on wire ==
   count: 0                       ← ZERO leaks

=== GATE-CLOSED PROOF: PASS ===
```

The 15 ops published: save, run, step, stop, pause, resume,
set_start_line, clear_start_line, set_breakpoint, clear_breakpoint,
to_auto, to_manual, set_move_rate, set_auto_rate, clear_error.
Every one rejected with `family=program, reason="allow_move gate
closed"`.

---

## Appendix B — Save-only test (verbatim from this branch)

Generated Lua for the 2-point test program (current pose p1, p1 with
+1° J1 offset p2):

```
-- generated by estun_driver.program_ops from program 'roboaitest'
-- taught steps: 2, requested speed_pct=10, operator_cap_pct=25, effective_pct=10

-- step[1] action='move_current'  joints=[-34.908, +15.663, +65.156, -38.675, +93.967, -21.136]
movJ(p1)
-- step[2] action='move_offset'  joints=[-33.908, +15.663, +65.156, -38.675, +93.967, -21.136]
movJ(p2)

--Lua version 5.3 time:2026-07-20 09:33:39
```

Full POST sequence with driver-side responses:

```
POST /api/robotcode/projectlua_roboaitest_lua/update/main/    → HTTP 200 {"code":909,"data":"ok"}
POST /api/robotjson/projectlua_roboaitest/update/varspoint/    → HTTP 200 {"code":909,"data":"ok"}
POST /api/robotjson/projectlua_roboaitest/update/project/      → HTTP 200 {"code":909,"data":"ok"}
POST /api/robotjson/projectlua/update/projectlist/             → HTTP 200 {"code":909,"data":"ok"}
```

Controller-side GET verification (bytes stored verbatim):

```
GET /api/robotjson/projectlua/select/projectlist/
  → {"projectluademo":{"nm":"lua-demo","posid":0,"varid":0},
     "roboaitest":{"nm":"RoboAi Save Test","posid":0,"varid":0}}
  (projectluademo preserved — merge works)

GET /api/robotjson/projectlua_roboaitest/select/project/
  → {"main":{"nm":"main","tk":1}}

GET /api/robotjson/projectlua_roboaitest/select/varspoint/
  → {"p1":{"joint":[-34.908,15.663,65.156,-38.675,93.967,-21.136]},
     "p2":{"joint":[-33.908,15.663,65.156,-38.675,93.967,-21.136]}}

GET /api/robotcode/projectlua_roboaitest_lua/select/main/
  → <full Lua source as generated above, CRLF preserved>
```

Effective speed capped to 10 pct (`min(operator_cap=25, requested=10) = 10`).

No `project/run` was sent during the save test. Rung 1 above is the
first thing that would put a program-run frame on the wire.
