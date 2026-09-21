---
ledger_split: addendum-16
source: cobot_project_conversation_v46.md
source_lines: 11356-11522 (inclusive)
title: The write path arc
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 16 — THE WRITE PATH ARC (July 14–15, 2026)
*Append-only. Covers: jog protocol capture → driver write path → first commanded motion → power path → collision guards → the calibration lessons. Sections 281–295. This addendum documents the two days in which the NeuRobots stack went from read-only mirror to full manual control of the Estun S10-140 — enable, jog (joint + Cartesian), disable, alarm recovery — with a layered safety system built and live-debugged alongside.*

### Section 281: Jog Write Protocol CAPTURED (July 14) — closes the §139 HIGH item

Captured via DevTools Send-direction filter on the factory UI WebSocket while jogging J1/J2 from the Codroid UI. Verbatim frames:

```
Joint jog start:
  {"ty":"Robot/jog","db":{"mode":1,"speed":0.51,"index":1,"coorType":0,"coorId":0},"id":"mrknoeef0wse414f"}
Heartbeat (~400–500 ms while held; 4 beats observed per ~2 s hold):
  {"ty":"Robot/jogHeartbeat","id":"<nonce>"}
Stop (on release):
  {"ty":"Robot/stopJog","id":"<nonce>"}
Cartesian jog start (captured same session, Coordinate tab, User frame/Coordinate0):
  {"ty":"Robot/jog","db":{"mode":2,"speed":0.51,"index":1,"coorType":0,"coorId":0},"id":"<nonce>"}
```

Field semantics (evidence: index:1→J1, index:2→J2; speed −0.51 on J2−; slider at 51%):
- `mode`: 1 = joint, 2 = Cartesian
- `speed`: signed fraction of the speed slider; **sign = direction**
- `index`: **1-based**; joint number in mode 1; 1–6 = X,Y,Z,RX,RY,RZ in mode 2
- `coorType`/`coorId`: 0/0 = User frame Coordinate0 (Tool-frame values still uncaptured, low priority)
- `id`: per-frame monotonic nonce (`mrk...` base36-time-like); fresh per frame, never reused

**SUPERSEDES §120's assumed write shapes** (`setparam jogMode/jogSpeed/jogIndex`, `commandHeart`, ±1/2/3 speed tiers) — shipped firmware v2.3 does NOT use them for jog. Wire capture is authoritative (Lesson 84 reaffirmed). Deadman semantics confirmed on the wire: heartbeat stop ⇒ controller stops motion.

Discovery notes: the jog frames were found only after (a) filtering the WS Messages panel to **Send** direction (the telemetry flood hides outgoing frames), and (b) discovering the commands ride the same socket as telemetry. The earlier report describing a `ControlStrip` UI with different verbs was describing the **main branch**, not the deployed feature branch — see Lesson 91.

### Section 282: Driver Write Path — branch `feature/estun-write-path`

Implemented in `estun_driver_node.py` on new branch off `feature/motion-lidar-step-foundation`:

- **Gates (layered, all default-closed):** `monitor_only` (master), `allow_jog` (+ env `ESTUN_ALLOW_JOG=1`), `allow_cartesian_jog` (+ `ESTUN_ALLOW_CARTESIAN=1`), later `allow_power` (+ `ESTUN_ALLOW_POWER=1`). YAML defaults all false; env overrides for test sessions; explicit startup banners announce every open gate.
- **Speed cap:** hard `|speed| ≤ 0.15` in the driver regardless of UI request (`jog_speed_cap`).
- **Freshness deadman:** no refreshed jog command within 300 ms → `Robot/stopJog` + heartbeat task killed. Controller-side heartbeat starvation (~400–800 ms) is the independent backup.
- **stopJog sent unconditionally on:** release command, freshness expiry, increment-duration expiry, WS disconnect, node shutdown (SIGINT), any heartbeat-task exception.
- **Increment path:** time-boxed velocity jog in the DRIVER (duration = angle / (speed_frac × max joint speed, 150°/s J1–J3, 180°/s J4–J6)) — frontend never owns stop timing.
- **Continuous path:** start on first command, heartbeat at 400 ms, refresh keeps session alive, direction/joint change mid-hold = stopJog + new Robot/jog.
- **Limit clamp:** pre-emptive on increments (reject if target exceeds ±limit − 2° margin; ±200° J1/J2/J4/J6, ±166° J3/J5); live per-tick check during continuous holds (stop on approach). `/estun/rejected` telemetry topic for post-hoc analysis.
- **J3/J5 sign analysis (accepted):** controller command and telemetry share the same convention; the URDF axis flip is a render-time transform only. No per-joint sign inversion in the driver — inverting would desynchronize button labels from motion. If bench shows disagreement the fix belongs in the URDF axis choice, not the command sign. (Consistent with §136.)

