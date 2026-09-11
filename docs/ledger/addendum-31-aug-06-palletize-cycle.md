---
ledger_split: addendum-31
source: cobot_project_conversation_v46.md
source_lines: 13389-13488 (inclusive)
title: Palletize cycle runs, deploy stops lying, cell box spec
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 31 — August 6, 2026 — THE PALLETIZE CYCLE RUNS, THE DEPLOY STOPS LYING, AND THE CELL BOX GETS SPEC'D
*(Appended in full. Nothing above this line was removed. The day the palletize program went from "placed geometry once" toward a real, inspectable, repeating pick-and-place — and the day two foundational reliability lies were finally killed: the deploy-hash that measured the wrong file, and the browser cache that served stale bundles. Also: the first real hardware-agnostic Cell Box I/O architecture, spec'd around an EtherNet/IP valve island for machine tending — not just gripper vacuum, but closing CNC doors and pressing cycle-start buttons. A hard, honest conversation about the week's performance drop, and the verification discipline that came out of it.)*

### Section 495: The enable button — the blast-radius verification discipline, born from a real miss

The operator asked to put the robot enable/disable control on the Monitor screen. A prior session reported it done; it was not. Grepping the actual source (`MonitorDashboard.jsx`) proved `ArmEnableControl` was entirely absent — only button-disable states existed. This "reported done, actually absent" became the template case for a new discipline: **every fix prompt maps its blast radius up front** (every file/surface the change must touch) and **verifies each surface with pasted grep evidence**, not a prose "✓ done." The fix: extract the enable control from `View3DLayout.jsx` into one shared `ArmEnableControl` component, render it in BOTH 3D View and Monitor, bind both to the same store state, fork-registry entry so no second implementation drifts. Verified: `MonitorDashboard.jsx:13 import` + `:1246 <ArmEnableControl />`, and `verify_deploy.sh → DEPLOYED (match)`. The acceptance test was the exact grep that returned empty before now returning a render line — falsifiable, not assertable.

### Section 496: THE DEPLOY WAS LYING — hashing the wrong file

Root cause of a huge fraction of the week's "I said fix it and nothing happened": **the deploy watcher computed `served_asset` by hashing `index.html`, not the content-hashed `index-*.js` bundle Vite actually produces.** `index.html` barely changes between builds, so the reported version stayed frozen (`DbEn17aP`) across commits with genuinely different app code. Every real frontend fix shipped but *reported* an unchanged version — the operator would refresh, see the same version, and correctly conclude nothing happened, when often something had. This retroactively vindicates much of the week: **some "phantom fixes" were real fixes behind a lying gauge.** Fixed: the watcher now hashes the real `index-*.js`; a frontend-changed-but-hash-unchanged build is now a LOUD `phase=frontend_stale` failure, not silent `ok`. First proof it worked: served asset finally *moved* (`DbEn17aP → Csq4hQ7g`). Added `scripts/verify_deploy.sh` — one command printing HEAD sha, served bundle hash, and MATCH/MISMATCH; read-only, cannot itself cause issues; now the standard last-step after any fix.

### Section 497: The stale-bundle problem — browser cache holding old code

Even with honest deploys, the tablet repeatedly ran old bundles, showing "New app version available — this tab is running <old>." Root cause: browser-side caching (likely `index.html` served with long cache headers, and/or a service worker) holding the old bundle so a plain refresh didn't pick up new code. Directed fix: `index.html` served `no-cache, must-revalidate` (it's the pointer to the current bundle), hashed `/assets/*` cache-forever (safe, name changes on change); service worker set to auto-update or removed; the "new version" toast made to actually force/one-tap reload. Flagged as **fleet-critical**: a customer silently running stale code = shipped fixes that never reach the floor. Same class as the deploy-hash lie — both are "make sure the code you shipped is the code that's running," which a fleet of unreachable robots absolutely requires.

### Section 498: The jog jitter — measured, not guessed; WiFi exonerated, lock contention convicted

