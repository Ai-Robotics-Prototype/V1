---
slug: aug-24-f1-motion-chain-and-hunt
number: 38
date: 2026-08-24
source: session
title: F1 motion chain proven on real arm; hold-jog hunt exposed and partial-fixed
---

*(Appended in full. The session that finally moved a real S10-140 joint through
the ROS2 stack for a sustained hold — first time end-to-end, per the ledger's
own record: addendum-35 §526 explicitly parked "no visible motion" on holds,
and no session between then and today rebooted that ladder. The ARM MOVED at
+11.75° on J6 over one second, then hunted audibly under sustained holds. Four
upstream defects landed as shipped commits; a fifth (bridge trajectory velocity
population) landed as a partial fix with the full-rate hunt trace captured to
disk for next session's analysis. Between the two: a reference tier built by
sweep, the Codroid operating UI at :9198 discovered, `Robot/switchOn` executed
over the wire, and the CriUdpSystem's remote-disconnect state-latching named
as its own hazard class.)*

## Section 539: The pre-rung obstacle course

The campaign opener was F1.4 rungs 3–6 (J6+ 3 s, J6- 3 s, deadman A, deadman B,
60 s soak). Actual work between "cue rung 3" and the first real-arm motion:

- **Bundle-tab confusion, twice.** Operator saw the version toast reading
  `da4caa4` (then `f100fc7` after rebuild) while a System Check indicator
  showed the chunk hash `CPjpRuaL` (then `DCKud4op`). Two IDENTIFIERS of the
  SAME bundle: `git describe --always --dirty` baked into `__BUILD_ID__` at
  vite build time vs. the vite content-hash embedded in the chunk filename.
  Server was serving the bundle on disk; the tab was on it; both indicators
  disagreeing was the intended-but-cosmetic UI bug the operator flagged for
  a future like-for-like comparison.
- **`_STATIC_DIR` drift class (L497) closed structurally.** The vite override
  outputting to `../mock_server/static` while `_STATIC_DIR` also read from
  there had been the source of a rsync-forgot-a-copy drift class. Retired to
  the single canonical `frontend/dist` (one source of truth), added a module-
  import assertion `_assert_frontend_coherent()` that refuses to boot if
  `index.html` is missing or its referenced `/assets/index-*.js` chunk isn't
  on disk. systemd `Restart=on-failure` now escalates loudly instead of the
  server serving a silent-broken shell. **Commit `830fc4a`**, ATTEMPTS.md
  L497 flipped DIRECTED → SHIPPED.
- **Lazy fanout publisher race closed.** `_dashboard_jog_events_pub` was
  lazy-created in `_publish_ros2_jog_event` under `hasattr()`. Under
  RELIABLE+VOLATILE QoS this loses the DDS discovery race whenever
  `jog_bridge` came up first — first press after any restart silently
  dropped. Moved to eager `__init__` matching the `/estun/program`
  publisher's earlier fix pattern (the two are twins of the same class).
  **Commit `1d3bc6d`**. Publisher count on `/dashboard/jog_session_events`
  now = 1 IMMEDIATELY after boot, no press required.
- **JSB canonical order at the dashboard.** JSB was publishing joint names
  as `[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]` — the yaml's own
  head comment predicted this exact fallback: `必须由 spawner -p 传入；
  否则 /joint_state_broadcaster 的 joints 为空，顺序会变成 2,3,1…`. Frontend
  indexes by slot not by name, so twin rendered J1/J2/J3 with the wrong
  values. Server-side normalization in `_on_joint_states` (build `pos_by_name`,
  reorder to canonical `Joint1..Joint6`). **Commit `b1729b4`**. Root-cause
  spawner-param investigation queued for F3.

## Section 540: The auth trail — jog_bridge's SAFETY guard is real

The bridge, on `JOG_BACKEND=ros2`, refuses to arm if `/estun/mode` reports
`allow_jog=true`. `roboai-estun` was running (STATE.md said "STOPPED" but
`systemctl is-active` said `active` — the stopped-vs-active gap). Stopped
it. Bridge SAFETY guard cleared. Then jog was still rejected because the
dashboard's `cri_proxy` override for arm-authority fields was gated on
`estun_stale > 3s` — with estun still publishing `/estun/status` (from
before the stop), the gate never fired. Extracted the override into a
helper `_apply_cri_proxy_authority(r)` called at the end of all three
`_on_joint_states`, `_on_estun_status`, `_on_estun_mode` handlers. Last-
writer-wins races can't flip authority now. **Commit `f100fc7`**.

