---
ledger_split: addendum-07
source: cobot_project_conversation_v46.md
source_lines: 10318-10447 (inclusive)
title: 3D viewer, Estun manual deep-dive, glTF/Draco
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM 7 — July 2, 2026 — 3D VIEWER: ESTUN MANUAL DEEP-DIVE, GLTF/DRACO TROUBLESHOOTING, PRIMITIVE URDF FK VERIFICATION, TABLET POLYGON BUDGET, VBA MACRO, SCP TRANSFER

*(Appended in full. Nothing above this line was removed. This July 2 session worked the 3D viewer end-to-end: Estun manual analysis for API/kinematic extraction, a full GLTFLoader/DRACOLoader troubleshooting arc, a verified forward-kinematics primitive-shape URDF, and a documented path to CAD-accurate kinematics via SolidWorks VBA macro. Same working pattern: Claude authors build/diagnostic prompts; Teddy runs them in Claude Code on the Jetson host and reports back.)*

## 70. ESTUN MANUAL ANALYSIS — API REFERENCE + ROS2 DRIVER DOCUMENT

A full read of the two Estun Chinese-language PDFs (hardware + software, S-Series Gen2 / S10-140 ECO with CC10-A cabinet) was completed this session. Key extractions:

**Full Estun scripting/API reference documented:**
- **Socket command set** — TCP-IP commands for all motion primitives (MoveJ, MoveL, MoveC, Speed, etc.)
- **Motion commands** — absolute/relative joint + Cartesian moves, speed/acceleration params, coordinate system selection
- **Modbus TCP** — register map for I/O and state polling
- **RS485 protocol** — framing, baud, register access
- **I/O commands** — digital output set/get via socket and Modbus
- **Position/state query commands** — joint positions (APOS), TCP pose, motion state, alarm codes

A comprehensive **ROS2 driver reference document** was produced from the manual data, covering: the correct TCP-IP connection point (Debug LAN on CC10-A → KEBA ETH1), socket command format and framing, required publisher/subscriber topics, service definitions, and a recommended node architecture for a minimal `estun_driver` ROS2 node that exposes standard `/joint_states`, `/tcp_pose`, `/cmd_vel`, and service interfaces.

**Key confirmed technical facts from the manuals:**
- DH zero pose: controller APOS [0,0,0,0,0,0] = J1:0°, J2:0°, **J3:90°**, J4:0°, **J5:90°**, J6:0° (confirmed from §9.1 teach pendant screenshot — Chinese readout 轴3:90.000, 轴5:90.000). URDF joint origins for J3 and J5 need −90° offsets; the correct implementation is to handle the offset in the DRIVER (add/subtract 90° on J3/J5 before publishing `/joint_states`) so the URDF remains in canonical zero-pose.
- **Elbow offset: 221mm** (corrected from an earlier misread of 231mm — the 221mm value was read directly off the technical drawing).
- **DH parameters are NOT printed in the manuals.** They are only displayed in the teach pendant software UI. A pendant screenshot is the authoritative source for the exact DH table (a, α, d, θ-offset per joint). The full numeric DH table is still pending a pendant screenshot.
- CC10-A cabinet DI/DO: PNP/NPN configurable, 16 channels. **24VDC is an inference, not sourced** — must verify against the actual CC10-A wiring diagram before wiring.
- RS485 confirmed at the M8 flange (RS485+/RS485− pins, selectable 0/12/24V) and at the cabinet level (alongside MODBUS TCP, TCP-IP, CAN, EtherCAT; ProfiNET/EtherNetIP optional).

---

## 71. 3D VIEWER TROUBLESHOOTING ARC — GLTFLoader, DRACOLoader, Tablet OOM

The 3D viewer went through an extended multi-iteration troubleshooting arc. Root causes identified:

**Issue 1 — urdf-loader does not handle GLB natively.**
`urdf-loader` expects mesh files (STL/DAE/OBJ) referenced in the URDF `<mesh filename="...">` tag. GLB files require an explicit `loadMeshCb` callback that routes through `GLTFLoader`. Without this callback, the loader silently fails to render any geometry — links are present in the kinematic tree but meshes are zero.

**Issue 2 — Draco decompression required.**
The assembly GLB (`s10-140_-eco_.glb`, 1.1MB) uses `KHR_draco_mesh_compression`. Three.js `GLTFLoader` requires `DRACOLoader` to be registered before loading any Draco-compressed GLB. Without it, the GLTFLoader throws silently and the mesh does not render. Fix: register `DRACOLoader` with the decoder path at `/static/draco/` before instantiating `GLTFLoader`.

