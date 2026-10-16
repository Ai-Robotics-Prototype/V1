# First-run sheet — bowl program under the 2026-07-31 full-vocab release

**BEFORE ANYTHING ELSE:** the arm was left at 90% / Auto after the last
session. **Drop speed to 10%** on the pendant and confirm the mode is as
required for your run (Manual for teach edits; Auto for cycled runs).
Verify the pendant shows 10% before touching this sheet's later steps.

## Preconditions

| Check | How | Pass |
|-------|-----|------|
| Speed = 10% | Pendant top-bar; matches dashboard `operator_speed_limit` intent | operator |
| Cell clear | Visual sweep + verbal call-out | operator + observer |
| E-stop reachable | Test-press on cable e-stop; arm re-safes | operator |
| Payload preset matches | Pendant PayloadId = preset matching `payload_kg=1.2 kg` from bowl header | operator |
| Codegen version served | `sha256sum src/estun_driver/estun_driver/program_ops.py` matches the manifest's `codegen.src_sha` after service restart | teddy |
| Verb reference honesty | `docs/estun_lua_reference.md` — 13 wire-verified, 2 untested (setPayload + suppressed wait) | teddy |
| Motion config in effect | `journalctl -u roboai-estun -f` shows `wire_verified_blender=True max_dps=[150,150,150,180,180,180] max_mmps=1500 cart_auto_max=2600` | teddy |
| Bowl program profile | `motion_profile=standard` in the program config (2026-07-31 §3 new default for wizard/PBD programs) | teddy in dashboard |

## Program under test

- `/opt/cobot/programs/whitebowlpickplace.json` rev `6`, 13 steps, 5 counted cycles.
- Program `speed_pct: 60`. **Overridden to 10 by the Run Modal for this run.**
- `motion_profile: standard`.

## First-run procedure

1. **Preview the Lua** (dashboard → Preview, or `GET /api/programs/whitebowlpickplace` + local codegen). Confirm on screen:
   - `-- motion:` header reads `profile=standard blend_preset='medium' radius_mm=12 descent_accel=normal max_dps=150 max_mmps=1500`.
   - Column steps (pick.approach / pick.contact / pick.retreat / place.*) emit `movL`; home moves emit `movJ`.
   - `setBlender(<mm>)` armed BEFORE the inter-station transit (retreat_pick → approach_place); `setNoBlender()` before each contact and program end.
   - `setSpeedJ(<dps>)` = 10% × 150 = 15 dps.
   - `setSpeedL(<mm/s>)` step-by-step: 60%×1500=900 for transits, 30%×1500=450 for contacts, 40%×1500=600 for retreats — all pct-scaled off the 10% run cap → 90 / 45 / 60 mm/s.
   - `waitCondition(false,500)` instead of `wait(500)` — this is the §1 replacement; NEW on the wire.
   - Zero `setBlender(` / `setNoBlender(` alarms should appear on `publish/Error` — probe THIS confirmation below.

2. **Hand on the e-stop.** Second operator on the physical e-stop, not the dashboard e-stop.

3. **First execution — WATCH THE FIRST 3 SECONDS**:
   - Kick off the run. Watch `journalctl -u roboai-estun -f | grep -E "(Error|10012|blender)"`.
   - If ANY 10012-class alarm fires on the setBlender/setNoBlender/setSpeedJ/setSpeedL/waitCondition lines → STOP. That verb is not callable; roll back per Appendix C.
   - If NO alarms → the captured verbs are wire-callable. Note this in the operator log; it promotes them from "captured/task-authoritative" to "wire-verified on this controller".

4. **Full clean cycle at 10%.** Expected observable:
   - Arm moves visibly slowly (10% × 150 dps ≈ 15 dps ≈ 1 minute per full arm sweep).
   - Contact descents visibly slow (10% × 450 mm/s emitted = 45 mm/s TCP cruise).
   - Inter-station transit blends smoothly (no dead stop at retreat_pick, one continuous swing to approach_place). If it doesn't blend visibly → setBlender may be a silent no-op; note it.
   - `waitCondition(false, 500)` — after each vacuum toggle, the arm pauses ~0.5 s. If the pause is ZERO or extreme (multiple seconds) → the ms unit is wrong; note the observed duration and switch to systemTime while-loop per §1 fallback.

