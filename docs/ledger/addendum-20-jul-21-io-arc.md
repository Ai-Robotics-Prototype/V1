---
ledger_split: addendum-20
source: cobot_project_conversation_v46.md
source_lines: 11911-12053 (inclusive)
title: The I/O arc — inventory, verbs, port map
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 20 — THE I/O ARC: INVENTORY, VERBS, PORT MAP, AND THE ROAD TO A RUNNING PICK-AND-PLACE (July 21, 2026)
*Append-only. Sections 336–350, Lessons 111–116. Covers: the System Check panel (built into Configure), the I/O capability push — verified port inventory (two independent ways), the IOManager WebSocket verbs, the authoritative CC10-A silkscreen pinout, the Lua verb captures (setDO/setAO/getDI confirmed, delay verb still open), the hardware-exact I/O port-map graphic, the "test wizard" pick-and-place blockers, and the ferrule/terminal hardware question. Ends mid-flight: one capture (delay verb) + one codegen pass (derived-pose resolver) from a running vacuum program.*

### Section 336: Session start — git reconciliation, two commits found

Fresh session state-check reconciled the git chain (the gap flagged at the end of Addendum 19): `9d53868` (OEM Parity Phase 0 roadmap — committed, the doc exists) and `027f839` (Monitor run-state unified + live step-preview panel) were both confirmed landed. So the run-state/step-preview feature requested at the close of July 20 was already built and pushed — committed-but-unverified. Driver came up `connected:true, state=0`.

### Section 337: System Check panel — built into Configure (commit 0121d31)

