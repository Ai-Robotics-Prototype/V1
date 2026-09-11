---
ledger_split: addendum-32
source: ledger_addenda_32-35.zip / ADDENDUM_32_2026-08-17_CRI_day.md
source_lines: (external — appended after v46; not part of the v46 reconstruction test)
title: CRI day — second transport, encoder-perfect motion, Phases A-D on the S10-140
---

# ADDENDUM 32 — August 17, 2026 — THE CRI DAY: A SECOND TRANSPORT DISCOVERED, FIRMWARE AT EXACTLY THE FLOOR, AND FIRST ROS2-NATIVE MOTION AT ONE ENCODER COUNT
*(Appended in full. Nothing above this line was removed. The day a driver zip revealed a real-time streaming interface we never knew the controller had — CRI: TCP :9001 setup, UDP joint streaming at 250 Hz — and one careful session took it from static code review to encoder-perfect coordinated motion on the real S10-140: Phases A through D of a brand-new motion architecture in a single day, with the WS/Lua stack paused intact as the fallback.)*

### Section 504: The CodroidROS2 zip — a transport the captures never showed

Session intent was "test the ROS2 driver." The plan assumed the only interface was the reverse-engineered WS :9000 CodroidApi (no official Estun ROS2 driver existed per the selection-time assessment; supplier had confirmed the "Pro SDK" was the same CodroidApi and "no longer available"). Then the operator uploaded `CodroidROS2-main.zip` — a genuine `ros2_control` stack for Codroid V2 controllers using **CRI**: a one-shot TCP :9001 JSON setup (`Robot/toAuto → toRemote → switchOn → CRI/StartDataPush → CRI/StartControl`), after which the controller streams a **308-byte state packet at ~250 Hz** (int64 ts, 2× u16 status, joint pos/vel, ee pose/vel, tcp speed, torque, ext torque — verified `struct` layout `<q H H 6d 6d 6d 6d d 6d 6d` = 308) and accepts **64-byte joint-position commands** (type=0) on UDP :9030. Packages: `cod_cri_hardware` (a real `hardware_interface::SystemInterface`, 486 lines, with first-frame alignment, hold-if-far 0.15 rad, err-vs-fb clamp 0.5 rad, `max_step_rad` 0.004), `cod_bringup`, an S5-ECO-G2 description, and a MoveIt2 config (OMPL + Pilz). **This answers the old unanswered Estun question ("maximum command frequency"): 250 Hz, via an interface our WS/HTTP captures never touched.** Requirements flagged up front: firmware ≥ 2.3.3.43 (our export said only "2.3"); everything geometry-sized for the S5, not our S10-140.

### Section 505: Phase A — mock proof, a disk gate that worked, and the logs regrew

