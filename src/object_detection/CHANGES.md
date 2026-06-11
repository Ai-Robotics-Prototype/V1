# object_detection — change log

## 2026-06-11 (latest) — STEP feature foundation (Parts A, B, F, G)

### Architecture summary

STEP files are no longer treated as an identification method. They are a
**feature dictionary** that boosts orientation confidence after a part
has been identified from taught camera images + size gate. This change
formalises that split:

- **Identity** = taught camera images (NCC + colour histogram) + size
  gate (35% tolerance). The June 9 `step_only` penalty already ensures
  STEP-only parts can't claim identity; this build adds the data
  needed to make STEP features actually useful for *orientation*.
- **Orientation** = group scoring of teach refs (primary truth) + STEP
  feature signatures (advisory boost — to land in the live-boost
  follow-up).

### What ships this build (Foundation)

| Part | Status | Where |
|---|---|---|
| A — STEP feature extraction (holes, bosses, slots, distinctiveness) | ✓ | `step_parser.py` |
| B — Pick direction → per-orientation feature signatures | ✓ | `step_parser.py` + `dashboard_server.py` |
| F — Dashboard surface for extracted features + revised warning | ✓ | `PartsLibrary.jsx` |
| G — Backend endpoints | ✓ | `dashboard_server.py` |
| C — Teach-time STEP↔image correlation | **deferred** | placeholder endpoint returns `status='not_computed'` |
| D — Live orientation boost from STEP features | **deferred** | live matcher unchanged from prior build |
| E — Live feature detection (Hough/blob CV) | **deferred** | hand in hand with D |

### `step_parser.py` — new public functions

```python
extract_step_features(face_features, part_id) -> dict
compute_orientation_signatures(features_doc, pick_face) -> dict
write_features_artifacts(part_id, features_doc, sig_doc) -> tuple
_face_from_normal(normal_xyz) -> 'top'|'bottom'|...
```

Plus heuristic slot detection: a row of ≥3 colinear holes with similar
size is rolled up into a `slot` feature (the typical CAD elongated-void
pattern that `extract_face_features` would otherwise split into N
separate holes).

`parse_step_file` now writes `/opt/cobot/parts/features/{id}_features.json`
and `_orientation_signatures.json` on every upload, defaulting the
pickable face to `top`. The dashboard rewrites the signatures whenever
`pick_normal` changes via the part config endpoint.

### Storage schema

```
/opt/cobot/parts/features/{id}_features.json:
  {
    "part_id": "...",
    "features": [
      {"id": "hole_top_1", "type": "hole", "on_face": "top",
       "center": [0.3, 0.5], "radius_norm": 0.05, "area_px": 30},
      ...
    ],
    "faces": {
      "top": {"features": ["hole_top_1","hole_top_2","hole_top_3"],
              "is_flat": false, "distinctiveness": 0.78,
              "feature_summary": "3 holes"},
      "bottom": {"features": [], "is_flat": true,
                 "distinctiveness": 0.0,
                 "feature_summary": "flat face, no features"},
      ...
    }
  }

/opt/cobot/parts/features/{id}_orientation_signatures.json:
  {
    "part_id": "...",
    "pickable": {"up_face": "top",
                 "visible_features": ["hole_top_1", ...],
                 "feature_summary": "3 holes",
                 "distinctiveness": 0.78},
    "non_pickable": [
      {"label": "flipped", "up_face": "bottom",
       "visible_features": [], "feature_summary": "flat face, no features",
       "distinctiveness": 0.0},
      {"label": "on_side_right", "up_face": "right", ...},
      ...
    ]
  }
```

### Backfill

Run-once script applied during this build: any existing part with
`face_features` on its metadata gets `_features.json` +
`_orientation_signatures.json` written. One part backfilled
(`250e9128aaeb`, 8 features, pick_face=front based on its saved
`pick_normal`). New uploads write artifacts automatically.

### New endpoints

- `GET /api/parts/{id}/features` — returns the feature doc and the
  current orientation signatures (empty doc if the part has no STEP).
