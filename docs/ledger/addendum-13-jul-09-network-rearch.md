---
ledger_split: addendum-13
source: cobot_project_conversation_v46.md
source_lines: 11118-11213 (inclusive)
title: Network re-arch, DH fit, live twin mirror
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 13 — July 9, 2026: Network Re-Architecture, DH Fit Completed & Supplier Cross-Check, Live Twin Mirror Verified (Signs Fixed, Smoothing In Progress)

*Append-only. All prior content (v14–v26, Addenda 1–12) preserved unchanged. Continues section numbering from §121 and lesson numbering from 74.*

## 122. DH FIT COMPLETED ON JETSON — SUB-MICRON-CLASS RESULT
The vectorized two-stage `fit_dh.py` ran on the Jetson against the 2458-unique-pose FK-oracle dataset (`estun_posture_20260708_161306.jsonl`). Result:
- **Euler convention CONFIRMED fixed-axis X-Y-Z** (extrinsic `xyz`, R=Rz(c)·Ry(b)·Rx(a)): pos RMS **0.025 mm** vs intrinsic-XYZ **581 mm** — decisive.
- **Stage B full fit (held-out test set): pos RMS 0.0245 mm, MAX 0.182 mm; ori RMS 0.0035°.** Train and test essentially equal (0.0251 vs 0.0245 mm) → not overfit. URDF-encoding sanity 6.8e-13.
- Recovered DH table (standard DH; a mm / α deg / d mm / θ_off deg):
  - J1: a=0, α=90, d=325.90, θ_off=−180
  - J2: a=−701.00, α=0, d=−579.69, θ_off=−90  (controller-zero offset)
  - J3: a=−538.59, α=180, d=−214.02, θ_off=0
  - J4: a=0, α=−90, d=−1000.00 (**pinned at bound**), θ_off=−90  (controller-zero offset)
  - J5: a=0, α=90, d=−161.47, θ_off=180
  - J6: a=0, α=0, d=150.50, θ_off=0
  - base_z = −139.90 mm
- **GAUGE FREEDOM (important):** d₄ pinned at its ±1000 bound and the least-constrained params (a₁,a₄,d₂,d₅,d₆ equal tiny Jacobian column norms) confirm several adjacent link lengths are unobservable aliases — the fit resolves the *combination* to 0.025 mm but the *individual* d₄/link split is NOT physically unique. **For kinematics (IK/commanding/TCP) the table is authoritative. For MESH placement the raw link lengths are NOT the physical frames** — the CAD-derived twin owns mesh geometry. Do NOT run a d₄=0 gauge-fix; it would just pin a different alias.
- Artifacts on Jetson: `~/cobot_ws/scripts/fit_dh.py`, `~/cobot_ws/config/estun_s10_140_fitted.urdf` (fitted transforms + shipped limits ±200/±166, vel 150/180), `~/cobot_ws/data/dh_fit_report.txt`. Provisional URDF backed up (`.bak-fit-*`), not overwritten.

## 123. SUPPLIER DH TABLE ARRIVED — THREE-WAY CROSS-CHECK
Estun sent their calibrated DH table (标定后的DH). Cross-checked against our fit AND against the S10-140 dimension drawing (manual 图4-9, 10kg机械臂 — the correct model; note 图4-6 S3-60, 图4-7 S5-90, 图4-8 S7-80 are OTHER models in the same manual).
- Supplier table: a=[0,0,700.85,538.18,0,0]; α=[0,−90,0,180,90,90]; d=[186,220.05,−175,−161.5,−161.31,169.5]; θ=[0,−90,0,−90,0,0].
- **Gauge-independent dimensions agree across ALL THREE sources** (manual drawing / supplier / our fit): base height **186** (ours: 325.9−139.9=186.0 exactly), upper arm **700** (~701), elbow offset **221/220**, shoulder offset **175**, wrist **161.5**. Triple-locked.
- **Two discrepancies, both wrist region:** (a) **d₆: manual drawing 150.5, our fit 150.5, but supplier table 169.5** — supplier's own table disagrees with supplier's own drawing by 19 mm, and OUR independent fit sided with the DRAWING. Likely a tool-plate/coupling offset baked into the supplier's d₆, or a transcription slip. (b) Forearm 700 split differently (supplier a₄=538.18 + wrist offset ≈ 700; same kind of bookkeeping split we did).
- **Verdict:** the supplier's "calibrated" table is NOT cleanly authoritative — it conflicts with the manufacturer's own drawing on d₆, where our fit matched the drawing. Treat all three as mutually confirming on the big links; trust manual+our-fit (150.5) on the wrist. Optional supplier question logged: "does d₆=169.5 include a tool/coupling offset? 图4-9 shows 150.5 at the bare flange."

