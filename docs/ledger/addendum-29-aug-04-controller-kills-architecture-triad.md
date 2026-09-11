---
ledger_split: addendum-29
source: cobot_project_conversation_v46.md
source_lines: 13066-13257 (inclusive)
title: Three controller kills pinned; architecture triad
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 29 — August 4, 2026 — THREE CONTROLLER KILLS PINNED TO ONE LINE, THE GHOST-STATE DAY, TWELVE VERIFIED COMMITS, AND THE ARCHITECTURE TRIAD (QUARANTINE · FORK REGISTRY · RECORD-THROUGH)
*(Appended in full. Nothing above this line was removed. The single most consequential debugging day of the project: a recurring "resident mismatch" banner unraveled into the discovery that our own generated Lua had assassinated C2Control three times — pinned to the exact firmware line by the controller's own logs — and the response built three permanent architecture layers in one day: the pending-pose/arity quarantine, the fork registry as a standing deploy gate, and record-through teach state. Twelve commits, every one verified by the git-log + boot-sha ritual before belief. The operator was right about the machine being wrong three separate times.)*

### Section 467: The morning banner — diagnosis before fixes, and verdict (d)+(c)

The day opened with the resident-mismatch banner recurring on every attempt to switch to `whitebowlpickplace` while the controller held `holepartpalletize`. The load-path fix `a17da6c` was suspected of being another false-pass report from the Aug 3 marathon. A read-only diagnosis (the discipline now standard: verdict before fix, code lines and log lines only) exonerated it:

- **(a) refuted**: `a17da6c` was real, at HEAD, and running (`codegen=a17da6c9e50d` stamped on live runs).
- **(b) refuted**: no unfixed fork — all program selection flowed through `/api/estun/program/run`; the old `/api/program/run action:'load'` path was dead with no frontend callers.
- **(d) primary**: the controller's :9000 WS was **refused for 29 straight minutes** (08:30–08:59); the driver correctly gated even the HTTP-only push behind `self._connected` (safety-correct: never save onto a controller whose state we cannot see), so the push was rejected.
- **(c) structural**: `MonitorDashboard.jsx:754` set `currentProgram` BEFORE the push at :772 and never rolled back on failure — so **every push refusal manufactured the exact divergence the banner warns about**, with only a generic warning toast to distinguish it. The operator legitimately read the banner as "the fix isn't working."

A user-side lesson from the same hour: the diagnosis prompt was pasted into the bash shell instead of Claude Code, producing a wall of `-bash: syntax error` — harmless, but the `[JETSON] start claude first` step is now explicit in every prompt-delivery instruction.

### Section 468: Commit 83f9472 — the UI's current program follows push success, never precedes it

The atomic principle shipped: **UI state follows the wire.** `onSelectProgram` pushes first via a shared `pushProgramToController` helper; `setCurrentProgram` only on `result.ok`; pending indicator during flight; hard equality with the actual controller resident on failure. The mismatch banner became UNREACHABLE via a failed load. Every failure got a named, error-severity message mapped from `outcome.kind` (`transport_down`, `empty_program`, `lint_failed`, `save_rejected`, byte-verify variants), with the driver's reject reason propagated verbatim into expandable detail. The driver's WS-gate rejects gained machine-readable `reason_code='transport_down'`. The banner (now reachable only by genuine divergence) gained a one-tap "Push to controller" button. The dead `/api/program/run action:'load'` handler was retired to HTTP 410. Seven pinned backend tests + eight frontend cases. Verified: three-way sha match (this became the standing PASS bar all day: `git log -1` sha == disk bundle == served bundle, boot-sha == disk-sha).

### Section 469: The five-hour ghost — "I cannot get this program to stop"

`holepartpalletize` showed RUNNING · task main · line 3 for five hours, cycle count 0, STOP presses doing nothing. Escalation ladder ran: journals showed the driver had seen NOTHING — no stop frames, no rejects — because **the controller's :9000 had been refusing continuously since 09:41** (and, as later established, since 09:10). The RUNNING pill was a **ghost**: the last state frame the driver ever received, frozen and re-rendered for five hours. Three stacked lies hid it:

1. The header "Connected" chip — dashboard↔driver truth masquerading as robot connectivity (a forked connectivity truth).
2. The RUNNING pill rendering last-known state with zero staleness marking.
3. The deploy watcher waiting on `program.state==2` — a frozen value from a dead feed. **This also explained the overnight mystery**: the previous deploy (`a17da6c`) had waited 51,180 seconds — 14.2 hours — queued behind ghost state from a kill the evening before, releasing only when the controller rebooted at 07:59.

The recovery ladder was re-rehearsed with a live correction mid-stream: the operator restarted the driver without cycling the cabinet (twice) — the sequence was reset to its canonical order and it held: **driver stop → cabinet cold boot → 5-minute wait → probe BOTH ports separately (`nc -zv ... 9000; nc -zv ... 9198`, never `&&` which hides the second probe) → driver start → watch for `Connected ... INITIALIZING (grace...)`**.

### Section 470: THE FORENSICS — firmware bug #3, three kills, one line

The operator pulled the controller's own logs via :9198 (the July 22 route). Three log files; **all three end in the identical crash**:

```
project_running_data.cpp:1480 mm2mAndDeg2rad() System Error| v.size() >= 6
 1# c2::Log::exitProcess(...)
 2# c2::inssys::ProjectRunningData::mm2mAndDeg2rad(...)
 3# c2::inssys::plugin::InsMov::_setRelativeOffset(...)
 4# c2::inssys::plugin::InsMov::movJCoorRel(...)
```

**Our generated Lua for `holepartpalletize` passed a relative-move offset vector with fewer than 6 elements, and the firmware killed the entire C2Control process via `exitProcess` instead of raising a Lua error.** Firmware bug #3 (family of bug #1's zero-length blend). The malformed emission traced to the poses-pending `MOVE_TO_PALL` step of the PBD draft.

The controller clock runs **China time (UTC+8)**; converting locked every kill to our logs to the second:

| Controller (CST) | Local (CDT) | Event |
|---|---|---|
| Aug 4 06:18:38 | Aug 3 ~17:18 | holepartpalletize run → kill #1 → controller dead overnight → the 14.2h deploy wait |
| 20:59:49 | 07:59:49 | C2Control boots; state clears; a17da6c deploys at 08:01 |
| 21:19:03 | 08:19 | whitebowlpickplace runs CLEAN |
| 21:20:38 | 08:20:38 | holepartpalletize → kill #2 (the 08:30–08:59 outage) |
| 21:59:02 | 08:59:02 | C2Control boots; driver connects 08:59:32 |
| 22:09:31 | 09:09 | whitebowlpickplace pushed + run clean (4 HTTP calls, 4 200-OK) |
| 22:10:05 | 09:10:05 | holepartpalletize → kill #3 → the five-hour ghost |

`whitebowlpickplace` was innocent throughout. The §465 motion-verb fix that added `movJCoorRel` to the valid-motion set had correctly unblocked the program — but nothing validated the verb's **arity**. The gate said "has motion"; nobody asked "is the motion well-formed." Also noted: the recurring "why do we keep power-cycling the cabinet" question got its answer — we were shooting it; when C2Control dies there is no exposed way to restart just that process, so cold boot is the only lever (the 08:59 revival suggests a possible slow internal watchdog, unconfirmed).

### Section 471: Commit 60790e8 — D14: the pending-pose quarantine and mov* arity validation

The kill chain was cut at the first link: `check_program_pending_poses` + `_bad_mov_pose_vector_arity` matcher across 9 mov* verbs; a codegen **post-emit AssertionError** on any D14 finding or any point vector not exactly 6 floats; the pending-pose gate running BEFORE codegen in `/api/estun/program/run` (`outcome.kind="pending_poses"`, HTTP 400 — and `push_only` does NOT bypass it); a distinct `arity_assertion_failed` outcome. **Seven programs auto-quarantined**: holepartpalletize, palletize1, test2, whitebowlpickplace2/3/4, machine — each now refused by name at the API instead of murdering the controller. Live-probed on the running dashboard: the assassin refused with the named error; the healthy program passed the gate (its failure was honestly `transport_down` — the controller was still down at probe time). 16 new pinned cases.

### Section 472: Commit 2236b31 — link-down honesty, D15, full-surface argument validation

The display-side lies from §469 got their fixes: **STALE `stale_link_down` pill** (a dead feed can never render as live RUNNING), **Run/Restart/Return-Home gated while LINK DOWN** with stated reason (click-then-fail retired), the resume path unified onto a ladder-verb endpoint (`/api/estun/program/resume`, source-only op), and — the firmware-kill class generalized — **D15 zero-length-blend named check** (`setBlender(0)` is a codegen bug; should emit `setNoBlender()` — firmware bug #1 now impossible to emit) plus **full-surface argument validators** extended beyond mov* arity toward the 168-verb catalogue signatures (`wait(0)` refused: ms must be > 0 — the wire-proven-undocumented verb now has a working matcher). §464's option-surface matrix landed as a design doc (build deferred deliberately). Live probes proved both new lint checks firing.

### Section 473: Commit 267108a — operator toast copy: title/detail split, forensics demoted

The pending-poses refusal toast had led with "known controller-crashing codegen — regenerate required" plus firmware citations, rendered twice. Root cause of the duplication: callers concatenated headline + " — " + detail into one string. Fix: `namedLoadError` returns structured `{title, detail, technicalDetail}`; `ToastContainer` renders each exactly once; technical detail behind a closed-by-default "Details" toggle + console.warn. `BANNED_OPERATOR_TOKENS` export forbids technical strings (codegen, mm2mAndDeg2rad, firmware bug, v.size()) in operator fields — lint-testable. The doctrine, stated: **headline says what to do; detail says why; forensics live in the log.** Live probe: server still sends the technical string; operator sees "Teach positions first — this program has untaught positions." with the five steps named.

### Section 474: The pallet-frame fork — §465 fork-1 had a frontend twin all along

Teaching pallet corners for the palletize re-teach, the operator hit "Row or column vector has near-zero length — corners appear coincident" while mid-re-teach of corner 3 — before even recording it. Read-only diagnosis delivered the verdict: `validatePalletFrame` in `frontend/src/lib/palletTeachSequence.js` was a **complete fork** of the backend shared frame path — its own raw `sub3/len3` math, no v1→v2 migration, no Gram-Schmidt (tilt read raw Z, not the plane normal), never fetching the backend's `pallet_slots` findings. The §465 fork-1 kill had fixed the backend consumers; the frontend twin was never in scope. Commit `3ae0760` killed it: frontend frame math deleted; findings come only from the backend shared path via a draft-validation endpoint; validation moved to Record-time and teach-complete (never a passive banner over the jog screen mid-re-teach); suppression rule for the corner being replaced; findings phrased with the fix ("corners 1 and 2 appear coincident (X mm) — re-teach corner 2").

### Section 475: Commit b3453b9 — THE FORK REGISTRY: fork prevention becomes a standing deploy gate

The operator's directive — "we need to check for forks and mitigate them whenever we make changes" — turned reactive fork-killing into structure (Lesson 180 operationalized):

- **`tools/fork_registry.yaml`**: every capability that must have exactly one implementation, with canonical owner and forbidden paths. Seeded from all known classes: geometry/frames, sign conversion, motion gating, taught-state, effector/verb vocabulary, motion-verb set, resident-program state, program-selection writes, line-map, validator invocation, io/port map, pallet geometry, toast/error copy.
- **`tools/fork_lint.py`**: registry-driven linter running in the **pre-commit hook AND the auto-deploy watcher's build phase** — a fork cannot deploy. Cross-boundary heuristics flag frontend reimplementation of backend-owned math.
- **CLAUDE.md standing rule**: grep the registry before implementing; new shared capabilities get a registry entry in the same commit; a second implementation of a registered capability is a defect regardless of tests passing.

Honest boundaries recorded: the heuristic catches computation forks, not concept forks (the registry's named-owner grep covers that side); CLAUDE.md rules only bind sessions that read them — which is exactly why the linter lives in the watcher's build phase, where even a rule-ignoring session cannot ship a fork.

### Section 476: Commit 0f884c6 — RECORD-THROUGH: the Jetson is the single store for mid-teach pose state

The operator named the hole and the same day's pallet diagnostic had already proven it: in-progress taught poses lived **only in the recording browser's Zustand state** until save — tablet and PC diverged during teaching, and a refresh mid-teach lost recorded poses. §406 covered saved positions; teach-time state was never covered. The architecture shipped:

- Server-side draft store `/opt/cobot/teach_sessions/{pid}.draft.json` (atomic tmp+fsync+rename), six endpoints (start/record/take_over/save/cancel/GET), boot hydration into STATE.
- Every Record Position POSTs the pose immediately; the draft rides the existing 25 Hz WS broadcast; **all connected UIs converge live** — taught badges, corner fills, step lists.
- Single active session per program; second device gets a locked banner + explicit Take Over (atomic, poses preserved); server-side 403 enforces ownership even without the UI gate.
- Zustand persist whitelist: `currentProgram` REMOVED — no pose data in localStorage, lint-guarded via a `teach_session_state` registry entry.
- Save promotes draft → program **through the same validator door** as every push (`check_program_pending_poses` — no second path to runnable state).

Live five-step probe on the running dashboard proved the full contract: record on A → broadcast visible → B refused (`not_owner`) → takeover atomic → cancel clean. Kill/restart the dashboard mid-teach: draft survives (it's on disk).

### Section 477: THE PUSH — 35 commits off the single disk

`git push origin feature/estun-write-path` executed under a full protocol: status, ahead-count, divergence check (origin strictly behind — the §407 stale-main lesson honored), secrets scan on the outgoing diff (clean — all "token" hits were code identifiers), LFS health, push, and **fetch-verify**: local HEAD == origin HEAD == `0f884c6...`, ahead-count 0. **35 commits (283c63d..0f884c6)**, eleven days of work, off the single disk. Standing rule proposed: push joins the end-of-session ritual. (Commits after `0f884c6` — the PBD determinism and unit-canon work — remain unpushed as of this addendum; flagged.)

### Section 478: Commit 1343920 — PBD DETERMINISM: extraction is probabilistic, composition is pure

The operator named the pipeline's weak point: same-or-similar demonstrations yielding differing programs — drifting labels, varying joint/linear assignment, extra steps, and detect steps that shouldn't exist yet. The architecture answer: **the LLM's job ends at a strict intent JSON; a deterministic composer owns structure, labels, verbs, I/O, and order.** Shipped:

- `label_vocabulary.COMPOSER_EMITTABLE_ACTIONS` frozenset — positive list; **detect deliberately absent — impossible by construction**, not filtered (the `_detect()` factory and 4 call sites retired).
- `LABEL_FOR_ROLE` single label table; `label_for(role, ...)` the one function; operator-spoken names slot into fixed templates.
- `check_program_emissions()` post-emit assertion: action ∈ positive list AND label prefix ∈ vocabulary.
- `StructuredIntent.from_dict(strict=True)` rejects unknown keys; LLM prompt stripped of vision suggestions.
- **57-fixture idempotence sweep**: byte-identical on repeated compose (~228 checks). Registry entries: `pbd_composer`, `pbd_label_vocabulary`, `pbd_archetype_skeletons`.
- Test suite 342 PBD (was ~132). Live probe on deployed code: three real demos, all idempotent, zero detect emissions.

Named gap (queued): idempotence pins code-against-itself; **golden regression files** (checked-in composed outputs, CI-compared, deliberate regeneration only) are the still-owed protection against silent restructuring by future composer changes. Boundary stated: demonstration→intent variance remains and belongs to the clarification flow; if the same video yields different programs now, the bug is extraction, never the composer.

### Section 479: THE UNIT LIE — corners 325 mm apart read as 0.33 mm, and the meters canon

The coincident warning returned on corner 3 — corners physically well-separated, taught per the diagram. The operator: "PLEASE FIX THIS ISSUE. something is wrong with the location protocol." Diagnosis (measurements, not guesses) delivered the day's most instructive verdict:

- The record path was **perfect**: draft `corner:1 = [0.532263, 0.138846, 0.114584]` (meters) matched controller-published `end = (532.263, 138.846, 114.584)` mm **to 1 μm** at the record instant. Record-through, buildTaughtPatch, the draft store — all transporting meters verbatim, correctly.
- The check was the liar: `pallet_geometry._xyz()` — docstring claiming mm, fed meters — compared 0.325 and 0.387 against `_MIN_EDGE_LEN_MM = 1.0`. **Physical distances 325/387/534 mm; the check saw sub-millimeter and refused the teach.** The §465 fork-1 kill had inherited the latent bug: routing the frontend through the shared module made it the first honest consumer to hit the module's own unit lie.
- Near-miss caught before hardware: `derive_slot_tcps` added mm pitches to a meter anchor — slot ghosts collapsing onto the anchor, and eventually **1000x-wrong point tables** that six well-formed floats would have sailed through every arity gate. The operator's refusal to dismiss-and-save through the warning is what kept it theoretical.

Commits `85342bd` + `ee62f71`: **canonical pose unit = meters + radians everywhere**; mm+deg exists only at the operator-render boundary and the codegen boundary; thresholds renamed `_M`; findings carry `distance_m` and render mm; `derive_slot_tcps` outputs `tcp_m`; the sibling endpoint's `measured` block (labeled `_mm`, holding meters — the same lie at the second boundary, initially missed) converted at response. `pose_unit_canon` registry entry + naming rule: pose-carrying fields carry unit suffixes. Live probe on the operator's real corners: 325.06 / 386.80 mm, no coincident finding, `blocking: false`. Standing caution recorded: **pallet-slot emission has never run on hardware and just had unit surgery — read the emitted point table for mm-scale magnitudes before the first live palletize run.** Unit lies come in litters.

### Section 480: The jog cutout — transport exonerated, the silent J6 clamp convicted

Jog during teach: starts then stops, sometimes step-like. The starvation hypothesis (Addendum 16's three-headed war returning via record-through's 25 Hz broadcast) was **fully refuted by measurement**: 100 ms client ticker sound, WS send synchronous, dedicated 60 ms native keepalive thread on the server, broadcast auto-drops to 8 Hz under hold (the GIL mitigation working), teach drawer imports the shared HoldButton (no fork), deadman constants deployed and consistent. The actual verdict:

- **52% of stops: the J6 dynamic joint-limit clamp** in `_on_jog_supervise` (continuous_cart) firing **silently** — J6 sitting near −192° of ±200°, cart motion projecting onto J6, margin 7–14°, stopJog at 6–52 ms after press. The operator experienced an invisible safety guard as broken jogging. Lesson 165, verbatim recurrence.
- 10 stops: genuine short-tap releases. 3 stops: real deadman trips at ~210 ms — inside the design envelope.

Immediate unblock: jog J6 back toward zero in Joint mode (the clamp is cart-only); cartesian smoothness returns at once. Fix directed (not yet landed at addendum time): surface every driver-initiated stop cause in the UI in operator language; **soften before stopping** (progressive speed scale near the margin, hard stop only at the true margin — approach reshaped, safety threshold untouched); live margin HUD when any joint is within 20° of its limit; and the 30-second hold test Addendum 27 always owed, in both J6 regimes. Open question flagged: how J6 winds to −192° during teach (the J6 excursion audit, owed since Addendum 16, gains new urgency).

### Section 481: Business layer — vision/mission ladder, and the deep-learning vision roadmap

- **Vision/mission work** (pending Josh's sign-off — CEO territory, same discipline as the slogan): the exploration moved from access-framing ("no robotics engineers required") through landscape-framing to the north-star claim. Leading candidates on the table: Vision **"The end of robot programming."** (the operator's own "We envision a world where robots don't need to be programmed anymore," tightened) and/or **"A manufacturing economy where no shop is too small to automate."** (the operator's selection in the landscape round); Mission candidates: **"We build robots that watch a job done once — and then do it."** (distinctive register) or **"We make automation accessible to every manufacturing business — with robots that learn by watching, not coding."** (accessible register, the operator's own phrasing extended with the mechanism). Classification note recorded: "we aim to..." grammar marks a mission, not a vision — the litmus test is whether the statement survives as a photographed world with the company deleted. The ladder nests with the locked slogan and product line; propagation bundles with the still-outstanding Chinese-deck founder-role correction, one pass.
- **Deep learning in the vision system** — the roadmap consolidated into one architecture: Layer 1 detection (YOLOv8/TensorRT Phase 1 live path; Phase 2 custom parts via domain-randomized synthetic data on the funded RTX 4090 — **gated on the RunPod account, still unopened**); Layer 2 pose (depth-fusion on the mask first, learned 6-DoF later); Layer 3 scene understanding via the teacher/student split (API understander labels train the local watcher — every Analyze Scene call is a data-collection event); Layer 4 the fleet-learning flywheel (corrections ledger + validation trajectories = supervised data as a byproduct of operation — the un-buyable moat). Hard prerequisites in order: hand-eye calibration (prompts authored, unrun), RunPod account, detection re-enters the composer only as a positive-listed archetype step when proven. Deliberately deferred: end-to-end learned policies — DL for perception feeding deterministic execution is more certifiable, which the §464 safety-certification gate makes the commercial argument, not just the engineering one. MotionCam sequencing decision (§464) unchanged.

### Section 482: Session status ledger (August 4, end of day)

| Item | Status |
|---|---|
| Firmware bug #3 pinned (mm2mAndDeg2rad v.size()>=6 → exitProcess, via movJCoorRel) | **PROVEN — three kills, controller's own logs, to the second** |
| Load rollback: currentProgram follows push (83f9472) | **SHIPPED + verified** |
| D14 pending-pose quarantine + mov* arity (60790e8) | **SHIPPED — 7 programs quarantined, live-probed** |
| Link-down honesty: STALE pill, gated buttons, D15, full-surface args (2236b31) | **SHIPPED + verified** |
| Operator toast copy: title/detail split (267108a) | **SHIPPED — live probe clean** |
| Pallet frame fork kill, backend-only validation (3ae0760) | **SHIPPED** |
| Fork Registry + fork_lint at pre-commit AND deploy (b3453b9) | **SHIPPED — the standing gate** |
| Record-through teach state (0f884c6) | **SHIPPED — five-step live probe** |
| git push, 35 commits, fetch-verified (283c63d..0f884c6) | **DONE** |
| PBD determinism: pure composer, no detect by construction (1343920) | **SHIPPED — 57-fixture idempotence** |
| Pose unit canon: meters+radians (85342bd + ee62f71) | **SHIPPED — operator's real corners validate clean** |
| Golden regression files for the composer | **QUEUED — idempotence alone doesn't pin cross-change drift** |
| J6 clamp fix (surface cause, soften, margin HUD) | **DIRECTED — not yet landed; Joint-mode J6 unwind is the immediate workaround** |
| Commits after 0f884c6 (1343920..ee62f71) | **UNPUSHED — one disk** |
| Bowl program 10% acceptance run | **STILL OPEN — the unclosed loop on the whole incident arc** |
| Palletize re-teach (corner 3 retry + datum + steps 1/2/3/6/8) | IN PROGRESS — unit fix deployed, retry cleared |
| First palletize run pre-check: read emitted point table for mm-scale magnitudes | **STANDING CAUTION — path never run on hardware** |
| /opt/cobot backup | **STILL OPEN — oldest item; now also holds live teach drafts** |
| Estun bug report (#1 zero-length blend, #2 boot-window subscribe, #3 arity exitProcess + the three logs) | **OWED — three firmware kills in two weeks is a pattern** |
| Vision/mission ladder | DRAFTED — Josh sign-off pending; propagate with Chinese-deck correction |
| RunPod account (gates detector Phase 2) | **STILL UNOPENED — critical path since §463** |
| C2Control watchdog question (08:59 self-revival — internal watchdog or operator?) | OPEN — worth hunting a restart option in cabinet settings |
| Toast message dedup (cosmetic double-render) | FIXED in 267108a |

## PROCESS LESSONS (182–191)

182. **The victim's logs outlive every theory — grab them before the reboot.** Three identical backtraces in the controller's own logs turned a day of "wedged program" mystery into arithmetic: program named, crash line named, three kills timestamped to the second (once the China-time clock skew was mapped). The flight-recorder principle (Lesson from §408) extended to the OEM's black box.

183. **UI state follows the wire, never precedes it.** Setting `currentProgram` before the push manufactured the exact divergence the mismatch banner existed to report, on every failure, of every kind. Optimistic UI on state the controller owns is a lie generator.

184. **A dead feed rendered as live state is the worst lie a UI can tell.** Five hours of ghost RUNNING, STOP presses into the void, a deploy watcher waiting 14 hours on a frozen number. Every state pill needs a staleness contract; every "Connected" chip must name which hop it vouches for.

185. **Validate emitted arguments like a safety property — the controller treats them as one.** A 5-element vector where 6 were expected didn't error the script; it killed the whole control process. On this firmware, malformed codegen IS a denial-of-service on the robot. Arity and argument validation joined the validator not as quality, but as the thing standing between any bad program and a dead cell.

186. **A unit is a claim; an unenforced claim is a future lie.** A docstring said mm, the data was meters, and a correctly-taught pallet read as coincident while slot derivation quietly prepared 1000x-wrong targets. One canonical unit, conversions only at named boundaries, unit suffixes in names, registry-guarded — because unit lies come in litters (the same endpoint hid a second one).

187. **When the guard is right and silent, the guard is still wrong.** The J6 clamp did exactly its job 14 times and the operator experienced broken jogging. Lesson 165 recurred in new clothing: every automated stop must say its name at the moment it fires, and a hard wall the operator approaches blind should slope first.

188. **Registries and lint gates scale; vigilance doesn't.** Six forks were sealed reactively in §465 and the seventh (frontend pallet math) was already live. The fork registry + deploy-phase linter made "no forks" a property of the build instead of a memory of the team — and it caught nothing all day because nothing forked, which is the point.

189. **Determinism lives one layer after the LLM.** The model extracts intent; a pure composer owns structure, labels, verbs, and order — same intent in, identical bytes out, detect steps impossible rather than filtered. Generation variance stopped being a pipeline weakness the day the composer stopped being creative.

190. **State that exists only in a browser is state scheduled for loss.** Taught poses lived in one tab's memory; a refresh deleted work, and two screens showed two truths. Record-through — server-owned drafts, broadcast convergence, single teach session with explicit takeover — made mid-teach loss structurally impossible instead of merely rare.

191. **The operator's "the machine is wrong" was right three times in one day.** The corners were taught correctly (the check divided by 1000). The jog was pressed correctly (the clamp was silent). The stop was pressed correctly (the controller was dead). The standing prior, now three addenda deep: when the operator's direct observation contradicts the system's explanation, instrument the system.

---

*Summary of Addendum 29: the day a recurring banner unraveled into three controller assassinations and the response rebuilt the platform's immune system. The morning's diagnosis exonerated the previous night's fix and convicted two new defects — a 29-minute controller outage swallowed into a banner, and optimistic UI state that manufactured false divergence on every failure. The five-hour "wedged" program was a ghost: C2Control had been dead since 09:10, killed — as the controller's own logs proved, three times over, to the second across a China-time clock skew — by our own generated Lua handing movJCoorRel a short vector that the firmware answers with exitProcess. The kill chain was cut three deep in one day (pending-pose quarantine, full-surface argument validation, post-emit assertion), the display layer learned to say STALE and LINK DOWN instead of lying, toasts learned to lead with what-to-do and demote forensics, and the recovery ladder was drilled until the cabinet cycle stopped being mysterious. Then the day built architecture: the fork registry turned no-fork from doctrine into a deploy gate hours before the unit-canon incident proved why — a correctly-taught pallet read as coincident because a docstring's "mm" was carrying meters, with 1000x-wrong slot targets waiting behind it; record-through ended browser-owned teach state after the same diagnostic showed poses living in one tab's memory; and the PBD composer became a pure function with detect steps impossible by construction. Thirty-five commits went to origin under a verified push protocol; twelve commits shipped through the three-way sha ritual without one false pass. The jog mystery ended the day on theme: transport exonerated by measurement, a silent-but-correct J6 clamp convicted of the one crime that recurred all day — machines failing without saying why — while the operator ran his record to three-for-three on "I did it right, the system is lying." Ten lessons, one firmware bug report owed to Estun, a vision/mission ladder awaiting the CEO, and the two loops still open at midnight: the bowl program's 10% run, and the backup that every new subsystem keeps making more overdue.*

*Last updated: August 4, 2026 (Addendum 29 — Sections 467–482, Lessons 182–191)*
---

<!-- v46-content-end -->