- `GET /api/parts/{id}/feature_correlation` — placeholder; returns
  `status='not_computed'` until the teach-time correlator (Part C)
  lands.
- `PUT /api/parts/{id}/config` (existing) — now recomputes orientation
  signatures whenever `grasp.pick_normal` changes.

### Dashboard

`PartsLibrary.jsx`:
- New `StepFeaturesPanel` rendered at the top of the part configure
  view. Shows per-face feature summaries with distinctiveness percent,
  plus the pickable / flipped signature lines.
- The `step_only` amber banner copy updated to make the new
  architecture explicit: identity comes from taught images, STEP
  features only boost orientation.
- Existing ⚠ icon on the part card continues to flag `step_only`
  parts.

### Deferred work (Parts C, D, E)

The live-feature-detection pipeline (Hough circles + blob analysis for
holes/slots/bosses against the camera crop) and the orientation-boost
integration in `_match_by_teach` are intentionally not in this build —
they are the largest CV components of the new architecture and need
their own tuning pass. The placeholder
`/api/parts/{id}/feature_correlation` endpoint is shaped so the
dashboard can light up later without a frontend change.

### Restart (operator-run)

```
sudo systemctl restart roboai-depth-segment
```

The live identification path is unchanged from the prior build, so the
restart is only required if you want the foundation log lines (none
yet — feature data is consumed by the dashboard and the deferred
live-boost code).

---

## 2026-06-11 (later) — Cross-path arbitration: step_only template penalty

### Symptom

Delrin (taught from camera, no STEP) misidentified as BT225L24 (STEP, no
teach images) when delrin's teach score occasionally dipped below the
0.48 gate (e.g., under different lighting). The matcher fell through to
the template path, BT225L24's STEP outline matched the delrin's
rectangular silhouette at >0.55, and BT225L24 won.

### Why outline-only matching can't be trusted

The STEP template matcher scores on size + mask IoU + edge NCC. For
flat / rectangular parts these signals are nearly identical between
unrelated parts. A part the operator has actually shown to the camera
(teach refs) carries appearance information the STEP geometry can't.

### Fix

#### `part_library.py` — new helpers

| Function | Purpose |
|---|---|
| `get_teach_image_count(part_id)` | Count of `ref_*.npz` files under `/opt/cobot/parts/teach/<id>/` |
| `has_teach_images(part_id)` | True iff ≥1 ref present |
| `has_step_file(part_id)` | True iff `metadata.source_file` resolves to a file under `step/` |
| `identification_basis(part_id)` | Returns `step_and_images` / `images_only` / `step_only` / `untrained` |

#### `depth_segment_node.py` — `_match_by_templates`

The matching loop now tracks per-part best scores (not just a single
global best). A post-pass applies a 0.6 multiplier to any candidate
whose `identification_basis == 'step_only'`, then re-ranks. The final
threshold compares against the effective (post-penalty) score, so a
step_only outline match needs a raw score of ≥ 0.55 / 0.6 ≈ 0.92 to
clear — overwhelmingly strong, last-resort only.

Log line emitted whenever the penalty fires:

```
[STEP_ONLY] BT225L24 template match 0.71 → penalized to 0.43
  (no teach images to confirm identity)
```

#### `depth_segment_node.py` — `_match_by_teach` decision logging

Three new `[DECISION]` log shapes:

```
# Path 1 teach win
[DECISION] det=[6.4x3.7cm]: teach winner = delrin (0.72, basis=images_only)
  — clears 0.48, template path skipped

# Path 2 template win (fallback)
[DECISION] det=[…]: Path1 (STEP) teach best 0.31 (basis=images_only),
  Path2 (template) BT225L24=0.43 basis=step_only → template wins …

# Honest UNKNOWN
[DECISION] det=[…]: no path cleared threshold (teach best 0.31,
  template best 0.43) → UNKNOWN
```

The match info dict now carries `identification_basis` so the dashboard
and downstream consumers can show it.

