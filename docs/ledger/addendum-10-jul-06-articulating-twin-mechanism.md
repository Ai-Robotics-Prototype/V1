---
ledger_split: addendum-10
source: cobot_project_conversation_v46.md
source_lines: 10815-10916 (inclusive)
title: S10-140 twin completed as a mechanism
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# ADDENDUM 10 — July 6, 2026 session (full articulating S10-140 twin COMPLETED as a mechanism — all six joint axes + coaxial centers verified)

## 88. MILESTONE — DIGITAL TWIN COMPLETE AS A MECHANISM
The colored, fully-articulating S10-140 twin is now correct on all six joints: every joint rotates in the right plane, the right direction, and about the correct physical center. This closes the long 3D-viewer arc (§71, §77, §84, §85) at the kinematic level. Remaining work is *deployment* (baking the verified chain into the dashboard URDF on the Jetson), not derivation. The mechanism was validated in a standalone browser harness, not yet pushed to the Jetson.

## 89. STANDALONE VERIFICATION HARNESS (`twin_test.html`)
All joint-axis work this session happened in a self-contained test page rather than the live dashboard, to iterate fast without deploy cycles:
- Single HTML file: three.js r0.137 UMD from CDN + all seven link GLBs base64-embedded inline + a hand-built kinematic chain (one `THREE.Group` per joint; `quaternion = setFromAxisAngle(axis, q)`).
- Sliders build immediately, decoupled from mesh loading, so the control panel is never blocked.
- Fixed named view buttons — **Side / Front / Top** — added specifically so motion questions could be anchored to a defined camera instead of a free-orbit screenshot (see Lesson 52).
- JS syntax validated with `node --check` on every rebuild before presenting.
- Nothing in this session was deployed to the Jetson; the page is the artifact.

## 90. FULL-ASSEMBLY STEP — THE GEOMETRY BREAKTHROUGH
A single full-assembly STEP export (`S10-140_-Eco_.STEP`, 94 MB, 8 PRODUCTs / 7 components / 18 solid breps) replaced the earlier per-part exports and fixed two long-standing problems: the **wrist2 duplicate** and the **CS-local flange position**. Converted via `cascadio.step_to_glb`; components extracted with world transforms and cached full-res to `asm_links.pkl` as `{label: (verts_meters, faces)}`.
- Assembly frame is **Z-up**, arm in the X–Z plane (all Y≈0), lateral offsets in **+X**.
- Component → link mapping by Z height, with assembly-frame bounds (mm):
  - `A_默认` → link0_base: X[-110,99] Y[-99,99] Z[-3,73]
  - `B_默认` → link1_shoulder: X[-80,111] Y[-80,80] Z[74,263]
  - `C_默认` → link2_upper_arm: X[111,301] Y[-80,80] Z[104,944]
  - `D_默认` → link3_forearm: X[-3,135] Y[-62,62] Z[823,1471]
  - `E_默认` → link4_wrist1: X[136,257] Y[-49,49] Z[1373,1511]
  - `F_默认` → link5_wrist2: X[158,297] Y[-49,49] Z[1511,1633]  (now DISTINCT from E)
  - `MFEco10.STEP_默认` → link6_flange: X[297,377] Y[-49,49] Z[1535,1633]  (real position, not CS-local)

## 91. FRAME TRANSFORM — ASSEMBLY (Z-up) → VERIFIED GEOM (Y-up)
J1/J2/J3 had earlier been visually verified in a Y-up "geom" frame. To reproduce that exact verified motion with the clean assembly geometry, the assembly frame is rotated into the geom frame by the proper rotation (det = +1):

  M1 = [[-1,0,0],[0,0,1],[0,1,0]]   →  geom_x = −asm_x,  geom_y = asm_z,  geom_z = asm_y

- Verified by centroid X-sign match. All build work moved into this Y-up geom frame; viewer is Y-up native, `robotRoot.rotation.x = 0` (no tilt).
- An intermediate Z-up build (`chain_asm.json`, `robotRoot.rotation.x = -π/2`) was tried and REJECTED — its bearing fit produced pitch axes that mapped back to the exact wrong direction previously fixed on J2. The dump-frame CS data (§83) was confirmed to be rotated 90° from the real geometry frame and was abandoned as an axis source.

## 92. FINAL VERIFIED JOINT CHAIN (geom frame, Y-up) — LOCKED
Working files: `chain_final.json` (name / parent-relative xyz in meters / axis / mesh) and `b64_final.json` (7 colored decimated GLBs). Absolute joint origins in `Jg_wall.npy`. Meshes baked as `(M1 @ asm_verts) − joint_origin` (translate only; link frames world-aligned). Color = PBR baseColorFactor [151,163,218,255], metallic 0.4, roughness 0.45. Decimation budgets: base 8k / shoulder 6k / upper 12k / forearm 10k / wrist1 6k / wrist2 6k / flange 7k (~50–55k total; 294k and 150k both crashed tablet-class Chrome).

