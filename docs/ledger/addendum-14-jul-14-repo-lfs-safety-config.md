---
ledger_split: addendum-14
source: cobot_project_conversation_v46.md
source_lines: 11214-11291 (inclusive)
title: Repo pushed with LFS, live safety-config verification
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 14 — July 14, 2026: Repo pushed to GitHub (git-LFS), live safety-config verification through the Codroid UI, J3/J5 sign + zero-offset re-confirmed, sign-location decision, relocation prep

*Append-only. All prior content (v14–v26, Addenda 1–13) preserved unchanged. Continues section numbering from §131 and lesson numbering from 82.*

## 132. REPO PUSHED TO GITHUB — git-LFS FOR BINARY ASSETS
The working tree (`Ai-Robotics-Prototype/V1`, branch `feature/motion-lidar-step-foundation`) was reviewed, staged with care, and pushed to GitHub. Key facts about the committed state (verified by pulling the repo ZIP back and inspecting it):
- **git-LFS is configured** via `.gitattributes`: `models/robots/**/*.glb`, `models/robots/**/*.stl`, and `*.STEP/*.step/*.stp` (plus `*.engine` TensorRT blobs) are LFS-tracked. The small UR5e-style meshes under `frontend/public/robot_model/` are intentionally NOT LFS (~1 MB, churn-free).
- **CONSEQUENCE (important for anyone cloning):** GitHub's "Download ZIP" does **NOT** fetch LFS content — it delivers ~130-byte **pointer files** in place of the real GLBs and the `S10-140_G2.STEP`. A real checkout requires `git lfs pull`. The code (all `.py/.jsx/.js/.urdf/.yaml`) comes through a ZIP fine; only the binary geometry is LFS-gated.
- **Committed:** the driver + dashboard source, `s10-140-full.urdf`, the 7 `links/*.glb` (via LFS), the DH fit checkpoint (`config/dh_fit_report.txt`), and an updated `.gitignore`.
- **Ignored/left local:** `data/` (WS `.jsonl` telemetry captures + DH derived outputs), `*.urdf.bak-*`, root `*.jsonl`, `links.uncompressed/`, `config/estun_s10_140_fitted.urdf` (derived), and the superseded `s10-140-hybrid.urdf` / `s10-140-partial.urdf` (untracked).
- **Secrets check:** `estun.yaml` and `roboai-estun.env.example` were inspected before staging — **no credentials/keys**; they contain only the cell IPs/ports (`192.168.2.136`, `9000`/`9198`), the `monitor_only` flag, and comments. Safe for the repo. (If the repo is ever made public, treat the internal network topology as mildly sensitive and move the addresses to the gitignored env — the driver already supports `ESTUN_ROBOT_IP`/`ESTUN_ROBOT_PORT` env overrides.)

## 133. REPO-REVIEW SYNC — actual deployed state confirmed
Reviewed the real code (not summaries). Confirmed against the repo:
- **`estun_driver_node.py` (540 lines)** is the v2.3 telemetry mirror: subscribe burst, `ty/db` envelope, ping/pong, `monitor_only=True` with ALL six write subscriptions routed to `_on_write` → reject + `/estun/rejected`. Writes are **not implemented** in this build; flipping `monitor_only` does not enable motion. The deg→rad conversion is a **raw `math.radians()`** at lines **405–406** of `_on_posture` — **no `apos_sign`/`apos_zero_offset` mapping layer exists yet**, and `estun.yaml` has **no `apos_to_urdf` block**. (Relevant to §135.)
- **`s10-140-full.urdf`** as deployed: joint origins are the CAD/geom values (Addendum 11 table); **axes carry the J3/J5 flip** (joint_3 `-1 0 0`, joint_5 `0 -1 0`) with a header comment documenting the 2026-07-09 live-arm verification and warning not to revert; **limits ±200°/±166°** (`±3.490659`/`±2.897247` rad) and vel `2.617994`/`3.141593` rad/s. So the sign correction currently lives in the **URDF axis**, not the driver.
- Draco decoder is present at `frontend/public/draco/` (matches the DRACOLoader path), confirming the compression path from Addendum 11 is in place.

