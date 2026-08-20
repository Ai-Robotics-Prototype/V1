---
ledger_split: addendum-30
source: cobot_project_conversation_v46.md
source_lines: 13258-13388 (inclusive)
title: Teach-pipeline siege, disk-full cascade, lock incidents
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 30 — August 5, 2026 — THE TEACH-PIPELINE SIEGE: A DISK-FULL CASCADE, FOUR LOCK INCIDENTS TRACED TO ONE BROKEN PRIMITIVE, AND THE DAY THE OPERATOR WAS RIGHT EVERY SINGLE TIME
*(Appended in full. Nothing above this line was removed. The day the palletizing program refused to finish being taught — not from one bug but from a chain of them, each masking the next: the pallet-frame validator enforcing the wrong doctrine, the teach-session lock trapping the tablet four separate times, the J6 clamp caging the jog, Record reporting success on poses Save couldn't see, and underneath it all a 57 GB disk filling to 100% on the platform's own wire logs — which crashed the record endpoint, half-landed a fix under ENOSPC, and crash-looped the dashboard fifteen times. Ended with a full code review that found the root cause of every lock incident in a single line: device identity stored per-tab instead of per-device. Eleven-plus commits, a business-strategy thread with a live investor, and the hardest week the operator has had at the pendant.)*

### Section 483: The J6 clamp trap — a guard that blocked its own exit

Continuing from Addendum 29's jog-clamp finding, the J6 dynamic joint-limit clamp produced its sharpest failure: with J6 wound to −193.31° (past the −191.90° soft limit), the clamp rejected **all** J6 jogs — including +J6, the direction that would recover it. The operator, correctly: "a soft limit is a wall, not a cage — the jog button should only fail if you're going further into the angle it cannot pass." The clamp checked `|angle| > limit` without checking the sign of the commanded motion. Compounding it, eleven identical reject toasts stacked and physically covered the J6 jog column. Fix directed: the **escape-direction rule** — a jog is rejected only if the commanded delta deepens the violation; motion toward the legal band is always allowed. Plus toast coalescing (one message with a counter, never covering controls) and a guided **Joint Recovery dialog** (offer, operator-confirmed, never auto-move — the recovery move goes through the same jog path, dead-man intact). The dialog shipped broken (dead button, unreadable text — a fix that failed its own bench verification), demoting it to assist-layer while the escape-direction clamp became the real fix. Doctrine crystallized: **guards must always leave the exit open, on every surface the guard appears.**

### Section 484: The pallet-pitch validator enforced the wrong doctrine

The palletize promote was refused with "Row pitch: typed 150.0mm vs measured 341.2mm — differ by 191.2mm." The check assumed corners were taught at far *slot centers* and derived pitch from corner-to-corner distance. The operator issued a doctrine ruling that became canonical: **corners 1–3 build the pallet FRAME ONLY** (origin, row axis, column axis, plane); **point 4 is the center of the first part place** (slot [1,1]); **slot spacing comes exclusively from the typed pitch** in the parameters dialog — `slot[i,j] = datum + (i-1)·pitch_row·row_axis + (j-1)·pitch_col·col_axis`. Corner-to-corner distance has no required relationship to pitch. Fix directed: remove the pitch-vs-corner-distance check entirely; replace with the check that IS valid under these semantics — the grid must FIT the frame (grid extent vs taught frame extent, warning if the grid exceeds it, error if wildly beyond — still catches a pitch typo like 1500 for 150 without false-positiving a legitimate config). Wizard/teach copy updated to teach the doctrine so the operator never has to infer which model is in force.

### Section 485: The teach-session lock — four incidents, one broken primitive

