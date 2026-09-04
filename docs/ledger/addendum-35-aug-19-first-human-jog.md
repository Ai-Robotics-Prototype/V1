---
ledger_split: addendum-35
source: ledger_addenda_32-35.zip / ADDENDUM_35_2026-08-19_F1_4_first_human_jog.md
source_lines: (external — appended after v46; not part of the v46 reconstruction test)
title: First human jog over ROS2 — 12/12 taps under the operator's finger
---

# ADDENDUM 35 — August 19, 2026 — FIRST HUMAN JOG OVER ROS2: 12/12 UNDER THE OPERATOR'S FINGER, THREE LAYERS OF PLUMBING EXHUMED TO GET THERE, AND ONE DEFECT PARKED WITH ITS DIAGNOSTIC PRE-WRITTEN
*(Appended in full. Nothing above this line was removed. The F1.4 real-arm session: the day a human press first moved the arm through the entire ROS2 stack — browser to 250 Hz UDP in 4.4 ms, twelve taps, twelve correct joints, twelve correct directions, mean stop 61 ms — reached only after a brutal succession of masquerading failures: a boot race, a TLS-broken dashboard misread as a hang, a frontend safety gate starving on state fields nobody was feeding it, and a zombie passive bridge squatting on the fanout. Continuous holds remain the one open defect, parked deliberately with the diagnostic already written. Also: the Enable button and status banner finally taught to tell the truth under the CRI backend, and both codebases pushed to GitHub.)*

### Section 524: The bring-up gauntlet — four failures, none of them the robot

The session's defining pattern: every failure lived in the operator-facing plumbing while the motion stack ran flawlessly underneath. In order of unmasking:

