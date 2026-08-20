# STATE.md — current truth as of 2026-08-19 (end of Addendum 36)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are
- **Phase F1 (jog over ROS2): rungs 1-2 PASSED on real arm** (12/12 taps, 4.4 ms
  press→goal, 61 ms mean stop). **Rungs 3-6 pending** on the hold-defect fix
  verification.
- **Hold defect: ROOT-CAUSED off-target** (addendum-36 §528). Watchdog flap
  (1.0s tripwire + always-true estun_stale + PIL GIL stalls) closing the frontend
  jogGateOk; compounded by the served bundle being an Aug 6 build predating the
  seam. Fix SHIPPED to V1 (3.0s threshold + hysteresis + flip counters on /health
  + CAMERAS_DISABLED=1 env). Confirmation instrument: flip counter during a hold.
- **Ledger restructure: split VERIFIED, distillates in flight.** v46 split into
  docs/ledger/ (addenda 1-35 present incl. the 32-35 zip). L90 recovered on second
  pass; L1-5 duplicated era/addendum-01 — index notes canonical. LESSONS.md build
  was in progress when sessions died; resume via tmux + --continue.

## Next session opener (exact order)
1. `npm run build` in the dashboard frontend (served bundle is Aug 6 — REQUIRED
   before any frontend behavior is trusted).
2. Finish ledger distillates if incomplete (LESSONS/STANDING/STATE/HARDWARE/INDEX
   + CLAUDE.md), commit, push.
3. Bring-up with CAMERAS_DISABLED=1 (tmux; Claude Code itself in tmux "claude").
4. One 3s hold: arm must move continuously; /health cri_proxy_flips must stay 0.
5. Rungs 3-6 (holds, deadman A/B, 60s soak) → F1 CLOSED.

## Open defects / directed-not-confirmed
- Safety-edge margin retune (measured-latency term, 5° cap, numbers-in-toast) —
  directed, completion unconfirmed.
- Recovery-modal lifecycle (hold-persistent, Done-gated) — directed; needs the
  frontend rebuild to be real.
- Palletizing: slot-1 stuck (2c2e435 regression suspect) + double-descend at pick
  — diagnose-first directive issued.
- Deploy-watcher [jog_hold_heartbeat] FAILED banner = watcher env divergence, not
  code (regression passes 5/5 against source) — F3 scope.

## Paused / intact
- WS/Lua stack (roboai-estun, roboai-executor): STOPPED not disabled — fallback.
- Cartesian jog over ROS2: out of F1 scope by design (F2+).
- Production dashboard service: runs OLD env (websockets pin) — carries none of
  this week's fixes until F3 formalizes them into the unit.

## Roadmap after F1
- **F2**: executor over MoveIt (MoveJ→Pilz PTP, MoveL→Pilz LIN, validate-before-
  submit, settle-before-next; WS keeps I/O). Programs run over ROS2.
- **F3**: everything under systemd (kills: env divergence, zombie processes, boot
  races, stale bundles, manual bring-up). Also: move_group pinned to JSB stream;
  JTC goal_tolerance tighten; camera encode → turbojpeg/off-process; dashboard
  Enable via CRI switchOn; deploy-watcher env fix.
- **F4**: white bowl end-to-end over CRI = DONE.

## Standing debts (unchanged, aging)
- Router DHCP reservation 50:2e:91:95:b6:15 → .246 (THIRD bite this week).
- /opt/cobot/logs retention cap (regrew to 2 GB twice).
- **V1 GitHub repo was PUBLIC — make private + rotate exposed credentials
  (aicollabs12 era, burned PATs); check audit log for exposure window.**
- RunPod account unopened; /opt/cobot backup (superseded by fleet-sync design,
  unbuilt); Synapse trademark counsel; UI rebrand screenshots in deck.

## Hardware/session constants (details in HARDWARE.md)
Controller 192.168.2.136 (:9000 WS, :9001 CRI TCP, UDP 9030/10086, fw 2.3.3.43
exact). Jetson eno1 192.168.2.246; Wi-Fi lease last seen .143 (unreserved).
max_step_rad 0.002 session override. Repos: Ai-Robotics-Prototype/V1 (e59baf1+),
theodoresimpson/CodroidROS2 (bd51632+).
