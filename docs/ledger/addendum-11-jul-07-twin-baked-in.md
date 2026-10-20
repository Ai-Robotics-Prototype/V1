---
ledger_split: addendum-11
source: cobot_project_conversation_v46.md
source_lines: 10917-11018 (inclusive)
title: Twin baked into dashboard, joint sliders, 6-DOF IK gizmo
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 11 — July 7, 2026 session (twin FINISHED as a mechanism + baked into the live dashboard on the Jetson: URDF deployed, joint sliders, 6-DOF Cartesian IK gizmo, coordinated Home; hardware-connection plan scoped)

## 100. MILESTONE — TWIN IS NOW LIVE IN THE DASHBOARD ON THE JETSON
Everything from Addendum 10 (standalone `twin_test.html`) was carried into the real React/Vite dashboard served at https://192.168.1.246:8080. The arm loads from a deployed URDF, and the operator can jog every joint via sliders, drag the TCP in full 6-DOF Cartesian via a gizmo, and send it home with a smooth animation. This is the last purely-virtual milestone before touching hardware; no motion has been sent to the physical arm.

## 101. J5 AXIS CORRECTED — SUPERSEDES the Addendum 10 J5 note
Addendum 10 left J5 as axis (−1,0,0)=X with a "sign flip." That was WRONG and is superseded. User clarified the wrist structure directly:
- **link4 (wrist1) is itself a 90° elbow** connected to link3. Its two dominant flat faces (confirmed from geometry, by total area): an **X-normal input face (76.1 cm²)** — that is the J4 mating face onto link3's flange — and a **+Y-normal output face (82.5 cm²)** that "faces upward when the arm is vertical." link5 mounts on that up-face.
- Therefore **J5 rotates about the up-face normal = vertical Y**, coaxial with link4's output face — NOT a horizontal pitch about X.
- **FINAL J5: axis (0,1,0)=Y**, located on link4's output-face center. Face fit: center **X=−0.2075, Z=0.0000, faceY=1.506, O.D.=95.3 mm**; cross-checked against link5's bottom mating face, which lands at the identical X=−0.2075, Z=0 (mating confirmed). Verified: flange Y stays constant (1584 mm) across J5=0/90/180 → pure rotation about the vertical axis, coaxial with the face. User: "rotates great now."

**Corrected final chain axes (geom, Y-up):** J1 (0,1,0), J2 (−1,0,0), J3 (1,0,0), J4 (1,0,0), **J5 (0,1,0)**, J6 (−1,0,0). This is what was deployed.

## 102. GEOMETRY REFINEMENT — smoothness is a triangle-budget problem, not flat shading
The GLBs already carried smooth welded vertex normals; the faceting the user saw was **decimation** (too few triangles + decimation "dents" on curved surfaces), worst on the flange (had been cut 30k→7k) and later the base.
- Full-res total across all 7 links = **171,912 tris**; the tablet OOMs near ~150k (dashboard context), so full-res everything is not viable inline.
- Progression: 55k → 124k → **final ~148k** with the visible parts at/near full-res.
- **FINAL decimation budgets (tris):** base 21,780 (FULL), shoulder 15,732 (FULL), upper_arm 26,000 (of 50,242 — the smoothest, least-detailed cylinder, the only meaningfully decimated part), forearm 28,768 (FULL), wrist1 12,812 (FULL), wrist2 12,816 (FULL), flange 29,762 (FULL). Total 147,670.
- Meshes rebuilt with `trimesh` `merge_vertices()` + `fix_normals()` + area-weighted `vertex_normals` for smooth shading; the dashboard/GLTFLoader applies these as-is (no `flatShading`).

## 103. RECOLOR — Deep Steel navy, matte
Recolored from the placeholder lavender-blue to the brand **Deep Steel navy**: `baseColorFactor = [38,52,84]/255 = (0.149,0.204,0.329)`, **metallicFactor 0.12, roughnessFactor 0.62**. The matte finish (low metallic / higher roughness) also evens out shading — a metallic sheen exaggerates any residual normal variation and reads as "odd patches"; matte spreads light uniformly. (Charcoal ~[50,54,62] offered as a one-line alternative; navy kept for brand.)

