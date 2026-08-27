# STATE.md — current truth as of 2026-08-27 (F1 CLOSED — WS-jog PROVEN, twin phantom-feedback class ENDED, F2 STARTED on bba8cea)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are

- **F1 CLOSED** (addendum-47 §613). Streamed jog retired (add-45 §597),
  WS-jog reinstated (add-45 §598), motion arbiter shipped with doctrine
  test 12/12 (add-45 §599), add-16 §286 three flicker fixes verified
  still present (add-45 §600), slider truth pinned as doctrine 5-case
  (add-46 §603), **real-arm sweep PASS** (add-47 §609), **tab-kill
  deadman PASS** (add-47 §610), **arbiter direction 1 PASS** (add-47
  §611), **twin phantom-feedback class ENDED** (add-47 §612).
  - Wire evidence for F1.1 sweep: 24 hold sessions, release→last-frame
    4–56 ms, no rejected frames, pendant-grade feel per operator.
  - Tab-kill: WS-disconnect handler beats freshness deadman by
    ~150 ms; end-to-end operator-refresh → wire `Robot/stopJog`
    measured at ~50 ms; driver logs `cause=release_cmd` (fast path)
    not `cause=freshness_deadman` (backstop).
  - Arbiter direction 1 (run-during-hold → 409): HTTP 409 in 10.5 ms
    against real `_active_holds` state; wire evidence perfect,
    hold_id matches wire_mon capture.
- **F1.2 arbiter direction 2 (jog-during-running-program → 409)**
  folded into F2.7 by operator directive (add-47 §611). Doctrine
  pytest already pins the logic; F2.7's real run against a genuinely
  propagating `STATE.robot.program.state ∈ {2, 3}` closes the state-
  propagation path in one operator session.
- **Twin phantom-feedback class ENDED** (add-47 §612, SHA `09f3158`).
  Third incident closed the class: dashboard `_on_joint_states`
  case-mismatched CRI-JSB `Joint1..Joint6` vs roboai-estun's
  `joint_1..joint_6`, wrote all-zeros to `STATE.joints.positions`
  every frame under WS mode. Structural fix: bind feedback
  consumption to `JOG_BACKEND` (one authoritative source per mode,
  other IGNORED-and-counted) + all-zeros quarantine safety net.
  Doctrine test 13/13. Full dashboard suite green: **30/30**
  (12 arbiter + 5 wire-truth + 13 phantom-feedback).
- **F2 STARTED** on `bba8cea` baseline. `s10_140_executor` package
  in CodroidROS2 with three pure-logic gate modules (validators,
  settle, silent-refusal) + node skeleton, 24 unit tests all PASS
  (add-46 §606). Palletize defects DIAGNOSED closed at code (add-46
  §605).
- **F1.5 cartesian jog** — recon complete off-arm (add-47 §614), code
  ~90% built already. Real work post-F1-CLOSE: operator F12
  confirmation of axis mapping + `ESTUN_ALLOW_CARTESIAN=1` flip +
  manualCartOverSpeed cap verification + real-arm acceptance test.
- **9012 forensics** (add-45 §601): LOW-confidence drive-fault-
  cascade hypothesis; undecoded `0x2058` — no S-Series Gen2 / CN SGS
  manual on Jetson (add-45 §603). Owed: browser `:9198` log page
  + drive-manual decode.

## Arm state at session end

`state=2 stateName='Enabled' recoveryState=1 isMoving=0 errors=[]`.

- `recoveryState=1` PERSISTS but motion works per the finding logged
  earlier this session (memory
  `cobot-recoverystate-not-motion-gate-ws`) — the WS four-tuple
  check under WS-jog simplifies to `{state:2 Enabled, errors:[]}`.
- Post-F1 pose (operator's last jog): J1 −3.18°, J2 +51.24° (from
  the earlier sweep; may have drifted after F1.2 direction 1 hold).
- `roboai-estun`: LIVE. `active`, `enabled`, `f1_monitor_only.env`
  restored to WS-jog canonical (`ALLOW_JOG=1, ALLOW_MOVE=0,
  ALLOW_CARTESIAN=0`) after the F1.2 test window.
- Dashboard: LIVE. `active`, `JOG_BACKEND=ws` + `CAMERAS_DISABLED=1`.
  Motion arbiter + twin phantom-feedback fix both live.

## Next session opener (exact order)

1. **F2.7 first taught program end-to-end** (operator-cued, real arm):
   - Flesh out F2.6 skeleton TODO surface (marked in
     `executor_node.py`): `_ws_four_tuple_ok()` real websockets probe;
     MoveGroupInterface Pilz PTP + LIN plans; JTC ExecuteTrajectory
     action client with response-callback + cancel deadman (Humble
     quirk memory `cobot-jtc-humble-cancel-terminal-quirk`);
     `/estun/io` ack wait; pause/resume/stop wiring.
   - Route dashboard `/api/estun/program/run` → executor node (behind
     a feature flag for A/B against the current codegen-to-Lua path).
   - One taught 2-point MoveJ + MoveL + vacuum I/O step, end-to-end
     over CRI on the real arm, operator-cued.
   - **Fold F1.2 direction 2**: during the real run, operator presses
     a jog button; expected 409 `program_running` against a genuinely
     propagating `STATE.robot.program.state`. Wire evidence closes
     arbiter direction 2 in the same session (add-47 §611).