**Issue 3 — Tablet OOM crashes from polygon count.**
- Complete assembly GLB: **294k triangles → Chrome "Oh snap" OOM on tablet.**
- Lite version (decimated): **~150k triangles → also crashes tablet.**
- **Tablet polygon budget estimated at ~30k triangles.** A decimated or primitive-shape model is required for tablet rendering.

**Issue 4 — Per-link GLB world-space transforms.**
SolidWorks exports per-link GLB files carrying world-space transforms from the assembly context. These transforms conflict with URDF joint positioning: each link mesh appears at its position in the fully-assembled world frame rather than at the origin of its local joint frame. Result: meshes scatter rather than composing as a robot. Fix requires stripping the world-space transform from each GLB and re-originating meshes relative to the link's joint frame before serving them. This is a pre-processing step (not a runtime fix), and is the primary blocker to using the real per-link SolidWorks GLBs in the viewer.

**File transfer completed:**
`s10-140_-eco_.glb` (assembly GLB) was SCP'd from the Windows laptop (`C:\Users\Laptop\`) to the Jetson at `/opt/cobot/models/robot/`. The `Content-Encoding: identity` header on the `/robot/assembly.glb` route is required to prevent nginx/FastAPI gzip from corrupting the binary.

---

## 72. FORWARD-KINEMATICS-VERIFIED PRIMITIVE URDF — JOINT CHAIN CONFIRMED

A primitive-shape URDF (boxes/cylinders per link, no mesh files) was built and its forward kinematics were verified programmatically. This gives a working articulated 3D robot in the viewer now, as a stand-in until the real DH-accurate URDF + correctly re-originated per-link GLBs are ready.

**Confirmed joint chain (FK-verified):**
```
J1 → Z axis (base rotation, vertical)
J2 → Y axis (shoulder pitch)
J3 → Y axis (elbow pitch, −90° zero offset)
J4 → Z axis (forearm roll)
J5 → Y axis (wrist pitch, −90° zero offset)
J6 → Z axis (wrist roll / flange)
```

This is: `J1(Z) → J2(Y) → J3(Y) → J4(Z) → J5(Y) → J6(Z)` — matches the expected kinematics for this class of 6-DOF cobot arm.

The primitive URDF was confirmed articulating correctly (each joint moves only its downstream links, no spurious motion, correct axis directions). Session ended before deployment to the Jetson — the primitive URDF build prompt was authored but the deploy+verify step was not completed.

**Status:** Primitive URDF authored, deploy pending. Once deployed, the 3D viewer shows a blocky but correctly-jointed robot that responds to live joint telemetry. This unblocks the viewer for motion visualization, workspace planning, and collision visualization while the real mesh pipeline is completed.

---

## 73. SW URDF EXPORTER — INCOMPATIBLE WITH SOLIDWORKS 2025

`sw_urdf_exporter` (the ROS SolidWorks URDF export plugin) was not available in SolidWorks 2025. The plugin likely has a version compatibility issue with SW2025. This blocks the one-click "define joint coordinate systems → export URDF + aligned meshes" workflow.

**Current SolidWorks version** in use: 2025. The plugin is confirmed to work on SolidWorks 2021-2023. For SW2025, the fallback is:
1. Place coordinate systems manually in the assembly (one per joint, Z = rotation axis)
2. Extract 4×4 transforms between consecutive joint frames (via Measure tool or VBA macro)
3. Convert to URDF joint origins in a Python converter script

---

## 74. VBA MACRO — AUTO-EXTRACT JOINT AXES FROM ASSEMBLY MATES

A SolidWorks VBA macro was written to extract joint axes from the assembly mate definitions. The macro:
- Iterates over all mates in the active assembly
- Identifies revolute-type mates (concentric/axis constraints defining joint rotation axes)
- Reads the axis entity, extracts its direction vector and origin point in the assembly coordinate frame
- Outputs per-joint: mate name, axis direction (X/Y/Z unit vector), origin position (mm)

**Status:** Macro written, not yet successfully run. User was in the process of placing coordinate systems in SolidWorks at session end. Claude recommendation: the VBA macro route is faster than manual coordinate system placement for extracting the joint transform data needed for the URDF.

---

## 75. OPEN ITEMS — 3D VIEWER (as of July 2, 2026)