The teach-session lock ("teach session owned by another device") blocked the tablet across FOUR separate incidents over two days. Each fix addressed the symptom the previous incident exposed:
- **Incident 1–2**: no Take Over button on the fullscreen teach overlay (it rendered the lock only as an HTML tooltip on Record, invisible on tablet) — while the editor tab had the banner+button. Fixed in `710d341` (Addendum 29 tail / this morning) with a shared `TeachLockBanner` component, registry entry `teach_lock_banner`.
- **Incident 3**: the operator blocked with the PC not even on the program page. Diagnosis showed the TTL was working; the lock was legitimately live from a stale session. Lifecycle fixes: close-ends-session on all exit routes, visibility-gated heartbeat, `openedPidRef` navigation fix, TTL shortened 300s → 90s, self-heal auto-grant at 60s owner silence.
- **Incident 4**: recurrence despite all the above. Resolved only by the end-of-day code review (§490).

Throughout, the operator was forced to escape via `curl .../take_over` with an invented device_id (`tablet-manual-recovery`, then `tablet-real`) — developer lore no customer operator could perform, and a source of phantom owners that compounded later incidents.

### Section 486: PBD determinism, the composer as pure function, and home-step unification
*(Carried from the determinism arc — the composer produces the same program byte-for-byte from the same intent; detect steps impossible by construction until vision lands.)* A concrete gap surfaced live: `holepartpalletize` had TWO independent `move_home` steps (step 1 and step 8) with separate untaught pose slots, so the operator taught step 1's home and step 8 remained NOT TAUGHT below the fold — the single finding blocking every promote attempt for an hour. Fix directed: the composer emits multiple `move_home` steps referencing ONE shared home slot (link-by-default at composition time) — teach home once. Plus **editor-truth**: the Program editor's NOT TAUGHT badges and progress banner must reflect DRAFT state (record-through means the draft is current truth), not the stale saved program — the operator taught five poses while the screen claimed six missing and the validator counted one.

### Section 487: The operator-copy fork on the Run-refused modal
The Monitor Run-refused modal rendered the RAW server string — "known controller-crashing codegen … firmware bug #3, mm2mAndDeg2rad v.size()>=6" — the exact forensic jargon the 267108a rewrite (Addendum 29) had banished from operator view on the load-path toasts. An unconverted surface, a copy fork. Directed: route it through `namedLoadError` like every other refusal surface; registry rule that operator-facing refusals render only through the shared copy module; sweep for any other raw-string surface.

### Section 488: THE DISK-FULL CASCADE — root cause of the afternoon

The teach pipeline failed the operator four distinct ways in three days, culminating in Record reporting success on poses Save couldn't see, then Record failing outright ("pose not saved to session"). The unified diagnosis — demanded as an accounting ("report what the last session did; Lesson 179 to our own fixes first") — uncovered the true root cause via the operator's own shell: **`df -h /` showed `/dev/mmcblk0p1 57G 54G 0 100%` — the Jetson disk was completely full.** The breakdown:
- `/opt/cobot/logs` = **7.2 GB** of `estun_ws_*.jsonl` wire logs (a single driver session = up to 272 MB; a week of crash-loop restarts multiplied it).
- The entire *product* — every program (136 KB), every teach session (4 KB), demonstrations (553 MB), models (182 MB) — was a rounding error beside the diagnostic logs.

The cascade, fully unwound: **disk 100% full → `api_teach_session_record` write crashed (ENOSPC at dashboard_server.py:12979, three tracebacks in the journal) → the prior fix session's Edit half-landed under ENOSPC (it correctly refused to Write further, but a partial edit was already in the source) → `systemctl restart` loaded the broken file → the dashboard crash-looped 15 times (3s per cycle) → `activating`, unreachable.** Recovery: manual log purge (`find /opt/cobot/logs -name "estun_ws_*.jsonl" -mtime +0 -delete` freed to 6.7 GB), then `git checkout -- dashboard_server.py` to discard the uncommitted half-edit (restoring clean HEAD 36e38fc), then restart → `active`, JSON flowing, safety GREEN. Every "mystery" of the afternoon had one parent.

