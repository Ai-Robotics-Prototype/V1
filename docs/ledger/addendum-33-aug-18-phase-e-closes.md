---
ledger_split: addendum-33
source: ledger_addenda_32-35.zip / ADDENDUM_33_2026-08-18_phase_E_closes.md
source_lines: (external — appended after v46; not part of the v46 reconstruction test)
title: Phase E closes — planner-computed real motion, 14 μm cartesian round-trip
---

# ADDENDUM 33 — August 18, 2026 — PHASE E CLOSES: THE PLANNER TAKES THE ARM, THE STRAIGHT LINE LANDS AT 14 MICRONS, AND THREE PHASE-F LAWS GET WRITTEN
*(Appended in full. Nothing above this line was removed. The morning the ROS2 effort's capability chapter ended: MoveIt-planned motion — joint-space and cartesian — proven on the real S10-140 over CRI, with a full cartesian round trip closing at 14 μm over 40 mm of commanded motion. Also: D5b banked, a boot-race diagnosed by measurement, a planner-choice doctrine born from OMPL's wander, the settle-poll law, and the URDF↔controller frame mapping pinned with cross-frame evidence instead of a guess.)*

### Section 511: D5b — the deferred return, banked as the warm-up it was designed to be

Session opened by finishing Addendum 32's deferral. Relaunch in tmux (a stale `duplicate session: robot` reminded us the session persists — attach, don't create). Warm-up hold: 249.90 Hz, all six joints at exactly 1 LSB drift; **cross-power-cycle finding: max pose drift through the full teardown/relaunch cycle was J3 at 4 LSBs (0.0013°) — the arm did not physically move a hair between sessions.** D5b return (J5 −0.05 / J6 +0.05, fresh-snapshotted): SUCCEEDED; full Phase-D round-trip integrity ±0.005° worst joint, J6 returning to reference at 0.00005° (1/15 LSB). Operator visually confirmed coordinated motion (the deferred visual gate: SEEN, no anomalies; fine-grained direction-vs-twin comparison rolled into E5 where it was implicitly closed by the LIN rung's correct vertical). Phase D: fully closed, all rungs, both sessions.

### Section 512: Phase E (E1–E4) — the S10 becomes a ROS2 citizen

- **E1:** `s10_140_description` built from the verified `s10-140-full.urdf` byte-for-byte (limits ±200°/±166°, deliberate J3/J5 axis flips untouched), joints renamed `Joint1..Joint6` for CRI consistency (mapping table in README), meshes packaged, two ros2_control variants (mock + CriUdpSystem with Phase-D IPs and `max_step_rad=0.002` inherited). `check_urdf` clean 7-link serial chain.
- **E2 — the Lesson-85 decision, made deliberately:** **Option A — sign flips stay in URDF axes.** Rationale accepted into the record: MoveIt consuming the flipped-axis URDF is *internally consistent* with the CRI feedback convention proven in Phase C; Phase D's entire encoder-perfect verification baseline was earned under this convention; migrating mid-build would trade zero Phase-E benefit for the worst diagnostic class (read/write sign asymmetry: twin right, arm wrong). The `apos_sign` migration remains on the ledger as its own future atomic session with paired read/write regression tests.
- **E3:** `s10_140_moveit_config` (SRDF, kinematics, joint limits, OMPL, Pilz cartesian limits, controllers) + unified launch `s10_140_cri_ros2_control.launch.py` (`use_mock` toggle). Two Humble gotchas patched and recorded: `Command()` URDF text must be wrapped `ParameterValue(..., value_type=str)` or launch YAML-parses the XML; Pilz cartesian limits must live under `robot_description_planning.cartesian_limits.*`, merged with joint_limits.
- **E4 (mock), four gates:** 257 Hz ✓; OMPL joint plan+execute SUCCESS ✓; Pilz LIN cartesian SUCCESS ✓; and the J3-over-limit probe — **PASS with a finding: MoveIt does not REJECT an out-of-limit JointConstraint target; it silently CLAMPS the plan to exactly the limit (166.0000°) and returns SUCCESS.** Hardware never sees an illegal command (the gate's purpose), but consumers must never rely on MoveIt erroring for out-of-bounds goals — **the executor validates goals before submitting** (now a standing Phase-F requirement).
- Mid-E4 incident that wrote its own rule: the mock launch collided with the *still-running* Phase-D CRI launch (two `controller_manager`s on one DDS graph → JSB spawn failed against the wrong one). Claude Code killed only its own orphan, refused to touch the operator's launch, and stopped for the operator's "safe and mock" (Ctrl-C + teardown) before proceeding. One graph, one controller_manager — verified in every subsequent preflight.

### Section 513: E5 morning — a boot race, diagnosed by measurement in one command

First E5 launch attempt failed at step zero: `TCP 连接失败 192.168.2.136:9001` — twice. The fail-fast launch design meant nothing was ever half-armed. Ping + nc a minute later: everything answering. Verdict: **the controller was mid-boot** (fresh power-up that morning); by the time the diagnostic ran, :9001 had come up. Relaunch succeeded fully — five 成功, `S10_140System` activated (the new description's first time driving real hardware), first-frame alignment, MoveIt "You can start planning now!", brakes audibly releasing at switchOn exactly as predicted for a cold-booted (disabled) arm. Note for the eventual supervised service: a CRI client must gate its own start on :9001 answering (the §389 pattern, now needed on a second port).

### Section 514: E5.3 — OMPL wanders, Pilz holds, and the planner-intent doctrine is born

E5.2 hold: 249.93 Hz, all joints at exactly 1 LSB; E5 reference pose captured (small honest drift vs Phase-C reference — J2 +0.043° — attributed to physical nudge or requantization across power cycles; new reference authoritative). First OMPL plan for "J6 +0.05, hold the rest" **validated against safety gates but exposed the planner's nature: RRTConnect used the goal-tolerance box as an envelope — all five "held" joints wandered 0.1–0.2° and J6 planned 0.15° past target.** Safe, legal, and wrong for the intent. Operator-approved re-plan with **Pilz PTP: J1–J5 bit-exact (start=end=min=max, zero velocity) at every waypoint, J6 a clean quintic to exactly +0.05 rad at half the velocity cap.** Executed: SUCCESS; settled within 1 LSB across the board.

**The doctrine, logged to memory (`cobot-cri-planner-intent`) and now standing for Phase F: MoveJ → Pilz PTP; MoveL → Pilz LIN; OMPL reserved for collision-aware planning when the scene demands routing.** Deterministic planners for deterministic intents — a sampling planner given a tolerance box will use it, and "every run lands 0.2° differently" is a production bug wearing a SUCCESS code.

### Section 515: The settle-poll law — SUCCESS is not arrival

E5.3's first post-execution snapshot showed J6 apparently 0.378° short of target. Claude Code held position, read the plugin source, re-measured — and found the truth: **JTC declares "Goal reached, success" at its default `goal_tolerance` of 0.01 rad (~0.573°), while the servos keep converging afterward.** The premature snapshot caught the arm mid-flight; a fresh one showed it settled at 1 LSB from target. Fix shipped before the next rung: **poll-for-settle** — after ExecuteTrajectory SUCCESS, watch `/joint_states` until per-joint drift ≤ 2 LSB over a rolling 500 ms window (15 s timeout) before any gate evaluation or next action. Its first live outing (E5.4) caught the arm at 232× the gate mid-convergence and confirmed settle in 1.1 s. **Phase-F law: the executor never fires the next step (especially I/O — imagine vacuum firing 0.4° from the pick pose) on action-SUCCESS alone; it settles first.** Related F-item: tighten JTC `goal_tolerance` in controller config so SUCCESS itself means more.

E5.4 (Pilz PTP return): SUCCESS; round trip to E5 reference at 3 LSBs worst, J6 bit-exact (0.00005°).

### Section 516: The frame question — refused on ambiguity, resolved by cross-frame evidence

E5.5's spec said "+0.02 m along base +Z (up)". Claude Code FK'd the pose, noticed the URDF is **Y-up** ("geom frame, Y-up"; Joint1 axis 0,1,0), and **refused to plan on an ambiguous vertical** — the correct instinct for a first cartesian motion, where a wrong axis is the arm driving sideways. Resolution came from data already in the session rather than a guess: CRI's `ee_pose` at this pose is [0.7531, 0.3192, 0.2386] in the controller's Z-up frame (dashboard-verified, Z=height), MoveIt's FK read (−0.3227, +0.2525, −0.7522) — magnitudes map **URDF +Y ↔ controller Z (up); URDF −Z ↔ controller X; URDF −X ↔ controller Y.** Logged to memory (`cobot-cri-frame-mapping`); the ~14 mm residual on the up-axis is flange-vs-TCP definition. **Phase-F dependency: every pose the executor sends crosses this conversion.**

### Section 517: E5.5 — the straight line

Plan (Pilz LIN, +0.02 m base +Y, orientation quaternion locked): 14 waypoints, 1.24 s; **J1/J5/J6 pinned; J2/J3/J4 in coordinated flex** (largest J4 at 2.16°); J3 excursion 0.71° monotonic with 49° of limit headroom; J5 excursion zero. Executed:

- **E5.5a outbound: TCP +20.010 mm against +20.000 commanded — 12 μm error — horizontal drift ≤5 μm per axis, quaternion bit-exact.**
- **E5.5b return: round trip closed at 0.014 mm total (36× under the 0.5 mm gate), quaternion bit-exact through both legs, all joints within 5 LSBs of the E5 reference.**

First cartesian-planned motion in the arm's history: **14 μm round-trip error over 40 mm of commanded motion, orientation held to the noise floor.** This is the primitive every approach/retreat in the bowl program will run on, now proven at a precision two orders of magnitude beyond what the job needs.

### Section 518: Shutdown, two cosmetic findings, and the state of the effort

Shutdown had friction: Ctrl-C wasn't reaching the tmux pane from the operator's console; solved from a second window with `tmux send-keys -t robot C-c` (a keeper for the ops runbook). During teardown, **move_group segfaulted in its own destructor** (CallbackGroup teardown, after all execution SUCCEEDED) — known MoveIt-on-Humble shutdown nuisance, cosmetic, logged. Also observed: planning-scene TF warnings for `camera_*` frames disconnected from `base_link` — the perception stack's frames need the **hand-eye calibration / static transform** to join the arm's tree before MoveIt can use camera data for collision awareness (existing horizon item, now with a concrete symptom; Phase F). `cri_teardown.py`: three OKs; controller in Manual.

**State of the ROS2 effort: the capability chapter is closed.** Proven end-to-end on real hardware: CRI transport (250 Hz), the S10's true geometry as the live hardware description, hand-built and planner-computed joint motion, deterministic PTP, cartesian LIN at micron-class repeatability, frame mapping, and the operational discipline (tmux, teardown ritual, settle-poll, plan-show-send). **Everything remaining is Phase F — integration:** F1 dashboard jog over ROS2 (first deliverable); F2 executor over MoveIt (MoveJ→PTP, MoveL→LIN, validate-before-submit, settle-before-next, WS keeps I/O — the hybrid becomes real); F3 production hardening (supervised systemd with :9001 boot-gating, teardown integrated into service stop, tightened goal_tolerance, WS-driver crash-loop lessons ported); F4 the white bowl over CRI — the finish line.

| Item | Status |
|------|--------|
| Phase D (incl. deferred D5b + visual gate) | **CLOSED — all rungs, both sessions** |
| Phase E1–E4 (S10 description, MoveIt config, mock) | **CLOSED — all gates** |
| Phase E5 (planned motion on real arm, PTP + LIN) | **CLOSED — 14 μm cartesian round trip** |
| Planner-intent doctrine (PTP/LIN/OMPL) | **ADOPTED — memory + this ledger** |
| Settle-poll law (SUCCESS ≠ arrival) | **ADOPTED — executor requirement** |
| Frame mapping URDF(Y-up) ↔ controller(Z-up) | **PINNED — memory + this ledger** |
| MoveIt clamps (not rejects) out-of-limit goals | **RECORDED — executor validates before submit** |
| JTC goal_tolerance (0.01 rad default, loose) | Phase F: tighten in controller config |
| Hand-eye / camera TF into base_link tree | Phase F (symptom now observed live) |
| move_group destructor segfault on shutdown | Cosmetic, logged |
| tmux send-keys remote Ctrl-C | Ops runbook keeper |
| DHCP reservation / log retention cap / RunPod | STILL OPEN (unchanged) |

## PROCESS LESSONS (219–226)

219. **A sampling planner treats tolerance as an envelope; a deterministic planner treats it as a target.** OMPL RRTConnect legally wandered every "held" joint 0.1–0.2° inside the goal box; Pilz PTP held them bit-exact. Choose the planner by INTENT: deterministic moves get deterministic planners (MoveJ→PTP, MoveL→LIN); sampling planners are for when the scene demands search. A wander that fits the tolerance is still a repeatability bug in production.

220. **Action SUCCESS means the controller is satisfied, not that the arm has arrived.** JTC's "Goal reached" fires at its goal_tolerance (default 0.01 rad ≈ 0.573°) while servos are still converging. Gate evaluation — and any dependent next action, especially I/O — waits for measured settle (per-joint drift ≤ 2 LSB over 500 ms). The first "failure" this exposed was a measurement taken 0.5 s too early.

221. **Refuse to plan on an ambiguous frame; resolve with cross-frame evidence, not a guess.** "Up" was undefined between a Y-up URDF and a Z-up controller. The answer was already in the session's own data: matching FK magnitudes against CRI ee_pose pinned URDF+Y↔ctrlZ definitively. First cartesian motion is exactly where a guessed axis becomes the arm driving sideways.

222. **A planner that CLAMPS instead of REJECTS moves the validation burden to the caller.** MoveIt returned SUCCESS for an out-of-limit joint target by silently planning to the limit. Consumers must validate goals pre-submit; never use "the planner would have errored" as a safety argument.

223. **One DDS graph, one controller_manager.** Two on the same domain silently misroute spawner requests (the E4 mock-vs-live collision). Preflight for any launch: pgrep + node-list for an existing controller_manager, and never start a second stack while a motion stack is live without explicit domain isolation.

224. **The persistence that makes tmux valuable is also state to manage.** `duplicate session` means attach, not create; a console that can't deliver Ctrl-C can inject it from any other shell with `tmux send-keys -t robot C-c`. The session outliving the operator's window is the feature — treat it like a service, not a terminal.

225. **A network-boot race looks identical to a dead service; measure before concluding.** Two launch failures at :9001 were the controller mid-boot, proven by ping+nc answering a minute later. Any supervised CRI client must gate its start on the port answering — the §389 boot-grace pattern, generalized to every port we depend on.

226. **Verification precision should be recorded even when it exceeds the requirement.** 14 μm round-trip on a 0.5 mm gate isn't overkill to note — it's the baseline that makes future regressions visible. When the bowl program someday lands 0.3 mm off, the record proving the motion layer does 0.014 mm points the investigation at everything except the motion layer.

---

*Summary of Addendum 33: the morning the planner took the controls and proved worthy of them. The deferred return move banked itself as a warm-up, showing the arm hadn't moved a hair across a full power cycle; then the S10's true geometry — the verified twin, axis flips and all — went live as a ROS2 hardware description for the first time and MoveIt began computing the motions. The first computed plan taught the session's biggest lesson before a single joint moved: a sampling planner given a tolerance box will use every bit of it, and the fix was doctrine, not code — deterministic planners for deterministic intents. The first execution taught the second lesson: SUCCESS is a controller's opinion, arrival is a measurement, and half a second of patience separates them. The first cartesian move demanded the third: refused on an ambiguous vertical, resolved by lining the URDF's own FK against the controller's dashboard-verified pose until up had evidence. And then the straight line itself: two centimeters up, two back, fourteen microns of round-trip error with the tool's orientation held bit-exact — the approach-and-retreat primitive of every future pick, landed at a precision the job will never need and the record will never forget. Eight lessons, one cosmetic segfault, one boot race, and a clean teardown: the capability chapter of the ROS2 method is closed. What remains is integration — the jog buttons, the executor, the hardening, and one white bowl waiting to be picked up by a new nervous system.*

*Last updated: August 18, 2026 (Addendum 33 — Sections 511–518, Lessons 219–226)*