## 104. URDF BAKE — deploy bundle + Jetson integration
**Assets generated** from `chain_final.json` + the navy high-res GLBs:
- `s10-140-twin.urdf` — geom Y-up; each `<joint>` carries parent-relative `origin xyz` (rpy 0) + `axis`; each `<link>` visual mesh at identity (meshes baked relative to joint origins); `<mesh filename="links/xxx.glb"/>` relative paths.
- `links/link0_base.glb … link6_flange.glb` (7 files) + `TWIN_MANIFEST.md`.
- Joint limits used = the MANUAL values (J1/J2/J4/J5/J6 ±360°=±6.2832 rad; J3 ±160°=±2.7925 rad) — see §108 open items: these are wider than robot.json and MUST be reconciled before hardware.

**Deployed joint chain (parent-relative origins, m, geom):**
| joint | parent→child | origin xyz | axis | role |
|-------|--------------|-----------|------|------|
| joint_1 | base_link→link1 | −0.000341, 0, −0.000038 | 0 1 0 | base yaw |
| joint_2 | link1→link2 | −0.201859, 0.183312, 0.000221 | −1 0 0 | shoulder pitch |
| joint_3 | link2→link3 | 0.144000, 0.700198, −0.000187 | 1 0 0 | elbow pitch |
| joint_4 | link3→link4 | −0.001437, 0.538990, 0.000005 | 1 0 0 | wrist tilt |
| joint_5 | link4→link5 | −0.147868, 0.083500, 0 | 0 1 0 | wrist pitch (on link4 up-face) |
| joint_6 | link5→link6 | −0.131895, 0.078106, 0.002073 | −1 0 0 | flange roll |

**Transfer:** SCP the bundle from the Windows laptop (NOT the Jetson) to `/home/teddy/Downloads/twin_deploy.zip`. Lesson reinforced: a `C:\...` scp path only works run from Windows PowerShell; run from the Jetson it treats `C:` as a hostname. `PS C:\Users\...>` = laptop (correct for scp); `teddy@teddy-desktop:~$` = Jetson. The browser had saved the bundle as `files (5).zip`; renamed on transfer.

**Integration (Claude Code on Jetson), PHASE A discovery findings (important corrections):**
- **Root rotation = 0, NOT −π/2.** The dashboard loader applies `robotRoot.rotation.x = 0`; both the current and twin URDFs are Y-up native, so 0 is correct — the earlier "Y-up→Z-up needs −90°" note was a hedge that did not apply here. No rotation added.
- **No "forearm roll" string exists in the dashboard** — that label lived only in the standalone `twin_test.html`. So no UI relabel was performed; joint names stay joint_1..joint_6. (Descriptive labels were later added in the jog panel instead.)
- **Nested-zip packaging artifact:** the outer `twin_deploy.zip` contained an inner `twin_deploy.zip` holding the GLBs; must double-unzip.
- Backups made: `s10-140-full.urdf.bak-<ts>` + `links-backup-<ts>.tgz`.
- Installed by replacing the CONTENTS of `s10-140-full.urdf` (the file the loader reads) with the twin URDF, mesh paths matched to the existing relative scheme (absolute paths double the prefix in urdf-loader). **Robot rendered correctly in the interface.**

## 105. DASHBOARD CONTROL SURFACE (all additive; twin-only, no hardware in loop)
**JointJogPanel** (`src/cobot_dashboard/frontend/src/components/JointJogPanel.jsx`): right-docked pane (~300px, absolute, top-right) inside the viewer. Six sliders in order with role labels (J1 base yaw … J6 flange roll); **min/max from `robot.joints[joint_N].limit`** (J3 auto-caps ±160°, rest ±360°); step 0.5°; value shown in **degrees (primary) + radians (secondary)** since the real arm uses degrees (APOS). Live **TCP readout** polling `robot.links.link6.matrixWorld` at ~15 Hz → position (mm) + ZYX Euler (deg), labeled **"TCP (TWIN FRAME) · link6"** so it isn't confused with the robot-base frame. Reset → all six to 0.

