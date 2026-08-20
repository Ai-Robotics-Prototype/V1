---
ledger_split: addendum-02
source: cobot_project_conversation_v46.md
source_lines: 9722-9768 (inclusive)
title: S10-140 technical drawing dimensions extracted
---

<!-- v46-content-start (do not edit; used by reconstruction test) -->
# SESSION ADDENDUM 2 — June 15, 2026 (continued) — S10-140 TECHNICAL DRAWING DIMENSIONS EXTRACTED
*(Appended in full. Nothing above this line was removed. This continues the June 15 session, refining the provisional-URDF work of §10b with actual dimensions read off the technical drawing.)*

## 14. S10-140 TECHNICAL DRAWING — DIMENSIONS READ DIRECTLY (provisional URDF now dimensionally faithful)

**Context / user point:** The user was being repeatedly told to "reference Figure 4-9 / the technical drawing" and was frustrated that no one was giving a special "format." **The resolution: the technical drawing IS the data — there is no other format to obtain.** A cleaner "Technical Drawings" image of the S10-140 was uploaded and the dimensions were read directly off it. Between this drawing (segment lengths, reach, flange) and the manual spec tables (exact joint limits/speeds), the provisional URDF can be built now with accurate proportions. The only thing no installation drawing can provide — a DH parameter table for sub-mm accuracy — still must come from Estun's official URDF later.

### Dimensions read off the S10-140 technical drawing (mm):
- **Base height (link0 → J1): 186**
- Base diameter ~**198.5**, base footprint **209.3**, base mounting circle Ø**180**, mounting hole spacing **89 + 89 = 178**, 4× Ø9 thru holes, 8 FG8 locating.
- **Shoulder horizontal offset: 221** (J1/J2 region lateral offset)
- **Lower major arm segment: 700** (upper arm — J2 to J3)
- **Elbow horizontal offset: 175** (J3 region)
- **Upper major arm segment: 700** (forearm — J3 to J4)
- **Wrist offsets: 161.5 and 150.5** (J4/J5/J6 region)
- **Total reach: SR 1400 (1400mm)** — matches the spec. **Inner dead-zone: SR 326.**
- Vertical stack sanity check: 186 (base) + 700 + 700 + wrist ≈ 1400mm ✓ (proportions are correct)

### Flange (from the same drawing — confirms ISO 9409-1-50-4-M6):
- 4× M6 threaded holes, 9mm deep
- Ø6 H7 (+0.012) locating pin hole, 6mm deep
- Ø63 h8 pilot boss
- Ø50 reference, Ø31.5 H7 (+0.025) central bore

### These EXACT values pair with the manual's exact joint data (already recorded in §10b):
- Joint POSITION limits: J1,J2,J4,J5,J6 = ±360°; **J3 = ±160°**
- Joint VELOCITY limits (Eco): J1/2/3 = 150°/s; J4/5/6 = 180°/s
- Payload 10kg, self-weight 39kg

### Updated provisional-URDF build prompt (dimensions baked in)
The §10b URDF prompt was refined to use these exact drawing dimensions as the link lengths (standard UR-style 6-DOF serial cobot layout: base yaw J1, shoulder pitch J2, elbow pitch J3, wrist J4/J5/J6) so the assembled arm's proportions and 1400mm reach match the real S10-140. Only the small perpendicular joint offsets are approximated (typical cobot pattern, each commented). The 8 per-link GLB meshes attach via the GLTFLoader callback with per-link visual-origin offsets so the robot looks assembled (not exploded). Output: `config/estun_s10_140_provisional.urdf` with the PROVISIONAL honesty header. Verify: overlay shows 8 links · 8 meshes · ~1.4m bbox, articulates within limits (J3 capped ±160°).
- **STATUS: PENDING run/verify.**

### HONESTY REAFFIRMED
This drawing makes the provisional URDF **much** more accurate than a guess — the proportions and reach will be right. It remains PROVISIONAL because it is an outline/installation drawing, NOT a DH parameter table: precise sub-millimeter joint-axis offsets/twists are approximated. Good for visualization, workspace, and motion-planning prep; replace with Estun's official URDF (still on the request list) for sub-mm collision-accurate planning. No installation drawing from any vendor contains the DH table — so this is the best obtainable from the manual, and it is sufficient for the visualization/north-star purpose.

### PENDING-ITEMS UPDATE (supersedes the §12 URDF row's detail)
- "Run/verify provisional URDF from manual" → now has exact drawing dimensions baked in (186 base / 700 / 700 / 221 / 175 / 161.5 / 150.5 / SR1400 / SR326 / ISO 9409-1-50-4-M6 flange). Still PENDING run/verify. Still flagged provisional; Estun official URDF still requested for precise planning.

---

*Last updated: June 15, 2026 (Addendum 2)*
*v16 = v15 (unchanged, nothing removed) PLUS the S10-140 technical-drawing dimension extraction: the installation drawing was read directly (base 186mm, two 700mm major arm segments, offsets 221/175/161.5/150.5mm, total reach SR1400mm, inner dead-zone SR326mm, ISO 9409-1-50-4-M6 flange with Ø63 h8 pilot / Ø31.5 bore), resolving the user's confusion that no special "format" was forthcoming — the technical drawing IS the data. Combined with the manual's exact joint limits (±360°, J3 ±160°) and velocities (150/180°/s), the provisional URDF build prompt now bakes in faithful link lengths/proportions and 1400mm reach, with only the small perpendicular joint offsets approximated (no DH table exists in any installation drawing). The URDF remains explicitly PROVISIONAL — for visualization/workspace/planning-prep, replaced by Estun's official URDF for sub-mm collision-accurate planning. All prior content from v14 and the v15 June 15 session is preserved unchanged.*

---
---

<!-- v46-content-end -->