2. **F1.5 cartesian jog acceptance** (small, post-F2.7 OK):
   - Step 1: operator F12 on `:9198` cartesian jog. Confirm axis-
     letter → 1..6 mapping matches dashboard `axis_map`; capture
     tool-frame `coorType/coorId` if any variant exists.
   - Step 2: flip `ESTUN_ALLOW_CARTESIAN=1` in drop-in.
   - Step 3: verify `manualCartOverSpeed 250 mm/s` cap
     interpretation.
   - Step 4: feel-parity + release per axis + tab-kill on cartesian
     hold.
3. **9012 forensics tightening** if browser `:9198` log page +
   `0x2058` subcode become available (add-45 §601 open action).

## Open defects / directed-not-confirmed

- **recoveryState=1 wire-recovery insufficiency** (add-42 §580).
  Under WS-jog motion still works (superseding finding); the flag
  is informational. F3 investigate.
- **9012 subcode decoding path** (add-45 §601). `0x2058` needs the
  S-Series Gen2 / CN SGS manual (search terms: `0x2058`, `2058`,
  `伺服错误`, `欠压`). Public ProNet A.xx tables don't apply. F3,
  gated on operator supplying manual.
- **CriUdpSystem silent-write-accept class** — still applies to F2
  program execution. WS-probe authoritative for arm-side state. F3.
- **JSB spawner-param root cause** — CodroidROS2 JSB publishes
  `[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]` instead of
  canonical order. F3. (Unrelated to twin phantom-feedback fix,
  which handled a DIFFERENT naming convention mismatch —
  lowercase vs capitalized.)
- **Version-toast false-fire** — vite chunk hash vs `git describe`
  build-ID mismatch. F3.
- **`cri-proxy-staleness` thread ImportError** at boot (`.staleness`
  relative import). Non-fatal (thread dies). F3.
- **DHCP reservation** `50:2e:91:95:b6:15 → .246` flaps periodically.
  Wired path `.2.50 → .2.246` sidesteps.
- **V1 GitHub repo still PUBLIC** — long-open credential rotation.
- **Palletize `holepartpalletize` fixture IK failure** (add-46 §605).
  27 test failures. Not a live defect — atomicity working; the
  fixture uses IK-unreachable slots. F3 clean-fixture task.
- Safety-edge margin retune, recovery-modal lifecycle, palletize
  real-arm confirmation — unchanged.

## Paused / intact

- **CRI motion stack: streamed jog fully retired at the launch
  level** (add-45 §597). `use_servo:=false` default. Adapter + RT
  accel clamp stay in-tree for F2 edge cases.
- **`roboai-estun`: LIVE** in WS-jog config. Drop-in has an
  operational note about the 32-minute F1.2 arbiter test window
  when `ALLOW_MOVE=1` was in effect (2026-08-27 15:23–15:55);
  restored to 0 after.
- **Dashboard: LIVE.** `JOG_BACKEND=ws`, `CAMERAS_DISABLED=1`.
  Motion arbiter + twin phantom-feedback fix both live.

## Reference tier updates this session

- `docs/LESSONS.md` — L302 (tab-kill deadman WS-disconnect path),
  L303 (arbiter live-fire direction discipline), L304 (twin
  phantom-feedback class ended) appended.
- `docs/ATTEMPTS.md` — add-47 §609, §610, §611, §612, §613, §614
  rows appended.

## Hardware/session constants (details in HARDWARE.md)

Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
`:9198` operating UI, `:8080` deploy tool DO NOT USE, fw `2.3.3.43`).
Jetson eno1 `192.168.2.246` (STABLE); Wi-Fi lease `.1.143` (unreserved
fallback). Repos:

- `Ai-Robotics-Prototype/V1:feature/estun-write-path` — cobot_ws head
  will be at the F1-CLOSED ledger commit after this ritual. Previous
  session-2026-08-27 SHAs: `09f3158` (twin phantom-feedback fix +
  13-case doctrine), `c6696b8` (STATE: F1.1 informal + recoveryState),
  `70ad201` (0x2058 decode-blocked), `783bcea` (addendum-46: F1 CLOSED
  code + F2 STARTED), `2a02cb4` (F1.3 slider-truth), `e02aad3`
  (motion arbiter + doctrine), `7faaf63` (addendum-45: architecture
  flip).
- `theodoresimpson/CodroidROS2:main` — head `bba8cea` (F2.6 executor
  skeleton + gates + 24-case tests). Previous: `4671c97` (streamed
  jog retirement at launch level).
