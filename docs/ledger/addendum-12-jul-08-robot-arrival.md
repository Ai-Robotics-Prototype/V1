---
ledger_split: addendum-12
source: cobot_project_conversation_v46.md
source_lines: 11019-11117 (inclusive)
title: Robot arrival, factory UI, Codroid v2.3 WS protocol
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 12 — July 8, 2026: Robot Arrival, Factory UI Commissioning, and Full Reverse-Engineering of the Codroid v2.3 WebSocket Protocol (FK Oracle Captured)

*Append-only. All prior content (v14–v26, Addenda 1–11) preserved unchanged. This addendum continues section numbering from §111 and lesson numbering from 63.*

## 112. ROBOT ARRIVAL & POWER-ON
The **Estun S10-140-ECO-V2** (Gen2, CC10-A cabinet, KEBA controller) physically arrived and powered on healthy. Confirmed on the factory dashboard: model **S10-140-ECO-V2**, **Real Machine** (实机, isSimulation:false), mode switch exposes **Manual / Auto / Remote** (Remote noted for future external-command sessions), and a `runDuration`/`totalTime` counter. Controller clock is ~12h off (showed 2026/07/09 ~2:3x AM) — fix later via Settings→Time (triggers restart), batch at end of session.

## 113. NETWORK TOPOLOGY (CRITICAL, UNRESOLVED HARDWARE CONSTRAINT)
The Wi-Fi router is **in the house, too far to cable to the shop**. Laptop, Jetson, and tablet are all on Wi-Fi. The **robot controller Ethernet is cabled DIRECTLY to the Windows laptop only** — so **only the laptop can reach the robot**; the Jetson (192.168.1.246) gets `Destination Host Unreachable` (ARP fails, robot not on its segment). The Estun cabinet has **no built-in Wi-Fi** — wireless requires a USB3.0 Wi-Fi module (optional accessory) in the cabinet.

**Robot IP = 192.168.1.136** (Gen2 default; found on first ping from laptop set to 192.168.1.50/24). This is on the LAN subnet → **NO subnet conflict**; the earlier 101.x dual-IP planning is moot. LAN ports: use **LAN1/2/4/5** (LAN3 = EtherCAT only).