**Speed fix (tab-switch reload lag):** the arm is ~148k tris of uncompressed GLB (~3.5 MB). Fixes applied: (1) **shared robot instance kept mounted** across Program ⇄ 3D View (visibility toggle, not unmount → no re-parse per switch); (2) **DRACOLoader registered** (`setDecoderPath('/draco/')`) + Draco-compressed GLBs; (3) **`THREE.Cache.enabled = true`** memoizes GLB bytes across mounts. `[urdf-load]` console.time bracket added to measure. Panel now shows on BOTH tabs, driving the same robot.

**Snap-back-to-vertical fix:** the 25 Hz FK loop lerps `cur += (t − cur) * 0.3` toward a **target that comes from a store** (the authority). On slider release the store re-asserted its pose (≈zeros) and the arm snapped upright. Fix: slider writes the **persistent target** with a **per-joint manual mask** — the jogged joint reads the slider's target (holds on release) while un-jogged joints still follow the store; **Reset** returns authority to the store. Architecture crystallized: **store = source of truth; sliders temporarily mask it per-joint; IK writes into the store.**

## 106. CARTESIAN IK GIZMO (drag the TCP, full 6-DOF)
- **tool0 frame** added at the flange (**zero tool offset for now → TCP = flange face**); IK target + TCP readout use it. (Also relevant: the pre-existing `ArmViewer3D.jsx:639` lookup `tool0 || link_6` did not resolve on the twin whose flange is `link6` — see §107.)
- **Solver: damped least squares (DLS)** — Jacobian pseudo-inverse with damping `dq = Jᵀ(JJᵀ + λ²I)⁻¹·err`, clamped to URDF limits, converge-and-stop if unreachable (no NaN/divergence), tuned to stay stable near wrist singularities. Solves full 6-DOF pose (position + orientation, orientation error = axis-angle of R_target·R_current⁻¹). Solved joints written to the **authority store** so the existing lerp drives the arm.
- **UI: three.js TransformControls gizmo** on tool0, **Translate | Rotate** mode toggle, **World | Tool space toggle** (`setSpace('world'|'local')`, default Tool so rotation rings ride the flange). OrbitControls disabled during gizmo drag. Joint sliders remain as fine-tune/fallback. Chosen gizmo over free-mesh-drag (6-DOF needs explicit axis + orientation handles); DLS over analytic IK (works now, any pose).

## 107. RENDER-STABILITY FIX — the "finicky Program-tab gizmo"
Symptom: gizmo dragged smoothly on 3D View but on the Program tab moved a little then stopped, repeatedly ("drag → stop → new drag pill → stop"). **Cause (diagnosed, not guessed):** an **un-consumed 25 Hz store selector** (`storePositions`, `ArmViewer3D.jsx:~1191`, feeding a since-deleted readout overlay) churned the parent render at ~25 Hz; the **IKGizmo setup effect depended on inline arrow-prop identities**, so it `detach()/attach()`ed TransformControls every ~40 ms — a drag survived at most one frame. **Fix:** (A) stabilize IKGizmo — store callback props in refs, trim setup-effect deps to `[enabled, jogApi, scene, camera, gl]`, keep the mode/space swap in its own effect; (B) delete the zombie selector + orphan `liveJointsDeg`, dropping ArmViewer3D from ~25 Hz to state-change-only. Temporary `[IKGizmo] setup/cleanup` logs left in one round to confirm setup fires ONCE per drag, not 25 Hz. Lesson: a fragile effect must be fixed (A), not merely masked by lowering render rate (B).

## 108. HOME ANIMATION
`lib/homeAnim.js` `startHomeMove` — **coordinated timed return to all-zeros over `HOME_MOVE_MS` = 2.0 s** with easeInOutCubic; all six joints start/finish together (not per-joint exponential). Drives the same target/store the FK loop reads. **Restartable** cleanly from the current interpolated pose (never queues); **interrupted** by any slider tug or IK write (hands authority back, no fighting); snaps exactly to zero on arrival and returns control to the store. Wired on both tabs via `jogApi.home()`.

