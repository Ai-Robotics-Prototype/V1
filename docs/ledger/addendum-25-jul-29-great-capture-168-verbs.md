---
ledger_split: addendum-25
source: cobot_project_conversation_v46.md
source_lines: 12655-12777 (inclusive)
title: The great capture session (168 verbs), config sweep
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 25 — July 29, 2026 — THE GREAT CAPTURE SESSION (168 VERBS), THE CONFIG SWEEP THAT FOUND EVERYTHING ZEROED, THE MOTION INTEGRATION BUILT AND DEPLOYED, CONTINUOUS JOG SHIPPED, AND THE DAY THE INVESTOR MEETING SET THE RISK BAR
*(Appended in full. Nothing above this line was removed. One very long day: the factory-UI archaeology reached its endpoint — the complete Lua vocabulary with units, extracted and committed — the Config sweep set the payload the controller never had, the full motion-parameter integration was built behind its deploy gate and then deployed, the teach drawer got honest feedback and hold-to-move jogging, and a stack of PBD designs (sameness, routines, pallet grids, waypoints) was authored while an investor meeting enforced the discipline of not shipping motion changes on demo day.)*

### Section 422: The blend capture — Move Params harvested with units

The morning's question — "what motion do we need to capture from the factory UI?" — got its honest answer: *the J4/J2 fix needed nothing* (movL was already wire-verified; the wrist re-teach is a tablet action). What remained gated was the **Smooth profile**, and the capture session that followed harvested the entire Move Params family from the palette doc panels, units and all:

| Verb | Meaning | Units |
|---|---|---|
| setBlender(b) | default transition radius (modal) | mm |
| setNoBlender() | blend off — exact stops | (bare — see §425) |
| setSpeedJ(v) | default joint speed | deg/s |
| setSpeedL(v) | default linear speed | mm/s |
| setAccJ(a) | default joint acceleration | deg/s² |
| setAccL(a) | default linear acceleration | mm/s² |

All modal defaults. The Move family was enumerated (movJ, movL, movC, movCircle, movAS, movAST, movLW, movCW, movTraj — arcs and trajectory primitives flagged for future capture), **ModbusRTU discovered fully documented** (readCoils signature captured: interface enum {0: flange, 1: cabinet} — smart end-effectors can hang off the tool port), and the Logic category confirmed as vanilla Lua control flow (if/elseif/else/for/while/goto/label/equal/break/return — no sleep, no delay verb visible).

### Section 423: The roboaihome scare — and the fossil that ate the palette

Mid-capture, the palette's Insert buttons wrote test verbs **into roboaihome itself** (the editor had it open) — `setBlender(0)` and a stray `setNoBlender()` landed inline. Recovery discipline held: **never saved** (later proven — §425), undo overshot (deleted the movJ line), redo/reload restored function-equivalence, and the standing doctrine was restated: *the controller-resident Lua is cattle, not a pet* — our program store owns the source of truth; the hash guard reprints the file on next Run. Separately, the **new_program_2 fossil** (the slug-era orphan from the delete-404 saga, July 20 timestamps, "skipped move_home: no taught_joints (got NoneType)" comment) turned out to be where the session's actual saves landed — it now contains the full palette-insertion test, which accidentally became the best syntax capture of the day. Added to the delete-reconcile scope: the orphan exists controller-side too.

### Section 424: Strategy under a deadline — the investor-meeting risk bar

With the investor meeting hours away, the "implement now?" question got the CTO answer: **no.** The risk inventory, itemized for the record: the July 22 Lua-crash class (blend + degenerate segments — and linked positions create zero-length segments by construction), modal-state sequencing bugs (a missed setNoBlender = blended contact), the speed-unit remap as a global behavior change, first-execution risk on doc-captured verbs (two firmware bugs found that way before), §408-fresh deployment staleness, and zero rollback margin at 2pm. Against: a cosmetic transit hump investors wouldn't register. Verdict: demo the proven build, say "motion-profile system ships this week" as the roadmap beat, implement after. Related calibrations delivered the same hour: the capture improves PBD's *expression*, not its *comprehension* (understanding improvements ride §415 + the flywheel); palletizing is *structurally composable today* (single-layer unrolled), demonstrated-palletizing is two authored prompts away, multi-layer is a hardening sprint with a possible vendor shortcut (the native pallet engine — doc-captured, unexercised).

### Section 425: The HAR verdict — 168 functions, §342 overturned, the fossil's gift

