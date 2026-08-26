# HARDWARE.md — session constants
> Always loaded. Slow-changing facts about the physical + network setup.
> Update on hardware change; not per-session. STATE.md carries anything
> that shifts inside a session. Every fact cites the source addendum
> (or `session-YYYY-MM-DD` for facts still awaiting an addendum).

Companion files: `OPERATIONS.md` (procedures), `FACTS.md` (ambient truths).

## Robot arm

- **Estun S10-140-ECO-V2** (Gen2), 6-DOF articulated, cabinet **CC10-A**,
  controller **KEBA**. Confirmed on-wire in `publish/RobotStatus.db.type`
  as literal `"S10-140-ECO-V2"`. [addendum-12 §112, §116]
- **Controller firmware:** exactly `2.3.3.43` — minimum floor of the
  CodroidROS2 driver. Config export stamps `SOFTWARE VERSION = 2.3` in
  `register_communicator_config.yaml`. [addendum-32 §506; addendum-12 §115]
- **MFC:** MF80. **MSC:** MS-ZLG06. **Joint firmware:** Ver 003D × 6.
  [addendum-32 §506]
- **URDF module:** `s10_140_description` (Phase E), byte-for-byte from
  `s10-140-full.urdf` with joints renamed `Joint1..Joint6`. Also on disk
  at `/opt/cobot/models/robot/s10-140-full.urdf`. [addendum-33 §512;
  addendum-13 §128]
- **Axis-flip convention (Option A, PERMANENT):** URDF `joint_3` axis
  `-1 0 0` and `joint_5` axis `0 -1 0`. Controller-positive rotation on
  J3/J5 is OPPOSITE the CAD geometric axis (consistent with the ~90°
  controller-zero θ offsets on J2/J4). **Do NOT correct back to CAD** —
  the CRI write path is calibrated against these axes. `apos_sign`
  migration deferred to its own atomic session with paired read/write
  regression tests. [addendum-13 §128; addendum-14 §133; addendum-33
  §512; memory `cobot-cri-axis-convention`]
- **Frame mapping (URDF Y-up ↔ CRI controller Z-up):**
  `ctrl_X = -URDF_Z`, `ctrl_Y = -URDF_X`, `ctrl_Z = +URDF_Y`.
  Physical "up" is URDF **+Y** for MoveIt Cartesian planning.
  [addendum-33 §516; memory `cobot-cri-frame-mapping`]
- **Joint limits (live from Config→Safety, enforced):**
  J1/J2/J4/J5/J6 = ±200°, **J3 = ±166°**. URDF `<limit>` = ±3.4907 /
  ±2.8972 rad (exact digit-match). `jointPositionLimitEnable` = ON.
  [addendum-12 §115; addendum-14 §134]
- **Joint velocity limits (Config→Safety, enforced):** J1/J2/J3 = 150°/s,
  J4/J5/J6 = 180°/s → URDF `velocity=` 2.618 / 3.142 rad/s (exact match).
  `jointOverSpeedEnable` = ON. [addendum-14 §134]
- **Firmware quirk:** `jointMaxVel = [150,150,150,180,180,180]` but
  `jointMaxVelRange` caps at 130 (J1–3) / 160 (J4–6) — factory defaults
  EXCEED their own settable range. **Do not edit/save that page.**
  [addendum-12 §115]
- **Encoder LSB:** 0.343–0.687 mdeg (Phase D characterization; drift
  0.000343° J1–J3 = one LSB, 0.000687° J4–J6 = two LSB).
  [addendum-32 §508]
- **Live `max_step_rad = 0.005`** (~1.25 rad/s slew ceiling at the 250 Hz
  plugin cycle = 71.6 °/s). Bumped from the earlier 0.002 override on
  2026-08-25 as part of the accel-ramp servo migration (addendum-40 §561)
  to give the adapter's per-cycle Δref adequate headroom without hitting
  plugin clamp during normal jog. Xacro `<xacro:arg name="max_step_rad">`
  default still reads 0.002 — the live value is set by
  `cri_tcp_setup.yaml`; verify with the plugin's boot line
  `[CriUdpSystem]: CRI UDP bind :10086 -> …:9030  max_step_rad=0.0050`.
