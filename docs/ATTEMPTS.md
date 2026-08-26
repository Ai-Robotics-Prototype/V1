# ATTEMPTS.md — approaches tried, verdicts, and pointers
> Grep-on-demand (NOT in the always-loaded distillate tier). One line per
> attempt, chronological by ledger slug. Cite with `add-NN §S` or
> `era-01 L####` for grep back into the ledger.
>
> **Format:** `<slug> <§section-or-line> — <one-line attempt> — VERDICT: <one-word>`
>
> **Verdict vocabulary:** SHIPPED, REVERTED, ABANDONED, DEFERRED, EXONERATED,
> FAILED, PASS, INFLIGHT, ADOPTED, REJECTED, DIRECTED, DIAGNOSED, PROVEN,
> DOCUMENTED, PARKED, FIXED, CONVICTED, PLANNED, MEASURED, LAUNCHED,
> RESOLVED, AUDITED, DECLARED, SPEC'D, CONFIRMED, NAMED.
>
> **Adding an entry:** append under the correct addendum slug in slug-order.
> The row-count sanity target is ≥ 100; anything much lower means an
> addendum's sweep is incomplete. Skipped-addendum audit list at the
> bottom.

## Entries (pre-v46 era + v46 splits)

era-01 L1663 — Ubuntu upgrade via `do-release-upgrade` over SSH — VERDICT: FAILED
era-01 L1999 — JetPack 6 / Ubuntu 22.04 upgrade — VERDICT: DEFERRED
era-01 L2103 — First colcon build (ament_cmake missing) — VERDICT: FAILED
era-01 L2116 — Second colcon build (invalid email in package.xml) — VERDICT: FAILED
era-01 L2124 — Third colcon build (invalid condition in occupancy_map) — VERDICT: FAILED
era-01 L3109 — Jetson flash attempts (VirtualBox USB driver orphan) — VERDICT: FIXED
era-01 L3158 — package.xml emails rosdep rejected — VERDICT: FIXED
era-01 L4016 — Pre-fix failure mode documented — VERDICT: DOCUMENTED
era-01 L4139 — Other flash methods tried that did NOT work — VERDICT: DOCUMENTED
era-01 L5591 — Root-cause analysis of 7 failed flash approaches — VERDICT: DOCUMENTED
era-01 L5944 — Features adopted from Standard Bots interface — VERDICT: ADOPTED
era-01 L6464 — Per-link URDF meshes (attempted) + `links.json` — VERDICT: ATTEMPTED
era-01 L6670 — Static 3D model (not articulated; STEP split failed) — VERDICT: ABANDONED

## v46 addendum splits (chronological)

