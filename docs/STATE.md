# STATE.md — current truth as of 2026-08-27 (end of Addendum 46 — F1 CLOSED, F2 STARTED on bba8cea)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **F1 formally CLOSED** at the code layer. Streamed jog retired
  (addendum-45 §597), WS-jog reinstated (§598), motion arbiter shipped
  (§599, 12 doctrine cases), add-16 §286 three flicker-fixes verified
  still present (§600), slider truth pinned as doctrine (addendum-46
  §603, 5 wire-truth cases). Real-arm acceptance (F1.1) + live-fire
  arbiter (F1.2) are operator-cued and wait on the physical power-
  cycle. All code / config / doctrine work is done.
- **F2 STARTED** on `bba8cea` baseline. New package
  `s10_140_executor` in CodroidROS2 with three pure-logic gate
  modules (validators, settle, silent-refusal) + node skeleton, 24
  unit tests all PASS. Palletize defects diagnosed CLOSED at code
  (addendum-46 §605) — c995e5d's 7 named pins all pass; the 27
  failures are pre-existing IK-fixture atomicity, not live defects.
- **F2.7 (first taught program end-to-end on real arm)** is the next
  milestone. Skeleton's TODO surface is explicit: real websockets
  four-tuple probe, MoveGroupInterface Pilz PTP/LIN planning, JTC
  ExecuteTrajectory action client, `/estun/io` ack wait, pause/
  resume/stop wiring.
- **Jog architecture (unchanged since add-45):**
  - **Jog path** = WS `Robot/jog` on `:9000` via `roboai-estun`. Driver
    banner: `JOG WRITE PATH ENABLED — monitor_only=false,
    allow_jog=true (source: ESTUN_ALLOW_JOG). /robot/jog_command
    will emit Robot/jog frames (|speed|≤0.50, heartbeat=0.40s,
    deadman=0.20s). All other write paths still rejected.`
  - **Program-execution path** = CRI streamed via `CriUdpSystem`
    (UDP 10086 ↔ 9030). Under F2 the executor node plans via Pilz
    and executes via JTC ExecuteTrajectory against the plugin.
  - **Motion arbiter** (JOG-11, addendum-45 §599, NON-NEGOTIABLE):
    dashboard-server refuses jog when a program is running
    (`state ∈ {2, 3}`) and refuses program-run when a jog hold is
    active. Release / stop ALWAYS pass. Doctrine test 12/12 PASS.
- **9012 forensics (add-45 §601, add-45 §603):** LOW confidence
  drive-fault-cascade hypothesis. Undecoded subcode `0x2058`; no
  Estun ProNet A.xx applicability (integrated joints use different
  encoding); no S-Series Gen2 / CN SGS manuals on the Jetson. Owed:
  browser `:9198` log page screenshot + Estun drive manual for
  subcode decode.

## Arm state at session end

`state=2 stateName='Enabled' recoveryState=1 isMoving=0 errors=[]`.

- **`recoveryState=1` STILL SET** — per operator rule, physical
  controller power-cycle is required before any motion test. All
  operator-cued live-fire tests (F1.1 WS-jog acceptance, F1.2
  arbiter live-fire, F2.7 first taught program) wait on this.

## Next session opener (exact order)

1. **Operator physical power-cycle** of the cabinet + physical
   inspection of J1 servo power connector + main feed (add-45 §601).
2. **Post-cycle WS four-tuple gate** — `{state:2 Enabled,
   recoveryState:0, errors:[]}`. Any field off → HOLD.
3. **F1.1 WS-jog acceptance (operator-cued):**
   - Open dashboard (`https://192.168.2.246:8080`) as only client.
   - Arbiter fires green: no program running, jog surface active.
   - J6 short tap (5% × 0.5s). Then one more joint. Then continuous
     hold at low %. Then full-slider soak on 6 joints. Feel-compare
     to factory pendant (should be identical — same generator).
   - Release semantics: stopJog on release, no coast, no ring.
   - Deadman test: kill browser tab mid-hold with e-stop in hand;
     expect arm stops within the driver's 200 ms freshness deadman
     + 700 ms of browser silence budget (add-16 §286 F3 chain).
4. **F1.2 arbiter live-fire (operator-cued):**
   - With a program running, attempt jog → 409 `program_running` +
     toast.
   - With a jog hold active, attempt program-run → 409 `jog_active`
     + toast.
   - Both refusals PASS.
5. **F2.7 first taught program (operator-cued):**
   - Flesh out F2.6 skeleton TODOs (marked in `executor_node.py`):
     `_ws_four_tuple_ok()` real websockets probe; MoveGroupInterface
     Pilz PTP + LIN planning; JTC ExecuteTrajectory action client;
     `/estun/io` ack wait; pause/resume/stop wiring.
   - Wire dashboard `/api/estun/program/run` → executor node (behind
     feature flag so operator can A/B against current codegen-to-Lua).
   - One taught 2-point MoveJ+MoveL + vacuum I/O step. End-to-end
     over CRI on the real arm, operator-cued.