- **CriUdpSystem plugin clamps:** `max_step_rad` per-cycle position slew
  cap (live value above); `max_err_vs_fb_rad = 0.5 rad = 28.6°` clamp of
  pos_cmd to feedback window; `hold_if_cmd_far_from_fb_rad = 0.15 rad =
  8.6°` holds output when cmd runs far from feedback.
  [session-2026-08-24 base; addendum-40 §561 update]
- **Cartesian terminalLimit (configured but DISABLED):** X ±1000,
  Y ±1000, Z −1000..+2500 mm. [addendum-14 §134]
- **Robot-limit config:** `cartAutoMaxVel = 2600 mm/s` (product ceiling
  1500), `manualCartOverSpeed = 250`, `payloadVerificationLevel = Off`,
  Drag Sensitivity 50, RunTo/Jog 30 deg/s / 250 mm/s. [addendum-25 area]
- **Config export snapshot:** `jointCollisionSensitivity 80`,
  `cartPositionLimitEnable false`, `safetyPosition [0,0,90,0,90,0]`,
  Auto acc `[450×3, 540×3]`, jerk `[3000×3, 3600×3]`,
  Tool 0 / Payload 0 / Coordinate 0 active during capture.
  Drag/freedrive → **DI port 18** (`robotDrag`, flange button).
  [addendum-12 §115]

### DH table (fitted, kinematics-authoritative)

Standard convention `(a_mm, alpha_deg, d_mm, theta_off_deg)`,
fit residuals: pos RMS 0.0245 mm test / 0.0251 mm train,
MAX 0.182 mm; ori RMS 0.0035°. [addendum-13 §122; addendum-08a §67]

| Joint | a (mm)   | α (°)  | d (mm)    | θ_off (°) |
|-------|----------|--------|-----------|-----------|
| J1    | 0        | 90     | 325.90    | −180      |
| J2    | −701.00  | 0      | −579.69   | −90       |
| J3    | −538.59  | 180    | −214.02   | 0         |
| J4    | 0        | −90    | −1000.00 (pinned) | −90 |
| J5    | 0        | 90     | −161.47   | 180       |
| J6    | 0        | 0      | 150.50    | 0         |

`base_z = −139.90 mm`. **Gauge freedom:** d₄ pinned; a₁, a₄, d₂, d₅, d₆
are unobservable aliases — the fit resolves the combination to 0.025 mm
but the individual link split is NOT physically unique. Use fitted DH
for IK; CAD-derived twin owns mesh placement. [addendum-13 §122, L78]

### Euler / TCP conventions

- **Fixed-axis X-Y-Z:** `R = Rz(c)·Ry(b)·Rx(a)`, scipy
  `Rotation.from_euler('xyz',[a,b,c])`. Intrinsic XYZ ruled out at
  581 mm residual. [addendum-12 §118; addendum-13 §122]
- **TCP height at home:** UI reads Z = 1586.577 mm; twin computed
  ≈ 1584 mm. [addendum-14 §134]

### Tool-flange + base mechanical

- **Tool flange (S-series manual §4.4):** 4× M6 threaded holes,
  ISO 9409-1-50-4-M6 / GB/T 14468.1-50-4-M6; bolts class 12.9,
  tighten to 12 N·m, screw-in depth ≤ 8 mm. Ø6 H7 locating-pin hole,
  Ø63 h8 pilot boss, Ø31.5 H7 central bore. [addendum-14 §138]
- **Base mounting:** 4× Ø9 through-holes on a Ø180 mounting circle
  (89+89 mm spacing) → M8-class fasteners. **Do not conflate M6
  (tool flange) with M8-class (base).** [addendum-14 §138]

### Power

- **CC10-A cabinet:** 0.35 kW typical / 2.5 kW peak, AC 100–240 V (or
  48 V DC via 1.5 kW supply). Full Synapse cell (Jetson + sensors +
  valves) ≈ 450 W typical. [addendum-34 §523]

## Network

### Controller (192.168.2.136)

Full open-port scan from Jetson-side, 2026-08-24 [session-2026-08-24]:

| Port | Protocol | Role | Cite |
|------|----------|------|------|
| `:22` | SSH | **NO SSH access** for us (Estun does not grant it) | [session-2026-08-24] |
| `:80` | HTTP | nginx default landing — unused | [session-2026-08-24] |
| `:502` | Modbus/TCP | Slave endpoint (ENABLED per register_communicator_config) | [addendum-12 §115] |
| `:5000, :5001` | Raw TCP | Proprietary; 10 s HTTP timeout, no reply | [session-2026-08-24] |
| `:5555` | ? | Open — role undocumented | [session-2026-08-24] |
| `:8080` | HTTP | **`部署系统` deploy tool (`api/update/upload`, `updatesys.pw`) — DO NOT USE for operations** | [session-2026-08-24] |
| `:9000` | WebSocket | **CodroidApi WS** (v2.3 `{ty, db, id}`, `publish/<Topic>` = SUBSCRIBE). No auth token needed. Boost.Beast async server. | [addendum-12 §116] |
| `:9001` | TCP | **CRI TCP control plane** (`Robot/*`, `CRI/*`, `System/*` verbs). Canonical write path from F1+. | [addendum-32 §506; session-2026-08-24] |
| `:9002` | ? | Open — role undocumented | [session-2026-08-24] |
| `:9090` | HTTP | `libhv/1.3.3` API-only backend (404 on every HTML path) | [session-2026-08-24] |
| `:9091` | ? | Open — role undocumented | [session-2026-08-24] |
| `:9198` | HTTP | **Factory web UI / operating panel** — title `Estun Web`. Alarms, clear-error, mode switch. Login `admin/123456` (also `eng/123456`, `project/123456`). Web accounts: eng, project, user. | [addendum-12 §114; session-2026-08-24] |
| UDP `:9030` | CRI | Controller state stream (~250 Hz, 308-byte struct) | [addendum-32 §506] |
| UDP `:10086` | CRI | Plugin binds local `:10086` and sends to controller `:9030` (log: `CRI UDP bind :10086 -> 192.168.2.136:9030`) | [addendum-32 §507; addendum-37 §537] |

- **Controller clock runs ~14 h ahead** (China time) — correlate logs
  accordingly. [addendum-32 §507]
- **IP was changed** from factory default `192.168.1.136` to
  `192.168.2.136` via factory UI Settings → Network (single "Robot IP"
  field, "Reboot to activate"). [addendum-12 §113; addendum-13 §124]

### CRI packet formats

- **State packet (UDP :9030 → :10086):** 308-byte struct
  `<q H H 6d 6d 6d 6d d 6d 6d` (int64 ts, 2× u16 status, joint pos/vel,
  ee pose/vel, tcp speed, torque, ext torque), ~250 Hz.
  [addendum-32 §506]
- **Command packet (UDP :10086 → :9030):** 64-byte joint-position
  commands, type=0. [addendum-32 §506]

### Jetson (`teddy-desktop`)

- **Model:** NVIDIA Jetson AGX Orin 64GB.
- **eno1 (wired to robot cell):** `192.168.2.246/24` (static,
  NetworkManager profile — NOT netplan; live `ip addr` changes never
  persist; watch for duplicate profiles and /32 masks that silently
  kill the subnet). [addendum-13 §124–125]
- **Wi-Fi (wlP1p1s0):** `192.168.1.246/24` (house network — flaky
  fallback, not the STABLE path). Last seen at DHCP `.143` (unreserved).
  MAC `50:2e:91:95:b6:15` → `.246` reservation requested but STILL NOT
  LANDED (5th bite as of 2026-08-25 — see also `.2.x` wired path
  under Subnet map, which sidesteps the whole class).
  [addendum-13 §124; STATE.md; session-2026-08-25]
- **JetPack 6.2.2** (Ubuntu 22.04), CUDA 12.6, L4T R36.5.0. ROS2 Humble
  native (no Docker). Isaac ROS NITROS 3.2.5 via apt. [HARDWARE.md
  legacy]

### Subnet map / operator access

**Physical topology — single switch.** TP-Link gigabit unmanaged switch
sits at the robot cell. On it, wired: Jetson eno1 `192.168.2.246/24`
(static), controller `192.168.2.136`, Livox LiDAR, operator laptop.
Jetson ↔ controller ↔ laptop all reachable on `.2.x` directly, no
tunnel. [session-2026-08-25]

**STABLE path (preferred) — wired `.2.x`:**
Laptop static IP `192.168.2.50` on its wired NIC (same switch as
Jetson). Then `ssh teddy@192.168.2.246`. Dashboard reachable at
`.2.246:8080` (wired) same way. No tunnel needed for factory UI: browse
the controller directly at `http://192.168.2.136:9198/`. This is the
recommended path for every operator session — kills the Wi-Fi flake
class entirely. [session-2026-08-25]