### Section 283: Validation Ladder + FIRST COMMANDED MOTION (July 14)

The gate-first test discipline, executed in order, all passed:
- **Step 0 (dry run):** `monitor_only=false` + `ESTUN_ALLOW_JOG=0` → command rejected at gate, zero wire frames (verified in raw .jsonl).
- **Deadman A (freshness):** one-shot `ros2 topic pub` jog → arm twitch, self-stop ≤300 ms, `Robot/stopJog` in the wire log.
- **Deadman B (process death):** `kill -9` the driver mid-jog → arm stopped ≤~1 s via controller heartbeat starvation.
- **6-joint agreement test (12 presses, ±1° increments):** button label vs physical arm vs twin direction — **all six joints agree, both directions, including J3/J5.** The §282 sign analysis validated empirically.

**MILESTONE: first commanded motion of the real arm from the NeuRobots dashboard**, through our own driver, twin tracking live. July 14, 2026.

### Section 284: Dashboard Jog UI Evolution

1. **IncrementalJogPanel** — first UI: per-joint [−5°|−1°|+1°|+5°], built after discovering the previously-reported "ControlStrip" did not exist in the deployed bundle (it lives on main; Lesson 91).
2. **JogControls promoted** — the Program tab's pendant-style jog (mode toggle, D-pads, step size, speed, Run/Pause/Stop/Home/Teach) extracted as a shared component and mounted in the 3D View tab as the REAL ARM panel: minimizable pill / normal dock / expanded states, Zustand-persisted (no localStorage). IncrementalJogPanel retired from layout (API path retained).
3. **Explicit Step | Continuous toggle** replaced the 200 ms tap-vs-hold heuristic. Step = one increment per press (no hold-repeat); Continuous = hold-to-run, **no latching under any circumstances** (deadman-by-finger principle). Step size greys in Continuous; captions clarify each mode.
4. **State banner** (after three silent-lockout incidents): READY / ROBOT DISABLED — ENABLE ON PENDANT / PROGRAM RUNNING (n/total) — press STOP / DRIVER DISCONNECTED. Buttons grey ONLY with a displayed reason.
5. **Run confirm guard** in the 3D View instance (program name + step count) after an accidental/ambiguous program start led to an operator e-stop.
6. **Footer build-id fix:** `git describe --always --dirty` baked at build invocation + second-precision build timestamp, after a stale footer string defeated the bundle-verification tell (Lesson 92).

### Section 285: Silent-Lockout / Silent-Stop Catalog (the recurring UX defect class)

Five+ variants encountered in two days, all with the same root cause — the system knew why it stopped/refused and didn't say:
1. Jog greyed: program running (APPROACH 1/5) — interlock correct, unexplained.
2. Jog greyed: robot disabled post-e-stop (state=0) — enable never completed; UI silent.
3. Jog greyed again next morning — same cause, new day.
4. Mid-hold stops with no reason shown (deadman, later limit clamp, later guards).
5. Guard stops with no explanation and initially **no escape** (§291 — the wedge).

Resolution across the arc: state banner (§284.4), `last_stop_reason`/`last_stop_ts` + `active_alarm` on `/estun/status`, alarm/limit recovery banner + modal (§289), guard popup with live escape jog (§291). **Design principle now standing: every automatic stop must arrive with (1) why, (2) live numbers, (3) a working way out — in the operator's face, not in a log.**

### Section 286: The Continuous-Jog Jitter Saga — three root causes, one symptom

Symptom throughout: "hold jogs, then stops after a moment." Three distinct bugs wore this mask sequentially:

1. **React identity churn (fixed):** `stop`'s useCallback deps chained to per-render closures; the store's ~25 Hz WS updates re-rendered JogControls, giving `stop` a new identity ~25 Hz, whose effect-cleanup fired release POSTs mid-hold (~100–200 ms stops, indistinguishable from step mode). Fix: route unmount cleanup through a `stopRef` with empty-dep effect; releases only on true unmount. Also: mouseleave only ends the hold when `e.buttons === 0` (drag-off ≠ release); global window mouseup/pointerup fallback attached at press, detached at stop.
2. **HTTP queue backlog → then clock-skew regression (both fixed):** 10 Hz jog POSTs stacked behind the saturated HTTPS server; release queued behind refreshes (overrun grew with hold length). Fix set: AbortController stop-preemption, monotonic per-session `hold_id`+`seq` with stale/out-of-order discard, refresh coalescing (queue capped at 1), QoS depth 1 best-effort. **Regression introduced by the first fix:** stale-discard compared CLIENT timestamps against the DRIVER clock — cross-machine clock comparison (≈920 ms tablet skew documented in §129) marked every refresh pre-expired; deadman fired ~300 ms into every hold. Fix: staleness judged on a single clock (driver-side inter-arrival), seq-only ordering, coalescing self-heal (abort in-flight >400 ms and refire). Verified: 2/5/10 s simulated holds full-duration, release-to-wire ≤60 ms, silence deadman intact at 301 ms.
3. **GIL starvation from JPEG encoding (fixed):** camera JPEG encode on the dashboard process held the GIL in bursts >300 ms, starving the asyncio loop relaying refreshes; ~5% of intervals stretched past the deadman → phantom stops every few seconds of holding. Fix set: (a) encode moved off-loop (run_in_executor / capture thread), (b) refresh cadence 150→100 ms, (c) **jog moved from HTTP POSTs to the already-open /ws channel**, and (d) **server-side hold keepalive** — while a hold session is open and the browser WS is alive, the server republishes freshness at 100 ms; keepalive stops on WS disconnect, release, or >400 ms of browser silence. Safety chain preserved: WS-death mid-hold stops the arm in ~1.05 s; total browser silence in ~700 ms; driver's own 300 ms deadman untouched.

**Final verification: 60 s hold, 1,001 refreshes, max inter-arrival 112 ms, zero staleness stops, cameras streaming throughout.** Related infra: WS broadcaster backpressure fix — bounded latest-state-wins send queues + kicker disconnecting clients stalled >500 ms (`ws_kicked` telemetry); root cause of the recurring dashboard wedges (HTTP unresponsive, 600–1700 ms header latency) where stale browser tabs' send buffers saturated the event loop.

### Section 287: E-Stop Recovery Procedure (exercised live, twice)

Controller behavior per manual §4.2.3 + live experience: e-stop latches; after rotating the button out, the arm does NOT return to enabled — sequence is **release button → clear alarm → re-enable**, and a limit/condition alarm will NOT clear while its cause persists (§289). The factory UI enable required the two-port SSH tunnel (:9198 + :9000) run FROM THE LAPTOP — a nested Jetson→Jetson tunnel binds the forwards on the wrong machine (encountered live; symptom: "controller not loading").

### Section 288: Power Path — enable/disable/alarm-clear from our UI (July 15)

Verbs (provenance: source-mining of the factory UI bundle + first live send validated on the wire): **`Robot/switchOn`**, **`Robot/switchOff`**, **`System/ClearError`**. Implemented behind `allow_power`/`ESTUN_ALLOW_POWER` (separate privilege from jog). Safety invariants, stated and verified: **no code path auto-enables** (no retry, no enable-on-reconnect/startup); disable + clear are never gated harder than motion; active jog → stopJog before disable. Gate-closed proof: 3 verbs rejected, zero wire frames. Frontend: banner [Enable] with confirm dialog ("ENABLING…" → state=2 → READY), subtle [Disable] on READY, alarm-first ordering (Clear Alarm before Enable when alarmed).

**MILESTONE: robot power enabled from the NeuRobots UI — `Robot/switchOn` → state=2 in 108 ms.** July 15, 2026. The pendant's remaining daily job is physical e-stop + in-alarm recovery jog (see §294 roadmap).

### Section 289: Joint-Limit Lockout + Recovery Guide + Alarm Modal

