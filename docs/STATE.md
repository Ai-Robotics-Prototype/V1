# STATE.md — current truth as of 2026-08-26 late (end of Addendum 42, plugin-side accel clamp shipped, hardware retest gated on power-cycle)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **Continuous jog on the real arm PROVEN smooth** at low percentages.
  Small bite (J6+ 5 % × 0.5 s) and Rung 3 (J6+ 3 s hold @ 10 %) both
  passed with cmd Δ = actual Δ to 0.000° tracking, no errors,
  no divergence, no settling triggered. Baseline:
  `theodoresimpson/CodroidROS2:main` sha `af24198`.
- **Three pre-flight fixes landed** on top of the addendum-40 accel-ramp
  + settling baseline (addendum-41 §569):
  - `c86ca60` — idle re-seed (tracks fb during idle to prevent
    stale-pose snap), name-map rebuild (JSB order-change guard),
    saturation invariant (WARN if commanded vel > 80 % of plugin slew).
  - `e46887c` — idle-track deadband (5e-5 rad ≈ 4 × encoder LSB) so
    `RobotStatus.isMoving` stays 0 during idle instead of flapping.
  - `af24198` — divergence_threshold_rad 0.087 → 0.175 (5 ° → 10 °),
    accommodating the ~250 ms J6 response latency named in §571.
- **Flicker mechanism diagnosed** (addendum-41 §571): NOT saturation
  (live `max_step_rad=0.0050` verified), NOT the guard-readopt loop
  (phantom defense already blocks it), NOT dueling consumers. Actual
  mechanism: arm response latency (~250 ms) × commanded velocity, at
  22 % wire speed_pct cmd advanced 7-8 ° during arm response window and
  tripped the old 5 ° threshold → settling ramped cmd backward → arm
  overshot the retreating cmd → oscillation.
- **Rung 3 at 10 % was on the razor's edge**: peak \|cmd-fb\| = +4.47 °,
  right against the old 5 ° threshold. New 10 ° threshold has
  headroom.
- **Retest at 5 % × 0.5 s** after threshold bump: cmd Δ = actual Δ =
  +2.47 °, \|cmd-fb\| SS = 0.000 °, max \|cmd-fb\| during ramp = +2.27 °
  (well under 10 °), guard silent (no DIVERGENCE / SETTLE / SILENCE).
  Evidence: `evidence/2026-08-26_F1_close/retest_5pct_v2/`.
- **Silent-refusal signature named** (addendum-40 §564, L272). JTC
  returns "Goal successfully reached!" against a Disabled arm (state=0);
  `cod_cri_hardware` `write()` does not propagate arm-side servo state.
  Verify `state=2 AND recoveryState=0 AND errors=[]` over WS `:9000`
  before trusting ROS2-side success.
- **Dashboard 15 %→22 UI bug remains OPEN** (addendum-40 §565). Slider
  "15 %" sends `speed_pct=22.0` on the wire. Named as the operator-
  experience root cause of the "flicker" the operator saw at "15 %";
  belongs to a dashboard session.
- **DDS start-drop race in f14_inject named** (addendum-41 §573). The
  0.5 s publisher-creation-to-emit gap in `f14_inject.py` occasionally
  loses the START event to DDS discovery. Workaround:
  `/tmp/hardened_inject.py` waits on `pub.get_subscription_count() > 0`.
  Filed as F3 hardening — promote the subscription-match wait into
  `f14_inject.py` proper.
- **Alarm 2015 tripped AGAIN at 24 % wire** (addendum-42 §576-§578):
  bursty adapter delivery. Python 250 Hz timer intermittently stalls
  10-60 ms, then bursts 2-4 msgs within <1 ms; plugin's next write()
  sees a multi-tick delta as a single pos_cmd_ update. Neither
  `clamp_step` (per-cycle position slew) nor the upstream adapter's
  accel-ramp closes this seam.
- **Durable fix shipped 2026-08-26**: `CriUdpSystem::clamp_accel_step`
  bounds `|Δv/cycle|` at the RT rate — upstream jitter is now
  irrelevant. Xacro param `max_accel_step_rad` default 0.00032
  (= 20 rad/s² × dt²). 10-case unit test PASS. CodroidROS2 sha
  `c66c8f0`.
- **Interim adapter accel** lowered 18 → 12 rad/s² as belt-and-
  suspenders. Revisit upward after plugin-clamp hardware verification.
- **Recovery gate: recoveryState=1 PERSISTS after ClearError +
  switchOn** (addendum-42 §580). Physical controller power-cycle
  required. NO hardware retest until power-cycle.
- **Rungs 4-6 + deadmans + soak** and **24 % retest** DEFERRED to next
  session on `c66c8f0`'s baseline (adapter interim + plugin clamp).

## Next session opener (exact order)

