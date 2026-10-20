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
- **General-purpose DIs are DI0–DI15.** DI16/17/18 are
  RESERVED signals wired through dedicated interfaces, NOT
  terminals available on the general I/O block. Do not attempt
  to jumper them from the general I/O connector. [manual §—; 2026-08-31 absorb]
  - **DI16 = `modeSwitch`** — routed via the **Hand Controller
    (HC) interface**. This is a HARDWARE AUTO/MANUAL gate: the
    firmware silently ACKs `Robot/toAuto` (empty `db` success
    shape) but does NOT transition mode when DI16 == 0. Wire
    evidence: 2026-08-31 MODE pill acceptance — two `toAuto`
    verbs both ACKed empty-db, `mode` stayed at 1, DI16 read 0
    via `IOManager/GetIOValue`. [add-53 §655-660]
  - **DI17 = `enableButton`** — likely also HC-interface
    routed (co-located reserved signals).
  - **DI18 = `robotDrag`** — the **flange drag / freedrive
    button**, routed via the **aviation plug on the tool
    flange**, NOT through cabinet DIs. [addendum-12 §115;
    2026-08-31 absorb]
- **Enabling AUTO — the software-binding path (2026-08-31
  software manual):** the CC10-A firmware supports assigning
  **function aliases to general-purpose DIs** at
  `http://192.168.2.136:9198 → Configuration → IO`. A DI
  bound to "Switch to Auto Mode" or "Switch to Manual Mode"
  triggers the corresponding mode transition on a **rising
  edge** — the alias takes effect immediately, no service
  restart, no separate Save. Combined with the driver's
  `IOManager/SetIOForcedFlag` write path (wire-proven), this
  gives us **zero-wire mode switching** without touching the
  DI16 modeSwitch hardware gate at all.

  **Reserved-DI hunt RETIRED (add-53 follow-up):** since the
  binding path bypasses DI16 entirely, we no longer need to
  find or wire the HC-interface modeSwitch input. DI16
  becomes an observation-only field.

- **DI function-binding table (per software manual,
  2026-08-31):** a bound DI's rising edge fires the assigned
  function. Selected assignments relevant to us:
  - `Switch to Auto Mode` — publishes the same firmware event
    as the (hardware, unwired) DI16 modeSwitch rising edge.
  - `Switch to Manual Mode` — inverse of the above.
  - `System Reset` — clears alarm state (equivalent to
    `System/ClearError`).
  - `Program Start` — starts the currently-loaded project
    (Remote-mode Run affordance).
  - `Program Pause / Stop` — inverse of Start.
  - `Protective Stop` — asserts the ch1-2 protective input
    equivalent (see safety §5.2.2). Do NOT bind lightly.
  - (More per the manual's alias list — copy the full table
    in when the manual is next open.)

  **This surface is our PLC-integration story** — external
  Run/Stop/Reset/Protective-Stop from a customer's PLC are
  wired to general-purpose DIs on the cabinet, each bound to
  its function alias in the UI. See Synapse note below.

- **Driver support:** `roboai-estun` env
  `ESTUN_MODE_VIA_DI=1` (default 0) flips the mode ladder to
  use the bound-DI pulse instead of `Robot/toAuto` /
  `Robot/toManual`. Bound-DI ports default DI6 (auto) /
  DI7 (manual), overridable via `ESTUN_MODE_DI_AUTO` /
  `ESTUN_MODE_DI_MANUAL`; pulse width via
  `ESTUN_MODE_DI_PULSE_MS` (default 120 ms). Read-back
  verify is unchanged (poll `publish/RobotStatus.mode` up to
  3 s). Dashboard-side Rung 0 (DI16 check) automatically
  skips when `ESTUN_MODE_VIA_DI=1`. Envelope carries
  `via='bound_di_<port>'` for observability. [add-54 §—]

- **Synapse enclosure note (controls-engineer deck):**
  customer-facing mode selection is one line item in a
  larger PLC-integration story. Cabinet-side general DIs
  (DI0–DI15) route to customer PLC terminals; each DI is
  bound to a function alias in the factory UI. Any PLC
  can then drive Run/Stop/Reset/Protective-Stop without
  writing a single line of software. This is the product
  story for controls engineers: **"any DI, any function,
  bound in the UI, effective immediately."** Add to the
  deck as a first-class capability slide.

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

## Software-manual constants (2026-08-31 absorb)

- **Factory-UI admin password:** `codroidsafety` — required
  for the Configuration / IO-binding pages at `:9198` and
  for other settings gated behind the safety role. Store as
  a bench credential; NOT a customer credential. Rotate on
  the Synapse enclosure integration if the manual documents
  a rotate procedure (TBD — pull from manual on next read).