Incident: J6 reached **−203.32°** (past −200°); controller latched an alarm that cannot clear while the joint is out of range; operator initially had zero guidance ("error that cannot be cleared"). Built in response:
- **Driver:** per-joint `out_of_range`/`near_limit` on `/estun/status`; `publish/Error` frames parsed → `active_alarm` (code + text); `last_stop_reason`/`_ts`.
- **Recovery banner then MODAL** (centered, non-dismissable while active, minimize-to-banner, E-STOP never covered): names the joint, live degrees, computed jog direction ("current > 0 → jog negative"), progress; honest statement that the inward jog happens on the pendant (controller rejects external jog while alarmed — unvalidated whether an in-alarm verb exists; §294); phase transitions live: out-of-range (red) → back-in-range (amber, [Clear Alarm]) → cleared ([Enable]) → READY, auto-close.
- **First live render:** alarm **2015 "Joint1 speed command jump / local acceleration too high: −2.19 → −2.292 rad/s"** — a REAL controller alarm surfaced by the modal unprompted (with one copy bug: Phase-B limit text leaked onto a non-limit alarm; fix specced).
- J6 excursion source: **unresolved** — every logged joint hold that day was axis=1; candidates are a Cartesian hold (multi-joint IK), the factory UI, or margin-vs-latency inadequacy (at 0.15×150°/s = 22.5°/s, 150 ms of latency = 3.4° > the 2° margin — a real design concern). **Prevention audit still owed** (§295).

### Section 290: Alarm 2015 → Singularity Analysis + Governor (specced)

Alarm 2015 during a mode:2 continuous hold: controller-side IK demanded ~2.29 rad/s (~131°/s) on J1 — ~8× our joint cap — near a singular configuration. Our TCP command was in-cap; joint explosion is inherent to Cartesian jog near singularities. **Specced (run status unconfirmed at addendum time):** singularity-aware speed governor — per-tick σ_min/manipulability from fitted DH; linear speed scaling below `sigma_soft`, stop with reason at `sigma_hard` ("Near a singular pose — use Joint mode"); reactive joint-overspeed backstop (posture-derivative > 1.5 rad/s → stop); ramped not stepped mid-hold speed changes; thresholds calibrated from the incident's measured σ_min. **Standing rule tightened: Cartesian direction validation (Test B) happens tap-by-tap BEFORE further free Cartesian holds — two incidents in one day trace to unvalidated mode:2.**

### Section 291: Collision Guard System — self, ground, environment