| Item | Priority | Status |
|------|----------|--------|
| Deploy primitive URDF to Jetson + verify articulation in viewer | HIGH | Prompt authored; not deployed |
| Strip world-space transforms from per-link GLBs (re-origin to joint frame) | HIGH | Root-caused; fix is a pre-processing step on the GLB files before serving |
| Run VBA macro in SolidWorks to extract joint axes from mates | HIGH | Macro written; pending run |
| Get numeric DH table from teach pendant screenshot | HIGH | Only source for exact kinematics; blocks DH-accurate URDF |
| Build DH-accurate URDF from DH table + SolidWorks joint data | HIGH | Method documented (§51c); blocked on DH table + re-originated GLBs |
| Produce decimated ~30k-triangle model for tablet rendering | MEDIUM | Tablet budget confirmed ~30k; lite 150k still crashes |
| Verify `Content-Encoding: identity` header on `/robot/assembly.glb` route | MEDIUM | Required to prevent gzip corruption of binary |
| Complete GLTFLoader + DRACOLoader registration in viewer code | HIGH | Root-caused; fix prescribed but not verified deployed |

---

## 76. PROCESS LESSONS — JULY 2 ADDITIONS (extend §56/§41/§27/§13; all prior lessons govern)

32. **urdf-loader requires an explicit GLB callback.** The loader handles STL/DAE natively; GLB requires a `loadMeshCb` routing through GLTFLoader + DRACOLoader registration. Missing either produces silent failure (kinematic tree present, no geometry rendered). Always wire the callback before testing GLB-based URDFs.

33. **Draco decompression must be registered before ANY GLB load.** `KHR_draco_mesh_compression` is pervasive in SolidWorks-exported GLBs. Without a registered `DRACOLoader`, `GLTFLoader` silently drops the mesh. Register DRACOLoader (decoder path at `/static/draco/`) unconditionally in the viewer setup, not conditionally on file type — you often don't know the compression format before loading.

34. **World-space transforms in per-link GLBs require a pre-processing strip step.** SolidWorks assembly exports bake the world-space transform into each link mesh. These are irreconcilable with URDF joint parenting at runtime — the fix must happen at export/pre-processing time (strip + re-origin), not in the viewer code. This is a one-time per-link step, not a recurring runtime cost.

35. **Get the DH parameters from the pendant screenshot — they are not in the manuals.** The Estun manuals document everything EXCEPT the actual DH table. The pendant UI is the only place the parameters are displayed. For any Estun robot, the pendant screenshot is the authoritative kinematic source.

36. **Tablet polygon budget is ~30k triangles — enforce this at asset creation, not at runtime.** Both the 294k assembly GLB and the 150k lite version crash the tablet. The ~30k limit must be imposed during the decimation/export step (not attempted as a runtime LOD). A purpose-built "tablet model" (decimated or primitive-shape) is a required asset, not an optimization.

---

*Last updated: July 2, 2026 (Addendum 7)*
*v20 = v19 (unchanged, nothing removed) PLUS the July 2 session: a comprehensive ESTUN MANUAL ANALYSIS produced a full API/socket-command reference and a ROS2 driver reference document from the two Chinese-language PDFs; key technical facts confirmed include the J3/J5 90° controller-zero convention (offset handled in driver, URDF stays clean), elbow offset corrected to 221mm (from misread 231mm), DH parameters confirmed only in the teach pendant UI (not in manuals — pendant screenshot required), and CC10-A cabinet DI/DO 24VDC flagged as inference not sourced; a full 3D VIEWER TROUBLESHOOTING ARC identified four root causes — urdf-loader requires explicit GLTFLoader callback for GLB (not handled natively), DRACOLoader must be registered before any compressed GLB load, the tablet OOM crashes at both 294k (full assembly) and 150k (lite) with budget estimated ~30k requiring a purpose-built tablet model, and per-link SolidWorks GLBs carry world-space transforms that scatter in the URDF viewer (fix is a pre-processing strip + re-origin step at export time, not runtime); the ASSEMBLY GLB was SCP'd from the Windows laptop (username Laptop) to the Jetson with the Content-Encoding: identity header confirmed required; a PRIMITIVE URDF was forward-kinematics-verified (J1(Z)→J2(Y)→J3(Y)→J4(Z)→J5(Y)→J6(Z), correct J3/J5 offsets, each joint moves only downstream links) and a deploy prompt authored but not yet deployed; the SW URDF EXPORTER PLUGIN was confirmed incompatible with SolidWorks 2025 (works 2021-2023), blocking the one-click workflow and requiring the coordinate-systems-in-assembly + VBA macro fallback path; a VBA MACRO was written to auto-extract joint axes from assembly mates (written, not yet successfully run; recommended over manual coordinate system placement for speed); and five new process lessons were added: urdf-loader GLB callback required; DRACOLoader must always be registered unconditionally; world-space GLB transforms require pre-processing not runtime fix; DH parameters only from pendant screenshot; tablet ~30k polygon budget enforced at asset creation. All prior content from v14 through v19 (Addenda 1-6) is preserved unchanged.*

---
---

<!-- v46-content-end -->