Relay prompt authored (Phases A + C; `AUTORUN: no`; standing rules: no systemd, no mode/power verbs, new `~/cri_eval_ws`, 5 GB disk floor). Claude Code's first act tripped the floor legitimately: **4.6 GB free** — and refused all writes, including `mkdir`. Cleanup: apt cache 1.5 G, `~/.cache` 777 M, `~/.ros/log`, dead docker images; **finding: `/opt/cobot/logs` was back at 2.0 GB and half of it was < 3 days old** — the §494 disease regrew because the watchdog (53a4137) alerts but nothing *prunes*; retention cap remains unimplemented and is now twice-proven necessary. Also surfaced: the DHCP wander recurred (laptop couldn't reach the Jetson; §501's router reservation for `50:2e:91:95:b6:15 → .246` is STILL pending; `teddy-desktop.local` + last lease `.143` were the door). The zip's scp initially never landed (operator ran it later; Claude Code's `ls` precondition caught the gap). Mock build: 3/4 packages clean on first compile (the 4th, MoveIt config, failed only on the deliberately deferred `moveit_core` dep). Mock gates: both controllers active, `/joint_states` **250.7 Hz**, FollowJointTrajectory round-trip SUCCEEDED with Joint1 settling at exactly 0.3 rad. Whole evaluation cost ~240 MB of disk.

### Section 506: Phases B/C — firmware at exactly the floor, the 10074 ladder, and first packets

- **B1 (the verdict):** factory UI About → **Soft Version 2.3.3.43** — *exactly* the driver's minimum, to the digit. MFC MF80, MSC MS-ZLG06, joint firmware Ver 003D ×6. Flag: being at the exact floor means no post-.43 CRI protocol fixes exist on this controller; if packet-layout weirdness ever appears, firmware age is a suspect before our code.
- **B2:** `nc -zv 192.168.2.136 9001` → open (a port never seen listening in any prior capture).
- **Run 1 (StartDataPush alone):** `err 10074/Please enter into remote mode first` — a *procedural* rejection, not the 404-class unknown-verb reply → **CRI exists on this firmware** (proven before B1 confirmed it).
- **Run 2 (toRemote → StartDataPush):** toRemote returned the success shape but StartDataPush still 10074 — sequence hypothesis vs async-latch hypothesis.
- **Run 3 (toAuto → toRemote → StartDataPush, 150 ms inter-command, retry×5):** **success on first attempt — the reference sequence `toAuto → toRemote` is mandatory and the latch is synchronous.**
- **First telemetry:** sustained **250–251 Hz**; `ee` in meters/radians matching the dashboard TCP (753.111 mm ↔ 0.7531 m); s1=0x800A observed. **Joint sign/convention question CLOSED:** CRI joint values matched the factory-UI dashboard to ≤0.002° on ALL SIX joints *including J3/J5 signs* — CRI shares the WS RobotPosture convention; the deployed URDF handling (deliberate J3/J5 axis flips) carries over unchanged.
- The listener (`cri_listen.py`) teardown discipline (StopDataPush + mode restore on exit AND SIGINT) worked on every run including the failures.

### Section 507: The controller's own boot log (operator-pulled) — independent confirmation

430-line controller log read: boot loads a **`RealtimeInterface` plugin** and starts **`UDP server: 9030`** (CRI infrastructure confirmed from the controller's side); our listener's TCP sessions appear as clean client connect/EOF pairs (no crash, no drama — the controller tolerated the new client politely); `allowTyList: Robot/toRemote` present. Also learned: **controller clock runs ~14 h ahead** (China time) — correlate logs accordingly; a "Plotter" config points UDP at `192.168.1.150:10086` (the old LiDAR IP — different subnet, no conflict, but port 10086 has a prior tenant in controller config, noted); the state machine showed the operator's disable-toggle cycling back to Enabled (Standby→Enabling→Ready twice) — explaining why no brake-release was heard at the later launch: the arm was already enabled. Tool 0 / Payload 0 observed at each enable (the §427 payload set is not reflected here — check later).

### Section 508: Phase D — the write path, a teardown gap, one benign incident, and first motion

**D0:** config IPs corrected to our subnets (`remote_host 192.168.2.136`, `local_ip 192.168.2.246`); **`max_step_rad` overridden DOWN to 0.002** (~0.5 rad/s equivalent) for the session; installed copies verified. **Teardown-gap finding (source-verified at two sites):** the launch does NOT clean up — `cri_tcp_setup_node` is one-shot (exits after step 5) and the hardware plugin's `on_cleanup()` closes UDP only; Ctrl-C leaves the controller in Remote + switchOn + StartControl with 250 Hz push to a dead endpoint. Antidote authored: **`cri_teardown.py`** (StopControl → StopDataPush → mode restore; strictly a verb-subset of setup — safe to run in any unknown state). Standing ritual: **every motion-launch shutdown, clean or crash, is followed by `cri_teardown.py`.**

**D1:** all five TCP setup steps `成功`; plugin log confirmed the clamp (`max_step_rad=0.0020`) and printed the first-frame-alignment line; both controllers active; factory UI independently showed Remote/Enabled with the arm frozen at the Phase C pose.

**Mid-D2 incident (benign, instructive):** the launch vanished from the graph. Claude Code executed a model stop-the-session (no relaunch, no goals, forensics first). Scrollback verdict: **operator Ctrl-C** — clean SIGINT shutdown, every controller deactivated, no crash, no alarm, arm never moved. `cri_teardown.py`'s first live outing restored everything (3× OK). Structural fix adopted: **motion-armed launches run inside `tmux` (session `robot`)** so window lifetime and stray Ctrl-C can't kill them.

**D2 (hold):** 14,997 samples / 60.00 s = **249.95 Hz**; per-joint drift 0.000343° (J1–J3, one encoder LSB) to 0.000687° (J4–J6, two LSB); max mean-vs-Phase-C 0.0020°. The RT loop holds the arm at quantization noise.

**D3 (first ROS2-native motion):** Joint6 +0.05 rad over 10 s (0.29°/s; 100× clamp headroom), goal's first point byte-matched to a live snapshot. **SUCCEEDED; J6 landed 0.00058° from target (one LSB); J2/J5 held BIT-EXACT during the move** — zero cross-talk.

**D4 (return):** SUCCEEDED; full round trip back to Phase C within **0.003° worst joint** (gate ±0.01°); J6 net displacement over out-and-back: 0.0014° (two LSBs of accumulated landing residual).

**D5a (coordinated two-joint):** J5 +0.05 / J6 −0.05 simultaneously. SUCCEEDED; both landed within one LSB with symmetric residuals (±0.00079°); J2/J3 bit-exact while their neighbors moved — no inter-axis coupling.

**D5b (return) DEFERRED** — the operator ran the shutdown ritual (Ctrl-C → teardown, all OK) before dispatch. Arm parked at the D5a outbound pose (J5/J6 ~2.86° off Phase C — harmless). **D5b is next session's warm-up:** relaunch in tmux → hold check → fresh-snapshotted return goal. **Also deferred: the operator visual confirmation of J5 command direction** (the one gate telemetry can't close) — to be done with the 3D twin or a camera alongside the move.

### Section 509: Strategic assessment — what CRI changes and what it doesn't

- **Reliability, structurally better:** the Lua path's worst failures (stop-wedge state 3 for 2h41m, zero-length-blend Lua crash, unclearable alarms) all lived in *controller-side program execution*. Under CRI the controller executes nothing — it follows positions at 250 Hz; **stop means stop-sending** (proven by accident in the Ctrl-C incident: stream died, arm held). New dependency: the Jetson must stay healthy at 250 Hz — hence tmux now, supervised systemd later with the WS driver's hardening ported over.
- **Speed:** command latency drops from write/upload/run seconds to the next 4 ms tick; motion quality moves to spline interpolation at 250 Hz; peak arm speed unchanged (same motors, same 150/180°/s limits, same caps).
- **What CRI does NOT replace:** I/O (vacuum, Synapse effector model), diagnostics/alarms, on-controller program persistence, mode management — the 168-verb WS library keeps those. Target end-state is the **hybrid** (CRI for motion execution, WS for everything else) — the same shape as UR/FANUC ROS2 drivers.
- **Product meaning:** streaming joint commands at 250 Hz makes the "our stack replaces the OEM programming layer" pitch architecturally literal, and `ros2_control` is the industry-standard "each brand is a driver" pattern (answers the Lesson-200 cabinet-inspection concern). IK/motion moves onto MoveIt-class libraries, retiring the pallet-IK-regression class from our own solver code.

### Section 510: The road remaining (E and F), and the status ledger

**Phase E — S10 adaptation (next build):** wrap the verified `s10-140-full.urdf` (limits ±200°/±166° = controller safety screens to the digit; deliberate J3/J5 axis flips; TCP height cross-checked) into a ros2_control description with `Joint1..Joint6` naming; author the S10 MoveIt2 config (SRDF/kinematics/limits) + install the deferred MoveIt deps. **The S5 SRDF/limits must never plan for this S10 arm.** Settle the long-flagged Lesson-85 decision (URDF-axis sign vs driver-boundary `apos_sign`) as one atomic change BEFORE MoveIt consumes the chain.

**Phase F — integration:** executor motion steps → MoveIt/JTC (WS keeps I/O/diagnostics); port WS-driver hardening into a supervised launch; pinned regression tests; then the validation ladder re-run culminating in the white-bowl program end-to-end over CRI at conservative speed.

| Item | Status |
|------|--------|
| CRI transport on our firmware (2.3.3.43, exact floor) | **PROVEN — 250 Hz, signs match, motion at 1-LSB accuracy** |
| Phase A (mock) / B (firmware) / C (feedback) / D1–D5a (motion) | **ALL PASS** |
| D5b return + J5 command-direction visual gate | **DEFERRED — next-session warm-up** |
| Arm parked | D5a outbound pose (J5/J6 ~2.86° off Phase C, harmless); controller Manual, streams stopped, teardown verified |
| roboai-estun / roboai-executor | **STOPPED (not disabled)** — WS/Lua stack paused intact as fallback; single-client rule held all session |
| `cri_teardown.py` post-shutdown ritual | **ADOPTED — mandatory after every motion-launch exit** |
| tmux `robot` session for motion launches | **ADOPTED** |
| `/opt/cobot/logs` retention cap (regrew to 2.0 GB in <2 weeks) | **STILL UNIMPLEMENTED — twice-proven, one-prompt fix owed** |
| Router DHCP reservation (Jetson Wi-Fi MAC → .246) | **STILL PENDING since §501 — second bite this session** |
| Fleet data architecture (cloud flywheel split) | Framed in-session: demonstrations/events/corrections → cloud (outbound-only, feature-toggled); programs/io_map/calibration authoritative local; retires the /opt/cobot backup item when built; data-rights clause flagged for Josh before customer two |
| Tool 0 / Payload 0 at enable (§427 payload not reflected) | Check later |
| RunPod account | STILL UNOPENED |

## PROCESS LESSONS (211–218)
*(Note: this session's working numbers 202–208 collided with Addendum 31's 202–210 — renumbered here; see Lesson 218.)*

211. **Standing-rule prechecks run before ANY filesystem-touching step, including mkdir and unzip.** A Humble ros2_control dep set is ~300–600 MB of debs; on a disk near the 5 GB floor that reproduces the 192/194 failure class. The gate that refuses to write is doing its job.

212. **"Operator-provided file" is a precondition to verify with `ls`, not an assumption.** The zip was declared present twice before it actually was; a one-line existence check catches it in seconds and prevents half-created workspaces tied to nothing.

213. **Before running motion, verify the SHUTDOWN path is symmetric with the STARTUP path.** A one-shot setup that opens Remote/switchOn/StartControl and exits leaves an RT plugin that knows nothing about mode as the only survivor; its `on_cleanup` must be presumed insufficient for controller-side state until proven. Symmetry check: whichever verb turned it ON must be reachable from wherever the OFF signal originates. The CodroidROS2 launch failed this check; `cri_teardown.py` is the permanent answer.

214. **When a step depends on an asynchronously-settling prior state, encode retry+backoff at the point that OBSERVES the not-ready error, not upstream at the state-change caller.** The observer sees the exact error code (5× 10074 → "never latched" is a distinct exit from any other failure) and can bail cleanly once the code-space is exhausted. (In the event, the fix was sequence — `toAuto → toRemote` — and the latch was synchronous; the retry ladder is what made that diagnosis one run instead of three.)

215. **With colcon `--symlink-install`, still rebuild + grep the installed copy after editing config.** The symlink usually makes source edits live instantly — the verification exists to catch the one case where the symlink chain is broken (Lesson-92 class). Cost: one second. Payoff: "I edited source but ros2_control read the stale copy" cannot happen at motion time.

216. **Teardown scripts are strictly verb-subsets of setup scripts** — never containing Start*/switchOn/mode-take verbs — so they are safe to run at ANY moment, including failure recovery from an unknown controller state. A byte-level banned-token grep is a cheap post-write gate.

217. **Motion-armed launches run in a tmux session, never a naked terminal.** One window-close or stray Ctrl-C otherwise kills the client and leaves the controller armed-but-unfed (Remote + switchOn + StartControl, 250 Hz push to a dead endpoint). Confirmed by this session's mid-D2 incident — which, silver lining, also live-proved the teardown script and demonstrated that a dead CRI client means the arm simply holds.

218. **Lesson numbers come from the FILE, not from memory.** This session provisionally assigned 202–208 while the source of truth already held 202–210 (Addendum 31); the collision was caught only by grepping the file's tail before appending. The append-only ledger is load-bearing for cross-references — the tail-grep is now part of writing any addendum.

---

*Summary of Addendum 32: the day the controller confessed to a second interface. A driver zip for the wrong arm revealed CRI — TCP setup on a port no capture had ever seen listening, UDP joint streaming at 250 Hz — and one disciplined ladder took it from static source review to real motion: mock-proven, firmware read at exactly the required 2.3.3.43, the 10074 error walked down to its answer (toAuto before toRemote, synchronous latch), first packets confirming our sign conventions to two thousandths of a degree on all six joints, and then the write path itself — a first move landing one encoder count from target, a round trip closing within three thousandths of a degree, and a coordinated two-joint move with bit-exact holds on the bystander joints. The day also paid its usual tuition: the disk floor tripped on regrown logs the watchdog watches but nothing prunes, the DHCP wander bit for the second time with the reservation still unmade, the borrowed launch turned out to arm the controller and never disarm it — answered with a teardown script that is deliberately incapable of turning anything on — and a stray Ctrl-C mid-session accidentally ran the best possible safety test, proving that when the stream dies the arm just holds. The Lua stack sleeps intact one systemctl away; the road ahead is the S10's own geometry under MoveIt and then the white bowl over the new nervous system. Eight lessons, one of them about the ledger itself: the numbers live in the file, not in anyone's memory.*

*Last updated: August 17, 2026 (Addendum 32 — Sections 504–510, Lessons 211–218)*