**F3 dashboard bind item:** dashboard currently binds to a single
interface. Bind to `0.0.0.0` so BOTH NICs (wired `.2.246:8080` and
Wi-Fi `.1.246:8080`) serve simultaneously — no code change should force
the operator to pick a network. Tracked in ATTEMPTS.md against F3.
[session-2026-08-25]

**FLAKY fallback — Wi-Fi `.1.x`:**
Jetson Wi-Fi `wlP1p1s0` lease `.1.143/24` (unreserved). Signal ~60,
**flaps on cold boot** — don't rely on it for a session start. DHCP
reservation for MAC `50:2e:91:95:b6:15` **STILL pending** (5th bite as
of 2026-08-25 — was requested at addendum-13 §124, not landed in the
router). Same-`/24`-fight rule below applies whenever Wi-Fi is up.
[addendum-13 §124; session-2026-08-25]

- **`192.168.2.x` (robot cell):** eno1 side + laptop wired. Robot .136,
  Jetson .246, Livox, laptop .50 all on the same switch.
  [addendum-13 §124; session-2026-08-25]
- **`192.168.1.x` (house / Wi-Fi, fallback):** Jetson .246 (Wi-Fi),
  tablet, laptop's Wi-Fi. [addendum-13 §124]
- **CRITICAL:** Wi-Fi laptop on `.1.x` **cannot reach controller on
  `.2.x` directly** — that's what the wired `.2.50` static path fixes.
  Two interfaces on same /24 will FIGHT: eno1 held to `.1.x` alongside
  Wi-Fi's `.246/24` killed SSH instantly and wedged Wi-Fi (power-cycle
  required). [addendum-13 §125, L75/L76; session-2026-08-24]
- **Factory UI direct browse (wired path, preferred):**
  `http://192.168.2.136:9198/` from the laptop's `.2.50` static.
  [session-2026-08-25]
- **Factory UI SSH tunnel (Wi-Fi fallback only):**
  `ssh -L 9198:192.168.2.136:9198 -L 9000:192.168.2.136:9000 teddy@192.168.1.246`
  then browse `http://localhost:9198/`. **Both ports must be
  forwarded** or frontend gets "Server network closed!"; nested
  Jetson→Jetson tunnel binds forwards on the wrong machine.
  [addendum-13 §124; L82]

## Sensors

- **2× Intel RealSense D435i** (`cam0`, `cam1`). NanoOWL on cam0
  (`roboai-nanoowl` service, L4T PyTorch, ~3–4 FPS, no TRT engine,
  runtime-mutable prompts, "approx (D435i)" depth labels).
  [HARDWARE.md legacy; memory `cobot-nanoowl`]
- **D435i USB gotcha:** cable >3 m drops to USB 2.0 / random
  disconnects; needs flex-rated cable, strain relief, active/optical
  USB3 above 3 m. [addendum-22 §384]
- **Eye-in-hand (planned):** ~80–120 mm lateral offset flange mount,
  hand-eye calibration via 100 mm tag36h11 AprilTag; scan pose settle
  ~300 ms; comfort distance ~300–500 mm. [addendum-22 §384]
- **Livox MID-360 LiDAR** — non-repetitive scan pattern → nvblox stays
  in camera-depth mode. `baseline_cloud.pcd` persisted per-cell.
  [HARDWARE.md legacy; addendum-04 §29–30]
- **Ouster:** scoped and blocked at physical layer; **do NOT add /24 to
  eno1** (SSH hazard). [memory `cobot-lidar-status`; HARDWARE.md legacy]

## Gripper / vacuum / pneumatics

- **Valve:** Tailonz **4V210-08** (5/2 internally pilot-operated),
  24 VDC coil, 3.0 W = 125 mA — exactly at the CC10-A DO channel limit,
  **relay mandatory**. [addendum-22 §374]
- **Vacuum generator:** venturi ejector (valve A port → venturi inlet
  → suction cup on venturi vacuum port); needs 0.4–0.6 MPa air.
  [addendum-22 §378]
- **Blow-off:** separate commanded valve on **DO3**
  (`setDO(3,1)` → pause → `setDO(3,0)`); NOT the valve's B port.
  [addendum-22 §379]