| Joint | Axis (geom) | Role | Center / notes |
|-------|-------------|------|----------------|
| joint_1 | (0, 1, 0) | base yaw | Y vertical, on base center |
| joint_2 | (−1, 0, 0) | shoulder pitch | X, in-plane (verified) |
| joint_3 | (1, 0, 0) | elbow pitch | X, parallel to J2 (verified) |
| joint_4 | (1, 0, 0) | **wrist tilt** (into/out of screen from Front) | on link3 output-flange center: **X=−0.0596, Y=1.4225, Z=0 (m)** |
| joint_5 | (−1, 0, 0) | wrist pitch | X; **sign flipped this session** to correct direction |
| joint_6 | (−1, 0, 0) | flange roll | X (tool axis) |

**IMPORTANT — J4 is a TILT, not a roll.** The slider/label still reads "forearm roll" from the earlier roll hypothesis and MUST be relabeled to its true tilt function when this is baked into the URDF.

## 93. THE J4 SAGA — how the last joint was resolved (the hard part)
J4 passed through several wrong states, each corrected by direct user feedback (annotated screenshots + anchored multiple-choice), in this order:
1. **Roll about the forearm centerline** (vertical Y) at the forearm geometric center → orbited the offset wrist ~150 mm, reading as a pitch. Rejected: "rotates parallel to J2/J3, wrong; J4 is coaxial with link3."
2. **Roll relocated onto the wrist-1 bearing** (still vertical Y) → still wrong; user drew arrows showing a *tilt*, not a spin, and confirmed via Q&A.
3. **Tilt about Z** (side-to-side / crosswise) → wrong plane; the head tipped left-right across the front instead of into the screen.
4. **Tilt about X** — resolved by anchoring to the fixed **Front** view: user confirmed the head must "tip toward/away (into the screen)." From the Front camera (looking along −Z), "into the screen" = depth = Z motion of the head; a Y-extending head moves in Z only when rotated about **X**. Set joint_4 = (1,0,0). Verified numerically: flange Δ over a J4 sweep = dX 0, dY −3, **dZ 202 mm** (pure depth, zero front-back-parallel component).
5. **Coaxiality fix (final).** Correct plane but not coaxial with link3. Viewing the link3↔link4 interface edge-on (down the X-axis, where the pivot is a single point in the Y–Z plane) revealed link3's **output flange**: a disk whose normal is X, with four bolt holes and an outer rim both symmetric about **Y = 1.4225, Z = 0**. The axis had been sitting ~7 mm low (Y=1.4157). Dropped it onto the flange center (Y=1.4225, Z=0; origin X set to flange plane −0.0596). Since the axis runs along X, only its Y–Z position defines the pivot line. User confirmed: "That worked great."

## 94. J5 DIRECTION FLIP
After J4 was locked, J5 was reported "moving the wrong way." Fixed by negating its axis (1,0,0) → (−1,0,0) — reverses rotation direction, same plane and pivot. No re-bake required (axis-direction-only change). Folded into `chain_final.json`. This is a twin-visual sign; the real arm's encoder sign is reconciled in the controller mapping layer (APOS↔URDF sign/offset), not by re-deriving the axis (see §87 open items / Lesson 55).

