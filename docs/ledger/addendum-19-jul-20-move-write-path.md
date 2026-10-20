---
ledger_split: addendum-19
source: cobot_project_conversation_v46.md
source_lines: 11764-11910 (inclusive)
title: The move write path — first program on the arm
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 19 — THE MOVE WRITE PATH REALIZED: FIRST PROGRAM ON THE ARM & THE CLOSED OEM LOOP (July 20, 2026)
*Append-only. Sections 319–335, Lessons 105–110. Covers: the move-verb capture session, the verb-vocabulary decode, the B1 (Lua-generation) architecture, the three-rung validation ladder that ran the first NeuRobots-generated program on the real arm, Monitor-screen Run integration, in-UI pose teaching, the integration-bug shakeout (id slugs, metadata inheritance, save-before-run, orphan steps, stale-bundle ghost), and the milestone: a program taught AND run entirely in NeuRobots with the factory UI never opened.*

### Section 319: The move-verb capture session (July 20)

Capture-first per standing discipline (no motion verb from source-mining alone). Setup: our driver stopped so the factory UI had clean WS ownership; DevTools Network→Socket→Send filter on the Codroid UI at :9198; the `lua-demo` project run/paused/stopped while recording. Dual-recording intent (browser HAR + our-side `posture.py` tap) — the tap didn't start, but the browser HAR captured the full session: **`data/estun_captures/estun_moves_20260720.har`** (10.5 MB, 29,838 WS frames, both directions; 91 command frames). Decoded to `/mnt/user-data/outputs/estun_moves_capture_20260720.jsonl`.

Process note: the session took several attempts (DevTools opened after page load missed the WS handshake → F5 with DevTools open; direction filter defaulted to "All" hiding Send frames). The factory UI's own Program editor proved unintuitive for teaching points — deliberately abandoned; teaching points via their UI is the exact workflow NeuRobots exists to replace, so we only needed to *see* the mechanism, not master it.

### Section 320: Move/project verb vocabulary — CONFIRMED

From the HAR (request→response pairs, verbatim shapes):

```
project/run          {"db":{"id":"projectluademo","task":"taskluademo"}}   — runs stored project AUTONOMOUSLY
project/setStartLine {"db":1}                                              — line-level start (single-step lever)
project/setBreakpoint{"db":{"taskluademo":[]}}                            — per-task breakpoint arrays
project/clearStartLine (bare)                                             — cursor reset after run
project/runStep       WITH db=initialize / WITHOUT db=advance one line    — N lines = N+1 presses
Robot/toAuto / Robot/toManual (bare)                                      — mode switch (programs run in Auto)
Robot/setManualMoveRate {"db":15}                                         — global speed, INTEGER percent
System/ClearError (bare)                                                  — clears the error flood
publish/ProjectState {id,type,state,isStep,scripts:{task:{line:N}}}       — LIVE program tracker
```

`publish/ProjectState` state enum decoded live: **2 = running, 3 = stopping, 0 = idle**; `scripts.{task}.line` = current executing line; `isStep` flag confirms step-mode exists.

### Section 321: The controller program format — LUA 5.3 (decides the architecture)

The factory UI Program editor exposed the stored program: `lua-main`, a **Lua 5.3 script** calling `movJ(p1)` / `movL(p1)` against **named points**. This is the single most consequential finding: our taught programs become **generated Lua text + a point table** — program synthesis, exactly what our stack (and the PBD layer) does naturally. The save path is **HTTP, not WS** (the best possible answer — plain POSTs, inspectable):
```
POST /api/robotcode/project<lang>_<prid>_<lang>/update/<tkid>/   — Lua source
POST /api/robotjson/project<lang>/update/projectlist/           — project registry
POST /api/robotjson/project<lang>_<prid>/update/varspoint/      — named-points library (taught-pose sync target)
POST /api/robotjson/project<lang>_<prid>/update/varsproject/    — project variables
```
→ **Architecture B1 confirmed:** generate Lua + point table from our taught program, HTTP-upload, `project/run` by id. Documented in `src/estun_driver/PART_2C_ARCHITECTURE.md`.