Read-only pre-flight/health panel, integrated into the existing Configure page (matched its styling), **five rows only** (design restraint held — green rows can't expand, detail only on trouble):
1. **Robot** — Ready/Disabled/Alarm/Offline (from /estun/status)
2. **Controller** — Connected/Disconnected (last-frame age vs 3s)
3. **Software** — Up to date/Refresh needed (served index.html hash vs built dist hash — the stale-bundle guard, making the July-20 lost hour structurally impossible to repeat)
4. **Services** — All running/N down (systemctl is-active on roboai-estun + roboai-dashboard)
5. **Safety** — Loaded/Check config (robot_limits.yaml, guard thresholds, ground_z, LiDAR zones)

**Safety boundary enforced in code:** the restart allowlist deliberately EXCLUDES roboai-estun — the arm's driver can never be restarted from a health panel, only the dashboard. Software-red = text-only recipe (no auto-redeploy button). Nothing auto-remediates the arm or gates. The Safety row shows amber ("Missing: joint limits") because robot_limits.yaml isn't at the expected path — a known reconciliation item, not a fault. **Live-validated later this session** (§348): when the driver was stopped, the panel correctly showed Robot Offline / Controller Disconnected / Services 1-down — it diagnosed the disconnect in plain language instead of leaving the operator guessing.

### Section 338: UI cleanup

Removed clutter (frontend only, runtimes untouched — explicitly confirmed): the **Quality Inspection** top-nav tab; the Configure **robot-connection panel** (folded into System Check's Controller/Robot rows); the Configure **safety-zone editor UI** (the collision-guard + LiDAR keep-out ENFORCEMENT runtime stays — only the hand-edit panel removed, which suits the OEM vision where zones come from perception); the **camera settings** panel (streams keep working). The "interface" panel contents were quoted before removal per the load-bearing-check guard.

### Section 339: I/O capability push — the goal

Operator drove toward running a vacuum pick-and-place ("test wizard"), which needs I/O the stack didn't have: SET_IO steps (vacuum/blow-off outputs) and WAIT steps showed **"pending capture"** in Monitor — the UI honestly flagging that I/O read/write verbs were never captured. This is the OEM-parity Track D (I/O), and it blocked a real, fully-taught program. The push: inventory the I/O, capture the verbs, extend codegen.

### Section 340: VERIFIED I/O inventory (two independent sources)

The starting port-map graphic hardcoded a provisional 8 DI / 8 DO (from a manual wiring-EXAMPLE subset — corrected). The real inventory, confirmed **two ways**:

**(a) Factory UI I/O panel enumeration** (the controller's own list):
- **Digital Input = 24 ports (0–23):** DI0–DI15 (16 general) + `modeSwitch`@16 + `enableButton`@17 (system-reserved) + `flangeButton0-3`@18–21 (18 = "Drag") + `flangeDI0/1`@22–23 (tool-flange)
- **Digital Output = 18 ports (0–17):** DO0–DO15 (16 general) + `flangeDO0/1`@16–17
- Plus Analog Input / Analog Output sections

**(b) CC10-A silkscreen label plate** (physical ground truth, operator photo):
- Nameplate: **Control Cabinet CC10-A, 1500W, 1PH AC100–240V, 8A, SN 12605280821, PN 15700001454**, IP20, made 28/05/2026
- **M-FUNC block:** CAN+/−, 485A1/B1, 485A2/B2, ON/OFF, 12V, COM, EN, **HDI1–4** (high-speed digital inputs), COM2
- **DI0–DI15:** DI0–7 paired with **0V** (SINK), DI8–15 paired with **24V** (SOURCE) — the sink-vs-source wiring split
- **PWR CFG/FUSE:** COM1, 24V, GND/0V, FUSE
- **DO0–DO15:** DO0–7 with 0V, DO8–15 with 24V
- **Analog:** AO0–AO3 (AGND0–3), AI0–AI3 (AGND4–7)
- **Safety:** VO1±, VO2±, ES1–ES4 A±/B± (4 dual-channel safety inputs), CHA/CHB

The two sources reconcile exactly. **Total signal channels = 54** (4 HDI + 16 DI + 16 DO + 4 AI + 4 AO + 10 flange). The "8 DI/8 DO" guess is retired; the map is now hardware-exact.

### Section 341: IOManager WebSocket verbs (captured)

From an I/O-panel capture (HAR `data/estun_captures/estun_io_20260721.har`):
```
IOManager/GetIOInfo        — enumerate
IOManager/GetIOValue       {db:[{type,port},...]}          — batch read all I/O
IOManager/SetIOForcedFlag  {db:{port,value,type}}          — FORCE/override (diagnostic)
```
**Key distinction drawn:** `SetIOForcedFlag` is a **force/override** — the diagnostic tool the I/O panel uses to clamp a pin, NOT the normal way a program sets an output. Confirmed on the wire for `type:"DI"`; DO-force unverified. The application-level output SET belongs in the **Lua program** (SetOut/setDO), not this WS verb — so SET_IO codegen is a Lua concern, consistent with B1.

### Section 342: Lua verbs captured from the API dictionary (setDO, setAO, getDI)

The controller's editor fetches `luaenginelib.json` + `luadoc.json` — the **complete Lua function dictionary**. A "with content" HAR (`estun_lua_io_v2_20260721.har`, 43 MB — the earlier 4.5 MB exports were WS-filtered and lacked HTTP bodies; Lesson 113) carried these. Verbs extracted **verbatim**:
```
setDO(<n>, 0|1)      — digital output set   [wire/doc-verified]
setAO(<n>, <value>)  — analog output set    [doc-verified]
getDI(<n>)           — digital input read   [doc-verified]  →  _diN = getDI(n)
```
Codegen (`program_ops.codegen_lua_from_program`) extended: `set_io` DO→`setDO`, AO→`setAO`; `wait_input` DI→`getDI`. Commits `bd7d474`, `b1099ea`. The frontend StepPreviewPanel reclassified `wait_input`→nonmotion ("read {io_id} (getDI)").

**STILL OPEN — the delay/wait verb:** audit-confirmed **absent** from `luaenginelib.json` (searched the candidate set Sleep/Wait/Delay/WaitTime). Working hypothesis: the delay is an editor NODE that compiles to a loop/timer construct, not a callable Lua function — so it only reveals itself in a saved Wait-node's generated source. Requires one more capture (a Wait-node save, "with content" HAR) OR pulling the full luadoc.json content (may spell it under a Control/System category). Flagged `wait` as "no delay verb" (definitive, not merely uncaptured).

### Section 343: The hardware-exact I/O port map (commit 380a09f)

Rebuilt from the silkscreen plate + software enumeration. `/api/io/portmap` emits both layers (WS + Lua verbs, 12 verbs with per-verb verified/blocked status). Rendering:
- Mirrors the physical plate layout with real terminal names.
- **Sink/source badges:** DI-A/DO-A blocks = blue "SINK · 0V", DI-B/DO-B = green "SOURCE · 24V", with tooltips ("sensor pulls DIn LOW through 0V" vs "HIGH from 24V") — surfaces the wiring polarity so PNP/NPN sensors aren't miswired.
- **Safety terminals (22)** rendered as non-editable red "SAF" chips — in the safety-PLC domain, display-and-respect only, never commanded (the deliberate OEM safety boundary).
- **HDI1–4** and CAN/485/power shown as physical-only (not IOManager software ports).
- Editable per-port assignments + notes persist to `io_map.json`; live-state layer present but inert pending live I/O validation.

### Section 344: "test wizard" — the pick-and-place blockers

A 16-step vacuum pick-and-place (Manual build, real taught poses). Codegen status after the verb work:
- **Motion anchors** (move_joint/move_home with taught poses) → `movJ(pN)` ✓
- **SET_IO** (Vacuum off DO2, Blow off DO3, Blow off stop DO3) → `setDO(2,0)`, `setDO(3,1)`, `setDO(3,0)` ✓ all 5 emit cleanly
- **derived_from MOVE_LINEAR** (steps 3/6/8/13 — approach/descend/lift, defined as anchor pose ± Z offset) → `-- skipped`: **needs a derived-pose resolver** (resolve derived_from + offset into concrete taught_joints/tcp at codegen time via FK/IK). Pure codegen task, no capture.
- **WAIT** (timed) → `-- skipped`: blocked on the delay verb (§342)

So two blockers remain: **(1) the delay verb** (one capture), **(2) the derived-pose resolver** (one codegen pass). Nothing else. When both clear, every step emits real Lua and the program runs.

### Section 345: First-live-I/O safety posture

`setDO` on a running program **energizes real outputs** (vacuum, blow-off). The agreed first-live discipline mirrors first-motion: cell clear, e-stop in hand, 10% speed, and validate `setDO` in ISOLATION first (force one DO, confirm the wired load actually switches) before trusting it inside a full cycle. "test wizard" also LOOPS (step 16 "Repeat continuously") — STOP must be ready; do not let the first run cycle unattended.

### Section 346: The ferrule / terminal question (hardware, unresolved)

Operator's ferrules wouldn't latch in the DI/DO terminals. Analysis: these are **push-in spring-cage terminals** (the orange tabs are release actuators) — the likely fix is **depress the orange actuator while inserting**, not a special ferrule. If that's not it, the probable cause is **ferrule cross-section too large** (compact I/O blocks typically accept ~24–20 AWG / 0.2–0.5 mm²; the cell cable read 28 AWG) or **wrong pin length / insulated-collar profile**. The manual (scanned images) does not state the terminal's mechanical spec (accepted gauge, strip length, ferrule type) — that lives in the connector maker's datasheet. Recommended: read the connector-body brand/PN, or confirm with Estun via the CC10-A model + PN. **Not resolved in-session**; flagged not to force a marginal crimp on an I/O line.

### Section 347: "Harness everything at once" — the efficiency turn

Operator observed the one-off capture-and-relay loop is the bottleneck. Two levels identified:
- **Level 1 (verb dictionary in one shot):** `luaenginelib.json` + `luadoc.json` are the COMPLETE Lua function library. Pull their full content once (`curl` from the Jetson, controller reachable) → parse the entire verb table (motion, I/O, delay, gripper, logic, loops) → unblocks codegen for the whole roadmap, not one verb at a time. Likely surfaces the delay verb too (unless it's a node-only construct).
- **Level 2 (stop hand-relaying):** Claude Code is on the 192.168.2.x network and can `curl` the controller's HTTP endpoints directly (API docs, stored program Lua via `robotcode/.../select/main/`, I/O enumeration) — most read-only captures need no browser/DevTools/operator relay at all. Reserve manual browser capture for WS-only data or UI actions with no HTTP equivalent. The git-mailbox relay agent is the existing me→Claude-Code channel. This collapses the relay to only the moments needing hands (motion validation, wiring, e-stop).

### Section 348: Driver-stopped-from-capture incident (recovered)

After the I/O capture (driver stopped for clean factory-UI WS ownership), the operator later couldn't connect — System Check showed Robot Offline / Controller Disconnected / Services 1-down. Root cause: `roboai-estun` was still stopped from the capture, never restarted. Fix: `sudo systemctl start roboai-estun` → `connected:true`. The System Check panel proved its worth by diagnosing it in plain language. (Also a repeat of the PowerShell-vs-Jetson wrong-window slip: `sudo systemctl` first pasted into PowerShell → "Sudo is disabled on this machine".)

### Section 349: Git state through July 21

Chain (I/O arc): `027f839` (run-state + step panel) → `0121d31` (System Check) → [UI cleanup] → I/O captures → `bd7d474` / `b1099ea` (setDO/setAO/getDI codegen) → `380a09f` (hardware-exact port map) → `b1099ea`/`4b775bae` (wait-verb audit) → `11167ee` port-map refinements. Branch `feature/estun-write-path`; two superseded URDFs still deliberately untracked. Merge-to-main still queued (supervised, post-verification).

### Section 350: OPEN ITEMS at end of July 21

| Item | Priority | Notes |
|---|---|---|
| **Delay/wait verb capture** | HIGH | Last verb for test wizard; capture a Wait-node save (with-content HAR) OR pull full luadoc.json content |
| **derived-pose resolver (codegen)** | HIGH | Steps 3/6/8/13 → real movL; no capture needed |
| **First live I/O run of test wizard** | HIGH | After the two above; §345 safety posture — isolate setDO first, e-stop, 10%, don't loop unattended |
| **Pull full Lua verb dictionary** (luaenginelib/luadoc) | HIGH | §347 L1 — unblocks the whole codegen roadmap at once |
| **Let Claude Code self-serve HTTP captures** | MED | §347 L2 — collapse the relay |
| Ferrule/terminal spec | MED | §346 — identify connector maker or confirm with Estun; don't force crimp |
| Safety-row robot_limits.yaml path | LOW | System Check amber — reconcile path so a healthy cell shows green |
| System Check `027f839` + panel live-verify | MED | run-state/step-preview panel committed, not fully exercised |
| Analog I/O verbs live-validate (setAO) | LOW | doc-confirmed, not hardware-tested |
| DI-force-on-DO / force-vs-set clarity | LOW | SetIOForcedFlag force semantics documented; keep force behind allow_io + warning |
| Merge feature/estun-write-path → main | MED | supervised, after test wizard runs |
| Password rotation + SSH keys | MED | `aicollabs12` exposed in-session (carried) |
| Pause/resume validation (move path) | MED | still SOURCE-ONLY (carried from Addendum 19) |

## PROCESS LESSONS (111–116)

111. **Verify hardware counts against the hardware, not a wiring example.** The port map's 8 DI/8 DO came from a manual illustration showing a subset; the truth (24 DI / 18 DO + analog + flange + HDI) came from the controller's own enumeration AND the silkscreen plate, which reconciled exactly. Two independent sources beat one inferred number — and neither was the wiring-example diagram.
112. **"Force" is not "set."** `SetIOForcedFlag` is a diagnostic override that clamps a pin regardless of program logic; a program setting an output uses the Lua `setDO`. Conflating them would have wired SET_IO steps to the wrong mechanism. Distinguish diagnostic-force from normal-set in both code and UI, and keep force gated + warned.
113. **"Save all as HAR" honors the current filter — and drops bodies without "with content."** Three failed captures were WS-filtered (no HTTP POST) or saved without content (no `postData.text`). For HTTP protocol captures: filter "All", check Preserve log, and use "Save all as HAR **with content**". The size tell: a real capture is much larger and `grep postData` finds `"text":` bodies.
114. **Refuse to guess verb spellings — a wrong token rejects the whole program.** Claude Code repeatedly stopped rather than fabricate Lua verb names, because a bad spelling triggers the controller's parse-error class (the same one that bit movJ bring-up). Verbatim-from-source or nothing. This discipline is correct even when it costs a recapture.
115. **The health panel is worth its weight the first time it diagnoses instead of you.** System Check turned "I can't connect" into "Controller Disconnected / Services 1-down" — pointing straight at the still-stopped driver. Build the boring read-only diagnostics; they pay off exactly when you're tired and something's wrong.
116. **When the relay loop becomes the bottleneck, harness the source, not the symptom.** Capturing verbs one editor-node at a time is slow; the full Lua dictionary (luaenginelib/luadoc) grabs them all at once, and letting the on-network agent curl HTTP endpoints directly removes the human relay for read-only work. Reserve the human-in-the-loop for what genuinely needs hands: motion, wiring, e-stop.

---

*Summary of Addendum 20: The I/O arc took the stack from "no I/O capability" toward a runnable vacuum pick-and-place. A read-only System Check panel landed in Configure (five rows, arm-restart deliberately disallowed) and immediately earned its keep by diagnosing a disconnect. The I/O inventory was verified two independent ways — the factory UI's port enumeration and the CC10-A silkscreen plate — reconciling to 54 signal channels (16 DI + 16 DO general, 4 AI + 4 AO, flange DI/DO, HDI, plus 4 dual-channel safety), retiring the provisional 8/8 guess. The IOManager WebSocket verbs (GetIOInfo/GetIOValue/SetIOForcedFlag) were captured, with the crucial force-vs-set distinction drawn. From the controller's own Lua dictionary, setDO/setAO/getDI were confirmed verbatim and wired into codegen; the delay/wait verb proved absent from the function list (likely a node-level construct) and remains the one open capture. A hardware-exact port map shipped with sink/source wiring badges and safety terminals walled off. "test wizard" now emits clean setDO lines and getDI reads; two blockers remain — the delay verb and a derived-pose resolver for its approach/descend/lift steps — leaving it one capture and one codegen pass from a first live run (which will energize real outputs, so first-motion safety discipline applies). The session closed on an efficiency insight: harness the full Lua dictionary at once and let the on-network agent self-serve HTTP captures, rather than relaying editor-node captures one at a time. Six lessons, including the two that will keep paying out: verify hardware against hardware, and refuse to guess verb spellings.*

*Last updated: July 21, 2026 (Addendum 20 — Sections 336–350, Lessons 111–116)*
---

<!-- v46-content-end -->