#### `_identification_basis_for(part_id)` cache

New per-instance helper on the node. 2-second memoization so the
template matcher doesn't hit disk on every detection — identical
pattern to `_part_id_in_library` cache added earlier.

#### `dashboard_server.py`

`/api/parts` and `/api/parts/{id}` now annotate each part with:
`identification_basis`, `has_teach_images`, `teach_image_count`,
`has_step_file`.

#### Frontend (`PartsLibrary.jsx`)

- Each part card shows a small ⚠ icon next to the name when basis ==
  `step_only`, with a tooltip explaining the limitation.
- The part configure view shows an amber banner at the top for
  step_only parts, with explanation copy and a "Teach This Part"
  button. The button dispatches a `open-teach-wizard` window event
  carrying `{partId}` — wiring into the actual teach wizard is left
  for the teach flow to consume (out of scope for this fix).

### Decision-priority table (per spec)

| Basis | Trust level | Behavior |
|---|---|---|
| `step_and_images` | highest | Teach refs match (Path 1), STEP gate validates dimensions |
| `images_only` | high | Teach refs match (Path 1) with neutral size gate |
| `step_only` | low | Template path applies 0.6 penalty, almost never wins |
| `untrained` | n/a | Cannot identify (no refs, no STEP) |

### Validation (smoke test against real `/opt/cobot/parts/`)

```
1d4faaa265df: basis=images_only teach_count=2
5f63d36cd800: basis=step_only   teach_count=0   ← gets the penalty
b8c522743335: basis=untrained   teach_count=0
c98e890b8f22: basis=images_only teach_count=26
ca57d6ab4df9: basis=images_only teach_count=3
f5f91c979d3f: basis=images_only teach_count=12
```

### Restart (operator-run)

```
sudo systemctl restart roboai-depth-segment
sudo journalctl -u roboai-depth-segment -f \
  | grep -E "STEP_ONLY|DECISION|FINAL|SIZE_GATE"
```

---

## 2026-06-11 — Revert part identification to the June 5 approach

### Symptoms

- White delrin (3 holes) being identified as aluminium BT225L24.
- Phantom BT225 boxes appearing in scenes with only the delrin present.
- Confidence stuck around 0.50–0.60 for everything; visually clean
  matches no longer climbed past 0.70.

### Root cause

Between Jun 5 and Jun 9, `_match_by_teach` accumulated extra signals
that misfired on the parts the operator actually has:

| Signal added Jun 9 | Why it misfired here |
|---|---|
| Depth geometry (`_depth_geometry_score`) | Near-zero height variation on flat/shiny parts → noise |
| Harris keypoints + LBP (`_extract_features` + `_match_features`) | Patch descriptors didn't generalise from teach refs to live frames on metal parts |
| CAD face anchor (`_match_cad_features`) | CAD renders ≠ camera images; cad_score collapsed to neutral 0.5 most of the time |
| Nearest-centroid orientation classifier | Used the noisy depth + colour-layout features above as its input vector |
| Four-branch combined score | Diluted the working size + group signals with the noisy ones |

Combined effect: the working signals (NCC + colour histogram) each
ended up carrying only ~10% of the score, so good matches couldn't
beat partial-noise matches from the wrong part.

### Code changes in `depth_segment_node.py`

