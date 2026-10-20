# First-run sheet — bowl program under the 2026-07-29 motion vocabulary

## Preconditions (read before the operator sits down)

| Check | How | Pass |
|-------|-----|------|
| Cell clear | Visual sweep + verbal call-out | operator + observer |
| E-stop reachable | Test-press on live-cable e-stop, arm re-safes | operator |
| Payload preset matches | Controller-side `PayloadId` = the preset matching `payload_kg=1.2 kg` from the bowl program header | operator on pendant |
| Codegen version served | `curl -s http://localhost:8080/health` → returns the same `program_ops` src_sha as `sha256sum src/estun_driver/estun_driver/program_ops.py` | teddy |
| Verb reference honesty | `docs/estun_lua_reference.md` lists `setSpeedJ`/`setSpeedL`/`setAccL` as **doc-captured** (NOT wire-verified) — meaning THIS run is what promotes them | teddy |
| Motion config in effect | Log line at driver boot must include `wire_verified_blender=False max_dps=60 max_mmps=250 gentle_accL=150 default_accL=1200` | teddy tails `journalctl -u roboai-estun -f` |
| Operator speed cap | Dashboard shows `operator_speed_limit = 100` but the RUN cap for this first-live is 10% | teddy in dashboard |
| SMOOTH profile OFF | Bowl program `config.motion_profile` = `joint` (NOT smooth) — smooth stays gated and is not selected on the first run | teddy verifies in program JSON |

## Program under test

- Path on disk: `/opt/cobot/programs/whitebowlpickplace.json`
- Rev: `6`
- Steps: `13` (5 counted cycles per the loop step)
- Program `speed_pct`: `60` — capped to **10** for this first run via the dashboard's Run Modal `run_speed_pct=10`.

## First-run procedure

1. **Load and inspect the generated Lua.** From the dashboard:
   * Open the bowl program.
   * Click *Preview Lua* (or `POST /api/programs/whitebowlpickplace/preview`) — screen must show the joint-profile output. Confirm every `setSpeedJ` line's absolute value matches `pct × 0.60` (e.g. `10% × 60 dps = 6 deg/s`) — the run cap has scaled the modal speed down.
   * Confirm zero `setBlender` / `setNoBlender` lines (smooth stays off).
   * Confirm the `-- motion:` header line reads
     `profile=joint blend_preset='medium' radius_mm=12 descent_accel=normal max_dps=60 max_mmps=250`.

2. **Hand on the e-stop.** Second operator on the physical e-stop, not the dashboard e-stop.

3. **Kick off the run at 10%.** Dashboard → Run → `run_speed_pct=10` → *Confirm*. Watch:
   * The dashboard's live trajectory panel should show the arm cruising at a **visibly slow** joint speed on the approaches (6 deg/s ≈ ⅓ of the driver-side limit clamp).
   * At the pick descent, the arm should visibly slow further (the contact runs on `setSpeedL(7.5)` = 3% × 250 mm/s = 7.5 mm/s).
   * Every step's `line` on `publish/ProjectState` should march through the `movJ`/`movL` file lines without any 10012 alarms on `publish/Error`.

4. **After one clean cycle:** pause the run (or hit e-stop, resume in AUTO). Pull the run manifest:
   ```
   curl -s http://localhost:8080/api/runs/latest | jq
   ```
   Verify the manifest carries the current `program_ops` src_sha256 in `codegen.src_sha` (the hash-check gate). If the manifest's src_sha ≠ the file on disk, STOP and restart the service.

5. **Post-run inspection.**
   * Trajectory analyzer: `curl -s http://localhost:8080/api/runs/<id>/trajectory | jq '.tcp_path_max_deviation_mm'` — the TCP path deviation vs. the URDF-FK reference should be under 5 mm for every segment.
   * Excursions: `curl -s http://localhost:8080/api/runs/<id> | jq '.excursions'` — should be empty. Non-empty means a joint or TCP left its ± tolerance window; investigate before escalating speed.