To prevent future estun startups from re-poisoning the wire, dropped a
`/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.conf` that
references a companion `.env` file with `ESTUN_MONITOR_ONLY=true`,
`ESTUN_ALLOW_JOG=0`. First attempt used `Environment=` in the drop-in;
didn't take. `systemd.exec(5)`: `EnvironmentFile=` overrides `Environment=`,
and drop-in `EnvironmentFile=` loads AFTER the base unit's — so
`Environment=` in a drop-in is shadowed by any base `EnvironmentFile=`.
Switched to the file approach; `/proc/PID/environ` confirmed the override
takes effect.

## Section 541: The alarm saga and switchOn-over-the-wire

`f14_inject.py` (F1.2 harness path, new script this session, at
`~/cri_eval_ws/f1_2_scenarios/f14_inject.py`) — publishes start/refresh/stop
events to `/dashboard/jog_session_events` with the correct RELIABLE+VOLATILE
QoS, drives the bridge without a browser. First 2 s J6+ 15%: NO motion.
JTC-side showed a ~5.4° reference vs feedback gap on J6 — plugin was
sending UDP but the arm wasn't executing. Root cause: latched controller
alarm.

**Flange LED red = alarm** per Estun S-series manual §5.1.2. Operator's
`.1.x` laptop couldn't reach controller on `.2.x`, so all diagnostics came
from the Jetson. Ping cleared 0.9 ms 0% loss; port sweep 1-9999 found
`:9001` (CRI TCP) and `:9000` (WS) open, plus a new one:

- **`http://192.168.2.136:9198/`** — title `<title>Estun Web</title>`,
  Chinese `element-ui` operating panel with cross-origin headers and
  no-cache index. The factory operating UI. All prior port scans in the
  ledger's history missed it because it's not on standard-port lists.
  Also confirmed `:8080` on the controller is `部署系统` (deploy tool,
  `api/update/upload`, `updatesys.pw` password form) — DO NOT USE for
  operations, this is a permanent doctrinal fact.

Alarm read over the wire via `publish/RobotStatus` + `publish/Error` on
WS `:9000`, subscribing with `{"ty":"publish/<Topic>"}` per addendum-12
§116's protocol reverse-engineering. Two latched alarms surfaced:

```
[4, 2009, 1787583448.684, "Collision detected on Joint1."]
[4, 2006, 1787583497.316, "Emergency stop button pressed."]
```

Operator cleared both via `:9198`. `publish/Error` frames went empty;
`RobotStatus.recoveryState` flipped 1 → 0. But `state` was still 0
(Disabled) — alarm-clear ≠ servos-on. Sent `Robot/switchOn` over CRI TCP
`:9001` directly:

```
SEND -> {"id":700,"ty":"Robot/switchOn","db":""}
RECV <- {"id":700,"ty":"Robot/switchOn","db":null}
```

`state` flipped 0 → 2 (Enabled), no pendant press needed. Enable-over-the-
wire is now a documented procedure (OPERATIONS.md §3a).

## Section 542: The stale-CRI-plugin hazard class

After enable, injected J6+ 15% 2 s: NO motion. `/joint_states` positions
looked FROZEN at the pre-alarm values `[6.51°, 10.40°, 90.09°, 3.91°,
-20.01°, -68.09°]`, but `publish/RobotPosture` from the WS (ground truth)
reported the arm was actually at `[-38.88°, 53.03°, 69.87°, 33.65°, 90.39°,
-69.38°]`. **They disagreed by up to 110°** (J5).

Root cause named: `CriUdpSystem` (the `cod_cri_hardware` plugin) sets
`rx_ok_` and `command_synced_` to `true` on the first UDP RX after plugin
init and NEVER resets them on remote disconnect. When the controller
rebooted mid-session (alarm sequence), CRI TCP + UDP sessions from
`ros2_control_node` died — `sudo ss -tnp | grep <PID>` showed zero
outbound sockets — but the plugin kept echoing its last cached
`pos_state_` into `/joint_states`. JTC saw fresh header timestamps at
250 Hz + zero error and reported "Goal reached, success!" on every goal
we sent, while the plugin's `write()` continued sending UDP into a
receiver that no longer existed.

This is the **silent-write-accept class** — CRI UDP is fire-and-forget,
no NAK. Named as an F3 hardening item in FACTS.md; the fix is to reset
`rx_ok_`/`command_synced_` when UDP push has been silent for >N ticks.
Immediate remediation: `python3 ~/cri_eval_ws/cri_teardown.py` + Ctrl-C
launch + relaunch. After that:

```
/joint_states positions == publish/RobotPosture (sub-LSB match)
CriUdpSystem [INFO]: 首帧 UDP 反馈已对齐关节指令
Hardware Component 1: cod_cri_hardware/CriUdpSystem  state: active
```

## Section 543: Motion. And a hunt.

Fresh bridge, fresh JTC, fresh plugin — inject J6+ 15% 1 s. **Arm moved
+11.75° on J6** at ~12°/s (~43% of commanded 27°/s). Full chain proven
end-to-end for the first time on real hardware:

```
fanout:      11 events on /dashboard/jog_session_events
bridge:      /dashboard/jog_session_final { reason: "release", 0.9986 s }
JTC:         5× "Received/Accepted new action goal" + "Goal reached, success!"
/estun/rejected:  empty
J6:          -69.375° → -57.620°  (Δ +11.75° in 1000 ms)
```

But: audible mechanical **hunting/back-and-forth** under longer holds.
Operator stopped early — correct call. Mechanism diagnosed from source:

- `state_machine.py:_build_goal` returns `commanded_vel_rad_s` in the
  goal dict.
- `jog_bridge_node.py:_do_send_goal` builds `JointTrajectory` with
  `p0.positions`, `p1.positions`, and `time_from_start` — **BUT
  `p0.velocities` and `p1.velocities` are LEFT EMPTY**.
- JTC's default `splines` interpolation applies vel=0 boundary conditions
  when velocities are missing → each 2-point trajectory is a
  cosine-accelerate-to-peak-then-decelerate-to-0 profile.
- 100 ms preempt cadence + 200 ms horizon → every 100 ms a fresh goal
  arrives saying "at t=0 you have velocity 0" while the arm is actually
  moving at ~54°/s peak. JTC brakes hard, then restarts from zero.
- **10 Hz brake-restart cycle on a real gearbox = audible hunting.**

Regression-vs-first-exposure hunt landed the historical correction:

- `git log --all -p -S 'p0.velocities' -- src/jog_bridge/` → **empty**.
  Velocities have never been populated since jog_bridge was written.
- Prior "smooth motion" the operator remembered = addendum-33 Phase E5
  cartesian LIN (14 μm round-trip). Pilz LIN emits multi-waypoint
  trajectories with velocities on every point — different code path.
- Addendum-35 §526 explicit: "Rungs 3–6 NOT RUN. Immediately after the
  12/12, sustained holds produced no visible motion." The 12/12 pass was
  discrete taps (start→stop, no refresh cycle). Sustained holds through
  jog_bridge on real hardware = **first exposure today**.

## Section 544: The partial fix + the trace

Ship the velocity population — `p0.velocities = p1.velocities = signed_vel`
vector, target-joint index only, zeros elsewhere. Consecutive goals now
stitch as constant-velocity segments — no boundary discontinuity, no
brake-restart. **CodroidROS2 commit `80d65dd`**, pushed to
`theodoresimpson/CodroidROS2:main`. ATTEMPTS.md updated.

Verification: 5% × 500 ms confirming inject moved J6 +1.80° (~40%
throughput). But 10% × 1500 ms follow-up moved only +2.30° (~8.5%
throughput). **Hunting reduced but not eliminated.** Operator listened
directly and confirmed residual oscillation is still audible under
longer holds.

Full-rate bag captured before stopping:

```
~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/
    hunt_10pct_1500ms/     (sqlite3, 1.5 MiB, 6.01 s duration)
      /joint_states                    1491 msgs (~248 Hz)
      /joint_trajectory_controller/controller_state   876 msgs (~146 Hz)
    01_inject.log
    00_pre_snapshot.txt
    README.md                          (next-session analysis plan)
```

Rungs 3–6 REMAIN OPEN. Do not retry motion until the residual mechanism
is identified from the bag trace. See the evidence dir's README for the
next-session plan.

## Section 545: Reference tier built

Between the auth trail and the alarm saga, the operator directed a sweep
of every fact out of the ledger + STATE + CLAUDE.md into structured,
always-loaded reference files. Extraction ran across all 38 ledger files
(era-01 + addendum-01..37) plus this session's operational discoveries.

- `docs/HARDWARE.md` — 3.2 KB → 17.5 KB. Full controller port table with
  role and citation for each of `:22, :80, :502, :5000/1, :5555, :8080,
  :9000, :9001, :9002, :9090, :9091, :9198`. Joint/velocity/DH/frame-map
  constants; CC10-A power; DHCP subnet map; systemd inventory with the
  `Environment=` vs `EnvironmentFile=` precedence gotcha.
- `docs/OPERATIONS.md` — NEW 15 KB. Every procedure as numbered steps
  with exact commands + verification: CRI launch (5-step TCP init +
  log-line-3 audit), CRI teardown, `Robot/switchOn` over-the-wire, WS
  status probe with the exact subscribe burst, backend flip WS↔ros2,
  jog_bridge L216/L217/L239 discipline, dashboard restart + HTTPS
  gotcha, vite outDir single-source, `f14_inject.py` schema, session
  ritual (three writes + reference tier update).