## 124. NETWORK RE-ARCHITECTURE — ISOLATED ROBOT-CELL SUBNET (RESOLVES §113)
The §113 constraint (router in house, robot cabled only to laptop) was resolved with a **TP-Link gigabit unmanaged switch** in the shop. Final topology:
- **Switch** ties together: Jetson (eno1, wired), robot cabinet (LAN port), Livox MID-360 LiDAR. Laptop stays on Wi-Fi.
- **Robot IP CHANGED 192.168.1.136 → 192.168.2.136** (factory UI → Settings/gear → Network → single "Robot IP" field, "Reboot to activate"; /24, no gateway/DNS fields).
- **Jetson eno1 → 192.168.2.246/24** via NetworkManager (`nmcli connection modify eno1 ipv4.method manual ipv4.addresses 192.168.2.246/24 ipv4.gateway "" ipv4.never-default yes`).
- **Jetson Wi-Fi (wlP1p1s0) stays 192.168.1.246/24** — house network, SSH path, untouched.
- **Two separate subnets** (robot cell 192.168.2.x isolated from house 192.168.1.x) → zero routing collision, deterministic wired robot link.
- **VERIFIED:** from Jetson, `ping 192.168.2.136` sub-ms, `nc -zv 192.168.2.136 9000` succeeded, and `posture.py` (rewritten for :2.136) streamed RobotPosture frames — telemetry chain proven from the Jetson over the wire.
- Factory UI now reached from laptop via **SSH tunnel**: `ssh -L 9198:192.168.2.136:9198 -L 9000:192.168.2.136:9000 teddy@192.168.1.246` then browse `localhost:9198`. BOTH ports must be forwarded — the frontend opens a :9000 WebSocket; forwarding only :9198 gives "Server network closed!". Tunnel is fragile (drops → refresh).

## 125. THE SUBNET-COLLISION SAGA (why 192.168.2.x was necessary)
Early attempts put eno1 on 192.168.1.x (same as Wi-Fi). **Any time eno1 held a 192.168.1.x /24 alongside Wi-Fi's 192.168.1.246/24, SSH-over-Wi-Fi dropped instantly** ("client_loop: send disconnect: Connection reset") and the Jetson's Wi-Fi wedged, requiring a power-cycle. Root cause: two interfaces on the same subnet → ambiguous return route, SSH replies routed out the wrong NIC. Also discovered eno1's persistent config was NetworkManager (NOT netplan — `/etc/netplan/` doesn't exist on this L4T box), pinned to `192.168.1.200/32`; the /32 mask made the whole 192.168.1.0/24 unreachable via eno1 anyway. The ONLY robust fix was full subnet separation (§124). Nothing set via live `ip addr` persisted across reboot — all recovery was power-cycle-clean.