### Section 322: Critical protocol findings from the capture

1. **Controller runs projects AUTONOMOUSLY** after `project/run` — zero client keepalive during execution. Therefore stop-on-disconnect requires the explicit **stop verb**, which was UNCAPTURED (the demo errored in ~1 s before Pause/Stop could fire) → mined SOURCE-ONLY, validated live-first.
2. **`publish/Error` refloods at ~3 Hz until `System/ClearError`** — error state floods until cleared; our handling must dedupe (one modal per fault event, not per reflow frame).
3. **Error 10006 "invalid target point"** — the controller validates point existence at execution and refuses (a backstop under our own checks); explains lua-demo's instant start/stop (its `p1` was undefined).
4. **Free-drive family exists but is inert on this arm:** `Robot/ExistTorqueSensor`→false, `GetDragMode`→0, `DisableDrag` present; **no torque sensor on this SKU** — drag-teach is unavailable, which validates that **vision-based PBD is the ONLY teach-by-demonstration path** for this arm (not a missing feature — a hardware fact that favors our approach). Setter verbs (EnableDrag) absent from the bundle; track-B, needs a torque-equipped arm to mine.

### Section 323: B1 implementation + save round-trip verified

`program_ops.py`: `codegen_lua_from_program` (pure function, no cache) emits `movJ(point)` per taught step; `save_project` POSTs varspoint + robotcode + projectlist + varsproject. Round-trip byte-verified via controller GET: `roboaitest` project with `p1`/`p2` stored, Lua source byte-perfect including the `--Lua version 5.3 time:...` trailer and CRLF endings, projectlist merge preserving other projects. Gated behind NEW `allow_move` + `ESTUN_ALLOW_MOVE` (monitor_only still master).

### Section 324: THE VALIDATION LADDER — first NeuRobots program on the real arm

`src/estun_driver/PART_2C_LIVE_TEST_LADDER.md`, executed in order, all PASS:

| Rung | Result | Wire-proven |
|---|---|---|
| Gate-closed (pre) | PASS | 15 ops → 15 rejects → 0 leaks |
| Save round-trip | PASS | HTTP 200 ×4, byte-verified GETs |
| **Rung 1: stop** | PASS | state 2→3→0, ACK 214 ms — **project/stop wire-proven, SOURCE-ONLY flag lifted** |
| **Rung 2: single-step** | PASS | initial + N advances = N+1 presses; +1.0° J1 at 10% via setAutoMoveRate (also its wire-proof) |
| **Rung 3: full run** | PASS | 9.46 s end-to-end, clean state=0, no errors |
| Gate-closed (post) | PASS | 15 ops → 15 rejects → 0 leaks |

Rung 1's stop-verb design: deliberately built around a **5-second-sleep program** so the SOURCE-ONLY stop had a guaranteed window to prove against (learning from lua-demo dying in 1 s); pause fallback, `Robot/switchOff` as fallback-of-fallback. **MILESTONE: the first NeuRobots-generated program executed end-to-end on the real arm** (rung 3, July 20). An operator e-stop mid-ladder was cleanly recovered. Codegen refactored so executable lines sit at 1..N with comments trailered (removes the setStartLine/line-number ambiguity for step mode). Still SOURCE-ONLY after the ladder: `project/pause`, `project/resume`, `project/clearBreakpoint`.

### Section 325: Monitor-screen Run integration

Wired the Monitor "Run Program" button to the validated pipeline (commit `a40ebee`, later hardened): every Run press **regenerates + re-uploads** the current taught program (no stale-program corner case — backend re-reads `/opt/cobot/programs/{id}.json` on every POST, pure-function codegen, unconditional re-POST), shows a run-confirm modal (program name, taught/total step count, effective speed, "runs on REAL ARM"), then toAuto → setAutoMoveRate → run. A `source_hash` (sha256 first-12 of the Lua) shows in the confirm modal so two presses visually confirm identical-vs-edited code shipped. Live line indicator from `publish/ProjectState`; STOP wired to the wire-proven `project/stop`. New files: `RunProgramModal.jsx`, `ProgramErrorModal.jsx`.

