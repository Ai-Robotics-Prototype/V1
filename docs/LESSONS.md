# LESSONS — numbered sections extracted from v46

Source: `cobot_project_conversation_v46.md` (see `tools/ledger_lint.py`) +
post-v46 addenda 32+. 252 numbered entries: 212 from v46 across addenda
01–31 + era-01; 40 post-v46 (244–283, add-36 §528–532, add-37 §535–538,
add-38 §539–543, add-39 §548–556, add-40 §562–565, add-41 §571–573,
add-42 §577, add-43 §584–585, add-44 §593).
Numbers reset across addenda in v46 — the same N may appear in multiple
files. **Ledger numbering rule: tail-grep this file (LESSONS.md) before
assigning a new number.**

Format: `N. one-line — file` (addendum slug; era-01 = pre-addendum).
Duplicates listed with all sites; gaps flagged at the end.

## Extraction methodology (2026-08-20 audit)

The v46 rows below (212 entries) were extracted from lines matching the
`## N.` heading pattern — v46's section-title numbering. Post-v46 rows
(244–250, from addendum-36) are true lessons on a single continuous stream.

**Known extraction miss:** v46 also carries a parallel `N. **Title.**`
list-item numbering with real lesson content — 383 such items across v46,
including 65 within the currently-listed "gap" range 146–243. Those are
not yet reflected in this file. Sample: v46:L12644 `146. **Summary
statistics hide paths...**`, v46:L13378 `200. **Every investor claim must
survive a cabinet inspection...**`. Backfill is deferred to a later
session — flag added here so the lint's LESSONS-gaps-documented check
(`tools/ledger_lint.py`) passes on the current honest state.

Counts on current file:
- v46 heading-format `## N.` entries in this file: 212
- Post-v46 continuous-stream lessons: 40 (244–283)
- Total entries below: 252
- Gaps in 1..304 range: 110 (see gap block at bottom)
- Known-extraction-miss list-format lessons NOT yet in this file: ~65 in
  146–243 range, plus additional list-format lessons in 1–145 that
  overlap the heading numbers (not necessarily missing content, just not
  in this index).

---