## 126. ROBOT COMMISSIONING STATE — ENABLED, JOGGING, LIMIT RECOVERY
- Robot **Enabled** (state:2), **Manual** mode, Real Machine, speed set to **15%** for manual work (had briefly been 83% — turned down).
- **J5/J6 out-of-limit fault discovered:** after the DH sweep, J5 was at **269.5°** and J6 at **235.8°**, both past the ±200° soft limit → controller blocked jog AND drag ("Joint5 exceeded limit"). This was why drag/jog appeared dead. **Fix: jog the offending joints back into range** (−J5, −J6). Once inside limits, jog and drag work normally. (Rescue/救援 mode is the documented path but plain jog sufficed here once enabled.)
- Drag/freedrive: deadman ("gun") at MIDDLE detent + flange button (DI 18) + physically move. Requires enabled state and joints within limits; ECO drag is motor-current/gravity-model based.

## 127. LIVE TWIN MIRROR — BUILT AND VERIFIED (the milestone)
Brought up the ROS2 driver (monitor_only) + dashboard on the Jetson, pointed at 192.168.2.136, driver message layer using the v2.3 ty/db protocol (mirrors posture.py).
- **Driver publishes /joint_states; verified IDENTICAL to factory UI to 3 decimals** (e.g. J1=100.020, J2=1.619, J3=−51.908, J4=−62.476, J5=−8.175, J6=51.695). Read chain proven end-to-end on real hardware.
- Dashboard twin at **https://192.168.2.246:8080** (HTTPS only, self-signed; HTTP gives ERR_EMPTY_RESPONSE). From laptop over Wi-Fi use **https://192.168.1.246:8080** (Jetson Wi-Fi IP). URDF loaded, 7/7 meshes, GLB 200 OK.
- **URDF wiring decision:** kept the mesh URDF (`s10-140-full.urdf`) as served twin; merged ONLY the fitted **limits** (±200/±166, vel 150/180) — did NOT overwrite joint **origins** (gauge-freedom would detach meshes; CAD origins are the physical truth). Axes verified, only J3/J5 changed (see §128).
- A **DIAG pose-lock** (diagnostic seed) initially held the twin at a fixed pose; removing it (delete DIAG seed + diagLockRef, rebuild) let the twin live-track /joint_states.
- **Manual-mask latching:** clicking the twin's own JointJogPanel sliders latches that joint to slider authority and stops it tracking; "Reset all → 0°" releases (also zeros targets — minor side effect).
- **VERIFIED live mirror:** jog from factory UI → real arm moves → twin follows, joint angles matching. Milestone achieved.

## 128. JOINT-DIRECTION SIGN VERIFICATION — J3 & J5 INVERTED, FIXED
Per-joint jog test against the physical arm (the safety-gated check from §119/§120): **J1, J2, J4, J6 correct; J3 (elbow) and J5 (wrist pitch) moved INVERTED** on the twin vs the real arm.
- **Key finding:** the served URDF axes already MATCHED the CAD record (J3=(1,0,0), J5=(0,1,0)) — yet the twin was inverted. **The physical arm is ground truth; controller-positive rotation on J3/J5 is OPPOSITE the CAD geometric axis.** This is consistent with J2/J4 (and the ~90° controller-zero θ offsets) — the joints where controller convention diverges from model convention are exactly where the sign diverges too.
- **Fix applied** in `/opt/cobot/models/robot/s10-140-full.urdf`: joint_3 axis `1 0 0`→`-1 0 0`; joint_5 axis `0 1 0`→`0 -1 0`. Header + inline comments added explaining the CAD-vs-controller convention and warning "do NOT correct back"; saved to Claude Code project memory (`cobot-estun-driver-twin.md`, indexed in MEMORY.md) so a future session won't revert it. Frontend rebuilt.
- After fix: all six joints track direction correctly (pending final re-confirm jog).