## 109. OPEN ITEMS — DASHBOARD / TWIN (as of July 7, 2026; extends §98)
| Item | Priority | Status |
|------|----------|--------|
| **Joint-limit reconciliation** — URDF currently uses MANUAL limits (±360/±160); robot.json says ±130/±150; pendant is ground truth. Bake the robot-enforced limits into URDF + IK clamp so the twin can't pose where the real arm can't. | HIGH | Next twin task |
| **Joint zero / θ-offset reconciliation** — twin "0" per joint must equal robot "0" (pendant readout offsets J2/J4 vs J3/J5). A limit is only meaningful relative to a known zero. | HIGH | Pairs with limits |
| **Real tool offset** — TCP is currently the flange face; add the gripper/tool offset to tool0 so TCP = tool tip. | MEDIUM | After limits/zero |
| **`tool0`/`link6` naming** — `ArmViewer3D.jsx:639` `tool0 || link_6` didn't resolve on the twin (flange = `link6`); tool0 frame from §106 should now resolve it — confirm. | MEDIUM | Verify |
| **`[DIAG:STEP1]` seed pose** — arm may load bent (J2≈+34.4°, J3≈−45.8°) from a diagnostic/store pose; confirm intentional or clear. | LOW | Confirm |
| **IK behavior at limits/singularities** — confirm graceful stop vs hunt/flip; confirm sliders reflect IK-solved angles. | MEDIUM | Verify on reload |
| **Pull temp `[IKGizmo]` logs** once drag stability confirmed. | LOW | After verify |
All prior §98 / §87 / §75 open items carry forward.