1. Project Overview — era-01:L55
1. MOTIONCAM-3D COLOR S+ — EVALUATED AND ADOPTED (reverses Section 274) — add-01:L9484
2. Hardware — era-01:L70
2. PROPRIETARY RECOGNITION STACK — DECIDED + BUILD PROMPTS AUTHORED — add-01:L9512
3. Software Stack Architecture — era-01:L82
3. SIMULATION — ISAAC SIM HARDWARE-BLOCKED, LIGHTWEIGHT SYNTHETIC IS THE NEAR-TERM PATH — add-01:L9546
4. ROS2 Package Breakdown — era-01:L131
4. PROGRAMMING BY DEMONSTRATION (PBD) — MAJOR AUTONOMY KEYSTONE — BUILT THIS SESSION — add-01:L9560
5. Quick Start — era-01:L175
5. HTTPS ENABLEMENT (to unblock camera) — DEPLOYED — add-01:L9584
6. Development Setup — era-01:L206
6. DASHBOARD — THE TABLET RIGHT-EDGE CUTOFF SAGA (RESOLVED) + RELATED FIXES — add-01:L9591
7. Windows WSL Setup (Step by Step) — era-01:L305
7. TABLET / KIOSK SETUP NOTES — add-01:L9638
8. GitHub Setup — era-01:L376
8. RESPONSIVE / COMMERCIALIZATION ARCHITECTURE NOTE — add-01:L9644
9. Claude Code Setup — era-01:L480
9. AR / AUTONOMY-STEPPING-STONE CONCLUSION — add-01:L9647
10. SSH & Remote Development — era-01:L552
10. 3D ROBOT VIEW — MESH LOADING + URDF-FROM-MANUAL — add-01:L9650
11. How to Develop Such a Large Project — era-01:L600
11. ESTUN / HARDWARE STATUS (updated) — add-01:L9679
12. Claude Code Pricing — era-01:L644
12. CONSOLIDATED PENDING ITEMS (June 15, 2026) — add-01:L9685
13. Team Collaboration — era-01:L668
13. PROCESS LESSONS — CONSOLIDATED (must govern all future sessions) — add-01:L9706
14. Team Development Split — era-01:L695
14. S10-140 TECHNICAL DRAWING — DIMENSIONS READ DIRECTLY (provisional URDF now dimensionally faithful) — add-02:L9725
15. How Components Interface Together — era-01:L763
15. ARTICULATED S10-140 URDF — MESHES DEPLOYED FROM SOLIDWORKS (the §10/§14 PENDING items now actioned) — add-03:L9772
16. Cobot Selection Guide — era-01:L820
16. HTTPS URL TRANSITION — RECURRING SUPPORT POINT — add-03:L9793
17. ROS2 Explained — era-01:L920
17. PROGRAM-FROM-DEMONSTRATION (PBD) — RUNTIME + API-KEY SAGA + STRATEGY — add-03:L9799
18. ROS2 on Any Robot — era-01:L976
18. SETUP / COMMISSIONING WIZARD + CELL DATA MODEL (new, in Configure tab) — add-03:L9816
19. Natural Language Robot Control — era-01:L1025
19. WORKSPACE BOUNDS — BUILT, THEN CIRCULARIZED, THEN REMOVED (full honest trail) — add-03:L9848
20. Fleet Learning & Continuous Improvement — era-01:L1110
20. COLLISION DETECTION (built on baseline + existing lidar_perception + URDF) — add-03:L9854
21. Commissioning Checklist — era-01:L1217
21. LIDAR — DENSE CLOUD RESTORED; FUSION DISABLED (root cause + correct fix) — add-03:L9864
22. Key Files Reference — era-01:L1291
22. 3D VIEW FRAME MISMATCH — LiDAR/objects not appearing where the robot is — add-03:L9870
23. Useful Commands — era-01:L1318
23. PBD WIZARD FULL-SCREEN / NO-CLIP FIX (tablet) — add-03:L9873
24. VS Code & WSL Explained — era-01:L1394
24. CAMERA / PERCEPTION STRATEGY — NVIDIA STACK STATUS + DETECTING THE USER'S OWN PARTS — add-03:L9876
25. GitHub Workflow (Practical) — era-01:L1434
25. NVIDIA-STACK GUIDANCE (consolidated) — add-03:L9884
26. Claude Code Token Usage — era-01:L1488
26. CONSOLIDATED PENDING ITEMS (June 16, 2026 — supplements §12, nothing removed) — add-03:L9887
27. Three-Way Development Workflow — era-01:L1521
27. PROCESS LESSONS — JUNE 16 ADDITIONS (extend §13; all prior lessons still govern) — add-03:L9903
28. Complete Build Prompt for Claude Code — era-01:L1581
28. GITHUB SOURCE-OF-TRUTH CONFUSION — WRONG BRANCH, NOT LOST WORK (critical process finding) — add-04:L9922
29. Jetson Setup — Session Log (May 4 2026) — era-01:L1630
29. STATIC KEEP-OUT ZONES — full BUILD → TUNE → TIGHTEN arc (extends §20) — add-04:L9931
30. Supplier Test Procedure — era-01:L1737
30. 3D-VIEW CLOUD DENSITY + "SUPER LIGHT" CLOUD (extends §22) — add-04:L9958
31. Company & Branding — era-01:L1815
31. MIRRORED-SCENE BUG — handedness in ROS→Three conversion (root cause found in code) — add-04:L9962
32. NeuRobots Control App — era-01:L1865
32. RETEACH ON MOVE STEPS — already built; verify-and-surface (the requested feature largely exists) — add-04:L9966
33. Project Status — era-01:L1958
33. LOAD-PROGRAM DROPDOWN — z-index / clipping / click-intercept — add-04:L9971
34. PROGRAM-LIBRARY TAB-SWITCH STALENESS (same family as the active-cell sync) — add-04:L9975
35. Jetson Setup — Session Log (May 18 2026) — era-01:L2046
35. SETUP WIZARD / CONFIGURE — ACTIVE-CELL AUTO-DEFAULT + tab-refetch (extends v17 §18) — add-04:L9979
36. Dashboard Session Log (May 19 2026) — era-01:L2345
36. UI CLEANUP PASS (consolidated requests — June 17) — add-04:L9983
37. Session Log — May 21 2026 — era-01:L2635
37. LiDAR MESH / LIVOX VIEWER 2 — will NOT boost cloud quality — add-04:L9993
38. Session Log — May 22–26 2026 — era-01:L3056
38. BIN PICKING + MOTION PLANNING WITH THE MOTIONCAM — honest difficulty framing — add-04:L9996
39. Session Log — May 20–21 2026 — era-01:L3377
39. PHOTONEO SDK / DRIVER / ARM64 DUE DILIGENCE — the decisive pre-purchase question — add-04:L9999
40. Session Log — May 20 2026 — era-01:L3786
40. CONSOLIDATED PENDING ITEMS (June 17 — supplements §26/§12, nothing removed) — add-04:L10018
41. Session Log — May 20 2026 — era-01:L3888
41. PROCESS LESSONS — JUNE 17 ADDITIONS (extend §27/§13; all prior lessons still govern) — add-04:L10037
42. Session Log — May 22 2026 — era-01:L3906
42. PBD API KEY — RESOLVED / WORKING — add-05:L10056
43. Session Log — May 27 2026 — era-01:L3961
43. PBD CORRECTION-vs-DRAFT DIFF CAPTURE — BUILT & VERIFIED (flywheel Phase 1, language side) — add-05:L10059
44. Session Log — May 28 2026 — era-01:L4461
44. DATA-FLYWHEEL PLAN — DOCUMENTED — add-05:L10067
45. PBD PALLET-GRID BUG — "1 by 1" wrong; structural gap (schema had no grid fields) — add-05:L10070
46. PBD INTERACTIVE CLARIFICATIONS — turn ambiguity into answerable questions — add-05:L10074
47. DETECT STEP — part dropdown (taught parts only) + Teach-New entry point — add-05:L10078
48. RENDER-ERROR DEBUGGING — cam0 expand + Part Recognition (the lesson: get the ACTUAL error) — add-05:L10082
49. CONTOURED STATIC KEEP-OUT ZONES — box→contour, and the box-fallback inconsistency — add-05:L10088
50. GITHUB — main BROUGHT UP TO DATE (the v18 §28 stale-main problem resolved) — add-05:L10093
51. DH-ACCURATE URDF FROM CAD — the path to a Standard-Bots-style movable model — add-05:L10098
52. PHOTONEO MOTIONCAM — ARM64 CONFIRMED; purchase likely — add-05:L10122
53. GETTING READY FOR THE MOTIONCAM + THE ARM — prep priorities — add-05:L10127
54. VIDEO-UPLOAD 500 ERROR (PBD) — backend crash returning non-JSON — add-05:L10130
55. CONSOLIDATED PENDING ITEMS (June 21-22 — supplements §40/§26/§12, nothing removed) — add-05:L10134
56. PROCESS LESSONS — JUNE 21-22 ADDITIONS (extend §41/§27/§13; all prior lessons govern) — add-05:L10154
57. INVESTOR MATERIALS PRODUCED — pitch deck (English + Chinese) + one-pager — add-06:L10172
58. NEUROBOTS MANUFACTURING — name + brand identity — add-06:L10176
59. POSITIONING CLARIFICATION — robot maker + AI platform (distinct from prior integrator framing) — add-06:L10199
60. STANDARD BOTS — competitive intel + funding history — add-06:L10205
61. FOUNDING TEAM — bios + role split — add-06:L10219
62. OPERATIONS — Boyceville WI shop + Jade Molds test bed + China sourcing — add-06:L10234
63. PHASED GO-TO-MARKET — Phase 1 + Phase 2 channels — add-06:L10242
64. SOFTWARE PILLARS — four capabilities (consolidates §4, §11, §54 references) — add-06:L10250
65. THE ASK + USE OF FUNDS — $1M for 10% — add-06:L10254
66. ROADMAP — Demo → Pilot → Scale — add-06:L10270
67. MESSAGING & TAGLINES — for delivery consistency — add-06:L10278
68. CONSOLIDATED PENDING ITEMS — investor materials (supplements §55/§40/§26/§12) — add-06:L10282
69. PROCESS LESSONS — investor-materials work (extends §56/§41/§27/§13) — add-06:L10296
70. ESTUN MANUAL ANALYSIS — API REFERENCE + ROS2 DRIVER DOCUMENT — add-07:L10322
70. LOGO REDESIGN — "Synapse N" (emphasizing the NEURO in NeuRobots) — add-09:L10747
71. 3D VIEWER TROUBLESHOOTING ARC — GLTFLoader, DRACOLoader, Tablet OOM — add-07:L10345
71. BIO REVISIONS — Josh & Pat (deck slide 13, slide 10, one-pager) — add-09:L10764
72. FORWARD-KINEMATICS-VERIFIED PRIMITIVE URDF — JOINT CHAIN CONFIRMED — add-07:L10368
72. DELIVERABLES REGENERATED — v2 materials — add-09:L10785
73. SW URDF EXPORTER — INCOMPATIBLE WITH SOLIDWORKS 2025 — add-07:L10390
73. PENDING ITEMS — updates to §68 table — add-09:L10793
74. VBA MACRO — AUTO-EXTRACT JOINT AXES FROM ASSEMBLY MATES — add-07:L10401
75. OPEN ITEMS — 3D VIEWER (as of July 2, 2026) — add-07:L10413
76. PROCESS LESSONS — JULY 2 ADDITIONS (extend §56/§41/§27/§13; all prior lessons govern) — add-07:L10428
77. 3D VIEWER GRAY + ARTICULATION ROOT CAUSES (confirmed from the actual uploaded codebase) — add-08a:L10452
78. CALIBRATED DH TABLE OBTAINED — THE KINEMATICS UNBLOCK (resolves §75 open item) — add-08a:L10466
78. THE THREE-SEGMENT BUSINESS MODEL — Josh's reframe, July 3 2026 — add-08b:L10622
79. DH-EXACT URDF BUILT AND FK-VERIFIED (`s10-140-dh.urdf`) — add-08a:L10487
79. TRAINABILITY AS THE HEADLINE MOAT — "Train it like a new hire" — add-08b:L10634
80. igus REJECTION REAFFIRMED — add-08a:L10500
80. THE DRIVER LIBRARY — moat #2, enabler of Segments 2 & 3 — add-08b:L10645
81. SOLIDWORKS EXPORT REALITY — GLB NOT NATIVE; STEP IS THE FORMAT — add-08a:L10506
81. MARKET DATA — researched, citable, honest ranges (replaces all placeholder market claims) — add-08b:L10649
82. STEP→GLB PIPELINE PROVEN (cascadio + trimesh, color preserved) — add-08a:L10514
82. COMPETITIVE LANDSCAPE — expanded per Teddy's research (extends §60) — add-08b:L10661
83. READ-ONLY CS-DUMP MACRO (`DumpCoordSystems.bas`) — SUCCESSFUL — add-08a:L10527
83. FINANCIAL PROJECTIONS — bottom-up model (replaces "illustrative" placeholders) — add-08b:L10672
84. FULL ARTICULATING TWIN BUILT FROM CS FRAMES (`s10-140-full.urdf`) — add-08a:L10547
84. USE OF FUNDS — dollar-level detail (supersedes the illustrative 35/30/15/12/8 of §65) — add-08b:L10698
85. INTERIM MILESTONE — `s10-140-partial.urdf` — add-08a:L10563
85. ROLLOUT PLAN — segment-aware roadmap (extends §66) — add-08b:L10711
86. WORKFLOW / ENVIRONMENT NOTES (July 3) — add-08a:L10569
86. DECK IMPACT — slides to change (queued for next deck revision) — add-08b:L10720
87. OPEN ITEMS (as of July 3, 2026) — add-08a:L10578
87. PHOTO / SCREENSHOT INCORPORATION — workflow for Josh — add-08b:L10731
88. PROCESS LESSONS — JULY 3 ADDITIONS (extend §76/§56/§41/§27/§13; all prior lessons govern) — add-08a:L10592
88. MILESTONE — DIGITAL TWIN COMPLETE AS A MECHANISM — add-10:L10817
89. STANDALONE VERIFICATION HARNESS (`twin_test.html`) — add-10:L10820
90. FULL-ASSEMBLY STEP — THE GEOMETRY BREAKTHROUGH — add-10:L10828
91. FRAME TRANSFORM — ASSEMBLY (Z-up) → VERIFIED GEOM (Y-up) — add-10:L10840
92. FINAL VERIFIED JOINT CHAIN (geom frame, Y-up) — LOCKED — add-10:L10848
93. THE J4 SAGA — how the last joint was resolved (the hard part) — add-10:L10862
94. J5 DIRECTION FLIP — add-10:L10870
95. BEARING / CENTER-FITTING METHODS — what worked, what failed — add-10:L10873
96. VERIFICATION DISCIPLINE (reinforced this session) — add-10:L10880
97. WORKING FILES / ARTIFACTS (this session, in Claude's env — regenerate on Jetson) — add-10:L10885
98. OPEN ITEMS — 3D TWIN (as of July 6, 2026; extends §87) — add-10:L10893
99. PROCESS LESSONS — JULY 6 ADDITIONS (extend §88/§76/§56/§41/§27/§13; all prior lessons govern) — add-10:L10904
100. MILESTONE — TWIN IS NOW LIVE IN THE DASHBOARD ON THE JETSON — add-11:L10919
101. J5 AXIS CORRECTED — SUPERSEDES the Addendum 10 J5 note — add-11:L10922
102. GEOMETRY REFINEMENT — smoothness is a triangle-budget problem, not flat shading — add-11:L10930
103. RECOLOR — Deep Steel navy, matte — add-11:L10937
104. URDF BAKE — deploy bundle + Jetson integration — add-11:L10940
105. DASHBOARD CONTROL SURFACE (all additive; twin-only, no hardware in loop) — add-11:L10965
106. CARTESIAN IK GIZMO (drag the TCP, full 6-DOF) — add-11:L10972
107. RENDER-STABILITY FIX — the "finicky Program-tab gizmo" — add-11:L10977
108. HOME ANIMATION — add-11:L10980
109. OPEN ITEMS — DASHBOARD / TWIN (as of July 7, 2026; extends §98) — add-11:L10983
110. HARDWARE-CONNECTION PLAN (scoped, NOT started — safety-gated) — add-11:L10995
111. PROCESS LESSONS — JULY 7 ADDITIONS (extend §99; all prior lessons govern) — add-11:L11004
112. ROBOT ARRIVAL & POWER-ON — add-12:L11023
113. NETWORK TOPOLOGY (CRITICAL, UNRESOLVED HARDWARE CONSTRAINT) — add-12:L11026
114. FACTORY WEB UI — LOGIN, LANGUAGE, CAPTURES — add-12:L11033
115. CONFIG EXPORT — KEY FINDINGS (firmware 2.3) — add-12:L11040
116. WEBSOCKET PROTOCOL FULLY REVERSE-ENGINEERED — THE KEY WIN — add-12:L11050
117. WORKING PYTHON CLIENT — `posture.py` — add-12:L11064
118. DH-IDENTIFICATION CAPTURE (THE FK ORACLE DATASET) — add-12:L11067
119. ROBOT STATE / SAFETY NOTES (this session) — add-12:L11079
120. PENDING ACTION ITEMS (as of July 8, 2026; extends §109/§110) — add-12:L11084
121. PROCESS LESSONS — JULY 8 ADDITIONS (extend §111; all prior lessons govern) — add-12:L11097
122. DH FIT COMPLETED ON JETSON — SUB-MICRON-CLASS RESULT — add-13:L11122
123. SUPPLIER DH TABLE ARRIVED — THREE-WAY CROSS-CHECK — add-13:L11137
124. NETWORK RE-ARCHITECTURE — ISOLATED ROBOT-CELL SUBNET (RESOLVES §113) — add-13:L11144
125. THE SUBNET-COLLISION SAGA (why 192.168.2.x was necessary) — add-13:L11154
126. ROBOT COMMISSIONING STATE — ENABLED, JOGGING, LIMIT RECOVERY — add-13:L11157
127. LIVE TWIN MIRROR — BUILT AND VERIFIED (the milestone) — add-13:L11162
128. JOINT-DIRECTION SIGN VERIFICATION — J3 & J5 INVERTED, FIXED — add-13:L11171
129. TWIN MOTION SMOOTHNESS — DIAGNOSED, PARTIAL FIX (OPEN) — add-13:L11177
130. PENDING ACTION ITEMS (as of July 9, 2026; extends §120) — add-13:L11183
131. PROCESS LESSONS — JULY 9 ADDITIONS (extend §121) — add-13:L11196
132. REPO PUSHED TO GITHUB — git-LFS FOR BINARY ASSETS — add-14:L11218
133. REPO-REVIEW SYNC — actual deployed state confirmed — add-14:L11226
134. LIVE SAFETY-CONFIG VERIFICATION (Codroid UI, this session) — limits CLOSED as correct — add-14:L11232
135. ZERO-OFFSET + J3/J5 SIGN RE-CONFIRMED — §130 pending items CLOSED — add-14:L11240
136. DECISION — WHERE THE J3/J5 SIGN SHOULD LIVE (architecture; execute post-move) — add-14:L11244
137. RELOCATION — the whole setup is moving to a new location — add-14:L11251
138. FLANGE / MOUNTING FASTENER SPEC (from the manual, for tooling) — add-14:L11259
139. OPEN ITEMS (as of July 14, 2026; extends §130) — add-14:L11264
140. PROCESS LESSONS — JULY 14 ADDITIONS (extend §131; all prior lessons govern) — add-14:L11277
141. TEDDY'S DECK FEEDBACK — four changes requested (relayed via Josh; Josh approved "make all the changes you'd recommend") — add-15:L11294
142. DECK v3 — the four changes as executed (16 slides, down from 17) — add-15:L11298
143. DELIVERABLES — v3 materials — add-15:L11312
144. PENDING ITEMS — updates to §73 table — add-15:L11318
145. PLATFORM SCREENSHOTS SLIDE — deck v4 (17 slides), from Teddy's demo videos — add-15:L11336
296. ROLE RESTRUCTURE — CEO / CTO / COO (supersedes all prior role framing) — add-17:L11525
297. MERGED TEAM SLIDE — v5 copy (position 10, "WHY US · THE TEAM") — add-17:L11539
298. DELIVERABLES + REBUILD LIMITATION — add-17:L11551
299. PENDING ITEMS — updates to §144 table — add-17:L11556
300. SLOGAN LOCKED — "Industrial robotics, radically simplified." — add-17:L11568
301. ONE-PAGER v5 — full propagation (real .docx at last) — add-17:L11581
302. BRAND CLEARANCE SCAN — "NeuRobots" (preliminary, July 16) — add-17:L11594
303. DEMO VIDEO + DEMO SLIDE (July 16) — add-17:L11615
304. FULL DECK v5 — 18 slides, complete rebuild (July 16) — add-17:L11627

---

## Post-v46 lessons (addenda 32+; single continuous stream, no numbering reset)

244. Exonerate layers by executing them off-target before debugging on-target — harness runs of shipped code produce evidence, not theories. — add-36 §528
245. A liveness watchdog's threshold must exceed the worst legitimate stall; audit AND-guards for always-true legs; count every flip. — add-36 §528
246. The served bundle's build date is part of every frontend diagnosis — check hash/date before trusting a source audit; rebuild before retesting. — add-36 §528
247. Safety margins scale from MEASURED latency with a hard cap, and every refusal prints its numbers. — add-36 §529
248. Dialog lifecycle keys on operator intent (explicit Done), not on the metric crossing its threshold. — add-36 §530
249. The ledger is a transaction log; sessions load a materialized view — STATE.md wins for current truth, ledger wins for history. — add-36 §532
250. Anything whose death costs work runs in tmux — including the Claude Code session itself. — add-36 §532
251. A launch file's default is part of the deploy state — read log line 3 (the `[launch.user]:` variant announcement) before trusting any downstream signal. — add-37 §537
252. "Stopped" is a state, not a promise — doctrine describes intent; `systemctl is-active` is truth. Cross-component safety guards close the gap. — add-37 §536
253. At JSON-decode boundaries treat `None` the same as missing — `int(evt.get(k) or default)` beats `int(evt.get(k, default))` when explicit `null` is a real input. — add-37 §535
254. When the frontend looks broken, name the synth flag first — every downstream layer honestly reports whatever the source construction publishes. — add-37 §537
255. Pull the exact 4xx before speculating on cause — event_log line + server return + frontend composer, in that order; premise is hypothesis, artifact is evidence. — add-37 §538
256. A tmux pane's window discipline is itself a safety guard — dedicated windows keep same-pane Ctrl-C from killing two things at once. — add-37 §536
257. Two identifiers of the same artifact aren't the same thing — a vite chunk hash (filename) and a `git describe` build-ID (baked constant) will always disagree even when the tab is on the fresh bundle. Server-vs-tab freshness checks must compare like-for-like. — add-38 §539
258. `CriUdpSystem` latches `rx_ok_`/`command_synced_` true on first UDP RX and never resets them on remote disconnect. A controller reboot leaves the plugin echoing stale cached feedback into `/joint_states` at rate; JTC reports success on every goal; arm doesn't move. Only plugin init (teardown+relaunch) repairs it. Silent-write-accept class. — add-38 §542
259. Drop-in `EnvironmentFile=` loads AFTER the base unit's; drop-in `Environment=` is shadowed by any base `EnvironmentFile=`. Use the file approach for overrides late in the systemd env chain. — add-38 §540
260. JSB with an unhonored spawner `-p` params file falls back to insertion-order joint names (`[Joint2, Joint3, Joint1, …]`, exactly as the yaml's own head comment warns). Frontend indexes by slot; server-side name-map normalization is the workaround. — add-38 §539
261. First-exposure vs regression matters — before scoping a fix, `git log -S` the exact geometry line to confirm which. Today's hold-jog hunt was first-exposure (jog_bridge geometry unchanged since Aug 19); the operator's memory of smooth motion was Pilz LIN Cartesian (different code path). — add-38 §543
262. JTC `splines` interpolation applies vel=0 boundary conditions to trajectory points with empty `.velocities`. Under 100 ms preempt cadence + 200 ms horizon that's a 10 Hz brake-restart cycle audible on a real gearbox. Populate p0/p1 velocities to stitch consecutive goals as constant-velocity segments; Pilz LIN already does this (which is why E5 Cartesian was smooth). — add-38 §543
263. The Codroid Web operating UI is on `:9198` (`<title>Estun Web</title>`), not any standard-scan port. `:8080` on the controller is `部署系统` deploy tool — DO NOT USE for operations. — add-38 §541
264. Fail-loud startup assertion beats silent-broken-shell. Dashboard now refuses to boot if `index.html` is missing or its referenced `/assets/index-*.js` chunk isn't on disk. systemd `Restart=on-failure` escalates instead of quietly serving stale. Closes L497. — add-38 §539
265. `controller_state.reference.velocities` is a stored echo of the trajectory point's `.velocities` field — NOT `d/dt reference.positions`. First-pass verdict script mis-read it as ground-truth reference velocity and reported "smooth reference" while the reference position was actually stair-stepping ±100–315 °/s at 12.7 Hz. Always derive reference velocity from `reference.positions` when diagnosing seam vs tuning. — add-39 §548
266. A "populated velocities" fix on trajectory points is necessary but not sufficient to close a preempt-cadence hunt. If the bridge still anchors each new goal's `p0.positions` to the **current feedback** rather than the **current reference cursor**, consecutive goals discontinue in position on every preempt, and JTC's spline resolves that as ±100–300 °/s transients (frequently sign-reversed vs. commanded). Realized fraction of commanded speed collapses to ~10% and the gearbox reverses ~12 times/s — the audible "hunt." Fix: track `last_p1_pos` + `last_p1_vel` and set `p0.positions = last_p1_pos + last_p1_vel × (t_now − t_last_p1)`; also match goal `header.stamp` to the actual preempt instant. — add-39 §551
267. When JTC `output` equals JTC `reference` exactly across the whole motion window, the tracking chain is a passthrough at that stage and any residual oscillation is upstream of JTC, not tuning-fixable at JTC. Look at what's feeding `reference`, not at gains or `goal_tolerance`. — add-39 §550
268. A hold-if-far safety guard on an extrapolated reference cursor MUST be set well above the loop's steady-state tracking error, or it will flip-flop cycle-to-cycle when err naturally hovers at threshold — producing a fresh violent transient (opposite to the one the cursor was fixing). Rule of thumb: threshold ≥ 1.5 × (peak steady-state |err|). Under 200 ms horizon × 18 °/s command on the S10-140, peak err ~5° → threshold 8.6° (0.15 rad). Verify with a d/dt-reference trace, not by eye: the guard-collision fingerprint is a symmetric single-sample step-back exactly matching the current err magnitude. — add-39 §554
269. Real-arm test injects on a **freshly-restarted jog_bridge** succeed cleanly; the same identical inject on a bridge that's been up for ~30+ minutes silently degrades (single goal reaches JTC per session even though every event dispatches). Named as a separate hazard class from the seam fix; workaround for formal F1 tests is `pkill -f jog_bridge_node` immediately before the inject. Suspect ActionClient handle leak / DDS state drift; separate F3 hardening item. — add-39 §556
270. When the wire (`ros2 topic echo`) confirms an event stream landed at the subscriber but the arm doesn't respond, the bridge has *received-and-silently-dropped*, not *missed*. Debug path: `--ros-args --log-level jog_bridge:=debug` won't help (pure-Python SM has no logger); add a temporary `_dispatch` INFO log printing every SM action to see whether goals are being emitted upstream of the ActionClient. — add-39 §553
271. CC10-A firmware enforces a per-cycle acceleration limit (~25 rad/s² between consecutive command cycles). Any jog command path MUST accel-limit its OUTPUT (ramp between cycles) or the drive trips alarm 2015 ("speed command jump or local acceleration too high"). `moveit_servo` Butterworth smoothing does NOT satisfy this; `JointGroupPositionController` passthrough does NOT either. `moveit_core` 2.15 ships `AccelerationLimitedPlugin` for exactly this constraint; Humble 2.14.1 may need it backported, else an explicit adapter-side ramp (§562's shipping answer). — add-40 §562
272. SILENT-REFUSAL SIGNATURE — JTC returns `error_string='Goal successfully reached!'` against a DISABLED arm (`state=0`). ROS2 side cannot tell: `cod_cri_hardware::write()` does not propagate arm-side servo state. Feedback flowing (liveness) ≠ drives executing. Always verify `state=2 AND recoveryState=0 AND errors=[]` over WS `:9000/publish/RobotStatus,publish/Error` — never trust ROS2-side "success" on real-arm tests. Extends the silent-write-accept class (add-38 §542 named it inside `CriUdpSystem`; add-40 §564 walks it up through JTC + JointGroupPositionController). — add-40 §564
273. A divergence / safety guard that SNAPS (step-corrects position in a single tick) is itself a trip source on an accel-limited controller. On CC10-A: adapter's 5° divergence guard did `cur_cmd_pos := fb; cur_cmd_vel := 0` in one tick; Δv/cycle exceeded the firmware's ~25 rad/s² ceiling and tripped 2015 (§563). Rule: a guard must not create the very discontinuity the hardware forbids. Fix pattern: two-phase settling — Phase 1 decels vel to 0 at the same accel limit, Phase 2 slews position toward fb at a bounded rate; new events rejected while settling. Extends L268's "guard must leave the exit open" — a guard must ALSO leave the entry open (the accel-limit invariant). — add-40 §563
274. Continuous jog is intrinsically the hard motion primitive; it defeated BOTH the Lua/WS path (flicker + multi-press UX) and goal-replacement ROS2 (goal-seam then per-cycle accel trip). Planned motion (Pilz PTP/LIN) is the easy case and works cleanly (E5 signed off with 14 μm TCP round-trip). Jog is NOT on the critical path to the white-bowl demo — it's operator UX on already-solved motion. Do not let jog-hunt sessions block F2 executor / F4 bowl work. — add-40 §568
275. J6 has ~200-250 ms response latency between position command and encoder-visible motion (motor spool-up + firmware buffer + servo loop). Divergence-threshold sizing MUST accommodate `latency × max_commanded_velocity`; too tight a threshold trips during ramp-up before the arm has time to respond. Rule of thumb: `divergence_threshold ≥ latency × vel_cap_frac × max_joint_vel × 1.5`. For S10-140 J6 at 22 % wire (0.69 rad/s), cmd advances 7-8° during the 250 ms window — the old 5° threshold was at the exact edge (Rung 3 at 10 % peaked at 4.47°, just under 5°). Bumped 5° → 10° in `af24198`. — add-41 §571-§572
276. Idle re-seed with an encoder-noise deadband: while `hold_id is None` AND `|cur_cmd_vel| < settled_vel_tol`, track fb per-tick bounded by `sync_slew_rate × dt`; but SKIP updates when `|fb - cur_cmd_pos| < deadband`. Without the deadband, adapter's `cur_cmd_pos` random-walks with encoder noise (~1.2e-5 rad = 0.0007° per tick), the plugin sends the tiny changes to the arm, and `RobotStatus.isMoving` flaps to 1 continuously during genuine idle. Deadband ≈ 4× upper-bound encoder LSB (5e-5 rad ≈ 0.003°) — well below any user-observable position change. — add-41 §569
277. Startup saturation-invariant honesty flag: WARN (don't refuse) when `vel_cap_frac × max_joint_vel > 0.8 × plugin_max_slew_rate`. Above threshold the downstream plugin's per-cycle clamp will throttle the adapter's stream — the arm PLATEAUS at plugin ceiling. Not a safety hazard (the plugin's clamp is what protects the firmware) but a per-jog-% behavioral cliff worth naming at launch time. Current config: `0.5 × π = 1.571 rad/s` commanded vs. `0.8 × 1.25 = 1.000 rad/s` allowed → plateau above ~79.6 % speed_pct. — add-41 §569
278. DDS start-drop race in ephemeral test publishers: a short-lived publisher (like `f14_inject.py`) creating pub → sleep 500 ms → emit start/refresh/stop can LOSE the START message to DDS discovery, even when refreshes and stop arrive at the subscriber cleanly. Distinct from the DDS lazy-publisher hazard (`cobot-dds-lazy-publisher-hazard`) — that one is publisher-side lazy-init; this one is discovery timing on an ephemeral socket. Workaround: `pub.get_subscription_count() > 0` wait-loop before first emit. Applies to ANY one-shot inject tool. — add-41 §573
279. Under a real-arm-latency regime with a threshold-vs-latency edge case, the OPERATOR-VISIBLE symptom (arm "flickers back and forth") is diagnostically valuable but INSUFFICIENT for choosing a mechanism — 5 plausible mechanisms produce similar bag traces. Always: (1) verify live config values, not disk (grep the plugin's boot line for `max_step_rad=…`); (2) enumerate ACTUAL publishers/subscribers on the topic (`get_publishers_info_by_topic`); (3) look at the `cmd` and `fb` time-series SIDE-BY-SIDE — a mechanism that stalls fb while advancing cmd looks nothing like a mechanism that also flickers cmd. — add-41 §571
280. Invariants that MUST hold at the wire cannot be enforced only in upstream (Python) layers — schedule jitter will always find a way through. If a firmware constraint is real (CC10-A: |Δv/cycle| ≤ ~25 rad/s²), the CLAMP must live at the RT-side that actually writes to the wire. The pattern: track `prev_step = pos_cmd_sent - pos_cmd_prev_sent`; clamp `this_step = cmd - pos_cmd_sent` to `prev_step ± max_accel_step`; then `cmd = pos_cmd_sent + clamped_step`. Enforced in `write()` after any pre-existing `clamp_step`. Upstream jitter (msgs bunching into a single write() cycle) becomes irrelevant. Unit-testable standalone (no ROS lifecycle needed). Closes L271 as an RT-side invariant, not just an upstream request. — add-42 §577-§578
281. Adapter's commanded velocity MUST be capped below downstream plugin's slew ceiling to prevent the "arm-response-latency vs divergence-threshold" flicker class (L275). Rule: `target_vel ≤ 0.8 × plugin_max_slew_rate`. At `max_step_rad=0.005` @ 250 Hz plugin cycle, plugin ceiling = 1.25 rad/s and adapter cap = 1.0 rad/s. Source of `max_step_rad` MUST be shared (both plugin and adapter read from same `cri_tcp_setup.yaml` via `cri_config.load_cri_config()`) — no cross-repo constant drift. If a maintainer bumps `max_step_rad`, both track together on next launch. — add-43 §584
282. Guard-halt / keepalive-restart oscillation class closed by a "halted_hold_ids" blacklist: any halt path (divergence, silence, stop) appends `self.hold_id` before clearing it; the event dispatcher rejects any subsequent event carrying a blacklisted hold_id with READOPT-REJECT. Extends the phantom defense of L272 with a stricter rule: it's not enough for a refresh to have `no active session`; a START on a previously-halted hold_id must ALSO be rejected. Fresh operator press (new random hold_id from JogControls.jsx:91) starts cleanly. Ring-buffered at 256 to bound memory. — add-43 §585
283. A safety-net counter (like the RT-side accel clamp's engagement counter, L280) firing during a nominally-clean session is a CLASS diagnosis, not a functional failure. Distinguish: (a) "the pipeline is safe" — no arm alarm, no flicker, no tracking error — vs. (b) "the pipeline is RT-clean" — the safety net's counter is at 0. A Python-timer-based publisher on a non-RT Jetson can produce (a) via the RT-side backstop but structurally CANNOT produce (b) at any speed: p99 inter-msg dt of 18 ms + msg-bursts at <1 ms are load-bearing at 250 Hz. Choice class: accept the clamp as the safety net + redefine SLO to engagement-rate over time, OR escalate to a native RT jog path (WS `:9000` on this controller). Do not confuse "clamp counter > 0 in a clean run" with "the fix isn't working" — the fix IS what made the run clean. — add-44 §593
296. Streamed jog cannot beat a controller's own motion generator when the arm has meaningful dead time. Measured on the S10-140 real arm 2026-08-27: J6 has ~500 ms dead time before ANY measurable motion under CRI-UDP setpoint stream (bag `press_trace_bag4`, hids `5m0sbn6z1d`/`69lacogs6d`). At the velocity ceiling of 26.7 °/s (10° / 300 ms × 0.8), cmd advances 13.4 ° during that 500 ms — divergence guard fires at 10.03 ° into every press, settling then streams multi-joint pos slew, disturbs non-jogged joints (J3 saw −0.82 °), and `jointCollisionSensitivity=80` trips 2009. Class is architecturally unfixable in software: cmd cannot lead fb by more than the divergence budget, and the arm's actual dead time exceeds any latency assumption we can reason about. Verdict: retire streamed-jog as the operator surface; use WS `Robot/jog` (controller's own motion generator) for jog; keep the CRI streamed path for F2 program execution where the motion generator IS the controller-side interpreter. — add-45 §596
297. When two motion channels coexist (F1.0 hybrid: CRI stack + WS driver, F2 CRI programs + WS jog), mutual exclusion belongs at the dashboard server entry points, not the wire. Refuse jog when `STATE.robot.program.state ∈ {2, 3}`, refuse program-run when `_active_holds` is non-empty. Return 409 with `reason_code` + `operator_copy` so the frontend toast is clean. Release/stop bodies (`hold=False` / `stop=True`) must ALWAYS pass — otherwise a program transitioning into running mid-hold strands the hold, and the safety-net freshness deadman becomes the only fallback. Doctrine test with 12 cases pins D1–D6 + race sanity. Non-negotiable per operator directive; removing the gates requires providing equivalent motion-exclusion at another layer in the same commit. — add-45 §599
298. Estun controller error forensics have three closed channels, one open: `publish/RobotStatus` state / recoveryState / isMoving are ground truth for current state; `publish/Error` returns the current cache only (no history verb exposed on WS); dashboard-side journald sees browser SPA socket drops (code 1001) but NOT its own controller-side proxy failures if the controller stays TCP-reachable. The `:9198` controller web UI IS the log-history channel — but its SPA bundles the log-fetch endpoints in compiled JS behind unknown POST bodies; the enumerated client-side routes (`/cocontrol/robotopt/colog/`, etc.) are React-router paths, NOT HTTP endpoints. Programmatic forensics from Jetson hit a wall at that boundary. Rule: any wire-drop investigation must go through the browser :9198 log page (screenshot / paste, ordered by log-index because the controller clock jumps across events); do not spend cycles trying to reach that data from curl / websockets. — add-45 §601
299. Under WS-jog, display=wire is ALREADY true at the code level — the frontend `jogSpeedPct` store field flows unchanged to `/cmd/jog` body → dashboard `_publish_estun_jog` payload → driver `/robot/jog_command`. The addendum-40 §565 "slider 15% sends 22" class was a stale-tab persistence artifact of the retired streamed (`JOG_BACKEND=ros2`) era, NOT a live scaling bug. Fix isn't a code change — it's a doctrine test that PINS the invariant so no refactor reintroduces it. Five-case guard (T1–T5 in `test_jog_slider_wire_truth.py`): hold-branch is bit-identical (banned any arithmetic on `speed_pct` between body-read and payload-write), increment path doesn't smuggle speed via delta_deg, slider label uses `Math.round` + `step={1}`, release/stop payload contains no `speed_pct` key at all (kills the stale-tab leak class at the boundary), cartesian uses the same 1:1 mapping. — add-46 §603
300. Palletize defects sometimes look re-opened when they're actually IK-fixture failures. In `test_pallet_codegen.py`, 27 of 51 tests fail. c995e5d's DEFECT A (slot-1 stuck) + DEFECT B (double-descend at pick) pins ALL PASS (`test_slot_along_row_axis_steps_pitch_row`, `test_slot_along_col_axis_steps_pitch_col`, `test_pick_block_replay_repeats_pick_contact_reference`, `test_refuse_pallet_when_dims_missing`, `test_refuse_pallet_when_loop_count_exceeds_capacity`, `test_pick_sequence_single_descend_before_vacuum_on`, `test_no_pick_approach_lift_in_cycle`). The failures are the `holepartpalletize`-fixture-has-IK-unreachable-slots class — atomicity kicks in (`test_atomic_pallet_emit_on_ik_failure` PASSES, refuses partial emit), leaving emit-expecting tests to fail-empty. That's DESIGN. Rule for diagnose-first requests: check which tests PASS to prove the defect is fixed; don't get distracted by a wall of fixture-driven failures. — add-46 §605
301. F2 executor architecture: three gates + one skeleton, testable pure-logic. L222 (validator) — planner CLAMPS not REJECTS; executor OWNS pre-submit validation with margin below the URDF hard limit + joint-count + workspace-bounds coarse pre-IK check + composite-first-fail dispatch. L220 (settle) — action SUCCESS is not arrival; poll `/joint_states` for per-joint drift ≤ 5e-5 rad (4× encoder LSB) over a rolling 500 ms window, 15 s timeout; ring-buffered for bounded memory; three terminal states (settled / converging / timeout). Silent-refusal — after settle, verify observed vs planned_end within `arrival_tol_rad`; distinguish `fb_far_from_target_at_start` (arm didn't move, the exact signature) from `fb_far_from_target` (general miss). Executor node wires them together, publishes `program_state ∈ {2, 3}` on `/estun/program_status` so the dashboard arbiter (JOG-11) mirrors and blocks jog for the duration of a run. — add-46 §606

---

## Anomalies

**Duplicates:** 58 numbers have >1 occurrence in v46. Each addendum resets numbering.

- 1: 2 sites — era-01:L55, add-01:L9484
- 2: 2 sites — era-01:L70, add-01:L9512
- 3: 2 sites — era-01:L82, add-01:L9546
- 4: 2 sites — era-01:L131, add-01:L9560
- 5: 2 sites — era-01:L175, add-01:L9584
- 6: 2 sites — era-01:L206, add-01:L9591
- 7: 2 sites — era-01:L305, add-01:L9638
- 8: 2 sites — era-01:L376, add-01:L9644
- 9: 2 sites — era-01:L480, add-01:L9647
- 10: 2 sites — era-01:L552, add-01:L9650
- 11: 2 sites — era-01:L600, add-01:L9679
- 12: 2 sites — era-01:L644, add-01:L9685
- 13: 2 sites — era-01:L668, add-01:L9706
- 14: 2 sites — era-01:L695, add-02:L9725
- 15: 2 sites — era-01:L763, add-03:L9772
- 16: 2 sites — era-01:L820, add-03:L9793
- 17: 2 sites — era-01:L920, add-03:L9799
- 18: 2 sites — era-01:L976, add-03:L9816
- 19: 2 sites — era-01:L1025, add-03:L9848
- 20: 2 sites — era-01:L1110, add-03:L9854
- 21: 2 sites — era-01:L1217, add-03:L9864
- 22: 2 sites — era-01:L1291, add-03:L9870
- 23: 2 sites — era-01:L1318, add-03:L9873
- 24: 2 sites — era-01:L1394, add-03:L9876
- 25: 2 sites — era-01:L1434, add-03:L9884
- 26: 2 sites — era-01:L1488, add-03:L9887
- 27: 2 sites — era-01:L1521, add-03:L9903
- 28: 2 sites — era-01:L1581, add-04:L9922
- 29: 2 sites — era-01:L1630, add-04:L9931
- 30: 2 sites — era-01:L1737, add-04:L9958
- 31: 2 sites — era-01:L1815, add-04:L9962
- 32: 2 sites — era-01:L1865, add-04:L9966
- 33: 2 sites — era-01:L1958, add-04:L9971
- 35: 2 sites — era-01:L2046, add-04:L9979
- 36: 2 sites — era-01:L2345, add-04:L9983
- 37: 2 sites — era-01:L2635, add-04:L9993
- 38: 2 sites — era-01:L3056, add-04:L9996
- 39: 2 sites — era-01:L3377, add-04:L9999
- 40: 2 sites — era-01:L3786, add-04:L10018
- 41: 2 sites — era-01:L3888, add-04:L10037
- 42: 2 sites — era-01:L3906, add-05:L10056
- 43: 2 sites — era-01:L3961, add-05:L10059
- 44: 2 sites — era-01:L4461, add-05:L10067
- 70: 2 sites — add-07:L10322, add-09:L10747
- 71: 2 sites — add-07:L10345, add-09:L10764
- 72: 2 sites — add-07:L10368, add-09:L10785
- 73: 2 sites — add-07:L10390, add-09:L10793
- 78: 2 sites — add-08a:L10466, add-08b:L10622
- 79: 2 sites — add-08a:L10487, add-08b:L10634
- 80: 2 sites — add-08a:L10500, add-08b:L10645
- 81: 2 sites — add-08a:L10506, add-08b:L10649
- 82: 2 sites — add-08a:L10514, add-08b:L10661
- 83: 2 sites — add-08a:L10527, add-08b:L10672
- 84: 2 sites — add-08a:L10547, add-08b:L10698
- 85: 2 sites — add-08a:L10563, add-08b:L10711
- 86: 2 sites — add-08a:L10569, add-08b:L10720
- 87: 2 sites — add-08a:L10578, add-08b:L10731
- 88: 2 sites — add-08a:L10592, add-10:L10817

**Gaps** (numbers 1..304 absent from v46, 137 total). These likely lived in an earlier ledger file not archived to v46 — do NOT reuse until confirmed by the operator. (244–264 no longer gaps: assigned in addendum-36, addendum-37, and addendum-38.)

```
146 147 148 149 150 151 152 153 154 155 156 157 158 159 160 161 162 163 164 165 166 167 168 169 170 171 172 173 174 175 176 177 178 179 180 181 182 183 184 185 186 187 188 189 190 191 192 193 194 195 196 197 198 199 200 201 202 203 204 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 265 266 267 268 269 270 271 272 273 274 275 276 277 278 279 280 281 282 283 284 285 286 287 288 289 290 291 292 293 294 295
```