**[DECISION / PENDING PURCHASE]** Need a **Wi-Fi-to-Ethernet bridge (~$30–60)** in the shop (a spare router in client/bridge mode, or a travel-router/extender with an Ethernet port), ideally feeding a small unmanaged switch, so the robot **and a wired Jetson** share the LAN. Wired Jetson is required before commanded motion (Wi-Fi jitter unsafe for the ~400 ms jog deadman). Until the bridge arrives: **ALL robot-facing work runs on the LAPTOP in PowerShell** (`PS C:\Users\Laptop>`). Prompt tells location: `PS C:\...>` = laptop; `teddy@teddy-desktop:~$` = Jetson (note: the Jetson's hostname is literally `teddy-desktop`, and it replies as .246 — the "desktop" name is misleading).

## 114. FACTORY WEB UI — LOGIN, LANGUAGE, CAPTURES
Web UI at **http://192.168.1.136:9198**, login **admin / 123456** (also `eng`/`123456`, `project`/`123456`). Accounts: eng, project (both Engineer/工程师), user (Operator). **Language toggle reverts to Chinese** repeatedly (per-account localStorage, unreliable) — remedies: select English → **应用/Apply**; if it reverts, log out → **清空缓存/clear-cache** link on the login page → log back in; or just use Chrome right-click **Translate**. Bottom-of-login links: 下载日志 (download logs), 清空缓存 (clear cache).

**Config export** (Applications/应用 → Import/Export) produced the YAML/JSON set already documented (see §Config below). **No DH page exists anywhere in the UI** — the Configuration tab tiles are: Install, tool, coordinate system, IT, Safety, communication, Preset position, Production, SDO, Developers, EOL, Safety controller. **SDO / Developers / EOL / Safety controller are LOCKED to both admin AND eng** (manufacturer-reserved; could not open). Confirmed: **no DH tile, no kinematics page** reachable at our permission level.

**[DECISION] Do NOT ask Estun/supplier for the DH table.** Teddy has escalated enough; we extract kinematics ourselves via the FK oracle (§118).

## 115. CONFIG EXPORT — KEY FINDINGS (firmware 2.3)
- **SOFTWARE VERSION = 2.3** (stamped in `register_communicator_config.yaml` on every protocol block) — **newer than the v2.2 English manual.** Expect minor UI/API drift from the docs.
- `safety_config.yaml` **shipped soft joint limits: ±200° J1/J2/J4/J5/J6, ±166° J3** (settable range ±360°, J3 ±166°). **These SUPERSEDE the manual's ±160° J3 quote and the earlier robot.json ±130/±150 guess.** Driver clamps + URDF reconciliation should use **±200 / ±166**.
- Morning packing pose was J=[90, 0, 160.7, −19.3, 181, 180] — **all inside ±200/±166**, so the earlier "J3 past limit / out-of-limit fault expected at enable" warning is **RETRACTED**. No fault occurred at enable.
- `jointMaxVel = [150,150,150,180,180,180]` but `jointMaxVelRange` caps 130 (J1–3) / 160 (J4–6) — factory defaults exceed their own settable range (firmware quirk). **Do not edit/save that page** or it may clamp down.
- `jointCollisionSensitivity: 80`; `cartPositionLimitEnable: false`; `safetyPosition: [0,0,90,0,90,0]`; Auto acc `[450×3,540×3]`, jerk `[3000×3,3600×3]`.
- Register comms **ENABLED**; **ModbusTCP slave live at 192.168.1.136:502**; method list includes a native **"Estun"** protocol option (+ Anybus/Profinet/EthernetIP). Heartbeat detection OFF.
- **Drag/freedrive mapped to DI port 18** (`user_di_function.yaml`: `{port:18, function:"robotDrag"}`) — the flange button.
- tool / payload / coordinate all factory-zeroed (Tool 0 = bare flange). **ToolId 0 confirmed active during the entire capture session** (from RobotStatus frames).

## 116. WEBSOCKET PROTOCOL FULLY REVERSE-ENGINEERED — THE KEY WIN
**[CRITICAL] The v26-documented API (JSON `{id,type,action,data}` at ws://:9000) is DEAD on firmware 2.3.** All eight guessed envelopes got silently ignored (connect OK, queries dropped). The real protocol was recovered by reading the **factory web UI's own WebSocket frames** via Chrome DevTools (F12 → Network → **Socket** filter → click socket → **Messages** / **Headers**). The working client reveals the true schema.

**REAL PROTOCOL (firmware 2.3):**
- **Server:** Boost.Beast (embedded C++, `Boost.Beast/290 websocket-server-async`). Endpoint **`ws://192.168.1.136:9000/`**. The browser opens **TWO** connections both to :9000 (one command/auth channel, one telemetry firehose). A separate **:9198** socket carries a session token in `Sec-Websocket-Protocol` but is **NOT needed** (red herring — likely terminal/log stream). **The firehose is on :9000 with NO token.**
- **Envelope = `{ty, db, id}`** where `ty` is the routing path (e.g. `publish/RobotPosture`, `command/send`, `user/login`). Frames must be **compact JSON (no spaces)** — the server's JSON handling is hand-rolled (it emitted literally invalid JSON `"type":,` in one error).
- **`publish/<Topic>` means "SUBSCRIBE me to Topic," NOT "here is data."** This was the crux. The browser's opening handshake on the firehose socket: `{"ty":"publish/web"}` then a **BURST** of `{"ty":"publish/<Topic>"}` subscribe frames. Topics observed: web, WebCommand, Error, ProjectState, RobotStatus, RobotPosture, RobotCoordinate, ProjectStatus, UserAgent, TasksInfo, Variable. It also does request/response on the same socket: `globalVar/getVars`, `additionalAxis/getAxisNumber`, `System/GetLog`, `Robot/Get3DModelName`.
- **Two error routers, split by `ty` prefix:** `user/*` → old-style `{type,action,code,data}` error, **strips** the prefix (`user/login` → action `login`); `command/*` & `request/*` → new-style `{id,ty,err:"404/unkown request"}`, **keeps** `ty`. The `user/login` frame `{"ty":"user/login","db":{"us":"eng","lv":5},"id":<16-char>}` is a **pub/sub broadcast the browser echoes**, NOT a real request — **password-less** (username + level only). **Login/auth is NOT required to receive broadcasts.**
- **Keepalive:** literal string frames `"ping"` / `"pong"`.
- **RobotPosture ONLY broadcasts when the robot is ENABLED** (`state:2`). When disabled (`state:0`), only RobotStatus + empty Error stream. This gating caused two zero-frame runs before it was understood.
- **RobotPosture frame = COMPLETE MATCHED PAIR (the FK oracle):**
  `{"ty":"publish/RobotPosture","db":{"joint":[j1..j6],"end":{x,y,z,a,b,c,mode},"ep":[]}}` — six joint **degrees** (APOS) ↔ TCP **mm/deg** in base/world frame, ~10–15 Hz. `mode:-1` is a config/branch flag. **This IS the DH-identification dataset.**
- RobotStatus frame carries: `mode, state, isMoving, moveRate, manualMoveRate, recoveryState, isSimulation, teachingPendant, rescueFlag, ToolId, PayloadId, CoordinateId, type:"S10-140-ECO-V2", stateName, runDuration, totalTime`.

## 117. WORKING PYTHON CLIENT — `posture.py`
A standalone Python client on the laptop (`C:\Users\Laptop\posture.py`, Python 3.13, `pip install websockets` — the asyncio/sync package, NOT `websocket-client`) replicates the browser: connects to `ws://192.168.1.136:9000/` with `origin="http://192.168.1.136:9198"`, sends `publish/web` + the subscribe burst (web, WebCommand, Error, ProjectState, RobotStatus, RobotPosture, RobotCoordinate, ProjectStatus), answers ping with pong, and logs every frame to `estun_posture_<ts>.jsonl` (**`encoding="utf-8"` required** — Chinese log text in some frames breaks the default cp1252 on Windows). Progression of probe scripts on the laptop: `test_estun_connection.py` (has `--ip`, config-param support from the driver-hardening work), `probe_estun.py`, `probe2.py`, `probe3.py`, `estun_logger.py`, `posture.py`. **PowerShell here-string** (`@'...'@ | Set-Content -Encoding utf8 file.py`) is the reliable way to write these files — Notepad paste and clipboard both failed repeatedly (0-byte files, concatenated junk lines).

## 118. DH-IDENTIFICATION CAPTURE (THE FK ORACLE DATASET)
With the robot **enabled** and Tool 0 active, `posture.py` captured a **hand-sweep**: the arm was drag-moved slowly through its range, roughly **one joint at a time** — the ideal structure for kinematic ID.
- **File:** `estun_posture_20260708_161306.jsonl` (~1,039 KB). **5982 frames total, 4653 RobotPosture frames**, 311 s.
- **After dedupe (drop frame if all joints within 0.05° of last kept): 2458 unique poses.**
- **Joint coverage (deg):** J1 −232.78..201.56 (span 434), J2 −93.66..41.94 (136), J3 −167.01..159.02 (326), J4 −89.76..30.29 (120), J5 90.98..269.56 (179), **J6 176.53..235.79 (span 59 — narrowest; adequate but a targeted re-sweep is the fallback if it fits poorly).**
- **TCP ranges (mm):** x −777..653, y −653..653, z 41..1606.
- Sweep segments (approx, single-axis): J1 alone ~1250–2450, J2 ~2500–3000, J3 ~3050–3550, J4 ~3800–3950, J5 ~4000–4200, J6 ~4250–4650; long static warm-up frames 1–1250.

**Euler-convention finding (partial, from Cloud analysis before timeout):** intrinsic **XYZ is WRONG** (fit residual ~350 mm). **Fixed-axis X-Y-Z** (`R = Rz(c)·Ry(b)·Rx(a)`, scipy `Rotation.from_euler('xyz',[a,b,c])`) and its equivalent are correct and match the Gen1 manual's X-Y-Z fixed-angle spec. Position error is convention-independent, so geometry fits first, then orientation locks the convention.

**Compute note:** the full nonlinear DH fit **could not complete in the Cloud analysis sandbox** (pure-Python FK loop × thousands of poses × numerical Jacobian is too slow / timed out). The fit is **handed to the Jetson** via a `fit_dh.py` Claude Code prompt requiring a **vectorized** FK (batched (N,4,4) matmul, no per-pose Python loop) and a **two-stage fit** (position-only to lock geometry, then position+orientation). Data staged to Jetson via `scp ... teddy@192.168.1.246:/home/teddy/cobot_ws/data/`. **DH extraction is the immediate next step — data is verified good; only the fit remains.**

## 119. ROBOT STATE / SAFETY NOTES (this session)
- The arm was **enabled** mid-session (green 已使能 / `state:2`) to make RobotPosture broadcast and to allow drag. An **e-stop (急停) was pressed** at ~16:00:39 (visible in the log stream and RobotStatus flipping to `state:0`), then re-enabled. RobotPosture stopped during disable and resumed on re-enable — this is how the enable-gating of the firehose was confirmed.
- **WARNING still open:** joint-direction **sign** between the on-screen readout and physical reality is **NOT yet verified**. Before any commanded motion, move one joint a few degrees and confirm the on-screen sign matches — do not trust commanded motion until then.
- Web UI is **open on the LAN with default passwords** — change post-commissioning.

## 120. PENDING ACTION ITEMS (as of July 8, 2026; extends §109/§110)
| Item | Priority | Status |
|------|----------|--------|
| **Run `fit_dh.py` on the Jetson** — vectorized two-stage DH fit on the captured 2458-pose oracle set; emit fitted DH table + `estun_s10_140_fitted.urdf` + residual report. Target sub-mm RMS. | **HIGH — IMMEDIATE** | Data staged; fit pending |
| **Reconcile URDF/driver limits to ±200°/±166°** (shipped soft limits; supersedes ±360/±160 and ±130/±150). | HIGH | Fold into fitted URDF |
| **Acquire Wi-Fi-to-Ethernet bridge + small switch** for the shop; wire the Jetson before commanded motion. | HIGH | Purchase pending |
| **Rewrite Jetson `estun_driver` message layer** for the `ty`/`db` v2.3 schema. The v26 `action:` schema is OBSOLETE. Real: `{ty,db,id}`; subscribe via `publish/<Topic>`; RobotPosture for telemetry; `command/*` router for commands (exact write verbs beyond `command/send` still unknown — `command/send` with `db:{pm:{}}` is an observed keepalive; **real command args go inside `pm` — need a populated `command/send` capture to learn write commands**). | HIGH | After DH fit |
| **Verify joint-direction signs** on the real arm before any commanded motion. | HIGH | Safety-gated |
| Complete the read-only mirror milestone (§110 step 4) once Jetson↔robot network exists. | HIGH | Blocked on bridge |
| Change default passwords; fix controller clock (Settings→Time, restarts). | MEDIUM | Post-commissioning |
| Targeted re-sweep of J6 (and any poorly-constrained axis) if the fit residual demands it. | LOW | Contingent on fit |
| (Carried) Write reusable `pmraw_decode.py` for Jetson; update Chinese deck + one-pager (founder roles); UI rebrand RoboAi→NeuRobots/Deep Steel. | — | Carried forward |

## 121. PROCESS LESSONS — JULY 8 ADDITIONS (extend §111; all prior lessons govern)
64. **Read the working client's traffic instead of guessing the schema.** Eight guessed JSON envelopes all failed silently; one DevTools capture of the factory UI's own frames revealed the entire `ty`/`db` protocol. When a vendor UI already talks to the device, its wire traffic is ground truth — F12 → Network → Socket → Messages/Headers.
65. **`publish/<Topic>` was a SUBSCRIBE, not a publish.** The single most misleading name in the protocol. The client asks to receive a topic by "publishing" its interest. Zero frames arrived until we sent the exact subscribe burst the browser sends.
66. **The telemetry firehose only streams when the robot is ENABLED.** Two zero-frame captures were caused by a disabled arm (`state:0`), not by a protocol error. Check `state:2` in RobotStatus before concluding the subscribe failed.
67. **Silent-connect / ignored-query is the signature failure mode of this controller.** TCP connect succeeds and the socket stays open even when every request is dropped or 404'd. "Connected" means nothing; only a matched reply or a broadcast frame means success. Catching this on the laptop saved the Jetson driver from chasing it twice (wrong schema, then enable-gating).
68. **Two error dialects reveal two routers.** `user/*` returns old-style `{type,action,code}` and strips the prefix; `command/*`/`request/*` return `{id,ty,err}` and keep it. Reading *which* error format comes back tells you which internal dispatcher handled the frame — a free map of the API's structure, obtained purely from 404s.
69. **Compact JSON + UTF-8, always, with this firmware.** The server's hand-rolled JSON is whitespace-sensitive enough to distrust pretty-printing; and frames contain Chinese text, so any file write must be UTF-8 (cp1252 default on Windows crashes on the first 关节/超限 string).
70. **The controller (CC10-A / KEBA) IS the robot; our entire stack is a WebSocket client of it.** It permanently owns servo control, kinematics, safety, and limits. There is no path that bypasses the factory controller — the factory web UI and our stack are peers, both clients of the same Boost.Beast server on :9000. Keep the factory UI as the permanent commissioning/diagnostic layer.
71. **The controller's own FK is the DH table, sampled — so capture it rather than transcribe it.** A hand-sweep logging matched joint↔TCP pairs yields a dataset that fits to authoritative kinematics with no transcription error and simultaneously validates the Euler convention. This is strictly better than a pendant screenshot and made asking the supplier unnecessary.
72. **Sweep one joint at a time for a well-conditioned kinematic fit.** Single-axis segments isolate each link's parameters and let you sanity-check per-joint coverage before the global optimization. J6's narrow 59° span flagged itself immediately as the one axis that might need a re-sweep.
73. **Match the compute to the job — hand the heavy nonlinear fit to the Jetson, not the analysis sandbox.** A pure-Python FK loop over thousands of poses with a numerical Jacobian times out in a constrained sandbox; vectorized FK (batched (N,4,4) matmul) on the Jetson host is the right tool. Validate data quality where it's convenient, run the optimizer where there's horsepower.
74. **`PS C:\...>` vs `teddy@teddy-desktop:~$` is the machine tell — and this session it mattered constantly.** All robot-facing work ran on the laptop (only machine wired to the robot); the Jetson couldn't even ping the robot. scp direction, which shell runs a script, and where a file lands all hinge on reading the prompt first. The Jetson's hostname `teddy-desktop` is a deliberate-sounding red herring; it is the Jetson (.246).

---

*Summary of Addendum 12: The Estun S10-140-ECO-V2 arrived, powered on healthy, and was commissioned through the factory web UI (192.168.1.136:9198, admin/123456). Network reality: the router is in the house, the robot is cabled only to the laptop, and everything else is on Wi-Fi — so only the laptop can reach the robot, and a Wi-Fi-to-Ethernet bridge (~$30–60) plus a small switch are needed before the Jetson can connect or any commanded motion occurs. Robot IP is 192.168.1.136 (on the LAN subnet — no conflict; 101.x planning moot). Firmware is v2.3 (newer than the v2.2 manual). Config export confirmed shipped soft joint limits of ±200° (J3 ±166°) — these SUPERSEDE all earlier limit values (±360/±160, ±130/±150) and retire the "J3 past limit" warning; also confirmed ModbusTCP slave live on :502, drag on DI 18, and Tool 0 (bare flange) active. No DH page exists in the UI at any accessible permission level (SDO/Developers/EOL/Safety-controller locked to admin AND eng); the decision was made to STOP asking the supplier and extract kinematics ourselves. The session's central achievement: the Codroid v2.3 WebSocket protocol was fully reverse-engineered by reading the factory UI's own frames in Chrome DevTools. The v26-documented {id,type,action,data} API is DEAD; the real protocol is {ty,db,id} over ws://192.168.1.136:9000/ (Boost.Beast), where publish/<Topic> means SUBSCRIBE, login is password-less (username+level) and not required for broadcasts, keepalive is literal ping/pong, and RobotPosture broadcasts matched joint(deg)↔TCP(mm/deg) pairs ONLY when the robot is enabled (state:2). A working Python client (posture.py) replicated the browser handshake and captured a one-joint-at-a-time DH-identification sweep: 4653 RobotPosture frames → 2458 unique poses, all six axes exercised (J6 narrowest at 59°). Euler convention is fixed-axis X-Y-Z (intrinsic XYZ ruled out at ~350mm residual). The full DH fit could not complete in the Cloud sandbox (pure-Python FK too slow) and was handed to the Jetson via a vectorized two-stage fit_dh.py prompt — DH extraction is the immediate next step; data is staged and verified. An e-stop was pressed and cleared mid-session (which confirmed enable-gating of the firehose); joint-direction sign vs reality remains UNVERIFIED and is safety-gated before any motion. The Jetson driver's message layer must be rewritten for the ty/db schema (the action: schema is obsolete; write-command verbs inside command/send's pm object are still unknown, needing a populated capture). Eleven new process lessons (64–74). All prior content v14–v26 (Addenda 1–11) preserved unchanged.*

*Last updated: July 8, 2026 (Addendum 12)*

---

<!-- v46-content-end -->
