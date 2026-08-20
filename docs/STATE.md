# STATE.md — current truth as of 2026-08-20 (end of Addendum 37)
> If this file contradicts a memory or an addendum, THIS FILE wins for current
> state; the ledger wins for history. Rewritten at every session end.

## Where we are
- **F1.4 pre-rung setup: COMPLETE.** Dashboard on `backend=ros2` +
  `cameras_disabled=True` (drop-in `campaign-f1.conf`); frontend rebuilt
  (`index-CPjpRuaL.js`, sha `66f2fab8…`); jog_bridge running in
  `tmux robot:jog_bridge`, authoritative, null-tolerant (int(x or 0) fix
  shipped); CRI motion stack up **on real hardware** (`use_mock:=false`),
  `/joint_states` at 245–247 Hz, JTC action server present, dashboard
  `robot.connected/enabled/allow_jog=True/True/True`,
  `cri_proxy.flips=0/0`.
- **F1.4 rungs 3–6 PENDING operator cue.** Rungs are: J6+ 3s, J6- 3s,
  deadman A (client keepalive death), deadman B (SIGKILL jog_bridge
  mid-hold), 60 s soak. Rung 1–2 already PASSED on real arm (addendum-35).
- **Ledger tier is now linted.** `tools/ledger_lint.py` all-PASS
  (CONTIGUITY / REDACTIONS / INDEX-RESOLVE / LESSONS-GAPS). ATTEMPTS.md
  populated; build_full_ledger.sh writes `build/full_ledger.md` (38 files,
  1.22 MB). LESSONS.md documents the heading-vs-list extraction miss
  (65 real lessons in the 146–243 "gap" range that extraction never
  pulled; backfill deferred).

## Next session opener (exact order)
1. **F5 the dashboard tab.** Loads the new bundle AND re-opens the WS to
   the restarted dashboard. Without F5 the tab is on the pre-rebuild
   bundle + a dead WS.
2. **Cue Rung 3: J6+ 3 s hold.** E-stop in operator's hand; I read
   `/health` immediately after — `cri_proxy.flips_down/up` must stay 0,
   `hold_keepalive.expired` must stay 0. Continuous motion the whole hold.
3. **Cue Rung 4: J6- 3 s hold.** Mirror; same acceptance.
4. **Cue Deadman A: client keepalive death mid-hold** (close browser tab
   or kill Wi-Fi ~1.5 s into a hold). Arm stops within ~500 ms; keepalive
   `expired` increments; no flip.
5. **Cue Deadman B: SIGKILL jog_bridge mid-hold.** I show pid, operator
   says go, I `kill -9`. Arm coasts to stop within tens of ms of the
   last JTC goal end; no runaway.
6. **60 s soak.** One continuous J6+ hold; I sample /health at
   t≈15/30/45/60 s. Flip counters 0 throughout, `expired=0`,
   `max_tick_gap_ms < 300`.
7. **F1 CLOSED** when all four pass. Then F2 (executor over MoveIt) starts.

## Open defects / directed-not-confirmed
- Safety-edge margin retune (measured-latency term, 5° cap, numbers-in-toast)
  — directed since addendum-36 §529, completion unconfirmed.
- Recovery-modal lifecycle (hold-persistent, Done-gated) — directed;
  needs the frontend rebuild in a client's tab to be real (see opener 1).
- Palletizing: slot-1 stuck (2c2e435 regression suspect) + double-descend
  at pick — diagnose-first directive issued in add-36 §531; pending
  operator running the artifact and verdict.
- LESSONS heading-vs-list extraction miss — ~65 real lessons in the
  146–243 gap range are v46's `N. **Title.**` list-format items and are
  NOT yet in LESSONS.md (documented; backfill deferred).
- V1 GitHub repo was PUBLIC (addendum-36 flag) — still open; still
  unbounded credential-rotation debt.

## Paused / intact
- **WS/Lua stack (roboai-estun, roboai-executor): STOPPED** (this
  session actually made it inactive, not just "stated" — see add-37 §536).
  Fallback path for F1 backend flip-back; `sudo systemctl start
  roboai-estun` to return to `backend=ws`.
- **CRI motion stack: LIVE in `tmux robot:0`** running with
  `use_mock:=false`. Do NOT re-launch without a `cri_teardown.py` first.
- **jog_bridge: LIVE in `tmux robot:jog_bridge`** (own-shell rule per
  L217; do not restart from the same pane as the CRI launch).
- **Cartesian jog over ROS2: out of F1 scope** by design (F2+).
- Production dashboard service: now running with new drop-in;
  post-F1-close, the drop-in either lands in the canonical unit
  (F3 formalization) or gets removed.

## Roadmap after F1
- **F2**: executor over MoveIt (MoveJ→Pilz PTP, MoveL→Pilz LIN,
  validate-before-submit, settle-before-next; WS keeps I/O). Programs
  run over ROS2. Pallet-defect fixes land as F2 prerequisites.
- **F3**: everything under systemd (kills: env divergence, zombie
  processes, boot races, stale bundles, manual bring-up). Formalize
  the campaign-f1.conf drop-in into the canonical unit. Also:
  move_group pinned to JSB stream; JTC goal_tolerance tighten; camera
  encode → turbojpeg/off-process; dashboard Enable via CRI switchOn;
  deploy-watcher env fix.
- **F4**: white bowl end-to-end over CRI = DONE.

## Standing debts (unchanged, aging)
- Router DHCP reservation `50:2e:91:95:b6:15` → `.246` (FOURTH bite).
- `/opt/cobot/logs` retention cap (regrew to 2 GB twice).
- **V1 GitHub repo — make private + rotate `aicollabs12`-era credentials;
  check audit log for exposure window.** Long-open, addendum-36 final
  argument.
- RunPod account unopened; `/opt/cobot` backup (superseded by fleet-sync
  design, unbuilt); Synapse trademark counsel; UI rebrand screenshots
  in deck.

## Hardware/session constants (details in HARDWARE.md)
Controller `192.168.2.136` (`:9000` WS, `:9001` CRI TCP, UDP `9030`/`10086`,
fw `2.3.3.43` exact). Jetson eno1 `192.168.2.246`; Wi-Fi lease last seen
`.143` (unreserved). `max_step_rad 0.002` session override. Repos:
`Ai-Robotics-Prototype/V1` (`da4caa4+`), `theodoresimpson/CodroidROS2`
(`f6e4f98+` — jog_bridge null-tolerance patch not yet committed here).