### Section 489: Commit 53a4137 — the atomic recovery: 507-on-ENOSPC + refresh persistence + disk watchdog

With disk space restored, the fix landed as ONE atomic commit (1,609 insertions, 11 files) rather than the half-transitions that had plagued the day:
- **Record endpoint hardened**: `_TeachWriteError` wrapper catches every fs failure (ENOSPC/EROFS/EIO/EDQUOT/EACCES) and returns a clean **HTTP 507** with operator-language copy ("Couldn't save — the dashboard's disk is full … earlier successful writes are safe"), instead of a 500 traceback crashing every Record.
- **Atomic draft writes**: tmp + fsync + `os.replace`, with `.tmp` cleanup on failure — a draft survives a mid-teach `systemctl restart`.
- **Refresh persistence**: new `ui_context.py` module (per-device server-side store of open program + active tab, `page_context_persistence` registry entry), `/api/ui_context/{device_id}` endpoints, `/api/teach_session/{pid}/edit` write-through for structural edits (`staged_program` in the draft), and `restoreOpenProgramOnMount` wired into App.jsx — refresh rehydrates instead of blanking; save merges `staged_program` as the base then overlays draft poses.
- **Disk watchdog** (`disk_watchdog.py`): free-space in the footer StatusBar, event-log entry + loud banner below threshold, enforced retention caps.
- **Teach-journey gauntlet**: end-to-end test playing the full operator journey against the running stack.

### Section 490: THE CODE REVIEW — device identity was per-tab, the root of all four lock incidents

The operator uploaded both branch zips for review. The review exonerated the teach-session architecture (TTL, self-heal, take-over, 507, atomic writes all sound) and found the true root cause of **every lock incident** in one line — `useStore.js:_getTeachDeviceId`:

```js
id = sessionStorage.getItem('roboai-teach-device-id')
```

**`sessionStorage` is per-TAB, not per-device.** Every tab close/reopen — which the operator was repeatedly instructed to do for bundle refreshes — minted a NEW device identity. The previous tab's UUID still owned the session with a fresh `updated_ts` (recorded seconds ago), so the self-heal's 60s-silence threshold never fired, and the new tab was 409'd "owned by another device." **The operator was being locked out by his own previous tabs all week.** The tab-counter "2" in a screenshot = two tabs = two conflicting "devices" on one tablet. The `curl` takeovers layered phantom owners on top. Every prior lock fix had correctly hardened the layers ABOVE a broken identity primitive.

Secondary review findings: heartbeat 30s vs stale-threshold 60s = only 2 intervals (one dropped request can expire a *live* owner — widen to 15s beat / 60s threshold = 4 beats); owner labels are `device_id[:8]` (banners read "Teaching in progress on 65f1efa3" — need human names); `_apply_draft_poses_to_program` silently `continue`s on slot keys matching no step (renumbered steps → poses vanish at save with no warning — a probable contributor to "taught everything, save says untaught"); stale "5 min TTL" comment (server is 90s); and confirmed `main` contains ZERO teach-session code (0 references) — the unpushed feature branch is entirely load-bearing.

Fix directed: **device identity → localStorage** (per-device, migrate old sessionStorage value; identity whitelisted in the fork registry against the pose-persistence ban), human device labels (platform sniff default + Configure rename), one-time ghost amnesty (clear UUID owners with no ui_context and no 10-min heartbeat — kills `tablet-real` and every orphaned tab-UUID), heartbeat 30s→15s, surface unmatched-slot poses as a named warning instead of silent drop, and a gauntlet test reproducing the exact incident (record as device A → new store instance same localStorage → enter teach → NO lock). Acceptance: close the tablet tab, reopen, teach — no banner. That reopen gesture, the one that burned the operator all week, becomes the pass.

### Section 491: Investor thread — Outsiders Fund, and the honest-claim discipline

