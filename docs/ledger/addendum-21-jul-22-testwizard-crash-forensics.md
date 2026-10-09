---
ledger_split: addendum-21
source: cobot_project_conversation_v46.md
source_lines: 12054-12196 (inclusive)
title: TestWizard runs, controller crash forensics, first actuator
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 21 — TESTWIZARD RUNS, THE CONTROLLER CRASH FORENSICS, DRIVER HARDENING, SPEED 65%, AND THE FIRST REAL ACTUATOR (July 22, 2026)
*Append-only. Sections 351–372, Lessons 117–126. Covers: the wait-verb hunt concluded (wait() needs INTEGER — 10006 proved it), the derived-pose resolver + first full test wizard execution on the arm, the J5 wrist re-solve diagnosis (movL IK, NOT teaching), the home-drift fix (96.67° delta), THE CONTROLLER CRASH — boot-log forensics proving our own reconnect loop was re-crashing C2Control at every boot — and the driver init-grace hardening that makes it structurally impossible; the operator body-test of collision detection; speed cap raised to 65% with confirm asymmetry; payload-per-program; I/O manual actuation (gate, bridge, toggles, the acknowledged-state snap-back that caught a real firmware limitation); solenoid wiring (Tailonz 4V210-08 = 3.0W = exactly the 125mA DO limit → relay required); Degson ferrule spec; and the NeuRobots Cell Box product idea.*

### Section 351: Wait verb concluded — wait() takes an INTEGER (error 10006 proved it live)