- **Valve port map (4V210-08):** P=1 supply-in, A=4 work (energized),
  B=2 work (de-energized) — **PLUG B**, R=5 exhaust-A, S=3 exhaust-B.
  **MUFFLERS never plugs.** [addendum-22 §379]
- **Wiring (relay path):** DO (PNP source) → relay coil A1(+) →
  A2(−) → 0 V paired with DO block. Relay COM ← 24 V; NO contact →
  solenoid terminal 1; terminal 2 → 0 V; ⏚ = DIN 43650 ground pin only
  (coil is strictly 1↔2). 1N4007 flyback across coil (stripe to A1)
  and across solenoid 1↔2. [addendum-22 §374]
- **DO electrical limits:** typical 24 V / max 30 V; 125 mA per channel,
  PNP source. [addendum-22 §373]
- **Relay recommendation:** Electronics-Salon 4-channel SPST-NO
  (Panasonic PA1a, built-in flyback diodes, DC common-negative).
  [addendum-22 §376]

## I/O vocabulary

- **Canonical naming (silkscreen-aligned):** `DO0..DOn`, `DI0..DIn`,
  `AI/AO` — replaces mock-era `X0.0/Y0.0`. [addendum-22 §380]
- **System-reserved terminals:** modeSwitch @ 16, enableButton @ 17,
  flangeButtons — excluded from step-editor selection. [addendum-22 §380]
- **Drag / freedrive:** DI 18 (`robotDrag`, flange button).
  [addendum-12 §115]

## Repos

- **V1** (`Ai-Robotics-Prototype/V1`): dashboard + roboai-* services.
  Working branch `feature/estun-write-path`. **PUBLIC — make private +
  rotate `aicollabs12`-era credentials** (long-open, final argument per
  addendum-36 §533). [STATE.md; addendum-36 §533]
- **CodroidROS2** (`theodoresimpson/CodroidROS2`, private): CRI ROS2
  stack + MoveIt configs. [addendum-35 §527]
- **git-LFS:** `.gitattributes` tracks `models/robots/**/*.glb`,
  `*.STL`, `*.STEP/*.step/*.stp`, `*.engine`. GitHub "Download ZIP"
  does NOT fetch LFS content — delivers 130-byte pointer files;
  `git lfs pull` required. [addendum-14 §132; L83]

## Systemd unit inventory

Under `/etc/systemd/system/`:

| Unit | Role | Boot / status |
|------|------|---------------|
| `roboai-dashboard.service` | FastAPI + WS + static frontend on `:8080` (HTTPS only, self-signed cert at `/opt/cobot/certs/dashboard_cert.pem`) | Active |
| `roboai-detector.service` | TensorRT detector (Ultralytics import BROKEN; do NOT re-add) | — |
| `roboai-executor.service` | Lua/WS program executor (fallback path) | STOPPED not disabled |
| `roboai-estun.service` | WS driver (v2.3 ty/db mirror). Monitor_only emits `/estun/rejected` 2 Hz baseline (`family='write'`, `reason='monitor_only active'`) | STOPPED not disabled under CRI backend |
| `roboai-lidar-identifier.service` | Publishes `/lidar_objects/identified` at 5 Hz | Active |
| `roboai-collision-monitor.service` | Python: FK + capsule-AABB, JSON `/collision/objects` + `/collision/status` | Active |
| `roboai-nanoowl.service` | NanoOWL on cam0, L4T PyTorch, ~3–4 FPS | Active |
| `roboai-pbd*` | PBD endpoints inside roboai-dashboard (no separate roboai-pbd unit); deps: ffmpeg + faster-whisper + anthropic; API key via EnvironmentFile drop-in | — |
| `roboai-autodeploy.path` → `autodeploy_wrapper.sh` | Watches commits; fires `scripts/deploy.sh` | Active |

- **EnvironmentFile drop-in pattern (F1 campaign):**
  `/etc/systemd/system/roboai-dashboard.service.d/campaign-f1.conf`
  sets `JOG_BACKEND=ros2` + `CAMERAS_DISABLED=1`. [addendum-37 §535]
  `/etc/systemd/system/roboai-estun.service.d/f1_monitor_only.env`
  (referenced by `f1_monitor_only.conf` via `EnvironmentFile=`) sets
  `ESTUN_MONITOR_ONLY=true`, `ESTUN_ALLOW_JOG=0`,
  `ESTUN_ALLOW_MOVE=0`, `ESTUN_ALLOW_CARTESIAN=0`.
  [session-2026-08-24]