The exported 26.7MB with-content HAR was analyzed in-conversation. Findings, in order of importance:
1. **roboaihome: ZERO update requests in the entire session** — never saved; the scare was formally a non-event.
2. **§342 CLOSES, overturned: `waitCondition(condition, timeout)` and `systemTime()` EXIST.** The old audit's candidate list missed them. Timed waits are natively expressible; verify_input's DI check is a one-liner (`waitCondition(getDI(n)==1, 2000)`).
3. **setNoBlender() is BARE** — the save bodies (their generator's own emission) are authoritative over the doc-panel's `(0)` ambiguity.
4. **The complete 168-function library extracted** from luaenginelib.json. New discoveries beyond the Move Params six: `setPayload("")` (string arg — a stop-condition until the format is known), `setCollisionDetectionSensitivity`, `setMoveRate` (suspected mid-run speed-slider mechanism), `getJointTorque`/`getJointExternalTorque` (motor-current force estimates — future contact detection), the full relative-move family (movJ/movL × Coor/Tool/JointRel), **pallet verbs** (createTray, getTrayPos, setLeftPallet/Right, palletizerRun), conveyor tracking (setConveyorTarget, waitConveyorObj, syncConveyorL), a welding suite, sockets/RS485/Modbus/registers, popUp, callModule, repeat/until, ByteWrapper.
5. The saves went to new_program_2 — whose accidental palette dump provided **verbatim insertion forms for every verb**.

The "what does this buy us" translation was recorded: this week (motion quality — the filmed defects' fixes), next two weeks (WAIT un-skipped, verify_input's engine, scriptable payload), this quarter (palletizing primitives, Modbus machine-tending, torque-based contact sense, conveyor tracking) — and strategically, **the driver-library moat is now 168 documented functions deep**, the pitch claim made concrete.

### Section 426: The motion doctrine + the consolidated integration prompt

The operator stated the policy directly: *TCP holds constant orientation through approach and descend (cartesian moves); station-to-station transits can be joint moves; the TCP must arrive at every taught pose in its taught orientation.* Recognized as the classical industrial doctrine independently derived, it became the **"standard" profile**: movL columns at stations, seeded-movJ transits, the boundary pose (approach-above) owned by the column, an orientation-invariant check (FK-of-solved-joints within 1° of taught, stamped in Lua comments), and the >20° transit wrist-delta display warning. The **final consolidated integration prompt** was assembled: verb reference from the HAR, the wait() resolution gate (whitebowlpickplace's `wait(500)` is not in the library — replace with the waitCondition idiom unless luabase proves otherwise), speed-model remap to captured absolutes, four profiles (joint default + grandfather rule; standard becomes the default for NEW programs post-validation), short-segment/zero-length blend guards, gentle descents (setAccL, off by default), setPayload behind its stop-condition, and the section-7 validation ladder (pinned tests → four-profile Lua comparison → hash-verified service deploy → 10% operator first-run sheet). UI surface confirmed minimal: one profile dropdown, one gentleness setting, passive validation notes — teach/review/library untouched.

### Section 427: The Config sweep — everything was zeroed, and the pages that talk back

The factory-UI Config tiles were swept (with a repeated safety nag: the arm was Enabled/Auto/90% throughout — flip to Manual for browsing):
- **Tool page: ALL ZEROS.** Tool 0 TCP bias 0/0/0; Payload 0 **Mass 0 kg**, CoG 0/0/0 — the controller had believed the flange bare for the entire project (explaining the drag button's inertness and degraded native collision detection). **Payload SET: Mass 1.2 kg + CoG estimate (x≈5, y≈10, z≈100mm — CAD refinement later); TCP deliberately LEFT at zero** (our architecture owns kinematics; the controller's TCP doesn't participate; changing a validated known state buys nothing).
- **robotLimit:** cartAutoMaxVel **2600 mm/s** (the speed-mapping anchor; product ceiling configured at 1500), manualCartOverSpeed 250 (explains slow manual jogs forever), payloadVerificationLevel **Off** (leave off until setPayload is wire-tested), dragThresholdCoeff Medium + Drag Sensitivity 50 (**drag is configured** — with payload now set, every documented precondition is satisfied), jointCollisionSensitivity 80, RunTo/Jog 30 deg/s / 250 mm/s.
- **speedLimit:** joint maxima **[150,150,150,180,180,180] deg/s**, overspeed monitoring on — the per-joint array for the mapping.
- **terminalLimitBit:** a cartesian workspace fence EXISTS (±1000 X/Y, −1000/+2500 Z) but is **DISABLED** — the controller enforces no spatial box; our guard stack has been the only fence. Recorded for the cell-commissioning checklist as a deliberate future step, not enabled today.
- **Parameter Identification:** the controller can **self-measure payload** (J3=90/J5=90 identification pose) — queued for the bench alongside the drag test; better-than-CAD CoG for free.
- **Communication → ModbusTCP:** a network-Modbus device registry (Add Device) + Register tab — machine-tending over Ethernet with zero wiring; reference gold, nothing to configure.
- **Pos page: ⚠️ long-press MOVES THE ROBOT** to canonical poses (Zero / Safe / Candle / **Packing** — the transport fold for the next move, noted). Backed out untouched; rangeLimit screenshot remains the one un-captured page.

### Section 428: The integration built — deploy gate respected, premise audited

Claude Code's implementation report: DEFAULT_MOTION_CONFIG (per-joint dps array, 1500 mm/s linear), _classify_standard_columns, orientation-invariant stamping, path-feasibility sampling, the wait→**waitCondition(false, ms)** replacement (retracting wait's prior alarm-inferred verification), 12 new standard-profile tests + speed-constant updates, the verb reference regenerated (**13 wire-verified rows**), four-profile side-by-side generated, the operator first-run sheet written (opening line: set 10%), and — correctly — **the deploy gate NOT crossed** (program_ops.py sha256 48ff6c60… recorded as the fingerprint). Its transparency section flagged that the on-Jetson HAR showed **zero save-body callsites** for the blend verbs — the task's "authoritative save bodies" claim couldn't be independently confirmed. Root cause: the with-content HAR lived on the laptop; the Jetson's copy was body-less. **Fix: scp'd the 26MB HAR across** (data/estun_captures/localhost_full_20260729.har), directed the provenance re-audit + gate crossing (service restart, served-hash verification, bowl regeneration via the service API per §408).

### Section 429: PBD sameness — decide, label, never ask

Two-iteration design session. First: spoken sameness ("the pick is the same spot each time") → `location_ref` identity keys → one program position, auto-linked, taught once — with a clarification for ambiguity. The operator then sharpened the requirement: **no user choice — the system determines linkage from video + speech and labels accordingly.** Redesign: dual-evidence fusion (speech sameness/difference language + **frame-region extraction** — the understanding stage reports where in the image each pick/place event terminated), a deterministic ordered fusion rule (explicit speech always wins; video corroborates; low-confidence renders as a passive "linked — verify" chip, never a blocking question), human-readable location labels from speech context ("Tray pick"), review shows the 🔗N badges with one-tap unlink-as-correction (which is itself a learning-record signal). Design principle recorded: *the system decides, shows its work, and stays correctable; it never delegates its job back as a question.* The prompt ran in Claude Code — hit the session rate limit mid-composer-task, resumed cleanly (5 of 8 tasks done at last report: schema, fusion module, prompt updates, labels in flight). The frame-region channel noted honestly as the newest untested muscle — speech carries decisions alone if video starts noisy. Bonus finding from its survey: the bowl demo's stored intent shows `matched_part_id: null, confidence 0.0` — the recognition gap sitting in the training data, the cloud pilot's case in miniature.

### Section 430: Routines, blow-off, and the continuous-jog saga

- **Repeated-routine condensation** (operator: "multiple same routines should condense into a loop"): designed as *representation-level grouping* — consecutive operation subsequences with identical structure + matching location_ref patterns collapse into `Routine ×N` (review/editor render collapsed; editing edits all iterations) — **while codegen continues to unroll** (byte-diff-identical Lua; true loop emission with pose variables deferred as unexercised wire territory). Queued behind sameness.
- **Blow-off as a review clarification** (operator requirement: answered No = zero blow-off steps in the persisted program): prompt authored completing §399 — a standard clarification card for vacuum demos, default No from cell config, both variants pinned on the SAVED artifact.
- **The continuous-jog saga:** first misread as teach-flow auto-advance (corrected: *jogging* — hold-to-move), prompt written with the dead-man design (every release path stops; server-side keepalive timeout as the backstop)… and then **not run** while the sameness session held the queue — producing the operator's justified "there is STILL no continuous button" ×3. Accountability recorded: prompts don't execute themselves; **operator-blocking pain beats architecture** is now a standing queue rule, and QUEUED-not-yet-run gets flagged explicitly. Mid-frustration the report escalated: **the step buttons don't work either** — the prompt was recut as diagnose-dead-buttons-first + continuous mode in one pass.

### Section 431: Continuous jog SHIPPED — and the buttons were never broken

The combined prompt ran and deployed (hash-verified). The diagnosis was the valuable part: **break point (e) — none of the above.** Every layer worked: handlers wired, correct increments emitted, movJCoorRel/movJJointRel on the wire. What was broken was the *feedback contract*: gate rejections were **silent**, buttons gave no motion acknowledgment, and 1mm increments under the ACK-starved state channel's churn made a working tap and a dead tap visually identical. The operator's "broken" report was the only reasonable reading of a UI that did things invisibly. Shipped: **toasts on every gate rejection** (the silent-rejection class is dead), **Continuous (hold-to-move) as the default jog mode** with the full dead-man stack (pointerup/leave/cancel/blur/hidden-tab/WS-drop all stop; 200ms keepalive timeout server-side; pointer capture; long-press menu suppression), Step mode preserved with now-verified exact increments, the drawer-height debug overlay removed. Operator acceptance list: hold→sustained, release/slide-off→stop, the deliberate killed-tab dead-man test, 1mm→1.0mm on the readout. Lesson attached: this incident is the strongest case yet for the **ACK-channel repair** — honest state streaming would have made the 1mm moves visible and the "broken" report impossible.

### Section 432: Pallet grids, the column invariant, and transit waypoints (prompts authored)

- **Palletizing step** (operator: teach the first corner, the rest is offsets): `pallet_place` pattern — ONE taught anchor (real contact, real compression), rows/cols/pitches/axes/order (snake default), layers in the schema defaulting to 1; every slot derived via seeded IK from the anchor, orientation identical; **ghost markers in the 3D twin** render all slot targets pre-run (the two-second catch for flipped axes/doubled pitches); per-slot reachability validation with named refusals; teach flow counts ONE position for the whole pallet.
- **Columns always cartesian** (operator: "cartesian for ALL approach/descend/ascend" — not just the standard profile): the column classification becomes an **invariant across every profile**; profiles govern transits only. Deliberate, visible grandfather override: existing programs' columns change on next regeneration, byte-diff reported program-by-program, transits untouched, ladder-validated. Interim zero-code action: flip the bowl program to Standard in the editor today.
- **Transit waypoints** (operator: user-added obstacle-avoidance points between teaching steps, with purpose labels and an easy smoothness control *with a graphic*): waypoints as full §397 positions on transit segments only (columns stay waypoint-free by construction); a one-tap-skippable interstitial in the teach flow after each recorded position ("Add a waypoint on the path to X?"); the record card asks *what it's for* (chips: Clear obstacle / Go around fixture / Stay high — operator-stated path intent becomes planner training data) and offers **four mini-diagrams** for smoothness (exact/tight/medium/wide — the same corner drawn with progressively wider arcs, one plain-language caption) with the **3D twin live-previewing the actual arc** through the actual waypoint; chained seeded IK, per-waypoint blend mapping, exact→setNoBlender(); a waypoint landing inside a column's footprint gets a validation note.

### Section 433: Two Claude Code sessions — the worktree answer

Operator asked about parallel sessions writing to the Jetson. Answer recorded: supported and sanctioned, but **never two writers in one checkout** (file collisions on program_ops.py, shared git state, test/build races — a §408-class staleness factory). The safe pattern: **git worktrees** — one branch per session, separate directories, merges explicit — with the hard rule that **exactly one session (or the operator) ever touches live services/deploys**; the robot is a singleton even when the codebase isn't. Practical guidance: the current motion/PBD queue is sequential by nature (sameness → column invariant → waypoints share the composer spine); the genuinely parallel second lanes are the **cloud pilot bundle** and the **hiring-prep work** (zero overlap with the robot stack). Rate limits are shared. This is the preview of the hiring plan's branch-per-engineer discipline.

### Section 434: Status ledger (July 29, end of day)

| Item | Status |
|---|---|
| Move Params six + units | CAPTURED (doc panels + save bodies) |
| 168-function Lua library | EXTRACTED from HAR; reference committed (13 wire-verified) |
| waitCondition/systemTime (§342) | OVERTURNED-CLOSED — verbs exist; wait(500) replaced with waitCondition idiom |
| Motion integration (profiles, speed remap, guards) | BUILT + tests green; deploy directed after HAR re-audit — **confirm served hash before the ladder** |
| 10% validation ladder (bowl, standard) | NEXT BENCH SESSION — the week's proof run; film it |
| Payload preset | SET (1.2kg + CoG estimate); Parameter Identification queued for measured values |
| Drag button | ALL preconditions now satisfied — one press at the bench decides |
| Cartesian fence (terminalLimitBit) | EXISTS, DISABLED — commissioning-checklist item, not today |
| Continuous jog + honest gate toasts | **SHIPPED + DEPLOYED**; operator acceptance pass pending |
| Sameness/location_ref | IN FLIGHT (5/8 tasks at last report) |
| Blow-off clarification card | PROMPT AUTHORED |
| Column invariant (cartesian columns everywhere) | PROMPT AUTHORED; bowl→Standard flip = today's zero-code interim |
| Pallet grid step | PROMPT AUTHORED |
| Transit waypoints + smoothness graphics | PROMPT AUTHORED |
| Routine condensation | DESIGNED, queued behind sameness |
| new_program_2 fossil (now with palette junk) | delete-reconcile scope updated |
| rangeLimit screenshot (§137 closure) | still owed — one page |
| pause/resume + setMoveRate + healthy-stop captures | ride the bench session's running programs |
| /opt/cobot backup | **STILL OPEN — most overdue item on the board** |
| Investor meeting | held today on the proven build; "ships this week" said honestly — the ladder redeems it |

## PROCESS LESSONS (149–156)

149. **Insertion forms beat doc panels; save bodies beat both.** The palette's Insert writes the generator's own syntax; the HTTP save bodies carry it verbatim. Doc panels showed setNoBlender(0); the save body's bare setNoBlender() was the truth. Capture hierarchy: save body > insertion form > doc panel > manual.
150. **A HAR without content is a map without terrain.** The Jetson's body-less HAR made an honest auditor report "no evidence" for claims that were true — the 26MB with-content export on the laptop had everything. Transfer the artifact, not the memory of it; "Save all as HAR with content" and verify the size.
151. **Config pages can move robots.** The Pos tile's long-press drives the arm to canonical poses — discovered while browsing Enabled/Auto/90%. Factory-UI browsing happens in Manual (or disabled), always; a settings tour is not exempt from motion discipline.
152. **The controller believed the flange was bare for three months.** Payload 0kg, TCP zeros, fence disabled, verification off — every native protection was running on defaults nobody had set. A commissioning checklist that ends at "our software works" has not finished commissioning the controller under it.
153. **Silent rejection manufactures "broken."** The step buttons worked perfectly and were reported dead — because gates rejected quietly, motion was sub-perceptual, and the state channel flickered. Anything that declines an operator's command must say so where they're looking; toasts are cheaper than the debugging session their absence causes.
154. **Prompts don't run themselves.** A written fix sat unexecuted while its author discussed architecture, and the operator asked three times for a feature that existed only as text. Standing rules: operator-blocking pain beats architecture in the queue, and anything authored-but-not-run is flagged QUEUED explicitly.
155. **Deliberate-and-visible may override grandfather.** The columns-always-cartesian change intentionally alters every existing program's motion — acceptable precisely because it is operator-directed, reported program-by-program, and ladder-validated. The grandfather rule guards against *silent* change, not against *chosen* change.
156. **One repo, one writer; one robot, one deployer.** Parallel Claude Code sessions are worktrees on branches, never two writers in a checkout — and the live services belong to exactly one hand regardless of how many sessions build and test.

---

*Summary of Addendum 25: the archaeology ended and the building resumed. One capture session harvested the controller's complete vocabulary — six motion-parameter verbs with vendor-documented units, the Move family, ModbusRTU, and then, from the with-content HAR, all 168 functions including the waitCondition that overturns §342, the pallet engine, torque reads, and a setMoveRate that probably explains the speed slider — while the roboaihome scare resolved into proof that the cattle-not-pets doctrine holds (zero saves, hash guard ready to reprint). The Config sweep found the controller running bare — payload zero, TCP zero, fence off — and left it with a real payload, a documented limits table (150/150/150/180/180/180, 2600mm/s), a self-measurement routine queued, and a warning about the page that moves robots on long-press. The full motion integration was built behind its deploy gate with an honest premise audit (the body-less HAR), unblocked by one scp, and directed through the gate; the investor meeting enforced the discipline of demoing the proven build and saying "ships this week" instead of shipping at noon. The teach drawer's dead buttons turned out to be working buttons wrapped in silence — fixed with toasts and hold-to-move jogging with a proper dead-man, deployed same day after the operator's justified escalation taught the queue its new rule: blocking pain first, and QUEUED means not-yet-real. Around it all, the PBD roadmap thickened: automatic sameness from speech+video fusion in flight, routines, pallet grids from one taught corner with ghost-marker previews, transit waypoints with purpose labels and corner-cutting diagrams, and the columns-always-cartesian invariant that makes the operator's motion doctrine law across every profile. Eight lessons, one 26-megabyte artifact, and a bench session tomorrow where the whole week either proves out at 10% speed or teaches the next one.*

*Last updated: July 29, 2026 (Addendum 25 — Sections 422–434, Lessons 149–156)*
---

<!-- v46-content-end -->