| Location | Change |
|---|---|
| `_match_by_teach` `default_weights` | `{ncc: 0.70, hist: 0.30}` (was 5-key blend with feat 0.35 / depth 0.25) |
| `_match_by_teach` per-ref inner loop | Removed spatial colour grid, depth geometry, Harris+LBP feature computation |
| `_match_by_teach` group score | `ncc * 0.70 + hist * 0.30` (was 5-signal blend) |
| `_match_by_teach` classifier block | Deleted — was running `_extract_orientation_fv` and overriding `is_pickable` post-match |
| `_match_by_teach` CAD face anchor | Deleted |
| `_match_by_teach` four-branch combined | Replaced with `size * 0.40 + group * 0.60` (the June 5 formulation) |
| `_match_by_teach` post-loop classifier override | Deleted (the block that flipped `is_pickable` to the classifier verdict at `clf_confidence ≥ 0.30`) |
| `_match_by_teach` size gate | `SIZE_GATE_RATIO_FLOOR = 0.65` (35% tolerance; was 0.75 / 25%) |
| `_match_by_teach` final return | Always logs `[FINAL]` (teach win / template win / honest UNKNOWN) |
| `_match_by_teach` per-group logging | New `[ORIENT]` line with HIGH/MEDIUM/LOW gap bucket; old `clf_conf` / `cad` / `sp` / `dep` / `feat` columns removed |
| `_match_by_teach` size-gate logging | Renamed `SIZE_GATE` → `[SIZE_GATE]`, includes `tol=35%` |
| `_match_by_teach` orientation-debug sidecar | Dropped `spatial` / `depth` / `feat` keys from `payload`; index into `group_dbg` updated for the new 5-tuple layout |

### Confidence-bucket mapping (Part E)

```
gap = best_group_score - second_best_group_score
gap > 0.08  → HIGH
0.04 ≤ gap ≤ 0.08 → MEDIUM
gap < 0.04  → LOW
single group     → SINGLE
```

### Kept intact (per spec)

- Orphan template skip in `_load_templates` and live-library check in
  `_match_by_templates` (both already deployed two changes back).
- `TEACH_READINESS:` startup summary line.
- `_id_to_name` centralised resolver — raw hex IDs never leak into
  labels.
- Size gate + `SIZE_GATE_BEST_MATCH` override semantics (just retuned
  the ratio floor).
- Detection front-end (depth averaging, bilateral filter, RANSAC,
  contour → OBB).
- `_match_by_templates` template path as fallback.
- Honest UNKNOWN return when neither teach nor template clears its
  threshold.

### Deviations from the spec

| Spec section | Actual | Why |
|---|---|---|
| Part A: "KEEP the two-path image-only matching split exactly as built" | One unified `_match_by_teach` with `size_score = 0.5` (neutral) for parts lacking a STEP record | No separate `_match_image_only` / `match_mode` code exists in this file — the spec assumed a Jun 5 build that isn't present in the workspace. Image-only parts still match (size-neutral gate), just through the same function |
| Part E: "Image-only path uses `NCC × 0.45 + hist × 0.40 + spatial × 0.15`" | Single `NCC × 0.70 + hist × 0.30` formula for all parts | Same reason — no separate code path. Spatial signal removed per Part A's "REMOVE" directive |
| Dead helpers (`_depth_geometry_score`, `_match_features`, `_extract_features`, `_extract_orientation_fv`, `_build_orientation_classifier`, `_match_cad_features`, `_load_cad_face_features`) | Left in the file | The teach save flow (`_extract_features` at line ~1673) and the classifier rebuild on teach (line ~1744) still call them. Removing them touches teach storage which is out of scope per the spec |
| `_orient_classifiers` and `_cad_face_features` instance state | Left initialised on startup | Same reason — populated by the teach save code path; matcher just doesn't read them anymore. Cost: a few MB of unused state. Benefit: the teach wizard storage format is untouched |
| `match_mode` dashboard badge | Not touched (no such code present) | Same reason — feature wasn't merged here |

### Restart command (operator-run; not run by this change)

```
sudo systemctl restart roboai-depth-segment
sudo journalctl -u roboai-depth-segment -f \
  | grep -E "SIZE_GATE|STEP_MATCH|IMG_ONLY|FINAL|ORIENT|orphan|TEACH_READINESS"
```

### Validation checklist

- [ ] Startup: `TEACH_READINESS: N templates loaded, M orphans skipped`
- [ ] Delrin alone in view → `[FINAL] … delrin via teach …` (or `UNKNOWN`, not BT225)
- [ ] BT225 alone in view → `[FINAL] … BT225Lxx via teach …`
- [ ] Empty table → no `[FINAL]` lines
- [ ] No raw hex IDs in any label