6. **9012 forensics tightening** if the operator's browser :9198 log
   page or the Estun drive manual becomes available:
   - Screenshot the alarm history ordered by log-index (controller
     clock jumped +14 h across the event; wall-clock is unreliable).
   - Decode `0x2058` — undervoltage-class → §601 confidence moves
     LOW → HIGH.

## Open defects / directed-not-confirmed

- **recoveryState=1 wire-recovery insufficiency** (add-42 §580) —
  only physical power-cycle clears the flag. F3 investigate.
- **9012 subcode decoding path** (add-45 §601) — `0x2058` needs the
  S-Series Gen2 hardware/software or CN SGS manual (search terms:
  `0x2058`, `2058`, `伺服错误`, `欠压`). Public ProNet A.xx tables
  don't apply. F3, gated on operator supplying manual.
- **CriUdpSystem silent-write-accept class** — still applies to F2
  program execution. WS-probe authoritative for arm-side state. F3
  hardening (`CriUdpSystem::read` should re-arm `command_synced_`
  on remote disconnect / arm-state transitions).
- **JSB spawner-param root cause** — yaml declares `Joint1..Joint6`
  but runtime publishes `[Joint2, Joint3, Joint1, Joint4, Joint5,
  Joint6]`. Server-side normalization is the workaround. F3.
- **Version-toast false-fire** — vite chunk hash vs `git describe`
  build-ID mismatch. F3 fix: compare like-for-like.
- **`cri-proxy-staleness` thread ImportError** at boot (`.staleness`
  relative import). Non-fatal (thread dies). F3.
- **DHCP reservation** `50:2e:91:95:b6:15 → .246` flaps periodically.
  Wired path `.2.50 → .2.246` (HARDWARE.md Subnet map) sidesteps.
- **V1 GitHub repo still PUBLIC** — long-open credential rotation.
- **Palletize `holepartpalletize` fixture IK failure** (add-46 §605)
  — the fixture uses transit_over_slot Z=273.2 mm which is
  IK-unreachable for the S10-140 URDF. 27 test failures. Not a
  live defect but is a persistent noise floor in `pytest`. F3:
  re-teach the fixture at reachable slots to clean the suite.
- Safety-edge margin retune, recovery-modal lifecycle, palletize
  slot-1 real-arm confirmation — unchanged.

## Paused / intact

- **CRI motion stack: streamed jog fully retired at the launch
  level** (add-45 §597). `use_servo:=false` default. Adapter + RT
  accel clamp stay in-tree for F2 edge cases. `jog_bridge` retired
  code — not consumed by any launch.
- **`roboai-estun`: LIVE.** `active`, `enabled`, `f1_monitor_only.env`
  in the WS-jog configuration (`ESTUN_MONITOR_ONLY=false,
  ESTUN_ALLOW_JOG=1, ALLOW_MOVE=0, ALLOW_CARTESIAN=0`).
- **Dashboard: LIVE.** `active`, `JOG_BACKEND=ws` +
  `CAMERAS_DISABLED=1` via `campaign-f1.conf` drop-in. Motion
  arbiter authoritative at `/cmd/jog`, `/cmd/jog_cartesian`,
  `/api/estun/program/run`.

## Reference tier updates this session

- `docs/LESSONS.md` — L299, L300, L301 appended.
- `docs/ATTEMPTS.md` — add-46 §603, §605, §606, §608 rows appended.

## Hardware/session constants (details in HARDWARE.md)

Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
`:9198` operating UI, `:8080` deploy tool DO NOT USE, fw `2.3.3.43`).
Jetson eno1 `192.168.2.246` (STABLE, laptop wired at `.2.50`); Wi-Fi
lease `.1.143` (unreserved, flaky fallback). Live plugin
`max_step_rad = 0.005` (session-2026-08-25 bump per add-40 §561; verify
at boot via `[CriUdpSystem]: CRI UDP bind …
max_step_rad=0.0050`; disk source is `cri_tcp_setup.yaml`). Repos:

- `Ai-Robotics-Prototype/V1:feature/estun-write-path` — cobot_ws head
  `2a02cb4` (F1.3 slider-truth doctrine test); previous
  session-2026-08-27 SHAs `e02aad3` (dashboard motion arbiter),
  `7faaf63` (addendum-45 ledger), `70ad201` (0x2058 decode-blocked
  ledger).
- `theodoresimpson/CodroidROS2:main` — head `bba8cea` (F2.6 executor
  skeleton + 3 gates + 24 unit tests). Preceding session commits:
  `4671c97` (streamed jog retirement, `use_servo:=false` default),
  `33d1b60` (JOG-10 (a)+(d), (b') gated OFF), `f736f14` (hold_far
  bump + ALLOW_MOCK assertion), `df075c2` (JOG-9 latency ceiling),
  `8944a4c` (JOG-1/2/3), `c66c8f0` (RT-side accel clamp).