### Section 326: In-UI pose teaching — authoring without the factory UI

`PointsPanel.jsx` (new) + a **📌 Teach current pose** action (Program tab and the 3D-View jog panel's previously-inert Teach button): captures live joint angles from `/estun/status`, stores BOTH joint angles (authoritative for movJ) and FK TCP pose (display/future movL), writes into the program's point table in `{id}.json`, auto-names p1/p2… (editable). Point management: list, re-teach, rename, delete-with-guard. **Safety separation made explicit: teaching only RECORDS a pose — it never publishes to the arm, never opens a WS write, needs no move gate. The gate governs RUN exclusively** (tooltip states this). Commit `f51d373`.

### Section 327: Program provenance / description accuracy

Bug: the Monitor description was hardcoded "Generated from demonstration — poses pending perception" for programs that weren't PBD-generated (a hand-built program wrongly labeled). Fix (`b78ae6a`): authoritative top-level `source` field ∈ {demonstration, manual, imported, unknown}, edit-safe (preserved across PUTs, only changed by explicit canonical value); `_infer_source` backfills legacy files from real signals (pbd tags → demonstration, else manual) with an honest **"Unknown source"** state rather than guessing; `has_taught_poses` boolean decouples provenance (how built) from pose-readiness (can run). Provenance badge renders from the stored field; a program with real taught poses no longer shows "poses pending." Single source of truth confirmed — Monitor and the Run pipeline read the same `{id}.json`.

### Section 328: The integration-bug shakeout (five UI-path bugs on validated primitives)

The pipeline was proven by the ladder; wiring it to buttons surfaced five distinct integration bugs, each traced and fixed:
1. **Underscore id split** (`new_program_2` → controller path-split → save/run id mismatch → error 10001 "does not exist"). Fix: alphanumeric-only slugs `^[a-z0-9]+$`; plus a **"Rename to controller-safe id"** migration endpoint (atomic: destination-write then source-delete, content byte-preserved) + amber toolbar button. Commits through `bd8f3ce`.
2. **Metadata inheritance** — new programs seeded from the PBD demo's tags/description (soda-cans palletize text on a hand-made program). Fix: new programs born blank (source=manual, empty tags/description/steps/points); mislabeled existing files reset.
3. **Save-before-run** — run fired without a successful upload (id mismatch, above). Fix: save GET-verified before run, ids matched end-to-end.
4. **Orphan steps** — steps referencing point names (`move_home`) with an empty points table → validation error; fix surfaces an explicit "Step N references untaught point X" message. Standing workflow rule: **teach points FIRST, then add/point steps** (steps created before poses is the failure).
5. **Stale-bundle ghost** — an hour of "still the same error" after fixes shipped was the browser running old JS while the server served a newer bundle (`CiYNMsCh`). The three-command deploy check (`ls` the served asset, `curl` the served index.html reference, `systemctl status` the process) proved the server correct and the browser cached; Incognito/close-tab loaded live code. Lesson 99's cousin, re-learned.

### Section 329: THE CLOSED OEM LOOP (the milestone)

`testprogram` (clean id, "Manual build" provenance, poses taught in the NeuRobots Program tab) uploaded, run from the **Monitor Run button**, `publish/ProjectState` state=2/auto/line=1/project=testprogram — **and the physical arm moved through the operator's taught poses.** A program **taught AND run entirely in NeuRobots, factory UI never opened.** This is the OEM thesis demonstrated end-to-end: teach in NeuRobots, run from NeuRobots; the Estun is the commodity actuator underneath. July 20, 2026.

### Section 330: OEM Parity Phase 0 roadmap (running / to be committed)

Prompt issued to produce `docs/oem_takeover_roadmap.md`: full verb+HTTP-endpoint inventory (captured vs source-only vs implemented), classified into build tracks — A DONE (teach-jog-run-recover-monitor loop), B AUTHORING (point teaching ✓, program CRUD, tool/coordinate frames), C MOTION COMPLETENESS (movL/movC/blend — only movJ today), D I/O + PERIPHERALS (grippers, sensors — uncaptured, needs an I/O-tab session), E PRODUCTION CONTROL (pause/resume/clearBreakpoint validation), F SAFETY (read + enforce; writes stay OEM by deliberate liability choice), G DIAGNOSTICS. Plus a grouped capture shopping list, a build order, a **"superiority layer"** section (deadman jog chain, collision guards, escape modals, twin, LiDAR keep-outs, PBD generation, provenance — features the factory UI lacks), and an exec-summary ownership percentage. This is the master plan for the takeover and doubles as investor/partner material.

### Section 331: OEM framing clarified (operator directive)

"Our controller will be the OEM — we are rebranding the physical robot and running it through our software." Technical reality named: the Estun **servo loop** (1 kHz torque/velocity, drive electronics in the CC10-A) physically stays in their hardware — it's the actuator. "Everything on our controller" = **every operator- and integrator-facing function originates in and is owned by our stack**; the Estun box is reduced to a motion-execution endpoint driven over the wire. Safety-parameter WRITES stay OEM by deliberate liability choice (read + enforce, don't rewrite certified safety config) — a positioning decision, not a capability gap.

