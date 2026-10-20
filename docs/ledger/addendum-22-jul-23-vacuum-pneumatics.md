---
ledger_split: addendum-22
source: cobot_project_conversation_v46.md
source_lines: 12197-12350 (inclusive)
title: Vacuum pneumatics commissioning, PBD review fixes
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM 22 — July 23, 2026 — VACUUM PNEUMATICS COMMISSIONING (CLICK ≠ SHIFT), RELAY SELECTION, I/O NAMING UNIFICATION, PBD REVIEW FIXES (ANSWERED-STATE BUG, DETECT-STEP INVESTIGATION, TEACH-CONTACT-POSES RESTRUCTURE), EYE-IN-HAND D435i PLAN, PROGRAM TAB SIMPLIFICATION
*(Appended in full. Nothing above this line was removed. This session continued the vacuum end-effector commissioning begun in Addendum 21 and opened a PBD-review improvement arc from the operator's first full video-demonstration walkthrough. Four Claude Code prompts were authored this session — all PENDING run/confirm. Hardware diagnosis of the valve is IN PROGRESS.)*

### Section 373: DO wiring review — 5.2.7 internal supply confirmed as the wiring pattern

Reviewed hardware manual 5.2.7 (Digital Output Wiring with Internal Power Supply, Figure 5-20) against the relay plan:
- Relay coil pattern: DO pin → relay coil → back to 0V/GND on the PWR CFG block, internal 24V supplying through the fuse. **Fuse stays IN for internal supply** (removed only for external supply per 5.2.6).
- Figure's two relay examples wire off DO-A (DO0–7, paired 0V) and DO-B (DO8–15, paired 24V) — consistent with the silkscreen sink/source split (§340).
- Table limits re-confirmed: typical 24V / max 30V, **125mA per channel, PNP source**.
- Inductive loads (relay coils, solenoids) get a flyback diode across the coil to protect the output stage.

### Section 374: Vacuum valve wiring plan — full sequence (relay path)

The settled wiring for the Tailonz 4V210-08 (3.0W 24VDC coil = 125mA, exactly at the DO channel limit — relay mandatory per Lesson 122):

**Step 0 — DO health check before wiring:** solenoid disconnected, force the DO on (factory UI, Manual, lock slider unlocked), meter DO ↔ adjacent 0V. 24V = output stage healthy; 0V = check the PWR-CFG fuse first (a blown internal-supply fuse kills every DO while all screens report success).

**Relay input side:** DO → relay coil A1 (+) (DOs are PNP/sourcing — the DO provides +24V); coil A2 (−) → the 0V paired with the DO block. Bare mechanical relay → 1N4007 across the coil (stripe to A1); relay *modules* usually have the diode built in — verify before doubling up. Typical coil draw 15–30mA, comfortable margin.

**Relay output side:** 24V from power strip / PWR CFG → relay COM; NO contact → solenoid coil terminal **1**; terminal **2** → 0V. The third pin (⏚) is the DIN 43650 **ground pin — coil is strictly 1↔2**. A wire landed on ⏚ instead of 2 reproduces exactly the "controller says on, no click" symptom (§365 carry-over). Second 1N4007 across solenoid 1↔2 (stripe toward 1) as contact-arc insurance.

**Wire/ferrules (carried from §346/Lesson 123):** 24 AWG stranded minimum (28 AWG is below the Degson block's 0.2mm² floor), 0.25mm² DIN 46228 ferrules, 8mm pins, no collar, press the orange actuator while inserting.

### Section 375: Direct-drive question — the honest margin analysis

Operator asked whether the cabinet could switch the valve directly (125mA load on a 125mA channel). Honest answer recorded: **probably yes on day one — but it's a margin call, not a capability question.**
- The 3W figure is nominal at warm coil temperature; a **cold coil draws 10–15% more** (copper resistance drops when cold), transiently ~140mA on a 125mA channel at every cycle start.
- Inductive turn-off transient: whether the CC10-A output stage has internal clamp diodes is **unverified** — and per the capture-first ethos, unverified protection is no protection. Unclamped spikes are the classic PNP-output killer.
- The asymmetry: relay ≈ $13; a cooked DO channel is permanent, non-user-replaceable, inside the dev unit / Jade pilot / investor demo cabinet — and §364's unresolved "DO set with no click" episode already occupies that diagnostic space.
- **Defensible temporary path** (bench-validation only, before the relay arrives): direct drive WITH the 1N4007 across the coil, logged as temporary, retired when the relay lands. The one forbidden configuration: direct drive with no diode.

### Section 376: Relay selection — spec + Amazon shortlist

**Spec:** 24VDC coil at well under 125mA draw (any interface relay passes at 8–30mA); contacts rated for **DC** (30/28VDC listing, not just 250VAC — DC inductive loads arc harder); SPST-NO or SPDT; flyback diode on the relay's own coil (built into most modules).

**Routes:** (1) slim DIN-rail interface relay — production-grade, tidy in the cabinet (Phoenix PLC-RSC-24DC/21, Omron G2RV, Finder 39-series class); (2) hobby relay module board — works but must be the **24V-trigger** variant, and set to **high-level trigger** so the SetDO polarity test isn't inverted; (3) 24V-trigger MOSFET module — no contacts to arc, no isolation (moot in a single 24V domain).

**Amazon shortlist (searched live):**
- **Electronics-Salon PA1a-24V** — slim DIN-rail SPST-NO 5A, original Panasonic PA1a on a pluggable socket, 26–12 AWG terminals. Best single-channel.
- **Electronics-Salon SPST-NO multi-channel family** — 24V version, Panasonic relays, **freewheeling diode per coil built in**, per-channel LED, explicit DC-common-negative support for PNP/source controllers (exactly the CC10-A's DOs). **Recommended: the 4-channel** — covers vacuum (DO2), blow-off (DO3), two spares, one DIN block.
- **GAEYAELE 2-channel AC/DC 24V** (~$13.60) — cheaper, does the job.
- **HF41F/24-ZS slim 6mm relays** + socket base — tidiest industrial look, self-assembled.
- **Skip:** generic optocoupler hobby boards (often active-LOW, loose PCBs in an investor-visible cabinet).
- **Next-day constraint:** use Amazon's "Get It by Tomorrow" filter — delivery depends on warehouse stock, not the listing. Checks before ordering: 24V selected in the variant dropdown (most common mis-order), DC contact rating present, 2+ channels preferred. Fallback that's stocked everywhere: AEDIKO/HiLetgo 24V 1-channel board, high-level trigger, temporary. **Add 1N4007 diode pack to the same order.**

### Section 377: CLICK ≠ SHIFT — the pneumatic diagnosis (the session's hardware headline)

Symptom: solenoid audibly clicks; valve does not actuate. Root insight: **the click is only the pilot armature moving.** The 4V210-08 is **internally pilot-operated** — it steals air from P to throw the spool. **No air at P (or below ~0.15 MPa pilot minimum) = the coil clicks forever and the valve never shifts.**

**The one-press diagnostic: the manual override button** (recessed, on the valve body near the pilot). With air connected, press with a small screwdriver:
- Override shifts the valve → pneumatics fine, problem is the pilot solenoid (loose coil retaining nut / DIN connector nut — a loose coil clicks but doesn't couple; or sagging 24V under load).
- Override doesn't shift either → pneumatic: (1) supply pressure/porting at P (P is the middle port of the 5-port face); (2) **blocked exhausts** — solid plugs in R/S hydraulically lock the spool (it must displace air to move); (3) judging actuation at the wrong point — with A dead-headed into a closed circuit, flow is subtle; test open-air at port 4; (4) a detent/turn-to-lock override left in the locked position mechanically holds the spool.

**Status: IN PROGRESS** — awaiting confirmation of supply pressure at P and override test result.

### Section 378: Full pneumatic chain — what the valve alone doesn't provide

The 4V210-08 switches compressed air; **it does not make vacuum.** Complete chain for the suction gripper:
1. **Compressor** — valve wants 0.15–0.8 MPa; venturi wants 0.4–0.6 MPa for good vacuum. Set regulator ≈ 0.5 MPa.
2. **FRL/regulator + filter** between compressor and valve.
3. **Venturi ejector / vacuum generator** — the missing piece class: valve A port → venturi inlet → suction cup on the venturi vacuum port. Energize DO → air flows → venturi pulls vacuum. (Electric vacuum pump is the alternative, but then an internally piloted valve is the wrong valve — externally piloted or direct-acting needed.)
4. **Tubing/fittings** — 6mm OD PU tube, 1/4"-thread-to-6mm push-connect on P and A, **mufflers on exhausts**.

### Section 379: Port map and plumbing decisions (B plugged, R/S muffled)

Letter↔ISO map on the 4V210-08 body: **P=1** supply in; **A=4** work port (pressurized when energized → venturi/vacuum line); **B=2** work port (pressurized when de-energized); **R=5** exhaust for the A side; **S=3** exhaust for the B side. Each work port vents through its exhaust when losing pressure; **the spool physically cannot shift unless the losing side can exhaust.**

Decisions:
- **B (2): PLUG.** Open B dumps the entire supply to atmosphere whenever the coil is off. The "B as blow-off" idea was explicitly rejected: it would blast continuously whenever vacuum is off, whereas blow-off is a commanded pulse — already its own verb on DO3 (`setDO(3,1)` → pause → `setDO(3,0)`) and therefore **a second small valve** (3/2 or another 4V210 on its own DO), not the B port.
- **R (5) and S (3): MUFFLERS, NEVER PLUGS.** 1/4" sintered-bronze silencers — quiet the hiss-bang to a puff, keep dust out, and preserve the venting the spool needs. Plugged exhausts reproduce the click-no-shift symptom exactly.
- Shopping list: one 1/4" plug (port 2), two 1/4" mufflers (ports 3, 5), venturi on port 4.

### Section 380: I/O naming unification — step editor must speak DO0/DO1 (prompt authored, PENDING)

Operator requirement: the IO step edit field must match the main I/O page naming (DO0, DO1, …). Root seam identified: the step editor's dropdowns still populate from legacy `/api/io/config` with mock-era X0.0/Y0.0 labels (§81), while the main page renders the hardware-exact `/api/io/portmap` (§343) persisting labels to `io_map.json` — two sources of truth, and only one matches the silkscreen and `setDO(n, x)`.

Prompt authored (PENDING run): portmap becomes the single source; dropdowns show "DO2 — Vacuum" (canonical name + user label); options filtered by direction per step type (set_io→DO/AO, wait_input→DI, gripper confirm→DI); system-reserved (modeSwitch@16, enableButton@17, flangeButtons) and safety-domain terminals **excluded** from selection (same display-and-respect treatment as the main page — flagged as a reversible decision if greyed-out-visible is preferred); steps store canonical `{io_type, port}`; read-time migration mapper Y0.n→DOn / X0.n→DIn **with a stop-and-report check against a real saved program before applying**; codegen reads canonical fields directly, translation tables removed; StepPreviewPanel format matched; verify by regenerating the test wizard's Lua and diffing for identity.

### Section 381: PBD review-screen fixes — four items from the first full demo walkthrough (prompt authored, PENDING)

Operator ran a real video demonstration (black bracket) end-to-end and reviewed the draft. Objects/locations/operations sections judged good. Four fixes:

1. **The answered-state bug (the important one).** Selecting the *suggested* option ("use a fixed top position") leaves the clarification chip on "suggested"; selecting the non-default ("detect the black bracket with vision each cycle") flips to "answered." Root-cause hypothesis (to be confirmed in code): answered state derived from *value ≠ suggested default* instead of from an explicit interaction event — so confirming the default compares equal and registers as unanswered. Fix: answered = operator explicitly interacted, regardless of value; both paths write through to the draft identically; learning store records `{answered, chose_suggested, value}` per clarification — **confirming the default is a distinct, valuable training signal** from changing it (additive schema only). Accept-with-defaults behavior unchanged.
2. **Spatial summary copy consistency** — regenerate with the app's own vocabulary: parts-library names verbatim, program-editor location terms (approach/pick/place/retreat), StepPreviewPanel units/format. No new synonyms.
3. **Remove the "informed by past demos" indicator** from the review UI — the retrieval mechanism and its provenance logging stay; only the user-facing text goes.
4. **Shorter generated program names** — max 4 words / ~30 chars, "<Part> <Operation>" pattern, detail into description, hard truncation fallback in the composer.

### Section 382: Detect step present despite "fixed position" — investigation prompt (authored, PENDING; diagnose-first)

Second finding from the same demo: the operator selected "fixed position" in clarifications, yet the draft contains a detect step. Explicitly framed as diagnose-before-fix with three candidate root causes:
- **(a)** The answer never applied — same answered-state bug (§381.1): a suggested-equal selection never registered, so the draft-update path never fired and the chip was truthfully describing the draft's state.
- **(b)** The answer applied but only wrote config (e.g. `part_source`) without restructuring steps — nothing removes the detect step.
- **(c)** The answer applied correctly but the composer emits detect unconditionally in the pick/place template.

Prompt requires: read the stored draft + clarification record from `/opt/cobot/demonstrations/`, trace the answer-application path, identify which of a/b/c with actual code lines **before** any fix. Fix per cause; either way the end state is **answers restructure the draft** (fixed → detect removed, pick bound to taught pose; vision → detect present bound to target_part_id), composer's detect conditional on part-source config, and flipping the answer restructures cleanly in both directions repeatedly. Flywheel note: fixed properly, future demos capture the clean structured signal ("answered fixed-position") instead of a raw "operator deleted detect step" diff.

### Section 383: Teach contact poses, derive approach poses — pick/place restructure (prompt authored, PENDING)

Operator: the draft asks to teach "move above pick/place position" — wrong targets. **The contact poses (pick, place) are the precision-critical ones; "above" poses are Z-offsets that should be DERIVED, never taught.** Teaching approach and implying contact bakes operator error into the pose that matters and doubles the teach workload (4 taught where 2 suffice). Converges with the §350 derived-pose-resolver item (resolver itself since completed in Addendum 21; this restructures what the composer/wizard emit).

Target model: **taught (2)** = pick, place (operator jogs to part contact). **Derived (4)** = above-pick, retreat-from-pick, above-place, retreat-from-place = taught pose + `approach_height` on Z at codegen. Sequence: above-pick(d) → pick(t) → vacuum on → dwell → retreat(d) → above-place(d) → place(t) → vacuum off + blow-off → retreat(d) → home. Side benefit: approach-height edits move all four derived poses in one parameter, zero re-teaches.

Prompt details: derived steps carry `{derived_from, offset_z_mm}` with no teach affordance, rendered "derived: above pick (+h mm Z)"; fix at the shared step-factory layer (PBD composer AND wizard); codegen resolves derived → movL targets (base-frame Z; **stop-and-report if tool-frame is the existing convention anywhere**); legacy programs with taught above-poses load read-only unchanged; the 16-step test wizard reported-as-regenerated but not overwritten; PBD review offers exactly two teach actions in order (pick, then place). Note from Addendum 21 that applies at implementation: zero-offset returns and pure vertical offsets should honor the movJ-for-taught-joints / seeded-IK rule (Lesson 118) — the resolver already does.

**OPEN QUESTION flagged to operator:** retreat height = same parameter as approach height, or split? (Same is simpler; split matters for deep-bin pick + open-table place. Prompt assumes shared.)

### Section 384: Eye-in-hand D435i at the flange — the plan, in dependency order

New capability declared: RealSense at the flange looking down, detect objects wherever the flange is, move to the detected object. First-things-first answer: **the transform chain is the whole game.** Detect-and-move is one equation — object-in-camera → camera-to-flange (the missing calibrated piece) → FK → object-in-base → motion target. Sequence:

1. **Mount with a known rigid offset** — printed/machined flange adapter, optical axis parallel to tool approach, ~80–120mm lateral offset to clear gripper occlusion. Rigidity > aesthetics: flex silently invalidates calibration. CAD-measured nominal becomes the initial `tool0 → camera_optical_frame` static TF.
2. **Cable reality first** — D435i USB 3.0; >3m drops to USB 2.0 / random disconnects (documented failure mode, §267). Flex-rated cable, strain relief at wrist and base, active/optical USB 3 if the run exceeds 3m.
3. **Hand-eye calibration = the first milestone.** Eye-in-hand variant: AprilTag board fixed on table, robot moves camera through 15–20 poses, solve camera→tool0. AprilTag script already in codebase; sizing already decided (100mm tag36h11, ~$30 board or `scripts/generate_apriltag.py`). FK dependency is solid (URDF verified to 3 decimals). **Flag:** calibration bakes in current FK — after the eventual J3/J5 sign migration, re-verify calibration even though the migration is designed behavior-identical.
4. **Scan-pose capture flow** — eye-in-hand replaces continuous streaming with: move to scan pose → settle ~300ms (vibration ruins depth) → capture. Existing depth_segment pipeline transfers but was tuned for fixed geometry — re-tune working distance, size gates, thresholds; keep scan distance in the D435i comfort zone (~300–500mm above workspace).
5. **Detection → motion** — detected pose TF'd through the calibrated transform to base frame, then the §383 derived-pose structure (above-object derived → descend). §47's `target_part_id` binding slots in unchanged.
6. **Safety model update** — flange capsule in the self-collision model must grow to include camera + mount, or the collision guard clears paths the camera doesn't.

**OPEN QUESTIONS to operator:** which D435i — pull cam0/cam1 off fixed monitoring duty, or a third unit? Mount printed in-house, or designed as a SolidWorks-COM-automatable adapter (ties to the CAD automation pipeline)?

### Section 385: Program tab simplification — editor only (prompt authored, PENDING)

Operator: remove the 3D viewer and the teach-pendant/jog tab from the Program tab's 3-panel resizable layout (§ Program tab 3-panel, sessions 69–117 era); only the program functionality remains, full width.

Design dependency surfaced and resolved: **teaching poses relied on the adjacent jog panel.** Replacement pattern in the prompt: a **jog drawer/modal** that opens only when a teach action is invoked (reusing the existing JogControls component unchanged — same safety gates, banners, alarm modals — plus a Capture button), stores the pose to the step, closes. No persistent pendant in the tab; no new verbs; safety posture unchanged. Components are NOT deleted (JogControls is the pendant elsewhere; viewer used in Monitor/parts) — only their instantiation in this layout, plus the 3-panel sizing state in Zustand and orphaned CSS. Pairs well with §383: two taught poses per pick/place pair means the drawer is invoked rarely — exactly when a modal beats a panel. Verify includes the full teach round-trip through the drawer and that Monitor/parts viewers are unaffected. **PENDING run.**

### Section 386: Session status ledger (July 23)

| Item | Status |
|---|---|
| Valve actuation (click-no-shift) | IN PROGRESS — override test + pressure at P pending |
| Relay purchase | Operator ordering (next-day filter guidance given); 1N4007 pack same order |
| Pneumatic BOM | plug ×1 (B), mufflers ×2 (R/S), venturi, FRL, 6mm PU tube, fittings |
| I/O naming unification prompt (§380) | AUTHORED, PENDING run |
| PBD review fixes prompt (§381) | AUTHORED, PENDING run |
| Detect-step investigation prompt (§382) | AUTHORED, PENDING run — diagnose a/b/c first |
| Pick/place teach restructure prompt (§383) | AUTHORED, PENDING run — retreat-height question open |
| Eye-in-hand D435i | PLANNED — camera choice + mount design questions open; AprilTag board to order/print |
| Program tab simplification prompt (§385) | AUTHORED, PENDING run |

## PROCESS LESSONS (127–131)

127. **A click is not a shift.** Internally pilot-operated valves click their armature with zero air connected and never actuate — the spool is thrown by pilot air stolen from P (≥0.15 MPa). The manual override button is the one-press diagnostic that splits electrical from pneumatic before any rewiring.
128. **Exhausts must breathe.** A 5/2 spool cannot move unless the losing side can vent; solid plugs in R/S hydraulically lock it — reproducing the click-no-shift symptom with a perfectly healthy coil. Mufflers on exhausts, plugs only on unused work ports.
129. **"Answered" tracks the interaction, not the value.** A UI that infers answered-state by comparing the selection to the suggested default cannot distinguish "operator confirmed the default" from "operator never touched it" — and it silently discards the confirm-default training signal the flywheel wants. State follows events, not diffs. (Root cause pending code confirmation, §382 a/b/c.)
130. **Teach the contact pose; derive the approach.** The precision-critical pose is the one the operator should capture; approach/retreat are parameterized Z-offsets computed at codegen. Teaching the approach and implying the contact bakes error into exactly the pose that matters — and doubles the teaching workload.
131. **Eye-in-hand begins with the transform, not the detector.** "Detect and move to it" is one equation, and the only uncalibrated term is camera-to-flange. Mount rigidly, solve hand-eye first, and remember the calibration bakes in the FK it was solved against — re-verify after any kinematic-sign migration.

---

*Summary of Addendum 22: July 23 split between the workbench and the review screen. On the bench, the vacuum valve arc continued: the relay wiring plan was finalized against manual 5.2.7 (fuse in, DO→coil→0V, DIN 43650's ground-pin trap named), the direct-drive question got an honest margin answer (works day one, dies warm — diode-protected direct drive acceptable only as logged temporary), an Amazon relay shortlist was assembled (Electronics-Salon 4-channel SPST-NO recommended — diodes built in, covers DO2+DO3+spares), and the session's hardware headline landed: the solenoid clicks but the valve doesn't shift because internally piloted valves need supply air to move their own spool — no air at P, no actuation, and the manual override is the one-press electrical-vs-pneumatic verdict. The full pneumatic chain was specified (compressor→FRL→valve→venturi→cup; the valve switches air, the venturi makes vacuum), B gets plugged, R/S get mufflers never plugs, and blow-off stays a separate commanded valve. On the review screen, the operator's first full PBD demo walkthrough yielded a four-part fix list headlined by the answered-state bug (suggested-equal selections never register — state must follow interaction, not value-diff), a diagnose-first investigation into a detect step that survived a "fixed position" answer (three candidate root causes, code-lines-before-fixes), and a structural correction to teaching itself: teach pick and place contact poses, derive every approach and retreat from one parameter. The Program tab sheds its 3D viewer and resident pendant for a teach-invoked jog drawer, the step editor's I/O dropdowns get unified onto the hardware-exact DO0-style port map, and the eye-in-hand D435i got its dependency-ordered plan — mount, cable, hand-eye calibration first, because detect-and-move is one equation and camera-to-flange is its only unknown. Four prompts authored, all pending; five lessons, two of them pneumatic truths learned the audible way.*

*Last updated: July 23, 2026 (Addendum 22 — Sections 373–386, Lessons 127–131)*
---

<!-- v46-content-end -->