The delay-verb hunt ended in three steps: (1) full `luaenginelib.json` pulled via curl (44,560 bytes — the working URL: `http://192.168.2.136:9198/webmodel/cocontrol/luaeditor/luaenginelib.json`; the luadoc.json URL guess returned 508 bytes/wrong) — grep found NO bare sleep/delay; only `waitCondition(condition,timeout)`, `systemTime()`, and specialized waits. (2) The editor's Control node list revealed a **`wait` node** which generated **`wait(1.5)`** live in the editor — apparently decimal seconds. (3) But EXECUTION rejected it: **error 10006 "bad argument #-2 to 'wait' (number has no integer representation)"** — the controller's `wait()` requires an INTEGER (unit: ms per the Chinese manual's WaitDI docs, which state 时长(ms)). Fix: codegen emits `wait(300)`/`wait(500)` (ms integers), never `wait(0)` for a real dwell. Lesson: the editor ACCEPTS syntax the interpreter REJECTS — editor display is not execution validation.

The Chinese manual (project files) also yielded the full I/O instruction reference: **WaitDI(port, value, 时长ms, timeout_var, jump_label)** — the real sensor-wait with ms timeout + timeout flag + jump target; WaitDI8421/WaitAI; SetDO8421/GetDI8421 multi-bit ops; and a **polarity caveat**: the SetDO parameter table reads "0 表示高电平，1 表示低电平" (0=high, 1=low) — possibly a doc error, flagged for live verification against the solenoid (note which value physically energizes).

### Section 352: Derived-pose resolver + full generated program

`_resolve_derived` pre-pass: builds {position_role → taught_joints/tcp}; a derived step (derived_from + offset_z_mm) resolves the anchor pose + offset in base frame (m→mm to match Estun cp). Emits `movL({cp={x,y,z,rx,ry,rz}})` for offset≠0, and reuses the anchor for offset≈0. move_linear now correctly maps movL (was always movJ); loop emits `goto _prog_start` with `::_prog_start::` label at exec line 1. Full 16-step test wizard Lua generated with **zero skipped lines**: movJ anchors, movL derived cp's with real coordinates (130mm Z-offset pairs visible: 200.941↔330.941, 577.338↔707.338), setDO(2,x)/setDO(3,x), wait()s, goto loop, varspoint={p1..p4}.

### Section 353: testwizard RAN — then the shakeout

The program uploaded and executed on the real arm — steps 1–6+ (home → vacuum off → approach → descend → vacuum on) with green checkmarks and live step highlighting before being stopped. First NeuRobots pick-and-place with I/O lines executing. The run surfaced, in order: (a) the 10006 integer-wait error at line 7 (§351 — fixed); (b) **unexpected J4/J5 rotation** (§354); (c) home-position inconsistency (§355); (d) a save-path id bug earlier in the arc (underscore path-splitting — new_program_2 → alphanumeric-only slugs + a rename-to-controller-safe-id migration endpoint, atomic destination-write-then-source-delete).

### Section 354: The J5 wrist re-solve — DIAGNOSED (movL IK, not teaching)

Operator observed J4/J5 rotating between poses taught with identical wrist orientation (head vertical, flange down). Diagnosis sequence: (1) suspicion fell on the derived-pose resolver corrupting orientation — WRONG, Claude Code proved rx/ry/rz preserved exactly; (2) the real cause: **movL re-solves IK at runtime and can select a different joint branch (wrist flip) even for a correct TCP pose** — worst on offset≈0 steps (movL to a pose the arm already occupies); (3) taught data proved it: taught poses all have J5≈89–92° consistent (step3 J5=89.18, step8 J5=89.68, step15 J5=92.62) while runtime showed J5≈138° — the rotation is IK re-solution, NOT teaching drift.

Fixes: **A (shipped, 8e546e3):** offset<1mm derived steps → `movJ(anchor)` reusing the taught jp — no IK, structurally cannot flip. **B (partial):** offset≠0 lifts kept movL with pinned `{coor=0,tool=0}` — Claude Code honestly flagged "wrist could still re-solve"; the proper fix is **seeded IK at codegen** (compute lifted-pose joints seeded from anchor's taught_joints so the branch holds) — prompted, completion unconfirmed. **C (shipped):** home drift normalized. Also: codegen must never emit a movL whose target equals the current pose (the zero-length class — see §357).

### Section 355: Home drift — 96.67° apart

test wizard's step 1 and step 15 homes were independently taught and differed by a **max joint delta of 96.67°** — the arm would have "returned home" to a wildly different pose than it started. Fix C aligned step 15 to step 1 (both now [-63.30, -5.55, 91.32, -3.18, 92.15, -106.01]) + validation flagging any two move_home steps differing >5°/axis. Root cause: the wizard's "Return to home" re-captured a fresh pose instead of referencing the start home. A **home-reuse control** for the wizard-editor view was prompted (with an explicit "verify it lands in THIS view, not the builder" instruction — the feature existed in the builder but not the wizard editor the operator was using); completion unconfirmed at session end.

### Section 356: Monitor/UX shipped during the arc

STOP button (prominent, exempt from the state-machine greying — added after the operator was trapped with a wedged program and NO on-screen halt); Return Home + Restart Program buttons; **Pause*** (asterisked provisional — pause/resume never live-validated); step list simplified to titles-only (annotation column + classifyStep/KIND_STYLE deleted — grep-verified "pending capture"/"no delay verb" strings gone from the bundle, commit c3d44e4); stuck-in-STOPPING recovery prompted (state 3 >3s → force-stop/reset; Home/Restart allowed from wedged state) after the program repeatedly wedged in STOPPING with controls greyed — the operator-trapped pattern. Mid-run speed control shipped at the API level (verified: 409 without confirm above threshold, wire sends only on confirm) but the UI input didn't fire mid-run initially (bug prompt issued). Teaching-mode jog found glitchy + black-themed: the TeachOverlay was restyled (7e8076f) and routed through the shared WS transport; the wizard's inline TeachWithJog pendant was flagged as still on the old pattern. Program-error modal redesign prompted (raw pink monospace → designed layout with plain-language alarm guidance).

### Section 357: THE CONTROLLER CRASH — forensics and recovery (the session's defining event)

Sequence: program wedged in STOPPING repeatedly; flange LED blinking green (= program running, per manual p38 LED table); driver restarts cleared our side but then the controller service went fully down — driver flooding "Cannot connect ws://192.168.2.136:9000/" every 2s, and **Estun's own factory UI showing "Server network closed!"** Ping remained perfect throughout (0% loss, <1ms). **A genuine cold boot did NOT fix it.** Manual p55: repair reserved to Codroid/authorized integrators — no user recovery documented.

**The operator downloaded the controller's own boot logs from the factory-UI error screen — and they solved it:**
- **07-22 20:15 log (1977 lines):** ends in a crash stack through `lua_resume → LuaRun::run → Project::_runTasks` — **a running Lua program crashed C2Control.** The pre-crash trace shows trajectory blend planning with a **zero-length second segment** (第2段轨迹耗时:0) and **DBL_MAX limits** (jmax=1.797e+308) — our testwizard's offset-0 movL exposed a firmware numeric bug in the blend planner. That was the original outage.
- **07-23 00:02 log (343 lines, post-cold-boot):** the service **crashes ~9s into EVERY boot** — `vector.cpp:41 System Error| 0 < 0 / id < _n` → `c2::math::Vector<double>::operator()` → `c2::plugin::Robot::step()` → exitProcess. EtherCAT enumeration identical to good boots (arm/drives fine). Projects NOT loaded at boot (ruling out corrupted project data).
- **The smoking gun was timing:** good boot — WS server listens, client connects **1.7s later**, fine. Crash boot — WS listens, client connects **16ms later** (our driver's 2s retry loop pouncing the instant the port bound), subscribes to RobotPosture/RobotCoordinate, **crash 32ms after subscribe**. The posture-publish path read joint vectors before the RT loop populated them (EtherCAT slaves still reaching OP) → empty-vector assert → exitProcess. **Our own reconnect loop was re-crashing the controller on every single boot** — the "boot loop" was us.

**Recovery test (confirmed the theory):** stop roboai-estun, close all factory-UI tabs, cold boot, wait 3 minutes untouched → boot sequence white light → **controller came up clean and stayed up.** Robot fully recovered. TWO reportable Estun firmware bugs on record with logs: (1) init-window subscribe crashes C2Control; (2) zero-length blend segment crashes the Lua runtime. Both should be exitProcess-proof in hardened firmware.

### Section 358: Driver init-grace hardening (commit 2788ec3) — the class-closing fix

Four mechanisms, live-verified: (1) **post-connect grace** — no subscribes for 5s after connect (held even when the probe answered in 44ms); (2) **readiness probe** — lightweight GetIOInfo must answer before any posture/state subscribe; (3) **exponential reconnect backoff** — 2s→4s→8s→cap 30s, reset only after 60s healthy; (4) **crash-loop detection** — 3 connect→disconnect cycles in 2min → 120s cool-down, surfaced on /estun/status + System Check ("controller appears to be restarting — backing off"). Writes additionally gated on state==READY. 9/9 unit tests. The exact failure sequence that took the controller down is now structurally impossible from our side.

### Section 359: LED decode (manual p38, OCR)

灯带 (flange light bar) table: solid green = boot-complete/not-enabled OR auto+enabled; **blinking green = program running**; the drag/jog-mode row is literally **"TBA"** in Estun's own manual (undocumented). Blue and white lights observed in-session are NOT in the table — working hypotheses only (blue ≈ jog/teach mode filling the TBA row; white ≈ boot/init); never rely on undocumented LED states for safety decisions.

### Section 360: Speed cap raised — 0.25 → 0.65, with teeth

`operator_speed_limit` 0.65 for programs; **jog deliberately unchanged** (50% hw / 25% op-limit — hand-proximity work never needed headroom). Verified on the wire: request 100 → 409 + "capped to 65", wire NOT sent without confirm; `confirmed_high_speed:true` → 200 → setAutoMoveRate 65; >40% requires the high-speed confirm; ≤40% clean. **Confirm asymmetry: increases confirm, decreases apply instantly** (slowing is the safe direction — never behind a dialog). The generated-Lua header mislabel resolved: it now prints the true cap (operator_cap_pct=65) — the earlier "=100" was the then-current config honestly reported, not a codegen bug. The **speed-scaled safety pass** (margins re-derived at 0.65 per the §310 rules: dynamic limit margins, guard stop bands ≥3 supervise ticks, LiDAR keep-outs, deadman overrun statement for sign-off, payload check, cartPositionLimitEnable status) was prompted as ship-with-the-cap; completion unconfirmed. Operational rule stated: 65% is headroom for PROVEN programs; first runs stay 10–25%.

### Section 361: The collision body-test and the sensitivity request

Operator deliberately stopped the arm with his forearm — ALARM 2009 "Collision detected on Joint1" fired and the arm stopped. The detection works. The response drew the line: (a) next safety-function test uses a foam block, not a forearm — same data, zero downside, especially with payload unmodeled; (b) collision **sensitivity is a controller-side safety parameter — read/display + guidance only from our UI, writes stay OEM** (standing policy); (c) the real accuracy fix is **configuring the actual payload** — with Payload 0 and a real tool mounted, the collision estimator's expected-torque model is wrong (oversensitive in some poses, undersensitive in others). A read-only Configure panel (per-joint sensitivity if readable, ALARM 2009 event history, factory-UI guidance) was prompted.

### Section 362: Payload as a per-program property

Shipped/prompted: payload_kg (+optional CoG, tool label) as program schema fields, collected as a wizard step, editable in the editor, **amber warning everywhere when unset** ("collision detection accuracy is reduced"), shown in the Run confirm; testprogram observed carrying "-- payload: 1.1 kg — info only" in its generated header. Loops also became finite-count (goto count=3 observed) rather than unbounded.

### Section 363: I/O manual actuation — gate, bridge, and the snap-back that told the truth

The I/O page rebuilt (declutter v2 → **silkscreen-exact v3**: nine cards mirroring the physical connector order M-FUNC | DI-A | PWR | DI-B | PWR-CFG | DO-A | PWR | DO-B | AI/O, plus collapsed Safety card and flange section; per-row paired-terminal tags; position indices for count-at-the-cabinet matching). DO rows got actuation toggles; DI force behind an "Expert: force inputs" switch. Enable chain (verbatim from IOPortMap.jsx): toggles render for DO always / DI only in expert mode; clicks enabled iff `allowIo && bridgeUp`, both from the 1 Hz /api/io/live poll. **allow_io gate** opened via `/etc/default/roboai-estun` (`ESTUN_ALLOW_IO=1`; the unit reads it via `EnvironmentFile=-/etc/default/roboai-estun`) — first attempts failed because grep found no existing ALLOW_IO line and a blind append raced the discovery of the correct mechanism; the definitive answer came from asking Claude Code to quote its own gate code. Bridge went LIVE (IOManager poll active).

**The toggle snap-back:** DO toggle flips then returns — **acknowledged-state rendering caught a real limitation**: the write goes out, GetIOValue reads the port still LO, the toggle refuses to lie. Root cause consistent with the capture-era evidence: SetIOForcedFlag was wire-confirmed for DI only; **the factory UI itself offers no Force on DO rows** — this firmware very likely doesn't force outputs via that verb. Fix path (prompted): capture the controller's response to the DO force (confirm rejection), then drive manual DO via the supported path — a driver-owned **"I/O Console" micro-project** (`setDO(port,val)` uploaded + project/run, all wire-proven verbs). The io-console project was observed live in the factory UI editor (`setDO(1, 0)` — roboai-authored). An optimistic toggle would have shown ON over a dead pin; acknowledged-state is the design that refuses to fake success.

### Section 364: Factory-UI manual forcing + the lock slider

For forcing on Estun's side: the I/O panel has a **lock/unlock slider** (top-right) gating manual value-setting, and Manual mode may be required. DO1's Value box was checked and HELD in the factory UI — the controller reports the output set — yet no solenoid click (→ §365 hardware chain). The SetDO 0=high/1=low manual note remains unverified; the solenoid will be the truth detector.

### Section 365: The solenoid — Tailonz 4V210-08, and the 125mA wall

The valve: **Tailonz Pneumatic 4V210-08** — a 5/2-way pneumatic valve (A/B work ports, P pressure, R/S exhausts), 0.15–0.8 MPa working pressure, coil **DC24V 3.0W** = **exactly 125mA — precisely the CC10-A's max-per-group DO rating.** Verdict: direct drive is at 100% of the output's rating — **a relay (or MOSFET module) between DO1 and the coil is required** (DO1 → relay coil ~15–30mA; relay contact switches the solenoid from the 24V power block). Also: 5/2 semantics (de-energized P→B, energized P→A — plumb vacuum through the energized-open port), pilot-operated valves may not shift below minimum air pressure, flyback diode if the relay is mechanical. Wiring facts settled along the way: DOs are PNP/sourcing (+ → DOn, − → adjacent 0V); the 16-terminals-per-block = 8 signal+reference PAIRS per row (A-banks pair 0V, B-banks pair 24V; the middle connectors are pure 24V|0V power strips); the valve's third terminal = DIN 43650 ground pin (coil is 1↔2 — a wire landed on ⏚ instead of 2 would give exactly the observed symptom and must be checked); sinking vs sourcing explained (pin provides vs absorbs current; buy PNP sensors). Diagnostic pending at session end: meter DO1↔0V with the output set (solenoid disconnected) — 24V = output fine, relay solves it; 0V = check the PWR-CFG **fuse** (internal-supply path requires it; a blown fuse kills all DOs while every screen reports success).

### Section 366: Degson ferrule answer

The CC10-A's I/O plugs are Degson push-in (orange actuator) pluggable terminal blocks, 3.5mm-pitch class: wire range typically **0.2–1.5mm² (24–16 AWG)**, **DIN 46228 ferrules, 8mm pin**, slim/no collar for the tight entries; press the orange actuator while inserting. **The operator's 28 AWG cable is BELOW the class minimum** — the earlier won't-latch problem is most likely the wire, not the ferrule: too-thin conductor means no ferrule size both crimps soundly and engages the spring. Fix: 24 AWG stranded + 0.25mm² 8mm ferrules (or twin-wire ferrules as a stopgap). Exact PN molded on the plug body would give the authoritative datasheet line.

### Section 367: Tablet as the first-class cell device — two bugs

(a) **Tablet jog jitter** vs smooth laptop: diagnosis prompt targeting mobile timer throttling (keepalives stretching past the 0.3s deadman → stop-start), touch-event handling (pointer events + capture + touch-action:none), Wi-Fi RTT — with the explicit rule that **the deadman is NOT widened** to absorb any of it (Lesson 102 stands); fix direction: Web-Worker-driven keepalive (exempt from page timer throttling) + pointer-event hold semantics. (b) **Teach button invisible on tablet** — viewport overflow; fix: sticky footer bar (Record + STOP + Cancel) that can never scroll away, ≥44px touch targets, verified at tablet viewports both orientations. Standing directive: treat tablet as the primary at-the-cell client.

### Section 368: The consolidated stability batch (Parts A–J)

One mega-prompt issued to close all outstanding could-bite items, commit-per-part: A deployment-truth audit (committed vs running vs served — the ambiguity that fueled multiple ghost-chases); B wait-verb end-to-end confirm (GET the stored Lua, paste integer waits); C seeded-IK wrist fix + per-step J5 table + zero-length-move prohibition; D stuck-in-STOPPING recovery; E zombie-WS wedge (per-client bounded queues + dead-client reaping — 3rd recurrence); F footer build-string truth (serve actual bundle hash — the footer has lied all arc); G empty-program guard + save byte-verify completion; H ProgramWizard hooks violations + wizard TeachWithJog pendant migration; I small-debt sweep (ErrorDedup stale-error, POINTS-panel removal confirm, Safety-row robot_limits path, true-cap header); J final verification sweep + one summary table with operator live-steps. Batch started; completion state not fully reported by session end. Excluded as operator-tasks: password rotation (aicollabs12 still exposed), the Estun firmware bug report, live validation runs.

### Section 369: I/O page routing bug

The I/O nav tab initially rendered the OLD I/O page before the new port map — two reachable versions. Fix prompt: one route, one page, delete/unlink the legacy component, check lazy-chunk staleness. Principle restated: exactly one reachable version of every view.

### Section 370: The NeuRobots Cell Box (product idea, operator-originated)

Proposal: a Jetson-based cell controller box — compute + pre-wired relay bank + valve manifold + regulated 24V + labeled plug-and-play connectors — making peripheral integration plug-and-play. Assessment: strategically strong (completes the OEM story hardware-side; captures integrator margin; solves NeuRobots' own deployment pain first; commodity components = integration product), honest cautions (hardware business gravity: inventory/RMA/compliance; focus cost vs the PBD moat; liability surface). **Sequenced: v0 = build ONE for the own cell now (needed anyway — the relay module for the solenoid is literally the first component), document BOM + wiring as the deployment package ("standard cell kit, ~$2–3k parts or assembled for $X"), productize only when 3+ customers pull.** Deck-relevant either way ("from pallet to picking in one day").

### Section 371: Git/infra through July 22

Commits (partial): ffd22ff (id-slug guard) → bd8f3ce (rename endpoint) → 8b2730d (blank new programs) → c3d44e4 (STOP/Home/Restart + titles-only steps) → 8e546e3 (wrist fixes A/C + movL pinning) → 7e8076f (TeachOverlay restyle) → 2788ec3 (driver init-grace hardening) → 0121d31/380a09f/bd7d474/b1099ea (I/O arc, prior) → cap-raise + mid-run-speed + payload + portmap-v3 + io-console commits (hashes in Claude Code reports; batch A–J in flight). Dashboard confirmed **TLS-only at :8080** (plain http = empty reply). The gates now: monitor_only master; ESTUN_ALLOW_JOG/CARTESIAN/POWER/MOVE/**IO** via /etc/default/roboai-estun. NeuRobots controller = Jetson at 192.168.1.246 (:8080 dashboard); Estun controller = 192.168.2.136 (:9000 WS, :9198 factory UI/HTTP).

### Section 372: OPEN ITEMS at end of July 22

| Item | Priority | Notes |
|---|---|---|
| **Batch A–J completion + Part A deployment-truth table** | HIGH | The ground-truth snapshot; several fixes (seeded-IK, wait confirm, STOPPING recovery, zombie-WS, footer truth) ride on it |
| **DO manual-actuation via io-console** | HIGH | SetIOForcedFlag DO rejected by firmware (probable); micro-project mechanism observed in factory UI — confirm toggle→click end-to-end |
| **Solenoid circuit** | HIGH | Meter DO1↔0V (fuse check if 0V); relay module (3.0W coil = 125mA = at the DO limit); check DIN connector wires on 1↔2 not ⏚; note which setDO value energizes (polarity truth) |
| **Single-step testwizard validation at 10%** | HIGH | Watch per-step J5 hold through steps 7/14; the wrist fix's live proof |
| **Speed-scaled safety margins at 0.65** | HIGH | Prompted ship-with-cap; confirm the margin tables + deadman overrun sign-off happened |
| **Estun firmware bug report** | MED | Two log-proven crashes (init-window subscribe; zero-length blend); logs in hand; PN 15700001454 SN 12605280821 |
| Payload: weigh the vacuum tool, set real value (program + controller) | MED | Fixes collision-estimator accuracy; 2009 false-trip risk at speed |
| Tablet jog transport + teach sticky-bar verify | MED | Prompted; confirm on the tablet |
| Home-reuse control in wizard editor | MED | Prompted with land-in-THIS-view guard; unconfirmed |
| Mid-run speed UI wiring | MED | API proven; UI input didn't fire mid-run — bug prompt issued |
| Program-error modal redesign | LOW | Prompted |
| Collision-sensitivity read-only panel | LOW | Prompted; payload first |
| I/O tab single-route fix | MED | Two reachable I/O pages |
| Password rotation + SSH keys | MED | aicollabs12 exposed repeatedly (carried) |
| Pause/resume live validation | MED | Pause* shipped provisional |
| Merge feature/estun-write-path → main | MED | After validation runs |
| 24 AWG wire + DIN 46228 ferrules (8mm) | LOW | Shopping list; 28 AWG below terminal class minimum |
| Cell Box v0 BOM | LOW | Relay bank + manifold + supply; doubles as deployment kit |

## PROCESS LESSONS (117–126)

117. **The editor accepting syntax is not the interpreter accepting it.** wait(1.5) rendered happily in the factory editor and died at execution with 10006 "no integer representation." Validate verbs at the EXECUTION layer; editor display proves nothing about runtime.
118. **Cartesian moves re-solve IK; joint moves replay the taught solution.** Identical-orientation targets can still wrist-flip under movL because the controller picks a branch at runtime. For "go back to where you were" and pure vertical offsets, emit movJ from taught/seeded joints; reserve movL for genuinely required straight-line paths. Taught-vs-runtime joint tables (per-step J5) are the diagnostic that separates teaching drift from IK re-solve.
119. **Your own retry loop can be the attacker.** The controller's boot-loop wasn't firmware failing alone — our 2-second reconnect hammered the WS the instant it bound, subscribing into the init window and crashing Robot::step() on every boot. Any aggressive reconnect against an embedded service needs grace periods, readiness probes, backoff, and crash-loop detection — or it becomes a denial-of-service against the thing it serves.
120. **The victim's own logs solve the case.** Ping, our driver logs, and the factory UI all said "down" without saying why; the controller's boot logs (downloadable from the error screen) contained the crash stacks, the timing, and the causal chain in 40 lines. When a black-box service dies, get ITS logs before theorizing.
121. **Acknowledged-state UI catches lies that optimistic UI would tell.** The DO toggle snapping back was the system truthfully reporting a write the firmware ignored. Render hardware state from read-back, never from hope — the snap-back turned a would-be phantom success into a precise diagnosis.
122. **Rate an output at 100% of its limit and you've designed a failure.** The 3.0W valve = 125mA = exactly the DO group maximum. At-the-limit direct drive works on the bench and dies warm. Switch inductive loads through a relay; keep outputs at ≤70% of rating.
123. **The wire can be the reason the ferrule fails.** 28 AWG is below the terminal class's 0.2mm² minimum — no ferrule choice fixes a conductor the spring cage was never designed to grip. Check the wire spec before blaming the ferrule (or the terminal).
124. **Safety-parameter tests use props, not limbs.** The forearm collision test produced good data and an unnecessary gamble — with payload unmodeled, the estimator's threshold was uncalibrated. Foam block: same data, zero downside. And configure the payload before tuning sensitivity; adjusting sensitivity around a wrong dynamics model treats the symptom.
125. **Increases confirm; decreases never wait.** The mid-run speed control's asymmetry is a pattern: any control where one direction is safe (slow down, stop, close) must act instantly, while the risk direction (speed up, open, energize) can afford a deliberate confirm. Never put a dialog in front of the safe direction.
126. **Screen order = physical order for anything an operator wires.** The port map only became a wiring aid when its nine cards matched the nine connectors left-to-right, power strips included. Logical grouping is for engineers; people at the cabinet count connectors.

---

*Summary of Addendum 21: July 22 was the project's hardest and most consequential day. The wait verb resolved (integer ms — proved by the controller's own 10006), the derived-pose resolver completed the codegen, and test wizard EXECUTED on the arm — home, approach, descend, vacuum-on — before the shakeout began: the J5 wrist rotation was forensically pinned on movL IK re-solution (taught J5≈89° vs runtime 138°), fixed with movJ-for-zero-offset and seeded-IK-for-lifts; the two independently-taught homes were 96.67° apart and unified. Then the controller died — Estun's own UI locked out, cold boot not helping — and the operator's downloaded boot logs cracked it: our test program's zero-length blend had crashed the Lua runtime (firmware bug #1), and afterward our own 2-second reconnect loop was re-crashing C2Control at every boot by subscribing into its initialization window (firmware bug #2, triggered by us). Recovery: stop the driver, cold boot, wait — clean. The driver was hardened (grace, probe, backoff, crash-loop detection; 2788ec3) making the failure structurally impossible. The speed cap rose to 65% with server-enforced confirm asymmetry; payload became a per-program warned-on property; the operator body-tested collision detection (it worked; next time a foam block); the I/O page went silkscreen-exact with gated DO toggles whose acknowledged-state snap-back honestly exposed that this firmware won't force outputs — routing manual actuation through a wire-proven io-console micro-program instead. The first real actuator was wired: a Tailonz 4V210-08 whose 3.0W coil sits exactly at the DO's 125mA limit — the relay it requires is the first component of the NeuRobots Cell Box, the operator's product idea that turns this week's integration pain into the deployment kit. Ten lessons, two of them the day's headline: your own retry loop can be the attacker, and the victim's own logs solve the case.*

*Last updated: July 22, 2026 (Addendum 21 — Sections 351–372, Lessons 117–126)*
---

<!-- v46-content-end -->