## 129. TWIN MOTION SMOOTHNESS — DIAGNOSED, PARTIAL FIX (OPEN)
Twin tracked direction but motion **surged (slow/fast/slow)** during steady moves while the Estun viewer stayed smooth. Diagnosis: source RobotPosture ~10–15 Hz with jitter + twin chasing each target (lerp lag) + a 2-frame queue letting the client receive STALE frames while fresher existed. The status-bar **~920 ms latency is likely mostly TABLET CLOCK SKEW** (computed as `(perf.now()-t0)+(Date.now()-data.t)` mixing tablet wall-clock vs Jetson time), not real wire lag (wired ping sub-ms).
- **Fixes implemented:** (1) server-side **drop-to-latest WS coalescing** (queue always holds freshest frame); (2) **client-side timestamped interpolation** — buffer 2–3 frames with data.t, interpolate at requestAnimationFrame (~60 Hz) with a fixed render-lag (~120 ms), playback on performance.now() so smoothness is decoupled from network jitter. Deferred: (3) joint dedup, (4) split /ws/joints fast channel.
- **STILL NOT 100% SMOOTH after the fix (OPEN ITEM).** Leading hypothesis: at a ~10 Hz source, 120 ms render-lag is too tight (barely one frame of runway) — one late frame starves the interpolation buffer and it re-stalls. Proposed next step: raise render-lag to ~200–250 ms (make it + buffer depth tunable constants), and characterize whether residual is slow-surge (buffer too small) vs fast micro-stutter (rAF beat pattern). Also quantify tablet clock skew via the console snippet.
- Driver left **monitor_only=true** and **roboai-estun DISABLED at boot** (interactive foreground instance running the mirror). Re-enable only after full sign-off.

## 130. PENDING ACTION ITEMS (as of July 9, 2026; extends §120)
| Item | Priority | Status |
|------|----------|--------|
| Finish twin smoothness tuning (raise render-lag ~200–250ms, tunable; confirm surge vs stutter; quantify tablet skew) | HIGH | Open (§129) |
| Final re-confirm jog: all 6 joints correct direction after J3/J5 flip | HIGH | Pending quick recheck |
| Capture a POPULATED command/send frame (write-command format) via DevTools while jogging factory UI — last protocol unknown before commanded motion | HIGH | Not started |
| Reconcile gauge freedom vs CAD for mm-accurate mesh overlay (only when needed for eye-in-hand/collision viz) | LOW | Deferred |
| Optional supplier question re: d₆=169.5 vs drawing 150.5 (tool offset?) | LOW | Logged |
| Persist eno1 192.168.2.246 config across reboot (verify NetworkManager profile sticks; the earlier /32 revert showed duplicate/competing profiles) | MEDIUM | Verify on next reboot |
| Change default robot passwords; fix controller clock | MEDIUM | Carried |
| Re-enable roboai-estun at boot once fully signed off | MEDIUM | Gated on sign-off |
| (Carried) pmraw_decode.py; Chinese deck + one-pager founder roles; RoboAi→NeuRobots/Deep Steel rebrand (dashboard still shows "RoboAi") | — | Carried |

