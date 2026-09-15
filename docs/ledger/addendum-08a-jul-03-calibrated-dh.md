---
ledger_split: addendum-08a
source: cobot_project_conversation_v46.md
source_lines: 10448-10617 (inclusive)
title: Calibrated DH table, full articulating twin
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM 8 — July 3, 2026 — CALIBRATED DH TABLE OBTAINED, DH-EXACT URDF BUILT, STEP→GLB COLOR PIPELINE, CS-DUMP MACRO, FULL ARTICULATING TWIN FROM CALIBRATED CS FRAMES

*(Appended in full. Nothing above this line was removed. This July 3 session resolved the two long-standing blockers — the missing DH table and the mesh-to-frame alignment — and produced a colored, kinematically-exact, fully-articulating S10-140 digital twin in the viewer. Same working pattern: Claude authors build/diagnostic prompts and does all mesh/URDF computation in its own environment; Teddy runs prompts in Claude Code on the Jetson and SCPs files from the Windows laptop.)*

## 77. 3D VIEWER GRAY + ARTICULATION ROOT CAUSES (confirmed from the actual uploaded codebase)

The current V1 codebase was uploaded (V1-main zip) and read directly rather than reasoned about from memory. Two definitive findings:

**Gray robot — confirmed cause:** In `ArmViewer3D.jsx`, the mesh-load callback contained a hardcoded flat material `ROBOT_MATERIAL = new THREE.MeshPhongMaterial({ color: 0xC0C8D4, ... })` and applied it to every loaded mesh via `child.material = ROBOT_MATERIAL` inside the `loadMeshCb` traverse. This overrode whatever material the GLB carried, so the robot rendered uniformly gray regardless of model. Fix: remove the override; keep the GLB's baked material; apply a fallback ONLY when `!child.material`; add a RoomEnvironment/PMREM environment map + hemisphere/directional/ambient lighting so metallic PBR isn't dark.

**Articulation — confirmed cause:** The server was serving `s10-140-real.urdf`, whose own header states "Zero pose = the SolidWorks export pose (L-shape, wrist twisted). Joint axes J5/J6 reflect the posed wrist orientation (computed from geometry)." Its wrist axes were non-orthogonal geometry-inferred garbage (joint_5 axis `0 -0.9019 0.4319`, joint_6 axis `0.0545 0.4313 0.9006`). Meanwhile `s10-140-provisional.urdf` on disk was kinematically clean (canonical pose, orthogonal J1(Z)→J2(Y)→J3(Y)→J4(Z)→J5(Y)→J6(Z)).

**Hidden third issue:** The provisional URDF named joints `J1..J6` while the viewer's `JOINT_NAMES` array expected `joint_1..joint_6` — switching URDFs without reconciling silently stops all animation. Also `StandaloneRobot.jsx` (the 3D View tab) loads the same `/robot/urdf` and needed the same handling (loader.packages map + tilt), or it would render nothing.