An inbound from a partner at **Outsiders Fund** (backers of PaintJet and AeroVect — shop-floor/long-cycle hardware investors), routed via Jovan Haye. The partner's hook was exactly the founding thesis: not the teaching layer per se, but that NeuRobots runs on a real arm with a live production floor at Jade to prove on before selling to a stranger. His two questions: which arm brands/controllers the retrofit covers today, and how the engineering team scales.

The reply went through many condensing passes, and the process itself encoded a discipline worth recording: **every claim must survive a cabinet inspection.** Corrections the operator drove: not "replaced the OEM stack" (we replace everything above the servo/safety layer; the OEM's certified core stays underneath — deliberately, because it's the short certification path and what makes retrofit work); not "running daily in production" (active commissioning); the Cell Box removed from the claim entirely (not built yet); "each new brand is a driver project" removed (Fanuc's closed controller won't be that simple); UR removed and **Fanuc named as the next target, specifically an M-16 6-axis arm** (the stronger answer for this fund — legacy industrial installed base IS "where the money actually is"); team framed as small-by-design with first hires an experienced controls engineer and software engineer. Final form: two tight paragraphs answering the two questions plus a live-demo offer. Standing note: the OEM-layer correction, cut for brevity, MUST be made verbally on the first call before the investor's "replaced the OEM software stack" framing calcifies into their memo.

### Section 492: Strategy threads — differentiation, deep learning, the box, Vention, and the integration gap