- **Systemd env precedence gotcha:** `EnvironmentFile=` in a drop-in
  loads AFTER the base unit's `EnvironmentFile=` and overrides.
  `Environment=` in a drop-in is SHADOWED by any base-unit
  `EnvironmentFile=` — use the FILE approach, not `Environment=`.
  [session-2026-08-24]
- **estun_driver env-var overrides:** `ESTUN_ROBOT_IP`,
  `ESTUN_ROBOT_PORT`, `ESTUN_MONITOR_ONLY`, `ESTUN_ALLOW_JOG`,
  `ESTUN_ALLOW_MOVE`, `ESTUN_ALLOW_CARTESIAN`, `ESTUN_ALLOW_POWER`,
  `ESTUN_ALLOW_IO`. [addendum-14 §132; addendum-21]

## Compute

- NVIDIA **Jetson AGX Orin 64GB**, JetPack 6.2.2, Ubuntu 22.04,
  CUDA 12.6, L4T R36.5.0. ROS2 Humble native. Isaac ROS NITROS 3.2.5.
  [HARDWARE.md legacy; CLAUDE.md]

## Safety zones (ISO 10218)

| Distance    | Zone   | Speed scale | ESTOP           |
|-------------|--------|-------------|-----------------|
| > 1.2 m     | GREEN  | 100%        | off             |
| 0.6–1.2 m   | YELLOW | 25%         | off             |
| < 0.3 m     | RED    | 0%          | on (latched)    |
| timeout     | —      | 0%          | on (watchdog)   |
| startup     | —      | 0%          | on (3 s warmup) |

- **Latch reset:** zone=GREEN + service call `/safety/reset_estop`.
- **Config:** `src/cobot_bringup/config/safety.yaml`
  (`zone_*_m`, `no_detection_safe_distance`).
- **Pipeline:** `human_safety` (MediaPipe skeleton) →
  `/safety/human_proximity`, `/safety/zone`, `/safety/skeleton_markers`
  → `safety_monitor` → `/safety/speed_scale`, `/safety/estop`,
  `/safety/status`.
- **Operator speed cap asymmetry:** 65% for programs, jog unchanged
  (50% hw / 25% op-limit). Increases confirm; decreases apply instantly.
  [era-01 §Safety Architecture; addendum-21; CLAUDE.md]

## Runtime motion-command constraints

- **Per-cycle acceleration limit ≈ 25 rad/s²** enforced by the CC10-A
  firmware on the incoming command stream (UDP `9030` in-bound from
  `CriUdpSystem`). Any command Δv/cycle above this threshold triggers
  alarm 2015 on the target joint. Applies to any layer feeding position
  setpoints — `moveit_servo` Butterworth output does NOT respect it;
  `JointGroupPositionController` passthrough does NOT respect it. The
  jog path now respects it via `jog_servo_adapter`'s 18 rad/s² accel-ramp
  (below the ceiling with margin). Pilz PTP/LIN planning respects it
  natively through the trajectory generator's own accel limits.
  [addendum-40 §562; STATE 2026-08-26]

## Alarm codes (observed / documented)

Codes from estun_driver source docstring + session-observed on-wire.
Severity 4 = latched fault. Full list is not exhaustively documented.
The 2015 text below corrects the estun_driver docstring's
"Cartesian velocity / singularity" label — the on-wire message text
observed 2026-08-25 is the acceleration-discontinuity variant.
[session-2026-08-24; addendum-40 §562]

| Code  | Text                                          |
|-------|-----------------------------------------------|
| 2000  | Joint\<n\> servo status error, error code: 0x\<hex\> |
| 2002  | Joint\<n\> exceeded limit                        |
| 2006  | Emergency stop button pressed                 |
| 2009  | Collision detected on Joint\<n\>                 |
| 2015  | Joint\<n\> speed command jump or local acceleration too high — accel/step-discontinuity trip; distinct from 2009 (collision) and 2006 (e-stop) [addendum-40 §562] |
| 2023  | Singular position                             |
| 9012  | Power disconnection detected                  |
| 13046 | Emergency stop pressed                        |