## 95. BEARING / CENTER-FITTING METHODS — what worked, what failed
- **Full cylinder fit (axis from normals eigenvector)** — FAILED; the castings are too complex, corrupted verified axis directions.
- **Collar-centroid** — FAILED; links are thin along their axis, so the fit grabbed the whole-arm centroid (300–468 mm errors).
- **Whole-part normal-eigenvector on wrist1** — gave a spurious 45° diagonal axis (contaminated by the J5 pitch features); rejected in favor of the user-confirmed X plane.
- **Band circle-fit mixing both mating parts** — soft/unstable; center slid Y 1.406–1.427 depending on band because the forearm taper and wrist collar don't form one clean cylinder.
- **[WORKED] Edge-on-down-axis inspection + symmetric-feature center.** Lock the axis direction to the user-verified value (X), view the mating interface down that axis so the pivot is a point in the perpendicular plane, then take the center from a *symmetric* feature (the output flange's outer rim AND its four bolt holes agreed on Y=1.4225, Z=0). Circle-fit residual dropped to 1.72 mm. This is the reliable recipe: **fix the axis from verified/user data; locate the center only in the perpendicular plane, off a symmetric machined feature.**

## 96. VERIFICATION DISCIPLINE (reinforced this session)
- Every axis/center change was checked **numerically** (flange delta over a joint sweep — which world axis dominates) AND **rendered** (matplotlib Poly3DCollection, S=[[1,0,0],[0,0,1],[0,1,0]] Y-up→plot-Z-up swap) at multiple poses BEFORE presenting the HTML.
- Top-down / down-axis views are the unambiguous test for in-plane vs out-of-plane motion.
- The flange-motion-delta check is definitive for tilt direction: J4=Z gave dX-dominant (crosswise), J4=X gave dZ=202 dX≈0 (into-screen) — the numeric signature settled the plane where screenshots could not.

## 97. WORKING FILES / ARTIFACTS (this session, in Claude's env — regenerate on Jetson)
- `twin_test.html` — the standalone verification harness (delivered repeatedly this session).
- `chain_final.json` — final 6-joint chain (xyz + axis + mesh), the source for the URDF bake.
- `b64_final.json` — 7 colored decimated GLBs (base64), baked relative to joint origins.
- `Jg_wall.npy` — absolute joint origins (geom, meters); J4 = flange center.
- `asm_links.pkl` — full-res per-link geometry from the assembly STEP (`{label:(verts_m,faces)}`).
- Verification renders: `j4_axis_test.png`, `j4_tilt.png`, `j4_coax.png`, `j4_interface.png`, `j4_final.png`.

## 98. OPEN ITEMS — 3D TWIN (as of July 6, 2026; extends §87)
| Item | Priority | Status |
|------|----------|--------|
| Bake `chain_final.json` (origins + axes) into dashboard `s10-140-full.urdf` on the Jetson; swap in the colored GLBs | HIGH | Next step; not started |
| Relabel joint_4 from "forearm roll" → its actual tilt function in slider + URDF | HIGH | Pairs with the bake |
| Confirm served bundle hash changes after `npm run build` (avoid stale-bundle trap, Lesson from §77 arc) | HIGH | During the bake |
| Fold J5 sign flip into the deployed chain | HIGH | In `chain_final.json`; carry to URDF |
| Ensure any twin↔real-arm sign flips live in the controller mapping layer (APOS↔URDF sign/offset), NOT in re-derived axes | MEDIUM | Standing rule |
| θ-offset (J2/J4 vs J3/J5 pendant readout) and joint-limit (manual ±360/±160 vs robot.json ±130/±150) reconciliation | MEDIUM | On arm arrival |
All prior §87 / §75 open items carry forward unchanged.

## 99. PROCESS LESSONS — JULY 6 ADDITIONS (extend §88/§76/§56/§41/§27/§13; all prior lessons govern)
52. **Anchor motion questions to fixed named views, never to free-orbit screenshots.** Most J4 rework came from Claude mis-mapping the user's camera angle from 3/4-view images. Adding Side/Front/Top buttons and asking "from the FRONT view, does it tip into the screen?" resolved in one exchange what several annotated screenshots could not.
53. **Trust the user's direct motion feedback over Claude's geometric reasoning about rotation planes.** Claude repeatedly mis-reasoned in/out-of-plane because three frames (dump vs geom vs assembly) differed by 90° rotations. When the user says "wrong plane," re-anchor and re-measure — don't re-argue the geometry.
54. **Fix the axis, then find the center — and take the center from a symmetric machined feature viewed edge-on down the axis.** Free cylinder/centroid fits on complex castings fail. The flange's bolt-circle + rim symmetry gave a 1.72 mm center where band fits wandered 20 mm.
55. **A verified plane can still be non-coaxial — location is a separate fix from direction.** J4 had the correct axis direction while still hinging ~7 mm below the flange center. Direction and center are orthogonal corrections; confirm both.
56. **The assembly STEP is ground-truth geometry; approximate CS dumps are not.** The single full-assembly export fixed the wrist2 duplicate and flange position that per-part/CS-dump paths never resolved. Positions/distances were the easy part all along; axes (directions) and coaxiality (center-on-feature) were the source of essentially all rework.

*Summary of Addendum 10: the full articulating S10-140 DIGITAL TWIN was COMPLETED as a mechanism — all six joints verified for plane, direction, and center. Work was done in a standalone `twin_test.html` harness (three.js + inline base64 GLBs + hand-built kinematic chain, with fixed Side/Front/Top view buttons). The single FULL-ASSEMBLY STEP (94 MB) was the geometry breakthrough, fixing the wrist2 duplicate and CS-local flange; components were mapped to links and transformed into the verified Y-up geom frame via M1=[[-1,0,0],[0,0,1],[0,1,0]]. The FINAL CHAIN is locked (axes J1 (0,1,0), J2 (-1,0,0), J3 (1,0,0), J4 (1,0,0), J5 (-1,0,0), J6 (-1,0,0); origins in Jg_wall.npy). J4 was the hard case: resolved from a wrong roll → wrong-plane tilt → correct X-axis tilt (tips into/out of screen from Front, flange Δ dZ=202/dX≈0), then made COAXIAL by dropping the axis onto link3's output-flange center (Y=1.4225, Z=0), found by viewing the interface edge-on down X and using the flange rim + four bolt holes as a symmetric reference — user-confirmed "worked great." J5's direction was then flipped ((1,0,0)→(-1,0,0)). Fitting methods that worked vs failed were catalogued; verification stayed numeric (flange-delta) + rendered before every present. OPEN: bake chain into `s10-140-full.urdf` on the Jetson, relabel joint_4 "forearm roll"→tilt, verify bundle-hash change, keep twin↔arm sign flips in the controller mapping layer. Five new process lessons (52–56). All prior content v14–v24 (Addenda 1–9) preserved unchanged.*

*Last updated: July 6, 2026 (Addendum 10)*

---

<!-- v46-content-end -->
