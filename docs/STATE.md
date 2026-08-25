# STATE.md — current truth as of 2026-08-24 (end of Addendum 39, F1 rungs 3-6 unblocked)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **F1.4 motion chain PROVEN on the real arm today.** J6+ 15% × 1 s
  drove the arm from -69.375° → -57.620° (Δ +11.75°, ~12°/s realized).
  Full path fanout → jog_bridge SM → JTC → CriUdpSystem → UDP → arm
  end-to-end for the first time on real hardware (per ledger record;
  addendum-35 §526 had parked "no visible motion" on holds).
- **Hold-jog HUNTING open (partial fix shipped).** Longer holds
  (15% × 2 s, 10% × 1.5 s) hunted audibly — mechanical back-and-forth.
  Mechanism named from source: JTC `splines` applies vel=0 boundary
  conditions on empty `p0/p1.velocities` → 10 Hz brake-restart cycle
  on preempt.
- **Velocity-populated fix shipped** in `theodoresimpson/CodroidROS2:main`
  as sha `80d65dd`. Constant-velocity boundary conditions on both endpoints
  of every goal. Reduces but does NOT eliminate the oscillation
  (throughput 40% at 5%×500 ms, 8.5% at 10%×1500 ms; residual still audible).
  Rungs 3–6 REMAIN OPEN.
- **Trace captured** at
  `~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/hunt_10pct_1500ms/`
  — 6 s bag with `/joint_states` (1491 msgs @ 248 Hz) and
  `/joint_trajectory_controller/controller_state` (876 msgs @ 146 Hz)
  during a 10% × 1.5 s J6+ hold.
- **Hunt-trace verdict = GOAL-SEAM** (addendum-39 §551). Diagnosis
  DONE, fix SHIPPED and verified on the real arm this session.
- **Reference-cursor anchor fix SHIPPED** (addendum-39 §553-§554).
  `theodoresimpson/CodroidROS2:main` head `f6d4d53` — jog_bridge
  `_build_goal` anchors target-joint `p0.position` on the extrapolated
  JTC reference cursor + safety guard at 0.15 rad (8.6°). Verified
  2026-08-24 16:26 CDT J6+ 10% × 1.5 s on v4 bag: sign reversals
  28 → 0, peak `d/dt reference −` reads +0.00 °/s exact, realized
  8.1 % → 79.5 %. Guard-collision (5° threshold vs. ~5° steady-state
  err) exposed and closed by the 8.6° tune-up.
- **Method gotcha named** (addendum-39 §548). Do NOT read
  `controller_state.reference.velocities` as a reference-velocity
  ground truth — it is a *stored echo* of what the bridge stuffed into
  the trajectory point. Truth lives in `d/dt reference.positions`.
- **Bridge-uptime degradation named** (addendum-39 §556). On the same
  jog_bridge process, fresh injects work at ~100 % throughput but
  subsequent injects (~30 min uptime) silently degrade to 13 % then
  0 % — every event dispatches, only one goal reaches JTC per session.
  Fresh restart cures instantly. F1 workaround: `pkill -f
  jog_bridge_node` before each formal test. F3 hardening item.

## Next session opener (exact order)

1. **Rungs 3-6 per the F1.4 script**, on this session's fix baseline:
   - `pkill -f jog_bridge_node && sleep 2 && JOG_BACKEND=ros2 ros2 run
     jog_bridge jog_bridge_node` in its own tmux (fresh-bridge workaround
     for §556 uptime degradation — do NOT skip).
   - Rung 3: J6+ 3 s hold at 10 %. Rung 4: J6- 3 s hold at 10 %.
   - Deadman A: `--no-stop` flag (bridge silence deadman must cancel).
   - Deadman B: `kill -9 $(pgrep -f jog_bridge_node)` mid-hold (JTC
     must fall through to a stop within safety margin).
   - 60-s soak at 10 % (extended hold; watch for guard-fallback count
     rising in bridge stats — if soak surfaces §555 spline overshoots
     as accumulation, revisit the deferred `.accelerations` populate).
   - Pass on each = smooth+quiet by ear AND
     `d/dt reference.positions` monotonic-signed (no sign reversals)
     with `peak −` at 0 °/s. Forward spline overshoots up to +80 °/s
     accepted per §555.
2. **§555 Path B** (populate `.accelerations = [0.0]*N` on
   JointTrajectoryPoint p0/p1) is deferred P3 polish. Revisit only if
   soak surfaces overshoot accumulation.
3. **§556 bridge-uptime degradation** — separate F3 hardening item;
   don't debug during rung work, just apply the fresh-restart workaround.
4. Arm safed at session end; before rungs resume, run through OPERATIONS.md
   §1 (CRI launch) and OPERATIONS.md §3a (`Robot/switchOn` over the wire
   if the controller comes up disabled).

## Open defects / directed-not-confirmed

