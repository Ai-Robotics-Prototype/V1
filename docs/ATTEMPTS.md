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

## Skipped-addendum audit list (initial sweep did not tabulate)

The first pass tabulated the substantive addenda densely and skipped the
following for brevity. Not "empty" — pending an inline sweep pass:

`add-01, add-02, add-03, add-04, add-06, add-08a, add-08b, add-09,`
`add-10, add-11, add-12, add-13, add-14, add-15, add-17, add-18, add-19,`
`add-20, add-22, add-25, add-26, add-28, add-32, add-33`

Any session that touches these addenda for other reasons is invited to
append any missing attempts in-place.