## 110. HARDWARE-CONNECTION PLAN (scoped, NOT started — safety-gated)
Agreed sequence for going from twin → real Estun S10-140 (CC10-A / KEBA), **read-before-write, motion last**:
1. **Network link** — confirm Jetson ↔ KEBA over the CC10-A debug-LAN → ETH1 path (ping + open-port check only; no motion socket).
2. **Characterize the controller motion interface** — determine what the socket actually accepts: streaming/servo targets vs MoveJ/MoveL commands vs Modbus register writes. Robot is a **TCP client to a Jetson-hosted socket server**; poses are **ZYX Euler mm**, joints **degrees (APOS)**. Live TCP dragging is only possible if a streaming mode exists; otherwise the twin becomes a MoveJ/MoveL target-setter.
3. **Frame + sign/offset mapping** — twin geom frame → robot APOS (per-joint sign, offset, θ-offsets). **Standing rule: these live in the controller mapping layer (APOS↔URDF), never re-derived in the twin geometry.**
4. **READ-ONLY MIRROR FIRST** — stream the real arm's actual joint/TCP data INTO the twin so it mirrors the physical arm as jogged by pendant. Zero motion risk; validates link + frame + sign/offset. **This is the first hardware milestone.**
5. **Then minimal motion** — one slow single-joint move, e-stop in hand, reduced speed, generous margins. Cartesian streaming is LAST, not first.
Safety realities: e-stop physically in hand for all motion; the **ROS2 safety nodes are advisory only** (don't stop the arm); safety laser scanner OSSD hardwiring to Estun safety inputs ideally precedes autonomous motion; the unresolved limit/zero conflicts (§109) are a collision risk and must be settled during the read-only phase.

## 111. PROCESS LESSONS — JULY 7 ADDITIONS (extend §99; all prior lessons govern)
57. **Wrist joints are defined by the mating faces of the elbow casting, not by intuition about "pitch vs roll."** J5 was wrong as an X-pitch; the deciding fact was that link4 is a 90° elbow whose OUTPUT face points +Y in the vertical pose, so J5 rotates about that face normal (vertical), coaxial with its O.D. Read the faces.
58. **Smoothness is a triangle-budget problem, not a shading-mode problem.** The GLBs already had smooth normals; the faceting/"dents" were decimation. Fix = raise tris on the CURVED, VISIBLE parts to (near) full-res; decimate only the smoothest, most-hidden part (the upper-arm cylinder) to hold the memory ceiling. Never drop resolution to fix a *speed* problem — that's a caching/compression problem (keep-mounted + Draco + THREE.Cache).
59. **Discovery beats a hedge — verify the frame the loader actually applies before trusting a bake assumption.** The prompt hedged "Y-up→Z-up needs −90°"; discovery showed the loader uses rotation.x=0 and both URDFs are Y-up native. Reading the real loader state prevented flipping the robot sideways. Likewise "forearm roll" didn't exist in the dashboard — that string was only in the standalone harness.
60. **Establish the single source of truth for commanded pose before layering controls.** Once "store = authority; sliders mask per-joint; IK writes to store" was explicit, the snap-back bug, the Home animation, and the IK write path all became coherent. Controls that each grab the joints independently will fight.
61. **"Moves a little then stops" = the interaction is being torn down mid-gesture.** A React effect that (re)attaches an interaction handler (TransformControls) must not depend on inline-arrow prop identity, or any parent re-render — here a zombie 25 Hz selector — reattaches it every frame. Stabilize with refs + minimal deps; also remove dead high-frequency subscriptions.
62. **Run scp from the machine that HOLDS the file.** A `C:\...` path only resolves in Windows PowerShell; run from the Jetson it parses `C:` as a hostname. Tell the machines apart by the prompt (`PS C:\>` laptop vs `teddy@teddy-desktop:~$` Jetson).
63. **Hardware comes read-before-write, motion last.** Mirror the real arm into the twin (read-only) to validate link/frame/sign/offset at zero risk before any commanded motion; then one slow joint with e-stop in hand. Software safety nodes here are advisory only.

*Summary of Addendum 11: the S10-140 twin was finished as a mechanism and BAKED INTO THE LIVE DASHBOARD on the Jetson. J5 was corrected from the Addendum-10 X-pitch to its true axis — vertical (0,1,0), coaxial with link4's +Y-facing output face (center X=−0.2075, Z=0, O.D. 95.3mm), because link4 is a 90° elbow whose output face points up; corrected final axes are J1(0,1,0) J2(−1,0,0) J3(1,0,0) J4(1,0,0) J5(0,1,0) J6(−1,0,0). Geometry was refined to ~148k tris (base/shoulder/forearm/both wrists/flange full-res; upper arm 26k) with smooth welded normals — faceting was decimation, not flat shading — and recolored to matte Deep Steel navy [38,52,84] met0.12 rough0.62. A deploy bundle (s10-140-twin.urdf + 7 GLBs) was SCP'd to the Jetson and integrated: discovery showed the loader uses rotation.x=0 (both URDFs Y-up native, so the −90° hedge did not apply), no "forearm roll" string existed in the dashboard, and the bundle had a nested zip; backups were taken and s10-140-full.urdf's contents replaced. A full control surface was built (twin-only): a right-docked JointJogPanel (six sliders from URDF limits, deg+rad, link6 TCP readout in twin frame, Reset) on both tabs; tab-switch lag fixed via shared kept-mounted robot + DRACOLoader + THREE.Cache; a snap-back bug fixed by making the slider write the persistent target with a per-joint mask over the authority store; a damped-least-squares 6-DOF Cartesian IK gizmo (tool0 at flange, zero offset) with Translate/Rotate + World/Tool toggles writing solved joints to the store; and a coordinated 2s easeInOutCubic Home. A finicky-gizmo bug on the Program tab was traced to a zombie 25Hz selector reattaching the IK gizmo every frame and fixed by ref-stabilizing the effect + deleting the dead selector. The hardware-connection plan was scoped (read-only mirror first, motion last, e-stop in hand) but NOT started. OPEN (HIGH): reconcile joint LIMITS (URDF has manual ±360/±160 vs robot.json ±130/±150 — use robot-enforced) and joint ZERO/θ-offsets; then real tool offset. Seven new process lessons (57–63). All prior content v14–v25 (Addenda 1–10) preserved unchanged.*

*Last updated: July 7, 2026 (Addendum 11)*

---

<!-- v46-content-end -->