**Architecture (built July 15):** per-link capsule approximation fitted programmatically from the GLB meshes (~10–15 mm padding) → `config/self_collision_capsules.yaml`; pair list excluding adjacent/impossible pairs; ground plane as pseudo-body; env obstacles from the LiDAR static-zone map converted to collision primitives. FK from fitted DH each 50 ms supervise tick during any jog; thresholds warn 80 / stop 30 mm (env later re-set to warn 50 / stop 25 mm per operator's 1-inch preference); direction-aware rule: **only clearance-decreasing motion is refused; escape motion never blocked**; guaranteed fallback (3% all-axes jog with loud warning) when the model sees no escape — a possibly-wrong model never outranks the operator with an e-stop.

**Guard popup** (amber modal): live distance, offending pair named in plain language, ESCAPE DIRECTIONS as live hold-to-jog buttons (finite-difference FK selects only improving directions; capped 6%; "J1 + · BEST · opens 92 mm" style labels), auto-dismiss with hysteresis (+20 mm), twin tints offending links. **Live-validated:** operator escaped a 22 mm stop via the popup's J1+ button (22 → 68 mm observed).

**Three calibration failures on day one, all conservative-direction:**
1. **Ground plane false stop at ~600 mm real clearance** — root cause: world z=0 is the BASE FLANGE (robot-as-origin convention per LiDAR extrinsics, operator-identified: "the bottom flange of the robot is the ground"), and the robot is on a ~300 mm stand. Fix: `ground_z_world = −300 mm` (LiDAR RANSAC floor fit), startup sanity line (enable-pose clearance vs TCP z), base-mount links excluded from ground pairs. Re-validated: 133 mm phantom → 433 mm true at the same pose.
2. **Ghost map:** env guard fired at 22–68 mm to `zone#static_003` while the raw LiDAR chip read ≥275 mm nearest — the static-zone map was accumulated with the arm in view; the arm's own parked points became a "static object"; the guard defended the arm against its own ghost. Fix (specced/partially shipped as of addendum): **robot self-masking in the static-zone accumulator** — live FK capsule volume (+80 mm dilation) excluded from static candidacy; map reset + re-accumulation; per-zone ghost audit (overlap of zone points vs arm's swept volume).
3. **Capsule shape mismatch:** self-guard reported 14 mm link3↔link5 at J3≈+122° with visible real clearance. Diagnosis: capsules within the 20% fatness threshold — the failure is SHAPE (cylindrical equators meet where rectangular mesh cross-sections have no material). Interim ship: pair REMOVED from the list — **overruled as an end state** (the wrist-into-forearm fold is the arm's most plausible self-collision); re-enable prompt issued: 2–3 capsule decomposition per boxy link, targeted dense grid sweep over the fold subspace (J3 90–166° × J5 range) since the 10k random sweep never sampled the folded region.

### Section 292: Driver-Down / Candle-Pose Incident

Twin snapped to the all-zeros "candle" pose with jog dead: the hand-launched driver had died with its SSH session (4th+ occurrence); the dashboard kept rendering last-known state with no staleness indication. Raw log's final frames showed a clean `Robot/stopJog` TX+RX — the shutdown path stopped active motion correctly on the way down. Fixes queued (§295): systemd unit (`Restart=on-failure`, gates via `/etc/default/roboai-estun`, disabled at boot per standing decision) and dashboard staleness watchdog (status >2 s old → red DRIVER DISCONNECTED, twin freezes+dims rather than snapping to zero).

### Section 293: Git / Branch State

- **July 15 morning:** discovered the entire July 14 arc was uncommitted (push prompt from the 14th never ran). Committed by hand: **`d2850fd`** — 11 files, +2,290/−126 (write path, jog UI, safety layers, pendant panel, lag fixes). Superseded URDFs (hybrid/partial) deliberately remain untracked per the Jul-13 decision — reaffirmed against a later include recommendation.
- **`0b64428`** — power path + mid-hold deadman fix + footer build-id (+500/−42).
- **`e3de8e2`** referenced in the capsule report (guard-era commit); further commits pending in the ghost-map/decomposition passes.
- **Branch ZIP gotcha:** GitHub's Code→Download ZIP packages the branch shown in the selector; a `V1-main` download misled a code review until caught by marker greps (Lesson 91). Direct branch URL: `.../archive/refs/heads/feature/estun-write-path.zip`. A PR (#1) has merged some earlier branch into main; post-arc merge of `feature/estun-write-path` into main recommended so downloads stop being a branch puzzle.

### Section 294: OEM Parity Program (declared) + "We are going to be the OEM"

Operator directive: eliminate every "switch to the factory UI" moment; strategic framing: NeuRobots owns the operator layer, the Estun becomes a commodity actuator (deck-relevant: "replaced the manufacturer's software layer in 90 days"). Phase 0 prompt issued (run status unconfirmed): mine the factory UI bundle for the full `ty` verb vocabulary; cross-reference against .jsonl captures (CAPTURED vs SOURCE-ONLY); classify into tracks — A implemented (jog/heartbeat/stop/switchOn/Off/ClearError), B recovery-critical (**jog-while-alarmed is the keystone unknown** — if a verb exists, the recovery modal's jog keys become real; free-drive/teach; alarm queries; mode switching), C operational (speed override, project run controls, I/O verbs, frame selection, inching config), D deliberately OEM-only (safety parameter writes, limit config, firmware, user management — certification-adjacent, not replicated). Output: `docs/oem_parity_roadmap.md` incl. a "superiority features" section (deadman chain, guards, recovery modals, twin+LiDAR — features the OEM UI lacks).

### Section 295: OPEN ITEMS at end of July 15

| Item | Priority | Notes |
|---|---|---|
| **Test B — Cartesian axis direction table** | HIGH | Still ZERO axes validated; taps only (X+/X−/Z+↑/Y+/RZ+ + one short hold); required before free Cartesian holds (§290 rule) |
| **Test A formal confirmation** | HIGH | 60 s simulated hold clean; operator live 10 s hold repeatedly interrupted by (now-fixed) guard false positives — one clean run + one-line confirmation owed |
| **J6 −203° prevention audit** | HIGH | Which path drove it; margin-vs-latency math (2° may be inadequate at 22.5°/s) |
| **Singularity governor run status + alarm-2015 σ_min reconstruction** | HIGH | Specced §290; unconfirmed |
| **Ghost-map fix completion** (self-masking, map rebuild, per-zone verdicts) | HIGH | Specced §291.2; partially shipped |
| **link3↔link5 pair re-enable** via capsule decomposition + fold-grid sweep | HIGH | Pair currently REMOVED — arm's most plausible self-collision unguarded |
| **Commit/push the guard-era stack** | HIGH | Multiple features beyond `0b64428` uncommitted at last report |
| systemd unit for driver + dashboard staleness watchdog | MED | §292; also re-check header latency (1703 ms observed late July 15 — kicker verification) |
| Modal copy bug (Phase-B text on non-limit alarms) | LOW | §289 |
| OEM parity Phase 0 inventory | MED | §294; keystone question: jog-in-alarm verb |
| Tool-frame coorType/coorId capture | LOW | §281 |
| In-modal recovery jog keys (gated `alarm_jog_validated`, default false) | MED | Unlocks when §294 answers the keystone |
| eno1 persistence check on next reboot | LOW | Carried from §139 |
| Re-enable roboai-estun at boot after sign-off | LOW | Carried |

## PROCESS LESSONS (91–97)

91. **Verify the branch before reading code.** A GitHub ZIP downloaded from the default branch selector delivered `main`, whose contents (including a `ControlStrip.jsx` that never existed on the working branch) had already misled one report and nearly misled a bug hunt. Marker greps (`switchOn`, `allow_power`, file existence) before any review; folder name is the first tell.
92. **A verification tell must itself be verified.** The footer build-id (commit-derived) went stale/blind across a day of uncommitted work and later showed `-dirty` on a clean build — defeating the "check the footer" rule from the earlier stale-bundle lesson. Content markers (grep the served bundle for feature strings) are the ground truth; the footer now bakes `git describe` + a build timestamp at build invocation.
93. **Never compare timestamps across two machines' clocks** — the same ~920 ms skew documented in §129 reappeared inside a safety deadman as a stale-discard bug that killed every hold at 300 ms. Staleness = inter-arrival on ONE clock; ordering = monotonic seq (clock-free).
94. **A protection layer must never be a trap.** The first guard implementation blocked ALL motion under stop_distance, wedging the operator with a wrong ground plane; the alarm lockout and both guard incidents converged on the same standing principle: every automatic stop ships with why + live numbers + a working escape, and escape motion is never blocked — with a low-speed override fallback because the model can be wrong and the operator holds the e-stop.
95. **A perception-driven safety system requires self/other segmentation.** The static map baked in the parked arm; the guard then defended the arm against its own ghost, unfixable by thresholds. The robot's live FK volume must be masked out of every world-model input (applies to the MotionCam pipeline later). Corroborating tell: two sensors disagreeing about the same space (guard 22 mm vs raw LiDAR 278 mm) means one of them is remembering, not seeing.
96. **Random-pose validation misses structured corner cases.** The 10k uniform sweep never sampled the folded J3≈122° region where the capsule shape mismatch fired. Guard geometry needs targeted dense sweeps over physically meaningful subspaces (folds, reaches, wrist flips) in the standing validation suite.
97. **Commit cadence is a safety practice, not hygiene.** A full day of safety-critical, live-validated work sat uncommitted through kill-9s, e-stops, and reboots (twice); the blind footer (Lesson 92) was a direct consequence. The rule going forward: every validated milestone commits before the next feature prompt runs.

---

*Summary of Addendum 16: In two days the stack crossed from read-only mirror to full manual control. The jog protocol (Robot/jog / jogHeartbeat / stopJog, both modes) was wire-captured, superseding §120's assumed shapes; a gated driver write path passed the dry-run/deadman/6-joint validation ladder to deliver first commanded motion on July 14; the power path (switchOn/switchOff/ClearError) made enable/disable/alarm-clear native on July 15 (108 ms enable). The continuous-jog jitter saga resolved through three distinct root causes (React identity churn, HTTP backlog + a self-inflicted cross-clock regression, GIL starvation) ending at 60 s holds with zero phantom stops via WS transport + server keepalive. A layered collision system (self/ground/env capsules, escape-guaranteed stops, live-escape popup) shipped and immediately taught three calibration lessons — flange-origin ground plane, the robot's ghost in its own static map, and capsule shape mismatch at folded poses — all failing conservative. Alarm/limit recovery gained a guided modal exercised on a real alarm 2015. Declared: the OEM parity program. Owed: Cartesian axis validation, the J6 excursion audit, ghost-map completion, link3↔link5 re-enablement, and a commit of the guard-era stack.*

*Last updated: July 15, 2026 (Addendum 16 — Sections 281–295, Lessons 91–97)*

---

<!-- v46-content-end -->