1. **Boot race, again (§513's pattern):** first two real-launch attempts died at `cri_tcp_setup TCP 连接失败` — the controller mid-boot after an overnight power cycle; ping+nc a minute later answered fine. Third launch clean. The supervised-service boot-gate (F3) is now a thrice-motivated requirement.
2. **The "hung" dashboard that wasn't:** the manually-run dashboard_server appeared dead — browser spinner, fresh tab dead, incognito dead. py-spy showed all threads healthy; the truth was **websockets 15.x renamed the `ssl_context` kwarg to `ssl`** — the server accepted TCP and muffed every TLS handshake. The systemd unit pins the old library; the manual run picked up the new one — **the exact env-divergence class F3 exists to abolish, now with a named victim.** (The earlier "106% CPU hang" verdict from the same day is retroactively suspect — same costume, and the CPU load was separately identified as the PIL camera-encode loop, a real but non-blocking F3 item.)
3. **The frontend's own safety gate:** with TLS fixed, presses produced `ws_msgs_in: 0` — the press died *inside the browser*. The old WS-era frontend gates jog on `monitor_only`/`allow_jog` from `/api/state`, and the CRI proxy wasn't supplying them. Fix: the proxy extended — `monitor_only=False, allow_jog=True`, jog heartbeat/freshness params, speed caps, honest source tags (`allow_jog_source='cri_proxy'`, `allow_power_source='cri_launch_manages_enable'`), and a safe-side staleness path that re-closes every gate if `/joint_states` dies (>1 s → chip flips DISCONNECTED; no stuck-ENABLED false positive).
4. **The zombie passive bridge — the final blocker:** with the frontend gate open, fresh presses STILL bounced: `jog_bridge inactive (JOG_BACKEND='ws')`, toast count climbing — proof the frame traversed browser→seam→fanout and was answered by a bridge in passive mode. A stale `ws`-mode jog_bridge instance from the day's restart churn had survived on the fanout. `pkill` all, start exactly one fresh `ros2` instance, verify via banner AND `/proc/PID/environ`. (Lesson 231's cross-check discipline — the *process's own environ*, not the launch command you remember typing.)

**Operator-trust findings promoted mid-session (out of F3's backlog, fixed NOW):** the Enable button had been a silent dead control for hours — wired to the absent WS driver, violating our own §285 doctrine (every dead control surfaces why). Fixed same-session: the REAL ARM chip now reads CRI truth via the joint-states-liveness proxy (`ENABLED/READY`, `arm_source='cri_ros2'`), the DRIVER banner reads CRI liveness, and POST `/cmd/power` under ros2 returns an immediate 409 with "Enable is managed by the CRI launch this session" — a button that either works or honestly says who's in charge. The full `Robot/switchOn`-over-:9001 wiring remains F3 scope.

### Section 525: RUNG 1 and RUNG 2 — the gate gates, and the mapping question closes forever

**Rung 1 (gate-closed proof): PASS.** With the bridge deliberately passive, operator taps produced surfaced rejections (`reason='jog_bridge inactive'`), zero JTC goals, zero motion at 2-LSB noise. The backend gate is real: a press becomes motion only when the system is explicitly told to allow it. (The first tap of the pair was swallowed by the predicted lazy-publisher discovery race — second tap landed; known, benign, documented.)

**Rung 2 (12-press agreement test): PASS 12/12.** The historic one. First tap — J1+, operator's finger: **press→goal-accepted 4.4 ms, J1 moved +0.487°, only J1, stopped 56 ms after release.** Then the remaining eleven: every joint, both directions, correct sign every time, zero cross-joint motion, mean stop latency **61 ms**, per-tap magnitudes 0.4–0.5°. The four-layer mapping question (frontend→fanout→bridge→JTC — any of which could have flipped a sign or index) is closed permanently, and the J3/J5 axis convention held under human command exactly as it did under feedback (Phase C) and planner command (E5). **First human jog over the ROS2 stack: proven.**

### Section 526: The hold defect — parked deliberately, diagnostic pre-written

**Rungs 3–6 NOT RUN.** Immediately after the 12/12, sustained holds produced no visible motion. Session energy was spent; the defect was parked rather than chased — with its diagnosis already scoped from a source-level read of the seam:

- **What holds add that taps don't:** a tap is `start`→`stop`, both press-driven — proven 12/12. A hold adds exactly one machine: the dashboard's **dedicated keepalive thread** republishing `refresh` frames at 60 ms (fanout-coalesced to 90 ms per hold_id; start/stop never rate-limited) for as long as the browser refreshes within a 400 ms window. If refreshes don't flow, the bridge's 200 ms horizon expires ~200 ms after start — a fraction of a degree of motion at 15% speed, indistinguishable from "won't move."
- **The diagnostic ships with the code:** keepalive stats are exposed on `/health` (`ticks`/`publishes`/`expired`/`max_tick_gap_ms`). One curl during a 3-second hold discriminates: publishes not incrementing → dashboard-side (thread never started in the manual run, or the `client_state` check wrongly expiring live sessions — a *known prior bug class at that exact spot*, per the in-code comment about the earlier `int(cs)` TypeError that silently expired every session); refreshes on the wire but the bridge cancels anyway → bridge-side refresh handling vs real JTC (which mock testing covered but real-frontend cadence did not).
- Next session opens here: one curl, one hold, fix, then rungs 3–6 (~4 minutes of button time) close F1.

### Section 527: Push, teardown, and the state of Phase F

**Teardown:** launch Ctrl-C'd via send-keys (capture-pane first), `cri_teardown.py` 3/3 OKs, controller confirmed Manual, production dashboard service restored (`roboai-dashboard` active — with the note that the production unit runs the OLD env and does not carry today's CRI-proxy fixes until F3 formalizes them).

**Code pushed:** `cobot_ws` → `Ai-Robotics-Prototype/V1` branch `feature/estun-write-path`, commit **e59baf1** (CRI proxy + seam + websockets fix + extended fields, 1 file +512/−31). `CodroidROS2` → committed locally as **bd51632** (84 files: full CRI stack, S10 packages, jog_bridge + 50-test suite, cri_listen/teardown, F1_3 report) on branch main with `.gitignore` and SSH remote staged to a new private org repo — push pending the one-click repo creation on github.com. Historical note honored: no tokens in URLs (two PATs were burned that way in May).

**Phase F scoreboard:** F1.0 coexistence PASS · F1.1 bridge built (50/50) · F1.2 mock scenarios PASS · F1.4 Rungs 1–2 PASS (first human jog) · Rungs 3–6 + hold fix open · F2 (executor over MoveIt) next after F1 closes · F3 (systemd everything) **elevated by this session from quality-of-life to correctness requirement** — the env-divergence bug class (websockets pin), the zombie-process class (passive bridge), the boot race, and the manual four-window bring-up are all abolished by the same fix · F4 the bowl.

| Item | Status |
|------|--------|
| First human jog over ROS2 (Rung 2, 12-press) | **PASS 12/12 — 4.4 ms press→goal, 61 ms mean stop, zero cross-talk** |
| Gate-closed proof (Rung 1) | **PASS — surfaced rejects, zero goals, zero motion** |
| Continuous holds | **OPEN DEFECT — keepalive republish path suspected; /health + fanout-echo diagnostic pre-written** |
| Rungs 3–6 (holds, deadman kills, soak) | NOT RUN — next session, after hold fix |
| Enable button / status chip / DRIVER banner under CRI | **FIXED — CRI-truth proxy, honest 409, staleness safe-side** |
| websockets 15.x ssl kwarg break (manual env) | **FIXED in code; root env-divergence is F3's** |
| Frontend jog gate vs CRI proxy fields | **FIXED — extended proxy with source tags** |
| Zombie passive bridge on fanout | **KILLED; environ-verify discipline adopted** |
| cobot_ws push | **DONE — e59baf1** |
| CodroidROS2 push | **DONE — bd51632 → git@github.com:theodoresimpson/CodroidROS2 (private, personal account; org transfer optional later)** |
| Production dashboard restored | Active (old env — F3 carries the fixes into the unit) |
| DHCP reservation / log retention / RunPod | STILL OPEN |

## PROCESS LESSONS (236–243)
*(Reconciling Claude Code's provisional in-session set; numbering per the file's tail — Addendum 34 ended at 235.)*

236. **When taps work and holds don't, the bug lives in the machinery only holds use.** Diff the two paths' architecture before tracing packets: tap = press-driven start/stop (proven by the taps themselves); hold = those plus a keepalive republisher. The delta names the suspect, and the 12/12 tap result is itself the exoneration certificate for every shared layer.

237. **A library version pin is part of the interface.** websockets 15.x renaming `ssl_context`→`ssl` broke TLS only under the manual run's newer environment while the systemd unit's pinned env kept working — "same code, different env, different behavior" is the Lesson-92 deploy-truth class extended to dependencies. A service's env (pins included) must travel with it; running production code outside its unit is running different code.

238. **A frontend safety gate is a consumer of the state contract — feed it or it fails safe against you.** The browser's jog gate starved on `monitor_only`/`allow_jog` fields the CRI proxy wasn't supplying and silently swallowed every press (`ws_msgs_in: 0`). When a new backend replaces a state producer, enumerate every field the frontend gates on and supply all of them — with honest source tags, and a staleness path that re-closes the gates when the proxy's ground truth dies.

239. **Verify a process's mode from its OWN environ, not from the command you remember starting it with.** The final jog blocker was a passive-mode bridge that survived restart churn; the running instance's `/proc/PID/environ` is the only authority on what env it actually has. Restart discipline for mode-switched daemons: pkill ALL instances, start exactly one, verify banner AND environ AND subscriber count.

240. **A rejection that reaches the user is a successful end-to-end test of everything except the gate that rejected.** The `jog_bridge inactive` toast — infuriating in the moment — was proof the press traversed browser→seam→fanout→bridge and the reason flowed all the way back. Read rejections as chain certificates: they localize the remaining problem to exactly one link.

241. **Dead controls are defects NOW, not backlog — §285 applies to every control, not just the ones being tested.** The Enable button sat silently dead for hours of operator frustration because it was classified "F3 item" while jog was the focus. A control that does nothing and says nothing manufactures operator distrust of the whole system; the minimum viable fix (honest refusal with a reason) costs minutes and should never wait behind feature work.

242. **Ship the diagnostic with the mechanism.** The keepalive thread was built with `/health`-exposed stats (ticks/publishes/expired) — so when holds failed, the discriminating measurement already existed as one curl instead of a new instrumentation project. Every background loop that can fail silently earns counters at birth; the cost is three dict increments, the payoff is tonight-vs-next-week diagnosis.

243. **Park deliberately: an open defect with a pre-written diagnostic and a banked ledger beats a midnight fix.** The session ended on a decision, not an exhaustion collapse: teardown ritual, both repos committed, the defect documented with its exact next command. The measure of a parked session is how surgical the next one can be — this one resumes at a single curl.

---

*Summary of Addendum 35: the day a human finger finally drove the arm through the new nervous system — twelve taps, twelve correct answers, four milliseconds from press to accepted goal — and the day the last mile proved harder than the motion. Nothing that failed was the robot: a controller still booting, a TLS handshake broken by a renamed keyword argument, a browser safety gate starving on fields nobody fed it, a zombie process answering from the grave. Each unmasking followed the same discipline — measure, cross-check, name the link — and each fix made the product more honest: a status chip that reads the truth, an Enable button that explains itself, a state contract with source tags. The holds that wouldn't hold were parked, not surrendered: the suspect machinery is named, the discriminating curl is written, and the next session begins where this one chose to stop. Eight lessons, two pushed repositories, one arm asleep in Manual mode — and the first entry in the product's history where the words "the operator jogged the robot over ROS2" are a test result rather than a plan.*

*Last updated: August 19, 2026 (Addendum 35 — Sections 524–527, Lessons 236–243)*