### Section 332: Next-build staged prompts

Two prompts staged: (a) **teach-poses build** (shipped, §326); (b) a **speed entry box** with cap-truthful display (entered% × operator_speed_limit, shows "100% → capped to 25%", selects within the cap never overrides) + program-provenance fix (§327). The **Monitor run-state + step-preview panel** prompt is next: unify the IDLE-vs-state-2 pill (both must read `publish/ProjectState`), and a collapsible live step-preview highlighting the executing step from `scripts.{task}.line`.

### Section 333: Known bugs / debt carried out of July 20

- **IDLE pill vs state=2 mismatch** — status pill reads a stale source while the banner reads ProjectState; unify (prompt staged, §332).
- **Empty-program client-side guard** + **save byte-verify before run** — marked in-progress in the run-trace fix, not confirmed complete.
- **ErrorDedup stale-error** — `/estun/program_status` showed a cleared 10012 after ClearError (controller refloods same unix_ts); observability fix, doesn't affect stop correctness.
- **Dashboard zombie-WS wedge** — `websockets._drain_helper` AssertionError flood + backed-up send queues recurred (~3rd time); kicker not fully covering this failure mode.
- **Footer build-string lies** — prints the compile-time `git describe` (e.g. `ffd22ff-dirty`) even when a newer bundle is served; trust the console/curl asset hash, not the footer (defeats Lesson 92's tell again).
- ProgramWizard.jsx 4 pre-existing rules-of-hooks violations (still).

### Section 334: Git state through July 20

Chain (partial): `d059207` (ladder) → `a40ebee` (Monitor Run wired) → `b78ae6a` (provenance) → `f51d373` (teach poses) → `ffd22ff` (id-slug guard) → `bd8f3ce` (rename endpoint + clearer errors) → served bundle `CiYNMsCh` (later build). Branch `feature/estun-write-path`; two superseded URDFs deliberately untracked. Merge to main still queued as a supervised post-verification step (main misleads default ZIP downloads).

### Section 335: OPEN ITEMS at end of July 20

| Item | Priority | Notes |
|---|---|---|
| **Monitor run-state fix + live step-preview panel** | HIGH | §332/§333; the IDLE-vs-running bug + the collapsible step highlighter (also demo material) |
| **Wire pause/resume validation** (small ladder addendum) | MED | project/pause + resume still SOURCE-ONLY |
| **OEM Parity Phase 0 roadmap** — confirm run + commit the doc | HIGH | §330; master plan for the takeover |
| Empty-program guard + save byte-verify — confirm complete | MED | §333 |
| ErrorDedup stale-error observability fix | LOW | §333 |
| Dashboard zombie-WS wedge — kicker coverage | MED | recurring |
| Footer build-string accuracy | LOW | trust console hash meanwhile |
| Merge feature/estun-write-path → main | MED | supervised, after verification |
| Speed cap raise 0.25 → 0.50 | MED | one YAML line, gated on a clean week |
| ProgramWizard 4 hook violations | LOW | carried |
| Password rotation + SSH keys | MED | `aicollabs12` exposed in-session, twice — rotate + set up keys |
| I/O capture session (track D) | MED | grippers/sensors — required for real palletizing |

## PROCESS LESSONS (105–110)

105. **Capture-first is non-negotiable for motion verbs — and it pays compound interest.** The move-verb session not only delivered the run vocabulary but incidentally answered the autonomy question, exposed the Lua program format (deciding the whole architecture), proved the HTTP save path, and revealed the no-torque-sensor fact that validates vision-PBD. One disciplined capture replaced weeks of guessing.
106. **Validate SOURCE-ONLY verbs live-first, against a window built to expose failure.** The stop verb was proven against a 5-second-sleep program precisely so a wrong wire shape would be visible and recoverable — not against a program that finishes before the verb matters. Design the test so the dangerous case is the observable one.
107. **A proven pipeline still sheds integration bugs when wired to a UI — treat them as plumbing, not architecture.** Five distinct bugs (id slugs, metadata inheritance, save-before-run, orphan steps, stale bundle) all surfaced AFTER the ladder passed; none were design flaws. Trace each to its hop; don't relitigate the architecture.
108. **Teach points before steps.** Steps that reference not-yet-taught points are the orphan-step error class; authoring order (teach → then step) makes invalid references structurally impossible. Build the UI to encourage the safe order.
109. **When "the fix didn't work" repeats, verify the served artifact before touching code — again.** An hour was lost to a browser running old JS against a correctly-updated server. The three-command deploy check (served asset hash, index.html reference, process uptime) settles browser-vs-server in ten seconds. The footer build-string is not the tell — the console/curl asset hash is.
110. **Name the OEM boundary precisely: own the operator layer, drive the servo as commodity.** "Everything on our controller" does not mean relocating the 1 kHz servo loop (it stays in the drive hardware); it means every operator/integrator-facing function originates in our stack. Safety-parameter writes stay OEM by deliberate liability choice — sophistication, not a gap.

---

*Summary of Addendum 19: The move write path went from unknown protocol to a NeuRobots-authored program running on the real arm — in one arc. A capture-first session decoded the project run/stop/step vocabulary and the live ProjectState feed, revealed the controller's programs are Lua 5.3 against named points (deciding architecture B1: generate Lua + point table, HTTP-upload, project/run), and established that this arm has no torque sensor (vision-PBD is the only teach path). A three-rung validation ladder — stop-verb wire-proven at 214 ms, single-step decoded (N+1 presses), full run in 9.46 s — executed the first NeuRobots-generated program on the real arm, bracketed by gate-closed proofs. The Monitor Run button was wired to the pipeline (regenerate + re-upload every press, source_hash shown), in-UI pose teaching shipped (teach records, never moves; the gate governs run only), and provenance tracking corrected the mislabel bug. Wiring the validated pipeline to the UI shed five integration bugs — underscore ids, metadata inheritance, save-before-run, orphan steps, and a stale-bundle browser ghost — each traced and fixed as plumbing. The milestone: testprogram, taught and named and run entirely in NeuRobots, moved the physical arm through the operator's taught poses with the factory UI never opened. The OEM loop is closed. Six lessons, including the boundary that defines the company: own the operator layer, drive the servo as commodity — and the one re-learned in an hour of lost time, verify the served artifact before blaming the code.*

*Last updated: July 20, 2026 (Addendum 19 — Sections 319–335, Lessons 105–110)*
---

<!-- v46-content-end -->