6. **Escalate ONE knob at a time.** Only after a clean 5-cycle table at every prior tier:
   * 10% → 25% (bowl runs at `pct/100 × 60 dps` = 15 deg/s cruise; contact still ≤ 3%);
   * 25% → 50%;
   * 50% → 65% (matches the pre-2026-07-28 operator ceiling);
   * 65% → 100% (only when 65% has one clean table).

   Escalate **speed only**; do NOT enable SMOOTH profile yet. SMOOTH stays gated until the bench probe (Appendix A) proves setBlender is callable on this controller.

7. **On any excursion / 10012 / operator concern:** e-stop, then follow the **July 22 recovery procedure** in `PART_2C_ARCHITECTURE.md §7` (verified path: safing → clear alarm → re-teach if needed → single-cycle at 10%).

## Appendix A — SMOOTH profile bench probe (do NOT run today)

Prerequisites: cell clear, operator + observer, e-stop in hand, arm in AUTO mode, program `roboai_probe_blender` loaded (create a 4-step move_home → 3× movJ program with all four points identical to the current pose — literally a zero-motion program).

Procedure:
1. Prepend a single line to the program's Lua source: `setBlender(12)` before the first movJ.
2. Kick off the run at **1%** speed cap.
3. Watch `publish/Error` for 3 seconds:
   * Empty (`[]` heartbeat): the controller accepted setBlender. Note in the operator log: `setBlender(N) is wire-callable on this controller — 2026-XX-XX`.
   * Any 10012 (or `Compile failed`): the controller rejected setBlender. Report back; SMOOTH profile stays gated.
4. Same probe for `setNoBlender()` (no argument).
5. If BOTH clean, flip `motion_config.wire_verified_blender=true` in `estun.yaml` and re-run this bowl-first-run sheet in the SMOOTH profile.

## Appendix B — What changed this release

| Item | Before | After (this release) |
|------|--------|------------------|
| Emitted verbs | `movJ`, `movL`, `movJCoorRel`, `setDO`, `setAO`, `getDI`, `goto`, `wait` | + `setSpeedJ`, `setSpeedL`, `setAccL` (gentle only), `waitCondition` (verify_input only). SMOOTH gate keeps `setBlender`/`setNoBlender` OFF. |
| Speed model on the wire | `Robot/setAutoMoveRate` WebSocket verb only — Lua carried no speed calls. | Same `Robot/setAutoMoveRate` as before, PLUS explicit `setSpeedJ(dps)` / `setSpeedL(mm/s)` in the Lua source, modal (only re-emitted on value change). Both compose: controller-side setAutoMoveRate multiplies the Lua-side setSpeed*. |
| motion_profile field | absent | `joint` (default) / `straight` / `smooth`. Straight and smooth behave identically on the wire today (SMOOTH gated). |
| Payload | `-- payload:` header comment only | Unchanged — `setPayload("")` still NOT emitted; §4 fallback triggered because the arg form remains undetermined. |
| WAIT step | `wait(ms)` integer millis — proven callable via alarm 10006 | Unchanged — the task's `waitCondition(false, ms)` rewrite was declined; existing wire-verified path is stronger evidence than a proposed rewrite. |
| verify_input | did not exist; `wait_input` emitted read-only `_diN = getDI(port)` | New `verify_input` action emits `waitCondition(getDI(port)==<expect>, timeout_ms)`. Old `wait_input` upgrades automatically if the step carries `expect` + `timeout_ms`. |

## Appendix C — Rollback

If any first-run cycle produces an unexpected motion difference from the pre-2026-07-29 codegen:
1. `git revert <commit>` on this branch.
2. `colcon build --symlink-install --packages-select estun_driver`.
3. `sudo systemctl restart roboai-estun roboai-dashboard`.
4. Verify `sha256sum src/estun_driver/estun_driver/program_ops.py` matches the pre-revert baseline.
5. Re-run the same bowl program; motion should be byte-identical to the pre-release output modulo the header timestamp.