1. **Rungs 4-6 + deadmans + soak** on `af24198`'s baseline:
   - OPERATIONS.md §1 (`use_mock:=false use_servo:=true`).
   - WS four-tuple `{state:2, stateName:'Enabled', recoveryState:0,
     errors:[]}`. If `recoveryState=1`, physical power-cycle only
     (addendum-40 §566).
   - Dashboard clients = 1 (operator only); 30 s idle monitor = 0
     events; if any straggler, `systemctl restart roboai-dashboard`.
   - Rung 4: J6− 3 s hold @ 10 %. Rung 5: J1 or similar range-safe
     joint. Rung 6: extended hold (30 s) at 10 %.
   - Deadman A: `--no-stop` flag on `f14_inject.py` — silence deadman
     must cancel within 300 ms (adapter's `silence_timeout_s`).
   - Deadman B: `kill -9 $(pgrep -f jog_servo_adapter_node)` mid-hold.
     Pass = arm HOLDS last commanded position (position controller
     forward-command semantics); no jump. New adapter should refuse
     to accept any prior refresh on restart (phantom-defense).
   - 60 s soak at 10 %; sample stats.divergence_halts and
     stats.phantom_rejects at 15/30/45/60 s.
   - Pass criteria unchanged: smooth by ear, zero `publish/Error`,
     Δref/tick at accel-ramp value throughout, guard silent.
2. **The dashboard 15 %→22 UI bug** (addendum-40 §565, addendum-41
   §571) — separate dashboard session. Blocks trust in any speed-
   labelled test result. The threshold bump in §572 defangs the
   flicker symptom but the underlying wire-map mismatch remains.
3. **DDS start-drop race in f14_inject** (addendum-41 §573) — promote
   the subscription-match wait from `/tmp/hardened_inject.py` into
   `f14_inject.py` proper before the next inject-driven test.
4. **`AccelerationLimitedPlugin` backport check** — still pending from
   addendum-40 §568. Only relevant if the adapter's per-cycle ramp
   moves out-of-tree; not blocking rungs.

## Open defects / directed-not-confirmed

- **Continuous-jog on real arm** — CLOSED-pending-verification. Accel-
  ramp adapter (`f0e2930`) + settling divergence guard (`cb022d3`).
  Mock guard-test PASS; real-arm retest gated on §568 sequence.
- **Goal-replacement bridge** — RETIRED (addendum-40 §558). J2 drive
  trip on velocity spike. Wrong primitive for jog (stitches preempted
  trajectory goals). Do not revisit.
- **Bridge-uptime degradation** — SUPERSEDED. Was on the retired path.
  Delete workaround from rung procedure.
- **CriUdpSystem silent-write-accept class** — extended (addendum-40
  §564): also applies to JTC "success" against Disabled arm, and to
  direct-write on `/joint_group_position_controller/commands`. WS-probe
  is authoritative for arm-side state. F3 hardening item
  (`CriUdpSystem::read` should re-arm `command_synced_` on remote
  disconnect / arm-state transitions).
- **Divergence-guard-snap trip cause (addendum-40 §563)** — FIXED. A
  guard that step-corrects position on an accel-limited controller
  becomes its own trip source. Settling substate ships in `cb022d3`.
- **Phantom stale-tab source (addendum-40 §565)** — FIXED
  operationally (dashboard restart); underlying browser lifecycle
  (queued hold state on WS reconnect) not yet debounced server-side.
  F3 item.
- **Dashboard 15 %→22 UI bug (addendum-40 §565)** — OPEN. Slider display
  ≠ wire value on `speed_pct`. Blocks trust in any prior speed-labelled
  result. F3 dashboard session.
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
  `python3 ~/cri_eval_ws/cri_teardown.py` executed after the guard
  mock-verification; arm restored to Manual mode. Do not restart without
  running the OPERATIONS.md §1 recipe (5-step TCP init).
- **jog_servo_adapter: not running** (the launch spawns it under
  `use_servo:=true`). Standalone runs during the guard test used a
  redirected topic (`/jog_test/pos_cmd`) — that mode is gone.
- **goal-replacement `jog_bridge`: RETIRED (§558).** Not running; not
  restarted. Code retained in-tree for jog_bridge tests / archaeology
  but no launch consumes it.
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
Live plugin `max_step_rad = 0.005` (session-2026-08-25 bump per
addendum-40 §561; verify at boot via `[CriUdpSystem]: CRI UDP bind …
max_step_rad=0.0050`; disk source is
`cri_tcp_setup.yaml`). Repos:
- `Ai-Robotics-Prototype/V1:feature/estun-write-path` — unchanged this
  session (all V1 patches for the retired goal-replacement path).
- `theodoresimpson/CodroidROS2:main` head `c66c8f0` — accel-ramp
  adapter (`f0e2930`) + settling guard (`cb022d3`) + phantom defense
  (`9241be5`) + F1 close-out pre-flight (`c86ca60`) + idle deadband
  (`e46887c`) + divergence-threshold 5°→10° (`af24198`) + plugin-side
  per-cycle accel clamp + adapter interim 18→12 rad/s² (`c66c8f0`).