**A failed intermediate attempt (documented so it isn't repeated):** Swapping to the provisional URDF + removing the transform-reset block + adding a Z-up tilt all at once SCATTERED the robot. The reason: the `final_linkN` meshes used by `s10-140-real.urdf` carry world-space transforms, and the transform-reset block was the load-bearing thing cancelling them. Lesson: the assembly was already correct on `s10-140-real.urdf` + the reset; the ONLY defect there was color. Reverting to serve `s10-140-real.urdf` and keeping only the material fix restored the connected, colored, base+shoulder-articulating robot.

---

## 78. CALIBRATED DH TABLE OBTAINED — THE KINEMATICS UNBLOCK (resolves §75 open item)

The calibrated DH table (标定后的DH = "post-calibration DH") was provided — the authoritative numeric kinematics the MD repeatedly flagged as the blocker for an exact twin. Standard DH (a, α, d, θ), mm and degrees:

| joint | a (mm) | α (deg) | d (mm) | θ (deg) |
|-------|--------|---------|--------|---------|
| 1 | 0 | 0 | 186 | 0 |
| 2 | 0 | −90 | 220.0517 | −90 |
| 3 | 700.8453 | 0 | −175 | 0 |
| 4 | 538.1791 | 180 | −161.5 | −90 |
| 5 | 0 | 90 | −161.314 | 0 |
| 6 | 0 | 90 | 169.5 | 0 |

**Drawing cross-check (two independent sources agreeing = high confidence, per §51c):** d1=186 ≈ drawing 186; d2=220.05 ≈ drawing 221; a3=700.85 ≈ drawing 700; d3=−175 ≈ drawing 175; d4=−161.5 ≈ drawing 161.5; d5=−161.31 ≈ 161.5. The `a4=538` vs the drawing's second "700" is expected — DH link lengths don't map 1:1 to visual segments (remainder distributes into d-offsets).

**θ-offset note / discrepancy flagged:** this calibrated table puts the −90° θ-offsets on joints 2 and 4, whereas the earlier pendant readout (§35/§10b) put 90° on joints 3 and 5. These are a legal DH re-parameterization (same arm, frames assigned differently). The θ offsets make the DH-zero pose BENT, not straight-up.

**Joint-limit conflict flagged (unresolved):** manual reading (§10b) = J1/J2/J4/J5/J6 ±360°, J3 ±160°; but `robot.json` on disk = j2/j5 ±130°, j3 ±150°. To be settled against the controller on arrival.

---

## 79. DH-EXACT URDF BUILT AND FK-VERIFIED (`s10-140-dh.urdf`)

Built a URDF directly from the calibrated DH via the standard PRE/POST decomposition: each URDF joint origin = POST_{i−1}·PRE_i where PRE_i = Rz(θ_off)·Tz(d), POST_i = Tx(a)·Rx(α); joint axis always local Z; flange = POST_6 as a fixed `tool0`.

- **FK round-trips against the raw DH to ~1e-13 (machine precision)** — kinematically exact.
- Joint names `joint_1..joint_6` to load unchanged in the viewer; joint limits from the manual reading; primitive (cylinder/sphere) visuals so it renders and articulates immediately.
- **Zero pose is intentionally BENT** (the calibrated θ-offsets on J2/J4 make all-joints-zero the DH-zero configuration, not visual straight-up). The clean design: URDF joint value = DH joint variable; the driver maps controller APOS → URDF via sign[]/offset[] (confirmed by jog test on arrival). Do NOT rebase the URDF to "look straight."
- Rendered FK skeleton verified at 3 poses: base yaw swings whole arm, shoulder/elbow flex, nothing scatters.

**Key reframing this produced:** the DH table fully solves KINEMATICS; it does NOT tell where the visual MESH geometry sits (DH frames are a mathematical convention placed by a/d/α, not at the physical bearings/castings). So the SolidWorks work is now needed ONLY for MESH placement, not for deriving kinematics.

---

## 80. igus REJECTION REAFFIRMED

A brief detour toward igus (ReBeL / published URDFs) was firmly closed by Teddy: the target robot IS the S10-140 and substituting a different arm would corrupt all motion paths, collision zones, and TCP poses. igus has an OFFICIAL open URDF (CommonplaceRobotics/iRC_ROS, AIRLab-POLIMI/ros2-igus-rebel), unlike Estun, but the ReBeL is a fundamentally different machine (~2kg payload, ~660mm reach vs S10-140's 10kg / 1400mm). The higher-level goal is an accurate S10-140 twin as geometric ground truth for the autonomy stack — no substitution. (This reaffirms the standing "igus/other arm = firm rejection" principle.)

---

## 81. SOLIDWORKS EXPORT REALITY — GLB NOT NATIVE; STEP IS THE FORMAT

Attempting to export per-link GLB with an output coordinate system failed because **SolidWorks does not natively export GLB/GLTF** — it supports STEP, IGES, Parasolid, STL, 3MF. That's why the CS-on-GLB option didn't exist. Corrected workflow: export **STEP per link with the output CS set** (STEP honors the output-CS dropdown reliably; STL/3MF have a known SolidWorks bug where the output-CS setting is silently ignored). STEP also carries the SolidWorks appearances, so color survives into the downstream GLB. STEP→GLB conversion happens off-SolidWorks.

**Export naming convention (locked):** `link0_base` (CS0), `link1_shoulder` (CS1), `link2_upper_arm` (CS2), `link3_forearm` (CS3), `link4_wrist1` (CS4), `link5_wrist2` (CS5), `link6_flange` (CS6). Each link exported with its own CS as the output coordinate system.

---

## 82. STEP→GLB PIPELINE PROVEN (cascadio + trimesh, color preserved)

Established the conversion pipeline in Claude's environment: `cascadio.step_to_glb(...)` (OpenCASCADE) → `trimesh` load. Key results:

- **Color survives:** cascadio pulls the SolidWorks appearance through as a `PBRMaterial` (`visual kind: texture`). The base/shoulder came through as flat baseColorFactor `[151,163,218]` (the SolidWorks default "默认" appearance). This settles the gray at the SOURCE — `withMaterial:1` guaranteed for STEP-sourced GLBs, independent of the viewer material fix.
- **cascadio outputs meters** (glTF convention); STEP native is mm — watch the scale.
- **Decimation drops color unless re-applied:** `simplify_quadric_decimation` via `fast_simplification` strips the material; fix = re-assign a `PBRMaterial(baseColorFactor=..., metallicFactor≈0.4, roughnessFactor≈0.45)` after decimation, and `merge_vertices()` + recompute vertex normals for SMOOTH shading.
- **Tessellation quality:** first pass at 12k triangles/link looked faceted on curved castings; re-converting from STEP at finer tolerance (tol_linear 0.05, tol_angular 0.2) and decimating to ~45k (for 2-link tests) or ~6–15k/link (for the full robot) with smooth normals reads smooth. Whole-robot budget kept ~50k total (the 294k full assembly and 150k lite both crashed the tablet; ~30–50k is safe).

**Base+shoulder alignment proof (link0+link1):** because CS0 and CS1 share the base-axis origin, the two meshes assemble directly in a common frame (base top and shoulder bottom both at 76mm — zero gap) and joint_1 rotates the shoulder cleanly about the vertical axis. This validated the whole approach on 2 links before doing all 7.

---

## 83. READ-ONLY CS-DUMP MACRO (`DumpCoordSystems.bas`) — SUCCESSFUL

The mesh↔DH-frame bridge could NOT be recovered from geometry alone: the per-link STEP exports came out in a COMMON base frame at assembled positions (forearm at ~1150mm, its assembled height, not re-centered), and the CS definitions were NOT embedded as named datums in the STEP files. A DH-only reconstruction was attempted and FAILED — the DH's abstract joint frames sit in genuinely different places than the physical meshes (DH put the wrist at 1645mm vs the mesh at 1413mm — a 230mm gap with no way to resolve without the CS locations), and the DH's "straight-up" pose wouldn't even go vertical (persistent 175–336mm kink). This CONFIRMED (not just asserted) that the seven CS transforms are the specific missing data.

A **read-only** VBA macro was written (distinct from the failed §74 mate-inference macro — this one only reads placed coordinate systems, touches no mates/geometry): iterates features of type `CoordSys`, calls `GetCoordinateSystemTransformByName`, dumps each CS's origin (mm) + X/Y/Z axis unit vectors relative to the model origin, writes `cs_dump.txt` next to the assembly. Teddy ran it successfully — **"Found 7 coordinate systems."** Assembly confirmed named `S10-140-Eco (Straight_up_ASM)`.

**cs_dump.txt (calibrated CS frames, mm, Y-up assembly, axes as unit vectors):**
```
CS0 | 0 0 0        | X(0,0,1) Y(1,0,0) Z(0,1,0)      (permuted base frame; Z=world Y=up)
CS1 | 0 186 0      | X(0,0,1) Y(1,0,0) Z(0,1,0)      joint_1 base yaw, axis=vertical
CS2 | 0 186 221    | X(0,1,0) Y(-1,0,0) Z(0,0,1)     joint_2 shoulder, axis sideways
CS3 | 0 886 46     | X(-1,0,0) Y(0,1,0) Z(0,0,-1)    joint_3 elbow, axis sideways
CS4 | 0 1424.5 207.5 | X(0,-1,0) Y(1,0,0) Z(0,0,1)   joint_4, axis sideways
CS5 | 0 1586 207.5 | X(1,0,0) Y(0,0,-1) Z(0,1,0)     joint_5, axis vertical
CS6 | 0 1586 363   | X(1,0,0) Y(0,1,0) Z(0,0,1)      joint_6 flange, axis sideways
```
All right-handed (det +1). Origins confirm the drawing distances exactly (221 shoulder, 700 upper-arm rise, 175 back-offset, 161.5, 155.5 flange).

---

## 84. FULL ARTICULATING TWIN BUILT FROM CS FRAMES (`s10-140-full.urdf`)

Construction (all in the assembly Y-up frame; three.js native, so NO viewer tilt):
- `base_link` = assembly world (identity root). Not CS0 — CS0 is a permuted frame, so the root is the world frame directly and joint_1 origin = CS1.
- joint_i origin = inverse(CS_{i−1})·CS_i; joint axis = local Z (0,0,1); link_i frame = CS_i.
- **FK at q=0 reproduces all seven CS world frames exactly**; each joint verified to move ONLY its downstream links (joint_2/3/5 upstream-fixed, flange moves).
- Mesh attachment: detect per mesh whether it's in the world/assembly frame (visual origin = inverse(CS_i)) or already CS-local (visual origin = identity), by comparing centroid to CS_i origin. links 1–4 were world-frame; link0 and link6 were CS-local. The visual-origin transform was baked into each GLB so the URDF uses identity visual origins.
- link_5 (wrist2) has NO mesh (the uploaded wrist2 STEP is a byte-identical duplicate of wrist1 — CS5 was likely left on CS4); joint_5 is present so kinematics is complete, but there's a visible gap at the wrist / floating flange until wrist2 is re-exported with output CS = CS5.
- Rendered through 4 poses (straight-up zero, shoulder+elbow bent, wrist pitched, base yaw 60°): stands straight up at zero and articulates correctly on the calibrated frames, colored meshes throughout.

**Result: a colored, kinematically-exact (nominal-calibrated), fully-articulating S10-140 digital twin** — the goal of the whole 3D-viewer effort. Precision is nominal-CAD accurate (CS origins at drawing distances); the calibrated DH refinements are sub-mm and can be layered later; for MoveIt2 sub-mm planning the calibrated `s10-140-dh.urdf` remains the reference.

**Orientation gotcha (critical for the serve step):** `s10-140-full.urdf` is **Y-UP** (assembly/three.js native). The viewer must set `urdf.rotation.x = 0` for it — do NOT apply the `-Math.PI/2` tilt used for the Z-up URDFs (`s10-140-dh.urdf`, `s10-140-partial.urdf`), or this one tips over.

---

## 85. INTERIM MILESTONE — `s10-140-partial.urdf`

Before the full CS-dump was available, an interim URDF was built and served: base_link (real base mesh) + link_upper (shoulder+upper_arm+forearm+wrist1 as one rigid block), joined by joint_1 (vertical axis). This gave the full colored robot standing straight up with the base-yaw joint articulating the whole arm about vertical — metrically honest (base-yaw axis is unambiguous) — while links 2–6 stayed rigid pending the CS transforms. Confirmed working in the viewer (base+shoulder moved correctly, colored).

---

## 86. WORKFLOW / ENVIRONMENT NOTES (July 3)

- **SCP path friction:** browser downloads repeatedly landed in `Downloads\files\`, `Downloads\files (1)\`, `Downloads\files (2)\` subfolders and/or with `(1)` suffixes; Windows hides extensions so STEP (`BambuStudio` type, ~10MB) and GLB (`3D Object` type, ~200KB) look identical by name — verify by size/type. Recommend enabling View → Show → File name extensions.
- **File sizes as integrity check:** decimated hi-res GLBs ~1.2MB (45k tris, 2-link tests) or ~160–370KB (full-robot decimation); old faceted versions ~245KB — size confirms which set is on the Jetson.
- **Claude Code auth:** hit `401 Invalid authentication credentials · Please run /login` mid-session; resolved via `/login`. SSH to the Jetson is the user's own (works — SCP transfers succeeded); Claude cannot provide SSH access or run commands on the host.
- **SolidWorks:** version 2025 SP1.2; assembly `S10-140-Eco (Straight_up_ASM)`; CSs are reference coordinate systems CS0–CS6.

---

## 87. OPEN ITEMS (as of July 3, 2026)

| Item | Priority | Status |
|------|----------|--------|
| Serve `s10-140-full.urdf` in the viewer with `rotation.x = 0` (Y-up) | HIGH | Files on Jetson; serve prompt authored; awaiting run + withMaterial confirmation |
| Re-export wrist2/link5 with output CS = CS5 (current is dup of wrist1) | HIGH | Fills the wrist gap / floating flange |
| Confirm the 6 withMaterial counts = 1 in the browser | MEDIUM | Verifies color survived to the tablet |
| Resolve joint-limit conflict (manual ±360/±160 vs robot.json ±130/±150) | MEDIUM | Settle against controller on arrival |
| Reconcile θ-offset convention (calibrated DH J2/J4 vs pendant J3/J5) | MEDIUM | Jog test on arrival; driver sign[]/offset[] mapping |
| Controller interface mapping layer (APOS↔URDF, config-driven sign/offset) | MEDIUM | Prompt authored; build-ahead (no arm connected yet) |
| Layer calibrated-DH sub-mm precision onto the CS-based twin if needed for planning | LOW | `s10-140-dh.urdf` remains the planning reference |

---

## 88. PROCESS LESSONS — JULY 3 ADDITIONS (extend §76/§56/§41/§27/§13; all prior lessons govern)

37. **DH table = kinematics; CS frames = mesh placement. They are different data.** The calibrated DH fully defines joint motion but NOT where the physical geometry sits (DH frames are placed by a/d/α convention, not at bearings). A DH-only mesh reconstruction was attempted and demonstrably failed (230mm wrist gap). The seven CS transforms are the specific bridge — verified necessary, not assumed.

38. **Read the actual uploaded/deployed code before diagnosing.** The gray cause (`child.material = ROBOT_MATERIAL` override) and the served-URDF issue were found by reading the real V1 codebase, not by reasoning from description.

39. **Change one thing at a time on a working assembly.** Swapping URDF + removing the transform-reset + adding a tilt simultaneously scattered a robot that only had a color defect. The transform-reset was load-bearing for the `final_linkN` world-space meshes.

40. **SolidWorks cannot export GLB.** Use STEP per link with output CS set (STEP honors output-CS; STL/3MF silently ignore it). Convert STEP→GLB off-SolidWorks with cascadio; color (appearances) survives.

41. **Re-apply material and smooth normals AFTER decimation.** Quadric decimation strips the PBR material and flat-shades; re-assign baseColorFactor + merge_vertices + recompute vertex normals.

42. **Verify export frames empirically per link.** Per-link STEP exports may land in a common assembly frame OR CS-local, inconsistently. Detect by comparing mesh centroid to the CS origin; set the visual origin accordingly (inverse(CS_i) for world-frame, identity for CS-local).

43. **Track the up-axis convention per URDF.** `s10-140-dh.urdf`/`s10-140-partial.urdf` are Z-up (viewer tilt −90° about X); `s10-140-full.urdf` is Y-up (no tilt). Mixing them without gating the tilt tips the robot over.

44. **A read-only dump macro beats hand-transcription and beats a bounding-box guess.** `DumpCoordSystems.bas` reads the seven placed CS transforms exactly (origin + all three axis vectors) in ~2 minutes; it does not infer joints (unlike the failed §74 mate macro).

---

*Last updated: July 3, 2026 (Addendum 8)*
*v21 = v20 (unchanged, nothing removed) PLUS the July 3 session: the GRAY robot root cause was confirmed from the actual uploaded V1 codebase (a hardcoded ROBOT_MATERIAL override in ArmViewer3D.jsx stripping GLB colors) and the ARTICULATION failure traced to the server serving the posed geometry-inferred s10-140-real.urdf instead of a clean-axis URDF, plus a joint-name mismatch (J1..J6 vs joint_1..joint_6) and a StandaloneRobot.jsx follow-through; the CALIBRATED DH TABLE (标定后的DH) was obtained — resolving the §75 blocker — cross-checked against the dimension drawing (186/220/700/175/161.5/155.5 all matching) with the θ-offsets on J2/J4 flagged against the pendant's J3/J5 and a joint-limit conflict (manual ±360/±160 vs robot.json ±130/±150) flagged; a DH-EXACT URDF (s10-140-dh.urdf) was built via the PRE/POST decomposition and FK-verified to 1e-13 machine precision, establishing that the DH solves kinematics but not mesh placement; a STEP→GLB PIPELINE (cascadio + trimesh) was proven to preserve SolidWorks appearance color (settling gray at the source, withMaterial:1) with a decimation-then-reapply-material-and-smooth-normals step and a ~50k whole-robot tablet budget; SolidWorks was confirmed unable to export GLB natively (STEP-per-link-with-output-CS is the correct path); a READ-ONLY CS-DUMP MACRO (DumpCoordSystems.bas, distinct from the failed §74 mate macro) was written and run successfully, extracting all seven CS transforms (origins confirming the drawing distances, all right-handed) after a DH-only reconstruction was attempted and demonstrably failed (230mm wrist gap proving the CS transforms are the specific missing bridge); and the FULL ARTICULATING TWIN (s10-140-full.urdf) was built from the CS frames with base_link=world root, joint origins = inverse(CS_{i-1})·CS_i, per-mesh frame detection for visual origins baked into the GLBs, FK reproducing all seven CS frames exactly and every joint moving only downstream links — a colored, kinematically-exact, fully-articulating S10-140 digital twin (Y-up, no viewer tilt; link_5/wrist2 mesh pending re-export as it was a duplicate; interim s10-140-partial.urdf with working base-yaw also delivered en route). Eight new process lessons (37–44) were added. All prior content from v14 through v20 (Addenda 1–7) is preserved unchanged.*

---
---

<!-- v46-content-end -->