- `docs/FACTS.md` — NEW 9.4 KB. Ambient truths: NO physical pendant
  (browser UI only), silent-mock class (L251), silent-write-accept
  (CRI UDP fire-and-forget), action-SUCCESS ≠ arrival, JTC humble cancel-
  terminal quirk, DDS lazy-publisher hazard, URDF J3/J5 sign flips
  intentional, twin J5 axis-flip render seam, JSB (2,3,1) fallback +
  server-side normalization workaround, NO SSH access on controller,
  Wi-Fi/.2.x split, standing debts.
- `docs/INDEX.md` — added REFERENCE section pointing at all three by
  topic.
- `CLAUDE.md` — session-start load raised from 5 → 8 files. New doctrine:
  **"update the ledger" now also updates the reference tier** whenever a
  new hardware/procedure/ambient fact is established. Reference facts
  land in the SAME COMMIT as the addendum + LESSONS line.

**Commit `edbfee0`** on `Ai-Robotics-Prototype/V1:feature/estun-write-path`.
`ledger_lint`: all 4 duties PASS.

## Section 546: Shipped commits, this session (chronological)

Ai-Robotics-Prototype/V1 (feature/estun-write-path):

```
f100fc7  dashboard: cri_proxy authoritative for jog fields under JOG_BACKEND=ros2
b1729b4  dashboard+frontend: serve from vite dist/, normalize JSB joint order
edbfee0  docs: build reference tier (HARDWARE + OPERATIONS + FACTS)
830fc4a  dashboard: fail-loud startup assertion on frontend coherence (closes L497)
1d3bc6d  dashboard: eager-init /dashboard/jog_session_events publisher
```

theodoresimpson/CodroidROS2 (main):

```
7d14be3  jog_bridge: null-tolerance on start/refresh event fields
80d65dd  jog_bridge: populate p0/p1 velocities on FollowJointTrajectory goals (PARTIAL)
```

## Section 547: Lessons

Continuous stream 257–264 land in LESSONS.md against this addendum. Each is
one line there; the mechanism lives here.

- **257** — Two identifiers of the same artifact aren't the same thing
  (§539 bundle tab confusion).
- **258** — `CriUdpSystem` latches `rx_ok_`/`command_synced_` true on
  first RX and doesn't reset on remote disconnect. Controller reboot →
  plugin silently serves stale cached feedback forever until plugin
  init. Named as its own hazard class (§542).
- **259** — Drop-in `EnvironmentFile=` loads AFTER the base unit's;
  drop-in `Environment=` is shadowed by any base `EnvironmentFile=`. Use
  the file approach for late-in-the-chain overrides (§540).
- **260** — JSB with an unhonored `-p` params file falls back to
  insertion-order joint names (`[Joint2, Joint3, Joint1, …]`). Frontend
  indexes by slot; server-side normalization by name is the
  workaround (§539).
- **261** — Real-arm sustained hold-jog through `jog_bridge` had never
  been proven before today. Prior smooth motion the operator remembered
  was Pilz LIN Cartesian (addendum-33, different code path). "Not a
  regression, first exposure" is a valid finding — verify with
  `git log -S` on the exact geometry line before deciding scope (§543).
- **262** — JTC `splines` interpolation with empty `p0/p1.velocities`
  applies vel=0 boundary conditions. Under 100 ms preempt cadence + a
  200 ms horizon that's a 10 Hz brake-restart cycle audible on the real
  gearbox. Pilz already populates velocities per waypoint — the jog
  path must do the same (§543/§544).
- **263** — The Codroid Web operating UI lives on **`:9198`**
  (`<title>Estun Web</title>`), not the ports a standard scan tries.
  `:8080` on the controller is `部署系统` deploy tool — DO NOT USE for
  operations (§541).
- **264** — Fail-loud startup assertion beats silent-broken-shell.
  Refuse to boot the server if `index.html` or its referenced chunk are
  missing/mismatched; systemd `Restart=on-failure` escalates loudly (§539
  / L497 SHIPPED).

## Summary

The first hold that moved a real S10-140 joint through the ROS2 stack
happened at 13:27 CDT on 2026-08-24: J6+ 15% × 1 s, arm moved
+11.75° at ~12°/s, motion chain proven end-to-end. Longer holds hunted
audibly — mechanism named (JTC vel=0 boundary on empty velocities), first-
exposure not regression (git log confirmed the geometry has never
populated velocities), partial fix shipped (velocity-populated goals
now stitch as constant-velocity segments), residual mechanism captured
to disk (a full-rate `/joint_states` + `/controller_state` bag under the
evidence directory). Between the arm hitting an alarm mid-session and
the fix landing, four upstream defects were shipped as their own commits,
the CRI plugin's remote-disconnect state-latching was named as a hazard
class, `Robot/switchOn` over the wire was proven, the Codroid operating
UI on `:9198` was discovered, and a reference tier of 42 KB was built and
committed with the standing rule that operational facts are now first-
class ledger citizens. Rungs 3–6 remain open pending the trace analysis;
next session opens on the bag.