add-05 L42 — PBD API key working after account funded — VERDICT: SHIPPED
add-05 L43 — Correction-diff capture — VERDICT: SHIPPED
add-05 L44 — Data flywheel plan — VERDICT: DOCUMENTED
add-05 L45 — PBD pallet-grid extraction (schema + prompt) — VERDICT: DEFERRED
add-05 L46 — Interactive clarifications (structured questions) — VERDICT: DEFERRED
add-05 L47 — Detect step part dropdown — VERDICT: SHIPPED
add-05 L48 — Render-error debugging with error boundaries — VERDICT: SHIPPED
add-05 L49 — Contoured keep-out zones (alpha-shape concave) — VERDICT: SHIPPED
add-05 L50 — GitHub main sync to current — VERDICT: SHIPPED
add-05 L51 — DH-accurate URDF from CAD — VERDICT: SHIPPED
add-05 L52 — Photoneo MotionCam ARM64 confirmed — VERDICT: CONFIRMED
add-07 L36 — Tablet polygon budget 30k triangles at export — VERDICT: ABANDONED
add-16 L281 — Jog protocol wire-captured (Robot/jog/stopJog) — VERDICT: SHIPPED
add-16 L282 — Driver write path with gated jog/power — VERDICT: SHIPPED
add-16 L283 — First commanded motion 6-joint agreement — VERDICT: SHIPPED
add-16 L284 — Dashboard jog UI evolution (step/continuous) — VERDICT: SHIPPED
add-16 L285 — Silent-lockout catalog (state banners, guards) — VERDICT: SHIPPED
add-16 L286 — Continuous jog jitter (three root causes fixed) — VERDICT: SHIPPED
add-16 L287 — E-stop recovery procedure rehearsed — VERDICT: SHIPPED
add-16 L288 — Power path enable/disable/alarm-clear — VERDICT: SHIPPED
add-16 L289 — Joint-limit lockout + recovery modal — VERDICT: SHIPPED
add-16 L290 — Singularity-aware speed governor (specced) — VERDICT: DEFERRED
add-16 L291 — Collision guard system (self/ground/env) — VERDICT: SHIPPED
add-16 L292 — Driver-down candle-pose staleness — VERDICT: SHIPPED
add-16 L294 — OEM parity program declared — VERDICT: DECLARED
add-21 L351 — Wait verb concluded (integer ms required) — VERDICT: SHIPPED
add-21 L352 — Derived-pose resolver built — VERDICT: SHIPPED
add-21 L353 — Test wizard first execution on real arm — VERDICT: SHIPPED
add-21 L354 — J5 wrist re-solve diagnosed (movL IK) — VERDICT: SHIPPED
add-21 L355 — Home drift normalized 96.67° — VERDICT: SHIPPED
add-21 L357 — Controller-crash forensics via boot logs — VERDICT: PROVEN
add-21 L358 — Driver init-grace hardening (grace + probe + backoff) — VERDICT: SHIPPED
add-21 L360 — Speed cap raised to 0.65 — VERDICT: SHIPPED
add-21 L361 — Collision body-test (foam block discipline) — VERDICT: ADOPTED
add-21 L362 — Payload as per-program property — VERDICT: SHIPPED
add-21 L363 — I/O manual actuation (gate, bridge toggles) — VERDICT: SHIPPED
add-21 L365 — Solenoid circuit (relay required) — VERDICT: DEFERRED
add-21 L367 — Tablet jog jitter + teach sticky-bar — VERDICT: DIRECTED
add-21 L368 — Stability batch A–J (prompts issued) — VERDICT: DIRECTED
add-23 L387 — Effector-aware composer (Engage/Disengage vacuum) — VERDICT: SHIPPED
add-23 L388 — 9012 alarm postmortem (shutdown residue) — VERDICT: EXONERATED
add-23 L389 — Zombie boot #2 (transport down) — VERDICT: EXONERATED
add-23 L390 — Wedge 2h41m state-3 (verification loop + auto-retry) — VERDICT: SHIPPED
add-23 L391 — Eye-in-hand mount measurements + AprilTag — VERDICT: MEASURED
add-23 L392 — Pause/resume + paused-state + retrace home — VERDICT: DIRECTED
add-23 L393 — Pre-move network prep — VERDICT: PLANNED
add-23 L394 — Bring-up at new shop (physical layer wins) — VERDICT: SHIPPED
add-23 L395 — Router saga (factory reset, self-provision) — VERDICT: RESOLVED
add-23 L396 — Joint-angle display + match selector — VERDICT: DIRECTED
add-23 L397 — Named positions (linking, sync, cross-device) — VERDICT: SHIPPED
add-23 L398 — Two-pair anchor bug (prompt authored) — VERDICT: DIAGNOSED
add-23 L399 — Accept-binding disease (recompose server-side) — VERDICT: SHIPPED
add-23 L400 — Program library delete 404 — VERDICT: DIAGNOSED
add-23 L401 — J4 solved via flight recorder (seeded IK) — VERDICT: SHIPPED
add-23 L402 — Vision reset (renderer + matcher gate) — VERDICT: SHIPPED
add-23 L403 — Fixed-cam vision-guided picking prompts — VERDICT: DIRECTED
add-23 L404 — Cloud recognition pilot (RunPod, domain-randomized) — VERDICT: LAUNCHED
add-24 L408 — J4 recurrence (stale-service staleness layer) — VERDICT: SHIPPED
add-24 L409 — 7.6° reframe (endpoint arithmetic) — VERDICT: EXONERATED
add-24 L410 — Video + J2 revelation (path hump) — VERDICT: DIAGNOSED
add-24 L411 — Trajectory-level analysis prompt — VERDICT: DIRECTED
add-24 L412 — Motion profiles (Straight vs Fast) — VERDICT: DIRECTED
add-24 L413 — Speed ceiling to 100% — VERDICT: DIRECTED
add-24 L414 — Joint values + match selector — VERDICT: DIRECTED
add-24 L415 — PBD multiplicity (three-bowl count) — VERDICT: DIRECTED
add-24 L416 — Editable review + corrections ledger — VERDICT: DIRECTED
add-24 L417 — Learning-store truth documented — VERDICT: DOCUMENTED
add-24 L418 — Hiring plan (two engineers) — VERDICT: PLANNED
add-24 L419 — Drag button config checklist + cell-scoped zones — VERDICT: DIRECTED
add-24 L420 — ROI math + factory-UI shopping list — VERDICT: DOCUMENTED
add-27 L450 — Pallet teach flow (six iterations, completed) — VERDICT: SHIPPED
add-27 L451 — Drag mode works (Auto was blocker) — VERDICT: SHIPPED
add-27 L452 — Teachability positive-list law — VERDICT: SHIPPED
add-27 L453 — Program doctrine (D1–D10) — VERDICT: DOCUMENTED
add-27 L454 — Validator consolidation (17 checks, one door) — VERDICT: SHIPPED
add-27 L455 — Sync convergence (never confidently behind) — VERDICT: SHIPPED
add-27 L456 — Self-collision stand-down + jog cutout fixes — VERDICT: DIRECTED
add-27 L457 — AUTO-DEPLOY ON COMMIT (root-cause fix) — VERDICT: SHIPPED
add-27 L458 — Confirm-capture fork unification — VERDICT: DIRECTED
add-29 L467 — Resident-mismatch banner root-cause diagnosis — VERDICT: EXONERATED
add-29 L468 — Load rollback (currentProgram follows push) — VERDICT: SHIPPED
add-29 L469 — Five-hour ghost state unmasked — VERDICT: PROVEN
add-29 L470 — Forensics: three kills, one line (movJCoorRel arity) — VERDICT: PROVEN
add-29 L471 — Pending-pose quarantine + arity validation — VERDICT: SHIPPED
add-29 L472 — Link-down honesty + D15 blend check — VERDICT: SHIPPED
add-29 L473 — Operator toast copy (title/detail/technical) — VERDICT: SHIPPED
add-29 L474 — Pallet-frame fork kill (backend-only validation) — VERDICT: SHIPPED
add-29 L475 — Fork registry + `fork_lint` gate — VERDICT: SHIPPED
add-29 L476 — RECORD-THROUGH teach state (server-owned drafts) — VERDICT: SHIPPED
add-29 L478 — PBD determinism (pure composer, no detect) — VERDICT: SHIPPED
add-29 L479 — Unit lie (meters vs mm check) — VERDICT: SHIPPED
add-29 L480 — J6 clamp silent-firing convicted — VERDICT: CONVICTED
add-30 L483 — J6 clamp trap (escape-direction rule) — VERDICT: DIRECTED
add-30 L484 — Pallet-pitch validator doctrine (corners=frame) — VERDICT: DIRECTED
add-30 L485 — Teach-session lock (four incidents → device-identity fix) — VERDICT: DIRECTED
add-30 L486 — PBD determinism (composer pure function, home unify) — VERDICT: DIRECTED
add-30 L487 — Run-refused modal copy fork — VERDICT: DIRECTED
add-30 L488 — Disk-full cascade (root-cause audit) — VERDICT: PROVEN
add-30 L489 — Atomic recovery (507-on-ENOSPC + refresh + watchdog) — VERDICT: SHIPPED
add-30 L490 — Code review (device-identity-per-tab root of all locks) — VERDICT: AUDITED
add-31 L495 — Enable-button blast-radius verification — VERDICT: SHIPPED
add-31 L496 — Deploy was lying (hashing wrong file) — VERDICT: FIXED
add-31 L497 — Stale-bundle browser cache — VERDICT: SHIPPED (2026-08-24, sha edbfee0..: vite outDir + `_STATIC_DIR` unified to `frontend/dist`; `index.html` served with `Cache-Control: no-cache, no-store, must-revalidate`; startup assertion `_assert_frontend_coherent()` refuses to boot if index.html is missing or its referenced `/assets/index-*.js` chunk isn't on disk — fail-loud replaces silent-broken-shell)
add-31 L498 — Jog jitter (WiFi exonerated, lock contention convicted) — VERDICT: FIXED
add-31 L499 — Palletize subroutine (real cycle with I/O) — VERDICT: SHIPPED
add-31 L500 — Performance-drop reckoning + verification gate — VERDICT: ADOPTED
add-31 L501 — Network IP-wander (WiFi DHCP vs robot static) — VERDICT: DIAGNOSED
add-31 L502 — Cell Box I/O architecture (EtherNet/IP valve island) — VERDICT: SPEC'D

## Post-v46 addenda

add-34 L519 — F1 scope: jog bridge via seam — VERDICT: SHIPPED
add-34 L520 — F1.0 hybrid coexistence (CRI + WS) — VERDICT: PASS
add-34 L521 — F1.1 bridge physics + state machine — VERDICT: SHIPPED
add-34 L522 — F1.2 mock scenarios (stuck-CANCELING race found) — VERDICT: FIXED
add-35 L524 — Bring-up gauntlet (four failures) — VERDICT: RESOLVED
add-35 L525 — Rung 1 + Rung 2 (first human jog 12/12) — VERDICT: PASS
add-35 L526 — Hold defect parked with diagnostic pre-written — VERDICT: PARKED
add-36 §528 — Hold defect root-caused (watchdog flap + stale bundle) — VERDICT: NAMED
add-36 §528 — Regression `test_jog_hold_heartbeat` 5/5 — VERDICT: PASS
add-36 §528 — In-vitro dashboard hold (27 events, 100ms cadence) — VERDICT: EXONERATED
add-36 §528 — Bridge SM simulation (27 goals, +81° over 3s) — VERDICT: EXONERATED
add-36 §528 — Watchdog 1.0→3.0s + hysteresis + flip counters + `CAMERAS_DISABLED=1` — VERDICT: SHIPPED
add-36 §529 — Safety-edge margin retune (measured latency, 5° cap) — VERDICT: DIRECTED
add-36 §530 — Recovery modal lifecycle (hold-persistent, Done-gated) — VERDICT: DIRECTED
add-36 §531 — Palletizing defects scoped (slot-1 regression, double-descend) — VERDICT: DIAGNOSED
add-36 §532 — Ledger restructure (split into distillates + archive) — VERDICT: SHIPPED
add-37 §534 — LESSONS extraction methodology audit (heading vs list format) — VERDICT: DOCUMENTED
add-37 §534 — docs/ATTEMPTS.md + build_full_ledger.sh + ledger_lint.py — VERDICT: SHIPPED
add-37 §535 — Dashboard drop-in JOG_BACKEND=ros2 + CAMERAS_DISABLED=1 — VERDICT: SHIPPED
add-37 §535 — Frontend rebuild + served-bundle hash verify (`index-CPjpRuaL`) — VERDICT: SHIPPED
add-37 §535 — jog_bridge null-tolerance (int(x or 0) × 6 sites) — VERDICT: SHIPPED
add-37 §536 — Stop roboai-estun to clear jog_bridge two-backend safety refusal — VERDICT: RESOLVED
add-37 §537 — cri_teardown after SIGSEGV + relaunch — VERDICT: RESOLVED
add-37 §537 — CRI motion relaunch with use_mock:=false (real hardware) — VERDICT: FIXED
add-37 §538 — Teach-promote refusal forensics (pending_poses, not ownership) — VERDICT: DIAGNOSED
add-37 §538 — §490 device-identity fix status audit (localStorage + ghost amnesty + heartbeat) — VERDICT: CONFIRMED

session-2026-08-24 — Dashboard fanout publisher `/dashboard/jog_session_events` moved to eager `__init__` (was lazy-created on first fanout, losing DDS discovery race under RELIABLE+VOLATILE, so first press after any restart silently dropped) — VERDICT: SHIPPED (sha 830fc4a..HEAD; closes another instance of the [[cobot-dds-lazy-publisher-hazard]] class, matching the pattern the `/estun/program` publisher already used per its eager-init rationale at dashboard_server.py:1365)

add-38 §539 — vite outDir + `_STATIC_DIR` unified to `frontend/dist`, `index.html` served with `Cache-Control: no-cache, no-store, must-revalidate`, and startup assertion `_assert_frontend_coherent()` refuses to boot on missing/mismatched chunk — VERDICT: SHIPPED (sha 830fc4a; also flipped L497 DIRECTED→SHIPPED above)
add-38 §539 — `_on_joint_states` normalizes msg.name/position to canonical `[Joint1..Joint6]` before writing STATE (JSB was publishing insertion-order `[Joint2, Joint3, Joint1, …]`; yaml's own head comment predicts this fallback) — VERDICT: SHIPPED (sha b1729b4; server-side workaround, root-cause spawner-param investigation queued for F3)
add-38 §540 — `_apply_cri_proxy_authority(r)` extracted from `_on_joint_states` and called from all three of `_on_joint_states`/`_on_estun_status`/`_on_estun_mode` so last-writer-wins races can't flip authority under `JOG_BACKEND=ros2` — VERDICT: SHIPPED (sha f100fc7)
add-38 §540 — `/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.{conf,env}` drop-in forcing `ESTUN_MONITOR_ONLY=true`, `ESTUN_ALLOW_JOG=0` — VERDICT: SHIPPED (dropin lives on disk on the Jetson; not tracked in git; retire when F3 formalizes)
add-38 §545 — Reference tier built (HARDWARE.md 3.2K→17.5K, OPERATIONS.md NEW 15K, FACTS.md NEW 9.4K, INDEX.md +REFERENCE section, CLAUDE.md session-start 5→8 files + new doctrine) — VERDICT: SHIPPED (sha edbfee0)
add-38 §543 — jog_bridge `_do_send_goal` populates `p0.velocities = p1.velocities = signed_vel` on target joint so consecutive JTC goals stitch as constant-velocity segments (empty velocities → vel=0 boundary → 10 Hz brake-restart on preempt → audible hunting on real gearbox) — VERDICT: PARTIAL SHIPPED (CodroidROS2 sha 80d65dd; throughput reduced hunting but residual oscillation still present at 10%×1500 ms, full-rate trace captured at ~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/ for next-session analysis; rungs 3-6 blocked)
add-39 §548 — Read `controller_state.reference.velocities` as ground-truth reference velocity — VERDICT: REJECTED (it's a constant echo of the field the bridge stuffed into `p0/p1.velocities`, not a derivative; first-pass verdict script reported "smooth reference" incorrectly. Truth lives in `d/dt reference.positions`.)
add-39 §549 — Phase-1 hunt-trace analysis of `~/cri_eval_ws/f1_2_scenarios/evidence/2026-08-24_hunt_trace/hunt_10pct_1500ms/` (876 controller_state @146 Hz + 1491 joint_states @248 Hz over 6 s; motion window 3.264→6.010 s) using `d/dt reference.positions`: reference position rate reverses sign 20× during a monotonic hold (peak +105 °/s, peak −315 °/s vs commanded +18 °/s), flat 59 % / jumping 41 %, ~12.7 Hz cadence matches 100-ms preempts; realized 9.6 %; `JTC.output == JTC.reference` (fix must land upstream of JTC) — VERDICT: DIAGNOSED (goal-seam confirmed; velocity-populate fix reduced but did not remove the position discontinuities at preempt boundaries)
add-39 §553 — jog_bridge `_build_goal` anchors target-joint `p0.position` on the extrapolated JTC reference cursor `(_prev_emit_p0_target_pos + _prev_emit_signed_vel × min(elapsed, _prev_emit_duration_s))` instead of on live fb_pos; cursor invalidated on joint switch, direction flip, and any IDLE reset; safety guard `|cursor − fb| > Config.cursor_max_deviation_rad` → fall back to fb + increment `sm.cursor_guard_fallbacks`; fb-past-effective-range in commanded direction promoted to early safety refusal (60/60 tests pass) — VERDICT: SHIPPED (CodroidROS2 sha 113e3f3; verified on real arm 2026-08-24 16:07 CDT J6+ 10% × 1.5 s: +28.87° over 1.5 s, 106.9 % realized, 14 goals dispatched with 0 rejects; but 5° guard threshold introduced a new residual — see §554)
add-39 §554 — `Config.cursor_max_deviation_rad` bumped 0.0873 → 0.15 rad (5° → 8.6°) after 5° threshold collided with the ~4.7-5.0° steady-state tracking error under 200 ms horizon × 18 °/s command, producing a -1272 °/s single-sample step-back at t=21.728 s in the 2026-08-24 v3 confirming trace when guard flip-flopped cycle-to-cycle — VERDICT: SHIPPED (CodroidROS2 sha f6d4d53; verified 2026-08-24 16:26 CDT on v4 bag: peak d/dt ref − reads +0.00 °/s exact, 0 sign reversals across 402 samples, 0 samples < −25 °/s, realized 79.5 %, sign changes 28→0 vs goal-seam baseline)
add-39 §555 — populate `.accelerations = [0.0]*N` on the JointTrajectoryPoint p0/p1 in `jog_bridge_node._do_send_goal` to stop JTC's cubic-spline solver from synthesizing forward-only overshoots at each 100-ms goal boundary (peak +76.49 °/s single-sample transient observed in v4 bag; all forward, gearbox absorbs without reversal) — VERDICT: DEFERRED (Path B P3 polish per operator direction 2026-08-24; not blocking rungs 3-6; revisit if soak surface accumulation)
add-39 §556 — bridge-uptime degradation observed on same jog_bridge process (~35 min uptime): inject 2 fresh moved +28.87° (106 % realized), injects 3-4 on same process moved +3.6° (13 %) then +0° (0 %); SM logged clean `_dispatch(send_goal)` at each event but only ONE goal reached JTC per session (reference moved for the horizon then held); fresh restart cured it instantly; wire echo confirmed events crossed on all attempts; suspected ActionClient handle leak / DDS state issue — VERDICT: DIAGNOSED (separate F3 hardening class; workaround for F1 is fresh restart before each formal test; do NOT let bridge accumulate uptime before rungs)
add-39 §557 — dashboard binds `:8080` to a single interface (currently wired eno1 `.2.246`); Wi-Fi `.1.246:8080` cannot serve simultaneously so operators on Wi-Fi hit the same-`/24`-fight class (§124 CRITICAL) when the wired path is intermittent — DEFERRED (F3 fix: bind to `0.0.0.0` so both NICs serve; documented in HARDWARE.md Subnet map on 2026-08-25 as the STABLE-path preference is now wired `.2.50 → .2.246`)
add-40 §558 — goal-replacement `jog_bridge` primitive (bridge SM sequences preempted `FollowJointTrajectory` goals @ 100 ms cadence): tripped J2 drive on velocity spike after rung 3 restart. Even with the addendum-39 reference-cursor anchor + 8.6° guard shipping, the underlying preempt-seam architecture kept producing single-cycle velocity discontinuities that the drives eventually rejected. Wrong primitive for continuous jog on this hardware — VERDICT: RETIRED (jog moved to moveit_servo → jog_servo_adapter path; do not revisit)
add-40 §559 — moveit_servo → JTC (`splines`) termination: mock trace showed a 35 Hz mechanical ring in reference. JTC cubic-spline resampling wobbles an already-smooth Servo stream. Same class as §543 arriving via a different upstream — VERDICT: REVERTED (replaced by moveit_servo → JointGroupPositionController passthrough in `d6bb65e`)
add-40 §560 — bump `joint_limits.yaml` `max_acceleration` 2.0/2.5 → 20.0 for all six joints (Phase E mock values were sized for Pilz planning, not runtime jog; Servo's JointJog integrator was clamping realized velocity to 1–2 %) — VERDICT: SHIPPED (`f0e2930`; Pilz planning scaling factors still provide planning-time safety headroom)
add-40 §561 — bump `cri_tcp_setup.yaml` `max_step_rad` 0.002 → 0.005 (was riding Servo's 0.108° per-cycle deltas as the last throttle; new value ≈ 71 °/s slew ceiling — well above any operator command; `jointCollisionSensitivity=80` remains the physical safety net) — VERDICT: SHIPPED (`f0e2930`)
add-40 §562 — `use_smoothing: false` in `servo.yaml`: NO-OP under moveit_servo Humble 2.14.1 (parameter does not exist). Smoothing is controlled solely by presence/absence of `smoothing_filter_plugin_name`. Setting `use_smoothing:false` while `smoothing_filter_plugin_name` is populated leaves Butterworth active — VERDICT: DOCUMENTED (workaround: near-transparent Butterworth coefficient at 0.001, or drop the plugin_name entirely and accept moveit_servo's boot refusal)
add-40 §562 — raising velocity cap / `max_step_rad` / `joint_limits.max_acceleration` alone: did NOT fix the creep, then caused the trip. Root cause was per-cycle acceleration at the firmware, not any single cap in the ROS2 chain — VERDICT: DIAGNOSED (motivates the §562 accel-ramp adapter; see LESSONS L271)
add-40 §562 — `jog_servo_adapter` accel-ramp integrator bypassing moveit_servo (18 rad/s² per-cycle cap; `cur_cmd_vel` ramps toward `target_vel`; `cur_cmd_pos` integrated per tick; published as `Float64MultiArray` on `/joint_group_position_controller/commands`): mock verdict CLEAN — VERDICT: SHIPPED (`f0e2930`; real-arm first-motion smooth, then §563 guard-snap tripped 2015)
add-40 §562 — moveit_servo `AccelerationLimitedPlugin` (`online_signal_smoothing::AccelerationLimitedPlugin` in `moveit_core` 2.15): built-in fix for the per-cycle acceleration constraint that §562's adapter solves out-of-tree. Not yet evaluated for Humble 2.14.1 backport availability; grep-check next session before considering replacement — VERDICT: PLANNED (adapter is authoritative until then)
add-40 §563 — divergence-guard snap re-sync (single-tick `cur_cmd_pos := fb; cur_cmd_vel := 0` when `|cmd − fb| > 5°`): the guard itself produced a Δv/cycle above CC10-A's ~25 rad/s² ceiling → tripped alarm 2015 on the phantom stale-tab event (§565). Replaced with a sticky two-phase settling state (Phase 1 vel-decel at `max_accel`; Phase 2 pos-slew at bounded `sync_slew_rate`; new events rejected during settle). Max Δref/tick through the entire recovery equals the normal steady-state jog Δref — VERDICT: FIXED (`cb022d3`; mock guard-test PASS, settle ≈ 990 ms for 5° divergence)
add-40 §565 — phantom jog session from stale browser tab on `192.168.1.111` (fired ~33 s post launch, before operator's inject; `hold_id=5jvotrcpge speed_pct=22.0`; source: `JogControls.jsx:91` `Math.random().toString(36).slice(2, 12)`). Dashboard restart cleared; 30 s idle monitor confirmed zero uncommanded events — VERDICT: FIXED (operationally; server-side debounce of queued-hold-on-WS-reconnect deferred to F3)
add-40 §566 — post-2015 wire-only recovery (`System/ClearError` → `Robot/switchOn` → re-issue `CRI/StartDataPush` + `CRI/StartControl`): cleared errors[] and `state → 2` but NOT `recoveryState`. Physical controller power-cycle was the only path that cleared `recoveryState=1 → 0`. Post-power-cycle sequence verified in-session — VERDICT: DOCUMENTED (only path for `recoveryState=1`; F3 investigate why wire recovery is insufficient)
add-41 §569 — idle re-seed in `jog_servo_adapter`: while `hold_id is None` AND at rest, track fb per-tick bounded by `sync_slew_rate × dt`; add encoder-LSB deadband (5e-5 rad) so `RobotStatus.isMoving` stays 0 during genuine idle. Eliminates stale-idle-pose snap on next hold-start (root of the 2015 trip on 2026-08-25) — VERDICT: SHIPPED (`c86ca60` + `e46887c`)
add-41 §569 — name-map rebuild in `jog_servo_adapter`: `_js_name_to_idx` regenerates whenever `msg.name` differs from cached tuple; logs a WARN on order change (JSB spawner-param fallback flips joint order mid-run, LESSONS L260) — VERDICT: SHIPPED (`c86ca60`)
add-41 §569 — startup saturation invariant in `jog_servo_adapter`: WARN (not refuse) if `vel_cap_frac × max_joint_vel > 0.8 × plugin_max_slew_rate`. Current config violates (1.571 > 1.000) → plateau above ~79.6 % speed_pct; not a safety hazard but a per-jog-% honesty flag — VERDICT: SHIPPED (`c86ca60`)
add-41 §570 — real-arm small bite (J6+ 5 % × 0.5 s) + Rung 3 (J6+ 3 s @ 10 %) on `af24198` baseline: cmd Δ = actual Δ to 0.000° tracking, zero errors, guard silent. Rung 3 peak |cmd-fb| = +4.47° (right at the old 5° threshold edge) foreshadowed §571 — VERDICT: PASS (evidence at `2026-08-26_F1_close/small_bite/` and `.../rung3/`)
add-41 §571 — flicker mechanism hypothesis 1 (guard-readopt loop): ruled out. Adapter log shows 0 `REFRESH-adopted-as-START` events and 15 `PHANTOM-REJECT` events cleanly rejecting refreshes after each halt. Phantom defense (`9241be5`) already provides sticky-halted-hold_id behavior — VERDICT: EXONERATED (no code change; existing defense sufficient)
add-41 §571 — flicker mechanism hypothesis 2 (saturation): ruled out. Live plugin boot line `max_step_rad=0.0050` (matches disk `cri_tcp_setup.yaml`); slew ceiling 1.25 rad/s vs 22 % wire commanding 0.69 rad/s — VERDICT: EXONERATED (config verified end-to-end)
add-41 §571 — flicker mechanism hypothesis 3 (dueling consumers): ruled out. `pgrep jog_bridge` empty; dashboard :8080 clients = `192.168.2.50` only; `/dashboard/jog_session_events` publishers = `dashboard_server` only — VERDICT: EXONERATED
add-41 §572 — divergence_threshold_rad 0.087 (5°) → 0.175 (10°): mechanism CONFIRMED as arm response latency (~250 ms) × commanded velocity. At 22 % wire (0.69 rad/s) cmd advances 7-8° in the arm's response window and tripped the old 5° threshold; new 10° accommodates any speed up to plugin ceiling. Runaway detection unchanged — VERDICT: SHIPPED (`af24198`; retest at 5 % × 0.5 s shows guard silent, |cmd-fb| SS = 0.000°)
add-41 §573 — DDS start-drop race in `f14_inject.py`: 500 ms publisher-creation-to-emit gap occasionally loses the START event to DDS discovery (refreshes/stop arrive fine at subscriber). Workaround `/tmp/hardened_inject.py` uses `pub.get_subscription_count() > 0` wait-loop before first emit — VERDICT: DIAGNOSED + WORKAROUND (promote wait-loop into `f14_inject.py` as F3 hardening)
add-41 §574 — rungs 4-6 + deadman A/B + 60 s soak: intended F1 close-out but flicker diagnosis + retest consumed the session — VERDICT: DEFERRED (next session on `af24198`)

## Skipped-addendum audit list (initial sweep did not tabulate)

The first pass tabulated the substantive addenda densely and skipped the
following for brevity. Not "empty" — pending an inline sweep pass:

`add-01, add-02, add-03, add-04, add-06, add-08a, add-08b, add-09,`
`add-10, add-11, add-12, add-13, add-14, add-15, add-17, add-18, add-19,`
`add-20, add-22, add-25, add-26, add-28, add-32, add-33`

Any session that touches these addenda for other reasons is invited to
append any missing attempts in-place.
