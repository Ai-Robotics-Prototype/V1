# STATE.md — current truth as of 2026-08-24 (end of Addendum 38)
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
- **Trace captured for next session** at
  `~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/hunt_10pct_1500ms/`
  — 6 s bag with `/joint_states` (1491 msgs @ 248 Hz) and
  `/joint_trajectory_controller/controller_state` (876 msgs @ 146 Hz)
  during a 10% × 1.5 s J6+ hold. See its `README.md` for the
  next-session analysis plan.

## Next session opener (exact order)

1. **Analyze the bag** at `~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/`.
   Plot `/joint_states.position[Joint6]` vs time; plot
   `controller_state.{reference, feedback, output, error}` per joint.
   Confirm whether residual oscillation is (a) JTC spline emitting a
   non-constant velocity within a segment despite the fix, (b)
   `CriUdpSystem.max_step_rad = 0.002` clamp firing at spline peaks,
   or (c) something else.
2. **Only after the trace mechanism is named**, propose the next fix.
   Options in scope depending on what the trace shows: longer horizon,
   populated accelerations on the trajectory points, tighter JTC
   `goal_tolerance` config, plugin `max_step_rad` retune.
3. Confirming inject at 5% × 500 ms, listen for smooth.
4. Then rungs 3 (J6+ 3 s), 4 (J6- 3 s), deadman A, deadman B, 60-s soak
   per the original F1.4 script.
5. Arm safed at session end; before rungs resume, run through OPERATIONS.md
   §1 (CRI launch) and OPERATIONS.md §3a (`Robot/switchOn` over the wire
   if the controller comes up disabled).

## Open defects / directed-not-confirmed

- **Hold-jog residual oscillation** — partial fix shipped (sha `80d65dd`
  in CodroidROS2); mechanism to be named from the captured bag. Rungs
  3–6 blocked on this.
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
  today; Wi-Fi currently at `.143` (unreserved).
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
Jetson eno1 `192.168.2.246`; Wi-Fi lease `.143` (unreserved).
`max_step_rad 0.002` session override. Repos:
- `Ai-Robotics-Prototype/V1:feature/estun-write-path` head `1d3bc6d+` (edbfee0/830fc4a/1d3bc6d landed today; addendum-38 + LESSONS + STATE + ATTEMPTS still to commit)
- `theodoresimpson/CodroidROS2:main` head `80d65dd` (velocity-populated fix, partial)