- **Hold-jog residual oscillation** — CLOSED. Reference-cursor anchor
  + 8.6° guard threshold (addendum-39 §553-§554, CodroidROS2 sha
  `f6d4d53`). 28 → 0 sign reversals, peak `d/dt reference −` at
  +0.00 °/s exact, 79.5 % realized. Rungs 3-6 unblocked pending the
  operator's by-eye confirmation on the v4 inject.
- **Bridge-uptime degradation** — DIAGNOSED (addendum-39 §556). Fresh
  bridge = 100 %; ~30 min uptime bridge silently drops to 13 % then
  0 % throughput. F1 workaround: fresh restart before each formal test.
  F3 hardening item (suspected ActionClient handle leak / DDS state
  drift).
- **CriUdpSystem silent-write-accept class** — `rx_ok_` and
  `command_synced_` latched, never reset on remote disconnect; controller
  reboot leaves stale cached feedback. F3 hardening item; workaround for
  now is teardown+relaunch after any controller state event.
- **JSB spawner-param root cause** — yaml declares `Joint1..Joint6` but
  runtime publishes `[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]`.
  Server-side normalization is the workaround; F3 investigates why the
  spawner isn't honoring `-p`.
- **Version-toast false-fire** — UI compares vite chunk hash (filename)
  vs `git describe` build-ID (baked constant), which are two identifiers
  of the same artifact. F3 fix: compare like-for-like.
- **`cri-proxy-staleness` thread ImportError** at boot — pre-existing
  `from .staleness import staleness_decide` relative import fails
  because `dashboard_server.py` runs as `__main__` not as a package.
  Non-fatal (thread dies, main server continues); flap-detection loop
  isn't running. F3 item.
- **DHCP reservation** `50:2e:91:95:b6:15 → .246` — FIFTH bite as of
  2026-08-25; Wi-Fi currently at `.1.143` (unreserved). Wired path
  `.2.50 → .2.246` (HARDWARE.md Subnet map) now sidesteps this class
  as the STABLE operator path — Wi-Fi is fallback only.
- **V1 GitHub repo still PUBLIC** — long-open credential rotation debt.
- Safety-edge margin retune, recovery-modal lifecycle, palletize slot-1
  — from earlier STATE, unchanged this session.

## Paused / intact

- **CRI motion stack: TORN DOWN at session end.**
  `python3 ~/cri_eval_ws/cri_teardown.py` executed after the trace
  capture; arm restored to Manual mode. Do not restart without running
  the OPERATIONS.md §1 recipe (5-step TCP init).
- **jog_bridge: killed at session end.** Restart per OPERATIONS.md §8
  (L216/L217/L239 discipline) in `tmux robot:jog_bridge`.
- **`roboai-estun` STOPPED** (with F1 drop-in
  `/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.env`
  forcing `ESTUN_MONITOR_ONLY=true`, `ESTUN_ALLOW_JOG=0`). Fallback:
  remove drop-in + `systemctl start roboai-estun` for `backend=ws`.
- **Dashboard: LIVE**, PID varies. Systemd active. `JOG_BACKEND=ros2` +
  `CAMERAS_DISABLED=1` via `campaign-f1.conf` drop-in. Frontend served
  from `frontend/dist` (single source of truth). Coherence assertion
  fires and passes at boot. Fanout publisher created eagerly in
  `__init__`.

## Reference tier built this session (always-loaded)

Per addendum-38 §545:

- `docs/HARDWARE.md` — full controller port table with role citations,
  joint/velocity/DH constants, systemd inventory with env-precedence
  gotcha, alarm code list.
- `docs/OPERATIONS.md` (NEW) — every procedure as numbered steps with
  exact commands + verification.
- `docs/FACTS.md` (NEW) — ambient truths (silent classes, wire quirks,
  "enabled" per surface).
- `docs/INDEX.md` — REFERENCE section added.
- `CLAUDE.md` — session-start load raised 5 → 8 files; new doctrine that
  "update the ledger" also updates the reference tier.

## Roadmap after F1

Unchanged from prior STATE. F2 (executor over MoveIt), F3 (everything
under systemd + hardening items collected here), F4 (white bowl over
CRI).

## Hardware/session constants (details in HARDWARE.md)

Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
`:9198` operating UI, `:8080` deploy tool DO NOT USE, fw `2.3.3.43`).
Jetson eno1 `192.168.2.246` (STABLE, laptop wired at `.2.50`);
Wi-Fi lease `.1.143` (unreserved, flaky fallback).
`max_step_rad 0.002` session override. Repos:
- `Ai-Robotics-Prototype/V1:feature/estun-write-path` head `872fdf5+` (addendum-38 + addendum-39 + LESSONS + STATE + ATTEMPTS all landed; §553/§554/§555/§556 pending commit at end-of-session)
- `theodoresimpson/CodroidROS2:main` head `f6d4d53` (reference-cursor anchor `113e3f3` + guard-threshold tune `f6d4d53`)