A run of positioning questions, consolidated:
- **Differentiation from other physical-AI companies**: not "we use deep learning" (everyone does) — the dividing line is *where the learning stops and accountability starts*. Learned perception feeding a deterministic, validator-stamped execution layer = certifiable years before end-to-end policies; the fleet corrections corpus = the un-buyable moat; robot-agnostic brain vs. ecosystem hub; buyer-first (the abandoned 250k shops) vs. technology-first.
- **"DL in cobots" vs "no-code interface for mid-market" as the pitch**: neither alone — the first enters the most capital-saturated space; the second is the Rethink/READY graveyard. The fundable pitch is the causal chain: no-code failed because ease without intelligence left the wrapper intact; foundation-model robotics can't reach this market because uncertifiable policies fail a risk assessment; NeuRobots is the composition. Emphasis flips by audience (DL-forward for AI funds, market-forward for industrial funds like Outsiders).
- **Is integration the largest gap?** Yes as a cost gap (arm ≈ 30% of project; wrapper 2–3×), and re-tasking is the largest *fit* gap (integrator model assumes one job for five years; SMBs change weekly). NeuRobots attacks both with one mechanism.
- **The all-in-one control box**: attacks the BIGGEST integration slice (cell electrical/pneumatic + commissioning) — PBD attacks the smallest. Ship-standard, not optional, because optional reopens the gap per-customer.
- **Box integration architecture**: OEM controller keeps servo + certified safety (sovereign); Cell Box owns cell intelligence + I/O; three planes — safety (hardwired dual-channel into the controller's certified inputs, zero software), control (the existing WS/HTTP driver), I/O (cell I/O routes through the box, `io_map.json` as single truth). Coordination model A (box orchestrates IO steps) preferred over B (controller-relayed, which forks IO truth).
- **Vention MachineMotion comparison**: closest existing analog (validation that "cell-in-a-box" has buyers), but differs on five axes — demonstration vs. flowchart programming, learning loop vs. static, robot-agnostic vs. ecosystem-locked, runtime perception vs. none, subscription vs. hardware-catalog gravity. Their commissioning UX is the bar; their assumption of a designed/fixtured cell is the gap NeuRobots exploits.
- **Deep-learning-in-vision roadmap** (Photoneo MotionCam-3D): six phases — extrinsic ground truth → geometric decomposition (classical) → CAD/PPF identity → semantics via the teacher/student split → environment state → understanding-gates-action via positive-listed archetype steps. Gated on the still-unopened RunPod account and hand-eye calibration. "Are we too late?" — no: downstream of the crowded spaces by design, consuming their commoditization; the risk is too *slow* (cells-deployed is the clock), not too late.

### Section 493: The vision/mission ladder (pending Josh's sign-off)
Explored across the day, landing on the north-star framing over the access framing. Leading candidates: **Vision** — "The end of robot programming" and/or "A manufacturing economy where no shop is too small to automate"; **Mission** — "We build robots that watch a job done once — and then do it" (distinctive) or the accessible-register variant. Classification lesson recorded: "we aim to…" grammar marks a mission, not a vision — the litmus is whether the statement survives as a photographed world with the company deleted. Ladder nests with the locked slogan ("Industrial robotics, radically simplified.") and product line ("Train it like a new hire. Retask it in minutes."). Propagation bundles with the still-outstanding Chinese-deck founder-role correction.

### Section 494: Session status ledger (August 5, end of day)

| Item | Status |
|---|---|
| Disk-full root cause diagnosed (57 GB, 7.2 GB of ws logs) | **PROVEN — the parent of the whole afternoon's cascade** |
| Manual log purge → 6.7 GB free; crash-loop broken via git checkout | **DONE** |
| Commit 53a4137 (507-on-ENOSPC, refresh persistence, disk watchdog, gauntlet) | **SHIPPED — verify deploy convergence + changed bundle sha** |
| Code review: device-identity-per-tab root cause of all 4 lock incidents | **FOUND — fix directed, NOT yet implemented** |
| Device identity → localStorage + human labels + ghost amnesty + heartbeat 15s + unmatched-pose warning | **DIRECTED — the fix that ends the lock class** |
| J6 escape-direction clamp + recovery dialog | **DIRECTED — dialog shipped broken once; escape-direction rule is the real fix** |
| Pallet doctrine (corners=frame, pt4=first-place, typed pitch=spacing) | **DIRECTED — grid-fits-frame check replaces pitch-vs-corner-distance** |
| Home-step unification + editor-truth | **DIRECTED** |
| Run-refused modal copy fork | **DIRECTED** |
| Event log (unified forensic store + daily download) | **SHIPPED earlier (fff683d) — the capability this week kept needing** |
| holepartpalletize teach completion | **BLOCKED on the lock fix; poses survive in the draft (verified via curl)** |
| Bowl 10% acceptance run | **STILL OPEN — the oldest unclosed loop** |
| First palletize run: read emitted point table for mm-scale first | **STANDING CAUTION — path never run on hardware** |
| git push (commits since 0f884c6, now including today's stack) | **PROMPT READY — main has ZERO of this; push is load-bearing** |
| /opt/cobot backup | **STILL OPEN — oldest item; today it demonstrated its OTHER failure (suffocation, not just fire)** |
| Estun bug report (#1 blend, #2 boot-subscribe, #3 arity exitProcess + 3 logs) | **OWED** |
| Outsiders Fund reply | **DRAFTED — pending Josh's name + UR/Fanuc confirmation + verbal OEM-layer correction on the call** |
| Vision/mission ladder | **DRAFTED — Josh sign-off pending** |
| RunPod account (gates vision Phase 2) | **STILL UNOPENED** |
| CLAUDE.md: no source edits without verified free disk; push at session end | **DIRECTED as standing rules** |

## PROCESS LESSONS (192–201)

192. **Check the disk before believing anything else.** A 100%-full disk masqueraded as a crashing record endpoint, a lying save, a half-landed fix, and a 15-cycle crash loop. ENOSPC is a shape-shifter; `df -h /` should be the first probe when writes mysteriously fail, not the last.

193. **The platform's own logging is a denial-of-service vector.** 7.2 GB of diagnostic wire logs strangled a system whose entire product data fit in under a megabyte. Retention caps and a free-space watchdog aren't housekeeping — they are uptime infrastructure for any system that logs about itself.

194. **A half-landed edit is worse than no edit — especially under ENOSPC.** The crash-loop came not from the disk being full but from a fix that partially wrote before the disk stopped it. Sessions must verify free space before writing, and land changes atomically; "some of the fix" took the whole dashboard down.

195. **Identity is a primitive; get it wrong and every layer above it lies.** Four lock incidents, four fixes to banners and TTLs and lifecycles — all hardening layers above a device ID that changed every time a tab reopened. When a bug recurs through multiple "fixes," suspect the primitive underneath, not the surface each incident shows.

196. **A guard must always leave the exit open.** The J6 clamp blocked the recovery jog; the session lock blocked the takeover; both passed their happy-path tests and trapped the operator on the path nobody tested. Every test that verifies a guard ENGAGES needs a sibling that verifies the operator can DISENGAGE from that same surface.

197. **The operator's semantics outrank the validator's assumptions.** The pitch check enforced a corners-at-slot-centers doctrine the operator never intended. When a validator refuses correct work, the validator may be encoding the wrong model — ask what the operator means before trusting what the checker asserts.

198. **Recovery lore is a bug, not a workaround.** Escaping locks via hand-typed `curl` takeovers created phantom owners that caused later incidents. Any recovery an operator can't perform from the interface is a missing feature wearing a terminal costume — and it compounds.

199. **Silent `continue` is silent data loss.** The pose-merge skipped unmatched slot keys without a word; renumbered steps could drop taught poses at save with no signal. A loop that discards input must say what it discarded.

200. **Every investor claim must survive a cabinet inspection.** "Replaced the OEM stack," "running in production," "each brand is a driver," a Cell Box that isn't built — each got corrected to what the hardware would actually show. Narrow true claims beat impressive false ones; the discount a diligence analyst applies to one caught overstatement taxes every other claim.

201. **The operator was right every single time.** The corners were taught correctly (the check divided by 1000, yesterday). The jog was pressed correctly (the clamp was silent, then caged). The poses were recorded correctly (the disk was full, then the identity forked). Four days, and not once did the operator's direct observation lose to the system's explanation. The prior is now overwhelming: when the person at the pendant says the machine is wrong, instrument the machine.

---

*Summary of Addendum 30: the day the teach pipeline laid siege to the operator and the platform's own foundations gave way one layer at a time. A palletizing program that should have taken an afternoon to teach instead surfaced a cascade — the pallet validator enforcing a corners-at-slot-centers doctrine the operator never held, a teach-session lock trapping the tablet four separate times, the J6 clamp caging the very jog that would free it, and Record cheerfully reporting success on poses that Save couldn't find. Beneath all of it, a 57 GB disk filled to the last byte on nothing but the platform's own wire logs, and that single fact turned out to be the parent of the afternoon: it crashed the record endpoint, half-wrote a fix that then crash-looped the dashboard fifteen times, and made every downstream symptom look like its own mystery. The recovery was a purge, a git checkout, and one atomic commit that finally gave disk-full its own honest 507 and shipped the refresh persistence and disk watchdog the day had proven non-negotiable. Then a full code review of both branches found what four days of symptom-fixing had missed: device identity stored per-tab, so the operator had been locked out all week by his own previous browser tabs — every lock fix a fresh coat of paint over a cracked foundation. Woven through the technical siege ran a business thread of unusual discipline — a live investor from a shop-floor fund, and a reply condensed through a dozen passes whose real product was a rule: every claim must survive a cabinet inspection, so "replaced the OEM stack" became "everything above the certified core," "production" became "commissioning," and a Cell Box that doesn't exist yet left the sentence entirely. Ten lessons, the oldest board items (backup, push, RunPod) still open and now louder, and one prior grown to near-certainty: across four days and a dozen mysteries, the person at the pendant was right every single time.*

*Last updated: August 5, 2026 (Addendum 30 — Sections 483–494, Lessons 192–201)*
---

<!-- v46-content-end -->