## 134. LIVE SAFETY-CONFIG VERIFICATION (Codroid UI, this session) — limits CLOSED as correct
Re-opened the factory UI via the SSH double-tunnel (`ssh -L 9198:192.168.2.136:9198 -L 9000:192.168.2.136:9000 teddy@192.168.1.246` → `http://localhost:9198`, admin), robot **Enabled** (S10-140-ECO-V2). Read all three **Config → Safety** limit screens directly and cross-checked against the deployed URDF:
- **jointLimit → rangeLimit** (`jointPositionLimitEnable` = **ON/enforced**): J1 ±200, J2 ±200, **J3 ±166**, J4 ±200, J5 ±200, J6 ±200 (deg). → **±3.4907 / ±2.8972 rad — EXACT match to the URDF `<limit>` values.** This is the authoritative source of the ±200/±166 numbers (they were read off this screen on 2026-07-09, not invented). **Limits item CLOSED — correct and traceable.**
- **jointLimit → speedLimit** (`jointOverSpeedEnable` = **ON/enforced**): J1/J2/J3 = 150 °/s; J4/J5/J6 = 180 °/s → 2.618 / 3.142 rad/s — **EXACT match to the URDF `velocity=` values.** The manual's velocity numbers happen to equal the controller's. Closed.
- **terminalLimit** (`cartPositionLimitEnable` = **OFF / not enforced**): configured-but-inactive Cartesian box X ±1000, Y ±1000, **Z −1000 .. +2500** mm. Since it's disabled, it does NOT currently constrain the arm (joint limits are the active bound) and is NOT reflected in the twin. **Noted for later:** if this box is enabled at the new site, mirror it as a workspace clamp on the IK gizmo target (Z+2500 is a sensible ceiling vs the ~1586 mm flange height).
- **TCP cross-check:** factory UI Dashboard read TCP **Z = 1586.577 mm** at near-home — matches the twin's computed flange height (~1584 mm). Independent confirmation the deployed geometry is right.
- These safety values are **controller-stored config** (editable on these screens), NOT arm physics — re-verify them after any controller reconfiguration, especially post-move.