5. **Post-run inspection.**
   ```
   curl -s http://localhost:8080/api/runs/latest | jq
   curl -s http://localhost:8080/api/runs/<id>/trajectory | jq '.tcp_path_max_deviation_mm'
   curl -s http://localhost:8080/api/runs/<id> | jq '.excursions'
   ```
   TCP path deviation should be under 5 mm per segment; excursions empty.

6. **Escalate speed one step at a time**, only after a clean 5-cycle table:
   10% → 25% → 50% → 65% → 100%. At each tier, re-verify the setBlender behavior and the actual `wait` duration.

7. **Motion Check panel.** In the editor, `GET /api/programs/whitebowlpickplace/motion_check` returns the analyzer's findings. Address the WARN before promoting the program to a production cycle:
   - `inconsistent_wrist_orientation` — 55.2° J6 delta between home and place. Re-teach or accept.

## Appendix A — SMOOTH / STANDARD bench probe (RUN THIS FIRST BEFORE §7.4)

Prerequisites: cell clear, 10% speed, operator + observer, e-stop.

1. Save a tiny program `probe_blender`: home → move_linear (any pose within 100 mm) → home. `motion_profile: smooth`.
2. Preview the Lua; confirm it contains `setBlender(12)` and `setNoBlender()` lines.
3. Kick off the run at 10%. Watch `publish/Error` for 3 seconds:
   - Empty (`[]` heartbeat): setBlender + setNoBlender wire-callable on THIS controller. Log the confirmation.
   - Any 10012: one of the verbs is NOT callable. Roll back `wire_verified_blender=True` → `False` in `motion_config` (or DEFAULT_MOTION_CONFIG), restart the service, verify the emission goes back to gated-off, then re-run the bowl in JOINT profile.

## Appendix B — What changed vs. 2026-07-29 release

| Item | Pre-release | 2026-07-31 |
|------|--------|------------------|
| `max_joint_speed_dps` | scalar `60.0` (conservative) | list `[150,150,150,180,180,180]` (S10-140 rated max from speedLimit screen); `min()` used for emission = 150 |
| `max_linear_speed_mmps` | `250.0` | `1500.0`; controller `cartAutoMaxVel = 2600` recorded as headroom |
| `wire_verified_blender` | `False` (gated) | `True` (captured per task §3 save-body evidence) |
| `motion_profile` | joint / straight / smooth | + `standard` (station columns movL orientation-locked, inter-station transits movJ blendable) |
| Wait step | `wait(<ms>)` | `waitCondition(false,<ms>)` — bench-verify unit |
| Speed observed at run | Controller `Robot/setAutoMoveRate` only | Same, PLUS `setSpeedJ/setSpeedL` in the Lua body (composes multiplicatively) |
| Path feasibility | wrist-lock guard only | STRAIGHT + STANDARD derived steps sample seeded IK, bound inter-sample joint velocity, fall back to movJ on branch flip; movL preferred when feasible |
| Orientation invariant | wrist-delta check only | FK-Euler stamp on FIX C emissions (`orient_dev=(rx,ry,rz) max=X°`); >1° flagged in comment |

## Appendix C — Rollback (single-verb regressions)

If a specific new verb alarms live:

| Verb | Rollback |
|------|----------|
| `setBlender` / `setNoBlender` | Set `motion_config.wire_verified_blender=False` in `estun.yaml` (or pass as override); restart service; SMOOTH/STANDARD blend emission goes back to gated-off. |
| `setSpeedJ` / `setSpeedL` | No config flag today; if these alarm, revert the commit that added `_emit_motion_prelude`'s speed block or set `max_joint_speed_dps` = `[0]*6` to force emissions to `setSpeedJ(0)` (which the controller should reject, revealing whether the alarm is on the verb or the value). |
| `waitCondition(false, N)` | Revert the §1 block to `wait(<ms>)` (previous behavior). File is `src/estun_driver/estun_driver/program_ops.py` around the `if action == 'wait'` branch. |
| `setAccL` (gentle only) | Set `program.config.descent_accel = 'normal'` per program (default already normal). |

Full-branch rollback: `git revert <2026-07-31 commit>` + `colcon build --symlink-install --packages-select estun_driver` + service restart + re-verify sha256sum matches pre-revert baseline.