Operator reported constant jog jitter. Claude's instinct said WiFi; the measurement said otherwise and Claude was wrong — a clean win for measure-first. Evidence: WiFi healthy (94% signal, 0 tx retries, 3ms RTT), and the gaps were **periodic ~180ms spikes every ~1000ms** — regular = code, not random = network. Root cause: **the 1Hz teach-session self-heal timer held the global teach lock during synchronous draft-file disk I/O (~150-180ms); the jog heartbeat needed the same lock and blocked behind it once per second** — and the self-heal ran even when nobody was teaching. Fixed three ways: self-heal skips entirely when no session active; lock released before disk I/O; jog heartbeat given its own `_hb_lock` so teach housekeeping can never stall it. Proven with the exact before/after histogram: idle-jog p99 **187ms → 79ms**, periodic spikes gone (nothing over 100ms); even jog-while-teaching worst case 210ms → 92ms. Regression test pinned (heartbeat completes <20ms even under a 500ms self-heal). Textbook loop: measured → found real cause (not the guess) → fixed mechanism → proved with the finding histogram → pinned.

### Section 499: The palletize subroutine — from skip-comment to real, inspectable, editable operation

The palletize codegen arc reached maturity across several commits:
- **Pick-loop structure fixed**: the program had picked ONCE then placed N times (I/O stranded: one vacuum-on, N releases). Restructured so each cycle is a COMPLETE pick+place with its own paired I/O — go to pick, vacuum on, carry, place, release, repeat N times, home once at start/end.
- **Operator doctrine locked** (canonical): pick source = ONE fixed taught pick pose reused per cycle, count = `part_count` (edit-box field, autofilled from the demonstration's stated quantity, operator-editable). Fill layer-by-layer (all of layer 1 before layer 2). Layer stacks UP. Part-count termination — partial top layer fine, no empty cycles.
- **Approach motion model** (canonical, A/B/C): (A) approach = offset back along the POSE'S OWN axis (not world-Z), linear move to contact — accommodates angled picks/places; (B) approach distance constant but the approach POINT rises per layer so a layer-2 place approaches from above layer 2 and never dips to layer-1 Z (clears placed parts); (C) optional teachable approach pose for angled cases, still per-layer per B.
- **Vacuum I/O in the edit box**: vacuum port (required, from `io_map`, not hardcoded) + optional blow-off port with pulse; N vacuum-ON and N vacuum-OFF, paired.
- **Dynamic transit height**: `transit_Z = slot_Z(layer) + layer_height + safety_margin` (default 50mm), rising per layer.
- **First hardware run**: the program RAN — geometry correct, layers stacked correctly (after fixing a layer-2-emitted-BELOW-layer-1 sign bug: Z was going down 100mm, a crash risk, corrected to stack up). Verified GO with 5 cycles, layer-0 filled then layer-1 above. This was the milestone the whole week built toward: **the program that killed the controller three times last week ran a real palletize pattern.**
- **Expandable/editable step view**: clicking the `move_to_pallet` step expands to show the full per-cycle template (12 steps: pick_approach → linear-down → vacuum → wait → linear-up → transit → traverse → place_approach → linear-down → release → linear-up → transit). Shipped first as read-only preview; directed to upgrade to **program-styled, shaded, editable step rows** where editing a field (mode A: tune-the-generation) writes back to pallet config and regenerates ALL cycles — preserving deterministic-composer integrity (no free-hand per-step edits that desync).

### Section 500: The performance-drop reckoning and the verification gate

A hard, direct conversation: the operator was rightly frustrated that simple fixes took multiple attempts and cost money. Honest diagnosis of the three mechanisms behind "reported done, not done": (1) the deploy-hash lie (real fixes reporting stale versions), (2) browser cache hiding shipped fixes, (3) reports trusted without verifying against the running system. None were "the fix wasn't written" — all were feedback-loop failures where the system lied about whether code changed. Committed process changes: every fix prompt ends with a self-verifying check that pastes raw evidence (grep/hash/rendered state), not prose "done"; the code-review gate (operator uploads branch, Claude greps actual source) becomes the checkpoint between "Claude Code says done" and "operator tests"; deliberately NOT building a heavy end-to-end gauntlet right now (adding complexity to a stabilizing pipeline is itself a risk) — small, read-only, additive tooling only. The honest ceiling named: a solo operator running an AI dev loop on live hardware is the developer, QA, and operator simultaneously — the verification tooling shrinks the pain but the real fix is the controls/software hires. Also diagnosed: "half-wired" fixes (changes landing in 6 of 7 places) come from prompts scoped to the symptom, not the change's full blast radius — hence the blast-radius mapping discipline.

### Section 501: The network/IP-wander incident, and fleet-connection architecture

The Jetson dropped its SSH session ("Connection reset") and, on reboot, DHCP handed it a new IP (`.246 → .143`) — the tablet and SSH couldn't find it. Diagnosis: the client-facing connection is on **WiFi** (`wlP1p1s0`, `192.168.1.x`, DHCP-dynamic — the wandering one); the wired port (`eno1`, `192.168.2.246`, static) is the isolated robot control network to the CC10-A. The `.246` the operator kept typing was the *robot-side* address all along — source of much confusion. Fix directed but deferred by operator: pin the WiFi MAC (`50:2e:91:95:b6:15`) to a fixed shop-LAN IP via router reservation. Reframed as fleet-critical: "the robot's IP changed and the tablet can't find it" = a dead cell + support call at a customer. Fleet-connection architecture articulated in four layers: (1) each cell self-contained, local-first, fixed hostname, no-SSH operation; (2) remote observe+update over secure outbound tunnel (never remote motion command); (3) a fleet console (cockpit for N cells); (4) the corrections-corpus flywheel. Doctrine: **cell self-sufficiency is the prerequisite for everything above it** — the unglamorous hardening (disk watchdog, link honesty, guided recovery, fixed identity) IS the fleet strategy, and every "why do I have to SSH in to fix this" is a Layer-1 gap that multiplies by N in the field. Lesson: the bugs that cost the week weren't in the robotics — they were in everything around it a customer would hit first.

### Section 502: THE CELL BOX I/O ARCHITECTURE — EtherNet/IP valve island for machine tending

A major architecture thread: how the separate control box signals I/O, and what it should drive. Decisions reached:
- **Protocol**: the operator selected a **PAL (Aventics-style) EtherNet/IP valve+I/O island** — so the Cell Box I/O protocol is **EtherNet/IP** (not Modbus TCP). More capable and more credible for industrial/Fanuc customers; more HAL implementation work than Modbus (needs a `pycomm3`/EtherNet-IP backend). `io_map.json` still abstracts it — codegen's "engage vacuum" resolves to a named effector regardless of wire protocol.
- **Physical hookup**: the island joins the **robot control network (`192.168.2.x`)**, the isolated segment with the Jetson's `eno1` and the CC10-A — via a small **industrial DIN-rail switch** added to the Cell Box (Jetson `eno1` + controller + island + future camera all on one switch). CAT5e/CAT6; island likely uses M12-D connectors (M12-to-RJ45 cables). Static IPs on `192.168.2.x`. Mental model: **`192.168.2.x` is the "robot control bus."**
- **Valve selection**: single-solenoid spring-return 24VDC for vacuum/blow-off (fail-safe-off, matches the `setDO` model); **locking manual overrides** on every station (commissioning/maintenance ground-truth — test a valve by hand independent of software, distinguishing plumbing failure from signal failure). Vacuum = 3/2 NC hi-flo; blow-off = 3/2 NC (NOT normally-open, which would vent continuously at rest).
- **SCOPE EXPANSION — the box is the cell's actuation hub, not just EOAT**: the operator clarified it also powers peripheral fixtures — **closing a manual CNC's door, firing an actuator to press cycle-start**, clamps, etc. This reframed valve selection: cycle-start = 5/2 single-sol (extend to push, spring retract); **CNC door = 5/3 closed-center (double-solenoid) — HOLDS position on power loss**, the safety-correct choice for an actuator near an operator. Default state becomes a per-actuator safety judgment ("what's safe if power dies mid-motion").
- **4 vs 8 solenoids per base explained**: both are 4-position bases; 4-solenoid drives up to 4 single-solenoid valves (1 coil each), 8-solenoid drives 4 double-solenoid/closed-center valves (2 coils each) — the 8-solenoid base is for the hold-on-power-loss valves (doors, clamps). Operator's two-base build (PAL-B4414 + PAL-B4814) correctly provisions both single-sol spring-return stations and double-sol hold-position stations. Software note: double-solenoid actuators are TWO named outputs (extend/retract), not one on/off — codegen/effector model must handle two-coil actuators.
- **Interlock note**: an actuator pressing CNC cycle-start is a machine-motion trigger — must be interlocked (via `roboai-logic` soft-PLC) against the arm being clear of the machine envelope and the door closed. "Don't press start until the arm has retracted and the door is closed" is a real safety sequence.
- **Guided commissioning wizard** (roadmap): the interface should not just document which port to use but VERIFY it — "plug vacuum into Slot X, press Test" fires the output and asks the operator to confirm; sensor inputs auto-discovered by watching which input changes; the flow auto-writes `io_map.json`. Device-type-driven (vacuum vs gripper vs door → right port + right valve type). Uses the locking manual overrides as the physical-layer fallback check. This is the "commissioning is a guided conversation, not a wiring project" product moment.

### Section 503: Session status ledger (August 6, end of day)

| Item | Status |
|---|---|
| Deploy-hash lie fixed (hash real JS bundle, loud frontend_stale) | **SHIPPED — foundational; retroactively explains much of the week** |
| scripts/verify_deploy.sh (one-command deploy truth) | **SHIPPED — now the standard last-step** |
| Enable control on Monitor + 3D View (shared component) | **SHIPPED + grep-verified on both** |
| Jog jitter (self-heal lock contention) | **FIXED + histogram-proven: p99 187→79ms, spikes gone** |
| Palletize: pick-loop + I/O pairing + approach A/B/C + transit + part-count | **SHIPPED — first real hardware palletize run, geometry+layers correct** |
| Palletize expandable step view (read-only preview) | **SHIPPED** |
| Palletize expandable → editable shaded step rows (mode A regeneration) | **DIRECTED — the last UX piece** |
| Null-owner save fix (7 endpoints, shared gate) | **SHIPPED earlier + regression-tested** |
| Collision guard fully OFF (COLLISION_ENABLED wired to ROS param) | **SHIPPED — startup log confirms DISABLED** |
| Stale-bundle browser cache fix (index.html no-cache) | **DIRECTED — fleet-critical, still to land** |
| WiFi IP-wander → static/reservation | **DEFERRED by operator — board note: pin MAC 50:2e:91:95:b6:15** |
| Teach-status icons render gray on tablet | **LIKELY stale-bundle, not a real bug — recheck on current bundle** |
| Cell Box I/O = EtherNet/IP valve island (PAL) | **SPEC'D — 2-base (B4414+B4814), machine-tending scope** |
| EtherNet/IP HAL backend + io_map effector mapping | **PROMPT-READY — buildable before hardware arrives** |
| Guided commissioning wizard (verified port mapping) | **ROADMAP — gated on island in hand** |
| Bowl 10% acceptance run | **STILL OPEN — oldest loop** |
| /opt/cobot backup | **STILL OPEN — oldest item** |
| git push (feature/estun-write-path → origin, PR #2 open, 144 commits) | **PUSHED — do NOT merge to main until a clean palletize cycle earns it** |
| Estun bug report (#1/#2/#3 + logs) | **OWED** |
| RunPod account (gates vision Phase 2) | **STILL UNOPENED** |
| Blast-radius + per-surface-grep verification discipline | **ADOPTED as standing process** |

## PROCESS LESSONS (202–210)

202. **The deploy can lie about what it shipped — measure the artifact that actually runs.** Hashing `index.html` instead of the content-hashed JS bundle froze the version indicator while real code changed underneath. A version number is only trustworthy if it fingerprints the thing that executes. Much of the week's "phantom fix" pain was real fixes behind a lying gauge.

203. **Browser cache is part of the deploy.** Shipping to the server isn't shipping to the operator if the tab serves stale cache. `index.html` no-cache + hashed-assets-forever is not a nicety — it's how the code you deployed becomes the code that runs.

204. **Measure before believing your own instinct.** Claude's WiFi hypothesis for the jog jitter was wrong; the gap histogram (periodic, not random) pointed at code, and the code was the culprit. Instinct — including the assistant's — is a hypothesis, not a verdict. The histogram that finds the bug is also the acceptance test that proves the fix.

205. **A fix's unit of work is the whole blast radius, not the symptom.** "Half-wired" fixes (shared component built but not rendered on the second screen; validator changed but its copy stale) come from scoping to what the operator reported instead of everything the change touches. Enumerate every surface up front; verify each with evidence.

206. **"Reported done" is a hypothesis; a grep is the proof.** The enable button was reported on Monitor and wasn't. The acceptance test became the exact grep that returned empty before — falsifiable, run against the real source, not the report. No prose "done" survives an empty grep.

207. **A verification tool must only read, never execute.** The anti-flakiness fix cannot itself add flakiness. `verify_deploy.sh` inspects state and reports truth; it changes nothing, so it cannot regress anything. Fix reliability with instruments, not with more moving parts.

208. **Default state is a per-actuator safety decision.** Vacuum-off-on-power-loss drops a part (fine); a CNC door or clamp flinging on power loss is a hazard — hence 5/3 closed-center that holds position. "What is safe if power dies mid-motion?" is asked per device, not answered once for the cell.

209. **Sense what you automate.** Machine tending is input-hungry: door-closed, cycle-complete, part-present, clamp-closed. What the cell can *sense* separates "safely autonomous" from "running blind on timers." Provision inputs for the states that gate safety, not just the outputs that cause motion.

210. **The moat is the boring layer.** The valve island, the fixed IP, the disk watchdog, the honest deploy, the guided commissioning — none are robotics breakthroughs, and all are what turn "works for the person who built it" into "works for someone who didn't." The week's costliest bugs lived entirely in this layer, which is exactly the layer a customer hits first and the layer the Cell Box productizes.

---

*Summary of Addendum 31: the day the palletize program stopped being a promise and started being a cycle — pick, place layer by layer, stack upward, terminate on part count — while two foundational lies that had poisoned the whole week were finally killed. The deploy watcher had been hashing the wrong file, freezing the version indicator so real fixes reported as no-ops; the browser had been serving stale bundles so shipped fixes never reached the tablet. Together they manufactured the maddening "I said fix it and nothing happened" pattern, and naming them retroactively vindicated a stretch of work that had in fact shipped behind a broken gauge. Out of the reckoning came a verification discipline with teeth: blast-radius mapping so fixes stop landing half-wired, per-surface grep evidence so "reported done" can't outrun the source, and a one-command deploy truth-check that only reads and so can never itself break. The jog jitter fell to measurement over instinct — Claude's WiFi guess was wrong, a once-per-second lock-contention stall was right, and the histogram that found it proved it gone (187→79ms). And the Cell Box got real: an EtherNet/IP valve island scoped not just for gripper vacuum but for the whole machine-tending job — closing a manual CNC's door with a hold-on-power-loss closed-center valve, pressing cycle-start with a spring-return actuator, every station a named effector in io_map.json, every default state a per-actuator safety decision, all on an isolated robot-control bus the Jetson orchestrates. Nine lessons, and the one that frames the rest: the moat is the boring layer — the fixed IP, the honest deploy, the valve island, the guided commissioning — because that is precisely the layer a customer hits first, and the layer that separates a robot that works for the person who built it from a product that works for someone who didn't.*

*Last updated: August 6, 2026 (Addendum 31 — Sections 495–503, Lessons 202–210)*
<!-- v46-content-end -->