## 135. ZERO-OFFSET + J3/J5 SIGN RE-CONFIRMED — §130 pending items CLOSED
- **Zero offset (was #3 open):** at the factory-UI home/park pose the pendant read J1=0.14, J2=1.389, J3=0.138, J4=0.343, J5=0.529, J6=−0.817 (deg) — all within ~1.4° of zero, i.e. no systematic offset. The dashboard **twin sits at its rest/zero pose to match**. **Conclusion: no zero-offset needed; the URDF's identity rpy origins are correct.** (`apos_zero_offset_deg` would be all zeros.)
- **J3/J5 sign (the §130 "final re-confirm jog"):** confirmed — **"J3 and J5 track as intended."** The deployed URDF axis flips (J3 `-1 0 0`, J5 `0 -1 0`) make the twin follow the physical arm correctly. All six joints now verified correct in direction against the real hardware. **Sign verification CLOSED.**

## 136. DECISION — WHERE THE J3/J5 SIGN SHOULD LIVE (architecture; execute post-move)
The J3/J5 sign correction currently lives in the **URDF `<axis>`** (§133). This *works* (twin tracks arm), but it deviates from the project principle that controller-convention sign flips belong in the **APOS↔URDF mapping layer**, not in re-derived twin geometry.
- **Why it matters:** the URDF is read as **pure geometry** by every downstream consumer — the IK gizmo (already live), and a future MoveIt/collision layer. A URDF whose J3/J5 axes are flipped to match the *controller* feeds those consumers a mirrored geometry and can yield geometrically wrong IK solutions. Keeping the flip at the driver boundary (deg→rad) means everything downstream sees clean CAD geometry and only the one controller-facing seam knows the encoder quirk.
- **DECISION: migrate the sign to the driver** — revert URDF axes to CAD (J3 `1 0 0`, J5 `0 1 0`); add `apos_sign: [1,1,-1,1,-1,1]` and `apos_zero_offset_deg: [0,0,0,0,0,0]` to `estun.yaml` (`apos_to_urdf:` block) and apply them between lines 405–406 of `estun_driver_node.py` (`urdf_rad_i = radians(apos_sign[i]*(apos_deg_i − apos_zero_offset_deg[i]))`).
- **CRITICAL — it must be ONE atomic change** (revert URDF + add driver map + re-jog-verify). Do NOT add `apos_sign` while the URDF axes are still flipped, or J3/J5 will **double-flip** and invert again. The sign must live in exactly one place.
- **TIMING: execute AFTER the relocation** (§137), not before — do not refactor a verified, working twin the same week the hardware moves, unless IK-against-the-real-arm is needed pre-move. Until then, the URDF flip + its tripwire comment stay.

## 137. RELOCATION — the whole setup is moving to a new location
The cell is being relocated. Because the robot's safety limits and network config are **controller-stored / site-specific**, the move checklist:
- **Re-check the three Config→Safety screens** (§134) at the new site — limits live on the controller and could change if anything is reconfigured/re-flashed. The twin's URDF must keep mirroring whatever those screens say.
- **Jetson Wi-Fi IP (192.168.1.246) will change** on the new network — update SSH commands, the dashboard URL (`https://<new-wifi-ip>:8080`), and the factory-UI SSH tunnel.
- **If the isolated cell subnet differs**, set `ESTUN_ROBOT_IP` (and port) in the systemd env drop-in (`/etc/default/roboai-estun`) rather than editing tracked `estun.yaml` — the driver's env override is built for exactly this.
- **Keep `eno1` (cell) and Wi-Fi on non-overlapping /24s** (the §125 collision saga) or SSH will wedge again. Rebuild the 192.168.2.x cell (Jetson eno1 .246, robot .136, LiDAR on the same switch) if practical, so nothing else changes.
- Re-verify the read-only mirror after the move before resuming any motion work.

## 138. FLANGE / MOUNTING FASTENER SPEC (from the manual, for tooling)
For attaching tools to the arm and mounting the base (documented, from the Codroid S-series manual §4.4 / the S10-140 drawings):
- **Tool flange: 4× M6 threaded holes**, standard **ISO 9409-1-50-4-M6 / GB/T 14468.1-50-4-M6**. Bolts **strength class 12.9**, tighten to **12 N·m**, **screw-in depth ≤ 8 mm** (do not exceed — risk of bottoming/flange damage). Ø6 H7 locating-pin hole for repeatable tool positioning; Ø63 h8 pilot boss; Ø31.5 H7 central bore.
- **Base mounting (different spec):** 4× Ø9 through-holes on a Ø180 mounting circle (89+89 mm spacing) → M8-class fasteners into the mounting surface. **Do not conflate M6 (tool flange) with M8-class (base).**

## 139. OPEN ITEMS (as of July 14, 2026; extends §130)
| Item | Priority | Status |
|------|----------|--------|
| Migrate J3/J5 sign from URDF axes → driver `apos_sign` map (revert URDF to CAD) — ONE atomic change, re-jog-verify | MEDIUM | Decided (§136); execute **post-move** |
| Relocation checklist — re-verify safety screens, update Jetson Wi-Fi IP, set `ESTUN_ROBOT_IP` if subnet differs, keep subnets non-overlapping, re-verify mirror | HIGH | On move |
| Finish twin smoothness tuning (render-lag ~200–250 ms tunable; surge vs stutter; quantify tablet skew) | HIGH | Open (§129) — carried |
| Capture a POPULATED `command/send` frame (write-command format) via DevTools while jogging factory UI | HIGH | Not started — carried; last protocol unknown before commanded motion |
| Persist eno1 192.168.2.246 NetworkManager profile across reboot | MEDIUM | Carried |
| Change default robot passwords; fix controller clock | MEDIUM | Carried |
| Re-enable `roboai-estun` at boot once fully signed off | MEDIUM | Gated on sign-off |
| Enable + mirror the Cartesian workspace box (terminalLimit) as an IK clamp IF turned on at the new site | LOW | Contingent (§134) |
| (Carried) `pmraw_decode.py`; Chinese deck + one-pager founder roles; RoboAi→NeuRobots/Deep Steel rebrand | — | Carried |

## 140. PROCESS LESSONS — JULY 14 ADDITIONS (extend §131; all prior lessons govern)
83. **A GitHub "Download ZIP" does not include git-LFS content.** LFS-tracked binaries (here: `models/robots/**/*.glb`, `*.STEP`) come down as ~130-byte pointer files, not data. Reviewing code from a ZIP is fine; inspecting the actual meshes/CAD is not — that needs `git lfs pull`. Flag this so a fresh clone doesn't render an empty robot.
84. **Verify controller-stored config by reading the controller's own screens, not by trusting a committed number.** The ±200/±166 limits, the 150/180 speeds, and the disabled Cartesian box were all confirmed straight off the Config→Safety pages and matched the deployed URDF to the digit. These values live on the controller and are editable — re-verify after any reconfiguration or relocation; the twin must mirror the screens, not a stale constant.
85. **A working sign correction in the wrong architectural layer is a latent bug, not a closed item.** The J3/J5 flip in the URDF axis tracks correctly today but feeds every geometry consumer (IK, MoveIt) a mirrored chain. Decide where controller-quirk sign lives (the driver boundary), migrate it as ONE atomic change to avoid a double-flip, and time the refactor away from a hardware move.
86. **Re-confirm the last safety-gated check explicitly before calling it closed.** J3/J5 sign and the zero-offset were left "pending final re-confirm" in Addendum 13; a direct pendant-home read (all joints within ~1.4° of zero) plus a per-joint jog ("J3/J5 track as intended") is what actually closed them. "Applied a fix" and "verified the fix on hardware" are different states.
87. **Controller config is site-specific; a relocation is a re-verification event, not a plug-and-play move.** Safety limits, the robot IP, and the Jetson's Wi-Fi IP are all properties of the current site/controller. Plan the move as: re-read the safety screens, re-point IPs (env override for the robot, new Wi-Fi IP for the dashboard/SSH), keep subnets non-overlapping, and re-verify the read-only mirror before any motion.

---

*Summary of Addendum 14: The repo was pushed to GitHub on branch feature/motion-lidar-step-foundation with git-LFS tracking the GLB/STL/STEP binaries — note that a GitHub ZIP download returns 130-byte LFS pointers, not the real meshes (needs `git lfs pull`); the committed source was reviewed and confirmed to contain no secrets (estun.yaml/env hold only cell IPs/ports and the monitor_only flag). A repo review synced the actual deployed state: the estun_driver is the v2.3 monitor_only mirror doing raw math.radians at lines 405–406 with NO apos_sign/offset layer yet, and s10-140-full.urdf carries the J3/J5 sign flip in its <axis> (not the driver) with limits ±200/±166 and speeds 150/180. Through the Codroid factory UI (SSH double-tunnel), all three Config→Safety screens were read live and cross-checked against the URDF: joint position limits ±200°/±166° (enforced) = the URDF's ±3.4907/±2.8972 rad EXACTLY — closing the limits question as correct and traceable (they were read off this screen, not invented); joint speed limits 150/180°/s (enforced) = the URDF's 2.618/3.142 rad/s exactly; and the Cartesian terminalLimit box (X/Y ±1000, Z −1000..+2500) is DISABLED so it doesn't constrain the arm (noted to mirror as an IK clamp only if enabled later). TCP Z=1586.577 mm at home matched the twin flange (~1584 mm). The §130 pending items were CLOSED: no zero-offset is needed (pendant-home read all six within ~1.4° of zero and the twin matches), and J3/J5 "track as intended" on a re-confirm jog — all six joints now verified in direction against real hardware. A decision was made on where the J3/J5 sign should live: migrate it from the URDF axis to the driver's APOS↔URDF mapping layer (apos_sign=[1,1,-1,1,-1,1]) as ONE atomic change with the URDF axes reverted to CAD — to keep the URDF clean geometry for IK/MoveIt — but EXECUTE POST-MOVE, since the cell is relocating. A relocation checklist was set (re-verify the safety screens, update the Jetson Wi-Fi IP and dashboard/SSH addresses, set ESTUN_ROBOT_IP if the subnet differs, keep eno1/Wi-Fi on non-overlapping /24s, re-verify the mirror). Flange fastener spec was documented for tooling (tool flange 4× M6, class 12.9, 12 N·m, ≤8 mm depth, ISO 9409-1-50-4-M6; base 4× Ø9 / M8-class — not to be conflated). Five new process lessons (83–87). All prior content v14–v26 (Addenda 1–13) preserved unchanged.*

*Last updated: July 14, 2026 (Addendum 14)*

---

<!-- v46-content-end -->