- **Simulation / Real Machine switch:** the factory UI
  exposes a switch that selects whether commanded motion
  goes to the real servos or to an internal simulator.
  Bench diagnostics may benefit from Simulation mode; do NOT
  leave a shipped cabinet in Simulation. Location: TBD from
  manual on next read.
- **Error-code appendix:** the manual has a canonical error-
  code appendix (matches the codes in `HARDWARE.md > Alarm
  codes`). When a new code surfaces on the wire, look up its
  operator-facing meaning + recovery gesture in that
  appendix before writing new ladder branches. Reference:
  CC10-A software manual, appendix (section-number TBD).

## Modbus TCP remote-control map (Estun Remote Control Manual v2.0)

**Provenance:** transcribed 2026-09-02 from
`docs/manuals/remote_control_v2.pdf` (机器人远程控制 v2.0,
10 pp, WPS-authored 2026-07-22, `webotl`). Every row below
is verified against the source PDF §3.1 (pages 6–7). Do NOT
overwrite this table from dictation — re-open the PDF and
diff against §3.1 if a re-verification is needed.

**Wire:** Modbus TCP slave at `192.168.2.136:502`
(HARDWARE.md > Network — enabled since add-12). Unit-ID and
function-code choices (03/06/16 vs 01/05/15) not specified
in the manual for the 1000-series addresses; the manual
uses generic "地址" (address) and the trigger semantics
"监测状态：0-1 变化生效" ("monitor state: 0-1 rising edge
takes effect"). 42000/42001 are explicitly holding
registers (UInt16 rw); the 1000-series is empirically-TBD
coil-vs-holding-reg — probe with FC03 first and FC01 as
fallback before writing.

**Preconditions the manual does not spell out but implies:**
- Arm must be in **Remote mode** (status reg 2015 = 1). The
  factory UI's top bar has 手动 / 自动 / 远程 buttons;
  bound-DI or WS toggle can drive the transition. Auto-only
  (2014=1, 2015=0) is NOT sufficient — this map is under
  the "远程模式" heading of the top bar, not Auto.
- Arm must be enabled (2003=1) before `1000 启动工程` will
  actually start motion. The manual's §1 时序图 shows 使能
  latched high before 开始信号 rises.

### §3.1.1 System control inputs (address 1000+, rising-edge)

| Address | Function (CN → EN)          | Notes |
|---------|------------------------------|-------|
| 1000    | 启动工程 (start project)     | rising 0→1 triggers |
| 1001    | 停止工程 (stop project)      | rising 0→1 triggers |
| 1002    | 暂停工程 (pause project)     | rising 0→1 triggers |
| 1003    | 上使能 (servo on / enable)   | rising 0→1 triggers |
| 1004    | 下使能 (servo off / disable) | rising 0→1 triggers |
| 1005    | 清除报警 (clear alarms)      | rising 0→1 triggers |
| 1006    | 开始拖动 (start drag)        | rising 0→1 triggers |
| 1007    | 停止拖动 (stop drag)         | rising 0→1 triggers |
| 1008    | 切自动 (switch to Auto)      | rising 0→1 triggers |
| 1009    | 切手动 (switch to Manual) [manual prints "切收动" — typo] | rising 0→1 triggers |
| 1010    | 下发自动速率 (apply auto rate)   | rising edge; latches value pre-written to 42001 |
| 1011    | 下发手动速率 (apply manual rate) | rising edge; latches value pre-written to 42001 |
| 42000   | `startProjectNumber` (project-map index) | UInt16 rw. **Requires the index to be pre-bound in `配置→IO→工程映射`; if the slot is empty, `1000 启动工程` is a no-op** (per §2.2.1 note). |
| 42001   | 设置手/自动速率 (set manual/auto rate) | UInt16 rw, value 1–100 (%). Write value THEN pulse 1010 or 1011 to apply. |

### §3.1.2 System status outputs (address 2000+, level)

| Address | Function (CN → EN)          | Semantics |
|---------|------------------------------|-----------|
| 2000 | 运行状态 (running)           | 1 while program is executing |
| 2001 | 停止状态 (stopped)           | 1 while program is stopped |
| 2002 | 暂停状态 (paused)            | 1 while program is paused |
| 2003 | 上使能状态 (enabled)         | 1 while servos on |
| 2004 | 下使能状态 (disabled)        | 1 while servos off |
| 2005 | 手动模式 (Manual mode)       | 1 in Manual |
| 2006 | 拖动模式 (Drag mode)         | 1 in drag/teach |
| 2007 | 运动中状态 (in motion)       | 1 whenever arm is physically moving (mode-agnostic) |
| 2008 | 碰撞状态 (collision)         | 1 after collision detected |
| 2009 | 在安全点状态 (at safe point) | 1 at safe point, 0 otherwise |
| 2010 | 报警状态 (alarm)             | 1 when an alarm is latched (semantics of 0/1 explicit in manual only for the "1" case) |
| 2011 | 仿真模式状态 (simulation)    | 1 in Simulation mode |
| 2012 | 急停按下状态 (E-stop pressed) | 1 while pendant E-stop is depressed |
| 2013 | 救援模式状态 (rescue mode)   | 1 while in rescue mode |
| 2014 | 自动模式状态 (Auto mode)     | 1 in Auto |
| 2015 | 远程模式状态 (Remote mode)   | 1 in Remote (required for this map to take effect) |
| 45000 | 自动运行速率反馈 (live speed) | UInt16 read, 1–100 (%) |

### §2 工程映射 (project-mapping) — controller-resident selector

Location in factory UI: **配置 → IO → 工程映射** (Configuration → IO → Project Map). Rows carry
`(索引, 工程)` — index 0..N mapped to an already-existing
controller project by name. Screenshot in the manual shows
indices 0–3 bound to `测试0..测试3` with additional empty slots.

The table is a **selector**, not an uploader. It binds
already-controller-resident projects to numbered slots so
that external Modbus (`42000`) or IO ("运行程序" alias)
signals can *choose which pre-existing project runs* by ID.
The manual's §2.2.1 note is explicit: *"运行程序" 配置，需
绑定默认程序，如果没有在"工程映射"内绑定程序，下发"运行程
序"信号，程序是不会启动的* → "Run program" needs a default
program bound; if no program has been bound in project-map,
sending "Run program" will NOT start anything. Nothing in the
Remote Control Manual describes a program-upload mechanism —
programs must first exist on the controller via the
teach-pendant / factory-UI 编程 tab (or via the existing
Lua-codegen push path we already have).

### §3.2 PN/EIP slave (out of scope for the Jetson today)

Manual §3.2 also documents PROFINET / EtherNet-IP with the
same semantic signal set packed into `controlFlags1/2`
(bytes 18–19) and `statusFlags1/2` (bytes 56–57) plus
`autoMoveRateValue` (UInt16 at 58–59). Not needed for our
Modbus TCP integration — captured for completeness in the
PDF; do NOT transcribe until a PN/EIP integration is
actually chosen.

## Cabinet power controls — ON/OFF rocker vs POWER key (2026-08-31 manual absorb)

There are TWO controls on the CC10-A cabinet that look like
power switches; they are NOT the same thing.

| Control    | Effect | CPU cycle? |
|------------|--------|------------|
| **ON/OFF rocker** | Servo / drive power on-off. Fires alarm 9012 "Power disconnection detected" on the WS but the CC10-A CPU stays online (WS session survives). Does NOT clear `recoveryState` (see [[recoveryState reframe]] — rs is session-persistent). | NO |
| **POWER key** (mains-side, on the cabinet) | True cabinet power cycle. Drops CPU. WS session terminates; the driver logs a new `Connected ws://192.168.2.136:9000/` line on reconnect. This is what the addendum-40 §566 "physical cabinet cycle" doctrine actually required. | YES |

**Diagnostic corollary:** if the operator reports "I power-cycled
the cabinet" and the driver's journal shows no new WS connect
line within ~30 s of the report, the ROCKER was cycled, not
the POWER key. This is the exact confusion behind the 2026-08-31
"latch persisted through power cycle" incident (add-53 §655).

Verification recipe (before asserting a CPU cycle happened):
1. `journalctl -u roboai-estun --since "2 minutes ago" | grep "Connected ws"` — expect a new line.
2. `ls -la /opt/cobot/logs/estun_ws_*.jsonl` — expect a new rotation.
3. `curl -sI http://192.168.2.136:9198` during the OFF window — expect connection refused (the HTTP page is served by the CPU; if it answers, the CPU is up).

## Cabinet light-strip mode indication (2026-08-31 manual absorb)

The CC10-A light strip encodes the running mode + enable state
at a glance:

| Color | Meaning |
|-------|---------|
| **Blue**  | Manual mode AND arm enabled |
| **Green** | Auto OR Remote mode |
| (off / dim) | Arm disabled / no power |

Operator-facing consequence: if the strip is BLUE while the
dashboard indicates AUTO expected, the wire is telling truth
(`mode=1`, MANUAL) — trust the strip over any dashboard-mirror
disagreement, and check DI16 modeSwitch state.

## Safety-relay I/O (manual §5.2.2, 2026-08-31 absorb)

The CC10-A safety-relay block provides:

- **4 dual-channel inputs.** Channels 1–2 are the **protective
  stop** (guard/interlock category — motion stops, servos may
  stay energized depending on drive config); channels 3–4 are
  the **emergency stop** (Cat-1 per EN ISO 13849 — controlled
  stop then power removal).
- **Internal safety relays.** The block's outputs drive
  redundant relay contacts internally; external safety-rated
  relays are NOT required for the standard integration.
- **Factory shorts.** Ships with jumper shorts across the safety
  input pairs so the cabinet runs out of the box with no
  external safety devices wired. **These shorts MUST be removed
  before shipping any integration** — an intact factory short
  means the safety inputs are permanently satisfied, defeating
  the entire safety chain. Factory-short removal is on the
  bench session plan (see [safety-relay deck slide 4](safety_relay_deck_slide4.md)).
- **Category-1 e-stop.** The e-stop inputs (ch3-4) are wired
  for Cat-1: motion is controlled-stopped, then power is
  removed via the drop output (below).
- **24V drop output.** A safety-triggered event drops the 24V
  rail to the servo enable circuit — this is the hardware
  path that removes drive power on e-stop, independent of the
  WS `Robot/switchOff` verb. Design any external logic on the
  assumption that 24V-present ≡ "safety chain closed."

**What this pins for the bench session:**
- Behavioral verification of the safety inputs is now a
  hands-on task (short one pair, verify motion refuses; open a
  pair, verify motion refuses again once behavior differs from
  factory-shorted state).
- Factory-short removal is a required deliverable per the
  above. Do NOT ship a Synapse enclosure with any factory
  short still in place.

## Robot-mode code table (`publish/RobotStatus.mode`)

Numeric ↔ label map for the `mode` field on `publish/RobotStatus`.
**Numeric is the ONLY ground truth (L298 stateName-lies class);**
string fields like `stateName` and the factory-UI `:9198` header do
NOT reliably indicate mode. Correlated on-wire 2026-08-28 by
disable → Manual → Auto → enable clicks against
`/api/state.robot.robot_mode_code`.

| Code | Label  | Established by |
|------|--------|----------------|
| **0**  | AUTO   | Factory-UI Auto click at 11:24:19.345 correlated wire `1 → 0` (arm disabled at click time). Required by the WS-programs execution path (`toAuto → project/save → project/run`). [session-2026-08-28, addendum-49 §630] |
| **1**  | MANUAL | Baseline at 11:20:58; factory-UI runtime log agreed ("not in automatic mode"). Required by drag-teach / PBD. [session-2026-08-28] |
| **2**  | REMOTE | Post-`toAuto → toRemote → StartControl` four-tuple `{mode:2, state:2, stateName:'Enabled', recoveryState:0, errors:[]}`. Required by the CRI execution path (MoveIt / Pilz via `cri_hardware`). [addendum-40 §566; addendum-32 §506] |
| -1   | UNKNOWN | Driver mirror pre-first-status. |

### Execution path ↔ required mode

| Path | Required mode | Precondition wired at |
|------|---------------|-----------------------|
| WS-programs (`/api/estun/program/run`, `_op_run`) | **AUTO** (0) | `RunProgramModal.jsx` auto-offers "Switch to Auto and run…" |
| CRI executor (`s10_140_executor` package, Pilz PTP/LIN) | **REMOTE** (2) | F2 executor precondition — see `test_f2_executor_precondition_is_remote` |

### Cutover flag (2026-08-28 addendum-52)

`RUN_BACKEND=legacy_lua` (default, unchanged) → WS-programs path,
target mode AUTO. `RUN_BACKEND=ros2_executor` → CRI executor
path, target mode **REMOTE**. `RunProgramModal.jsx` reads
`/api/provenance.run_backend_target_mode` and auto-offers
"Switch to <Auto|Remote> and run" accordingly. Flag flips to
`ros2_executor` on the F2.7 first-run acceptance commit. Until
then, the ros2_executor branch of `/api/estun/program/run`
returns `501 ros2_executor_not_wired_yet` (labeled stub) so the
acceptance signal is loud.

The Lua-push class of bugs (recoveryState=1 palletize latch,
add-51 §640) CANNOT exist on the CRI executor path: no Lua, no
HTTP push, Pilz PTP/LIN trajectories streamed directly. Fixing
individual palletize codegen elements on the legacy path is
therefore de-prioritized — the fix IS the cutover.

**Enable-interlock (locked 2026-08-28):** the controller REFUSES
`Robot/toAuto` / `Robot/toManual` / `Robot/toRemote` while
`enabled=True`. Ack returns `ok=True` on the WS but
`publish/RobotStatus.mode` never transitions — surfaces to
`/api/estun/mode` as `reason_code=mode_readback_timeout`. The
required sequence is:

    disable → switch mode → re-enable

`/api/estun/mode` orchestrates the three steps behind a single
confirm; the driver's `_on_mode_command` pre-checks `enabled` and
refuses standalone with `reason_code=arm_enabled_interlock` so a
raw call surfaces the rule instead of silently timing out.

## WS-jog guard demotion (verb-era trust, 2026-08-28)

Streamed-era vs verb-era trust boundary. When we sent 250 Hz
joint-position setpoints via UDP :9030 (CRI-day, addendum-32
§506), WE had to enforce every kinematic limit, singularity guard,
and joint-velocity cap in the driver — the controller received
raw position commands with no room for it to intervene. On the
WS `Robot/jog` verb (`{ty:"Robot/jog", db:{mode, speed, index,
coorType, coorId}}`), the CC10-A firmware is BETWEEN us and the
motion: it does the IK, clamps commanded joint velocity, refuses
travel past axis limits, and stops without erroring at wrist
singularities. The factory pendant proves it — it slows / stops
the RIGHT axis under identical conditions where our driver used
to kill the entire hold from outside.

Param `wsjog_trust_firmware_clamps` (default **True**) demotes
the redundant guards on the cart WS-jog path to observe-only.
Under observe, `cart_softening.mode='observe'` populates with a
cause tag; the dashboard toasts an INFO ("firmware is clamping")
instead of a warning ("Slowed by our scaling").

**Demoted (observe-only, cart mode):**
- `cart_limit_at_wall` — joint |q| ≥ physical limit
- `cart_limit_deepening` — joint past soft edge, velocity same sign
- `joint_limit_soft` — angular limit soft-zone approach
- `joint_overspeed` — posture-derivative |dq/dt| > cap
- `singularity_guard` — σ_min ≤ σ_hard
- `sigma_soft` — σ_min in scaling zone

**Kept enforced (any mode):**
- Freshness deadman (hold staleness / hb send failed) — firmware
  cannot detect browser death; our layer must.
- Arbiter (jog vs running program) — JOG-11 architectural policy.
- `collision_guard` (self / ground / env) — our unique layer;
  firmware knows nothing about our capsule model, the ground
  plane, or the workspace zones.
- JOINT-mode `escape_only` + JointRecoveryModal — UX-level guard
  the operator explicitly asked for (add-42).
- Faults / disable / release / hold-transition / zero-speed /
  increment-end — protocol semantics + operator gestures.

Regression override: `WSJOG_TRUST_FIRMWARE_CLAMPS=0` on
`roboai-estun` restores the streamed-era ENFORCE behavior end-
to-end (all six demoted causes fire their pre-08-28 scale/stop
paths). Doctrine tests refuse a commit that flips the default OR
removes any observe branch.

## Joint-velocity governor (cartesian holds, 2026-08-28)

`cart_joint_velocity_cap_radps` (default 1.5 rad/s per joint)
bounds every posture-derivative velocity during a cartesian
hold. When any joint's observed |dq/dt| approaches the cap, the
driver **SCALES** the commanded cart magnitude via
`_apply_cart_speed_scale_locked` — it does NOT hard-stop.

Scaling formula (see `_on_jog_supervise` cart branch):

    worst_ratio = max_i(|dq_i| / cap)
    if worst_ratio > 1.0:
        scale = 0.85 / worst_ratio   # 15 % margin under the cap
        apply(scale)                  # stopJog + fresh Robot/jog

Hard-stop is reserved for:
- **Axis-limit contact** — joint reached its escape-only or hard
  limit (existing `joint_limit` / `joint_limit_deeper` path).
- **Scaling exhausted** — after target_scale ≤ 0.08 AND
  worst_ratio > 3.0 AND the last-sent speed is already < 0.05,
  the pose is unrecoverable; the driver hard-stops with the
  named `joint_overspeed` tag suffixed `— scaling exhausted`.

Frontend surface: `robot.cart_softening.cause` reads either
`joint_overspeed` (this governor) or `governor` (singularity σ_min
governor). `CartSofteningToast` fires an operator-visible warning
on the null→active transition; `WristWindIndicator` renders a
persistent pill when J4 or J6 exceeds ±150° with a one-tap
unwind suggestion.

Doctrine tests: `test_cart_hold_scales_not_stops` +
`test_cart_softening_toast_and_wrist_indicator_present`.

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