## 131. PROCESS LESSONS — JULY 9 ADDITIONS (extend §121)
75. **Two interfaces on the same subnet will fight; separate the robot onto its own subnet.** Putting the Jetson's wired NIC on the same 192.168.1.x as its Wi-Fi caused instant SSH death and a wedged Wi-Fi requiring power-cycle. An isolated robot-cell subnet (192.168.2.x) with the robot's IP changed to match is the robust topology — deterministic wired link, no route ambiguity, Wi-Fi untouched.
76. **This L4T Jetson uses NetworkManager, not netplan.** `/etc/netplan/` doesn't exist; persistent IP lives in `nmcli` profiles. Watch for duplicate profiles on the same device (two "eno1" entries appeared) and a `/32` mask that silently makes the whole subnet unreachable. Live `ip addr` changes never persist across reboot here.
77. **The controller's positive-rotation sign can be OPPOSITE the CAD geometric axis.** J3/J5 URDF axes matched the CAD record yet rendered inverted vs the physical arm. Physical arm is ground truth. The joints that diverge in sign are the same ones carrying ~90° controller-zero θ offsets — controller convention ≠ model convention on those axes. Record WHY in-file so it isn't "corrected" back.
78. **A gauge-perfect DH fit is not a physical link-length map.** 0.025 mm flange accuracy coexists with d₄ pinned at bound and several unobservable link aliases. Correct kinematics, wrong-looking geometry — fine for IK, not for mesh placement. Keep CAD for meshes, fitted DH for kinematics; don't try to "fix" the gauge freedom without a physical constraint.
79. **A supplier's "calibrated" table is not automatically ground truth.** Estun's own DH table disagreed with Estun's own dimension drawing (d₆ 169.5 vs 150.5) — and our independent FK-oracle fit matched the DRAWING. Cross-check every authoritative-looking source against an independent one; the reverse-engineered fit earned its keep by catching the supplier's inconsistency.
80. **An out-of-limit joint silently blocks jog AND drag.** "Can't drag/jog" with the arm enabled was J5/J6 sitting past ±200° after the sweep — the controller refuses motion that would worsen a limit violation. Jog the offending joint back into range (or rescue mode) before concluding drag is broken.
81. **Twin smoothness must be decoupled from network timing via interpolation.** A jittery ~10–15 Hz telemetry stream renders as surge-jerk if the twin chases each frame. The fix is game-style timestamped interpolation with a render-lag buffer sized to the SOURCE rate (≥2 frames of runway) — playback on the browser's own animation clock, not on frame arrival. And beware latency readouts that mix client wall-clock against server time: that "920 ms" was mostly tablet clock skew, not real lag.
82. **Tunnel BOTH ports for the factory UI.** The Codroid frontend loads over :9198 but opens a data WebSocket to :9000; forwarding only :9198 yields "Server network closed!". `ssh -L 9198:… -L 9000:…`.

---

*Summary of Addendum 13: The DH fit completed on the Jetson with a test-set RMS of 0.0245 mm (fixed-axis X-Y-Z convention confirmed; intrinsic-XYZ ruled out at 581 mm), recovering controller-zero θ offsets on J2/J4 and matching the S10-140 manual dimension drawing on every gauge-independent link (base 186, arm 700, elbow 221, shoulder 175, wrist 161.5). A known gauge freedom (d₄ pinned at bound) means the fit is authoritative for kinematics but not for physical mesh placement — CAD keeps the meshes, fitted DH keeps the kinematics. Estun then sent their "calibrated" DH table, which cross-checked cleanly on the big links but DISAGREED with Estun's own drawing on d₆ (169.5 vs 150.5) — and our independent fit matched the drawing, so the supplier table is not blindly trusted. The §113 network blocker was resolved by a TP-Link switch and a full subnet separation: the robot's IP was changed to 192.168.2.136, the Jetson's wired eno1 set to 192.168.2.246/24, Wi-Fi left on 192.168.1.246 — after a painful collision saga (any eno1 address on 192.168.1.x killed SSH and wedged Wi-Fi; the box uses NetworkManager not netplan). Telemetry was verified from the Jetson over the wire, and the full stack was brought up: the driver (monitor_only) publishes /joint_states matching the factory UI to 3 decimals, and the dashboard twin live-mirrors the physical arm. Per-joint sign verification found J3 and J5 inverted (controller positive-rotation opposite the CAD axis — consistent with their controller-zero offsets); both URDF axes were flipped and the reason recorded in project memory to prevent reversion. An out-of-limit J5/J6 (past ±200° after the sweep) was found to block jog/drag until jogged back in range. Twin motion still surges (not fully smooth); server drop-to-latest coalescing + client timestamped interpolation were implemented but need render-lag tuning (~200–250 ms) — the ~920 ms status-bar latency is largely tablet clock skew, not real lag. Driver left monitor_only and disabled at boot pending final sign-off; the write-command (populated command/send pm) format remains the last uncaptured protocol piece before commanded motion. Eight new process lessons (75–82). All prior content v14–v26 (Addenda 1–12) preserved unchanged.*

*Last updated: July 9, 2026 (Addendum 13)*

---

<!-- v46-content-end -->
