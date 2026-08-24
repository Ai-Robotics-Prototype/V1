# OPERATIONS.md — session procedures
> Always loaded. Every procedure as numbered steps with the EXACT command,
> URL, or wire verb, plus a verification step. Additions to this file are
> first-class in the "update the ledger" ritual — see STANDING.md.
>
> Companion files: `HARDWARE.md` (constants), `FACTS.md` (ambient truths).

---

## 1. CRI launch — real hardware (`use_mock:=false`)

**Preconditions:**
- Controller powered; `nc -zv 192.168.2.136 9001` succeeds.
  [addendum-33 §513, L225]
- No prior CRI launch running (one DDS graph, one controller_manager).
  [addendum-33 §512, L223]
- `roboai-estun` STOPPED (`systemctl is-active` = `inactive`) —
  jog_bridge safety-refuses if `/estun/mode.allow_jog=true`.
  [addendum-37 §536, L252]
- Motion launch lives in `tmux robot:0`. Not a naked terminal.
  [addendum-32 §508, L217]

**Steps:**

1. `tmux new -s robot` (or `tmux attach -t robot` if it exists — do NOT
   create-duplicate). [addendum-33 §518, L224]
2. `source /opt/ros/humble/setup.bash && source ~/cri_eval_ws/CodroidROS2/install/setup.bash`
   (or the cobot_ws overlay as appropriate).
3. `ros2 launch cod_bringup s10_140_cri_ros2_control.launch.py use_mock:=false`

   `cri_tcp_setup_node` sends 5 TCP `:9001` JSON commands in order
   (150 ms inter-command): [addendum-32 §506; session-2026-08-24]
   1. `{"id":1,"ty":"Robot/toAuto","db":""}` — switch to AUTO
   2. `{"id":2,"ty":"Robot/toRemote","db":""}` — enable REMOTE
      (toAuto → toRemote is the mandatory sequence; synchronous latch)
      [addendum-32 §506, L214]
   3. `{"id":3,"ty":"Robot/switchOn","db":""}` — servo enable
      (brakes release if arm was disabled)
   4. `{"id":4,"ty":"CRI/StartDataPush","db":{"ip":"192.168.2.246","port":10086,"duration":4,"highPercision":true}}`
      — begin UDP feedback stream
   5. `{"id":5,"ty":"CRI/StartControl","db":{"filterType":1,"duration":4,"startBuffer":5}}`
      — enable real-time control
4. Wait for the CriUdpSystem plugin's alignment line:
   `首帧 UDP 反馈已对齐关节指令`. Its `command_synced_` flag flips true
   on first UDP RX; before that write() returns silent OK without
   sending. [session-2026-08-24]

**Verification:**

- **Read LAUNCH LOG LINE 3** — the `[launch.user]:` variant announcement.
  Real path prints: `[cri_tcp_setup] ========== 全部 5 步 TCP 初始化成功` +
  `[CriUdpSystem]:  CRI UDP bind :10086 -> 192.168.2.136:9030 ...`.
  Silent-mock path would say `MOCK variant`. [addendum-37 §537, L251]
- `ros2 control list_hardware_components` shows
  `cod_cri_hardware/CriUdpSystem` (NOT `mock_components/GenericSystem`).
  [session-2026-08-24]
- `ss -tnp | grep 192.168.2.136` → outbound TCP session to controller
  present. Mock has none. [addendum-37 §537, L254]
- `ros2 topic hz /joint_states` → 245–247 Hz with real positions.
  [addendum-37 §537]
- Dashboard `/health`: `backend=ros2`, `flips=0/0`, `active_holds=0`;
  `robot.connected/enabled/allow_jog=True/True/True`.
  [addendum-37 §537]

**End state:** JSB active at 250 Hz, JTC action server present, arm in
AUTO + REMOTE + servos on.

---

## 2. CRI teardown

**Preconditions:** any CRI launch has been running (clean or crashed).
The launch does NOT clean up on Ctrl-C — teardown script is mandatory.
[addendum-32 §508, L213; memory `cobot-cri-launch-teardown-gap`]

**Steps:**

1. Ctrl-C the CRI launch in `tmux robot:0`. From another terminal:
   `tmux capture-pane -t robot:0 -p -S -20 | tail -20`  (READ before
   send-keys), then `tmux send-keys -t robot:0 C-c`.
   [addendum-34 §522, L230]
2. `python3 ~/cri_eval_ws/cri_teardown.py`

   Sends reverse sequence to TCP `:9001`:
   `CRI/StopControl` → `CRI/StopDataPush` → `Robot/toManual`
   (150 ms inter-command). Teardown scripts are strictly verb-subsets of
   setup — safe to run in ANY controller state. [addendum-32 §508, L216]
3. `python3 f14_alarm_read.py` (or the WS probe in §5) — controller
   should be in Manual, no active alarms.

**Verification:** all three "OK" in the teardown output. Factory UI
`:9198` shows the arm in Manual mode. [addendum-32 §508]

---

## 3. Enable / servo-on (`Robot/switchOn`)

### 3a. Over the wire (proven session-2026-08-24)

**Preconditions:** alarms cleared (`recoveryState=0` via WS probe).
Physical e-stop released. Arm in AUTO + REMOTE.

**Steps:**

1. Open TCP to `192.168.2.136:9001`.
2. Send: `{"id":<nonce>,"ty":"Robot/switchOn","db":""}\n`
3. Expected reply: `{"id":<nonce>,"ty":"Robot/switchOn","db":null}`
4. Wait ~1.5 s.
5. Re-probe WS `:9000` for `publish/RobotStatus.db.state` (§5).

**Verification:** `state` flips 0 → 2 (Enabled) in <6 s.
[session-2026-08-24]

### 3b. Via factory UI

1. Open `http://192.168.2.136:9198/` (or `http://localhost:9198/` via
   SSH tunnel; see HARDWARE.md § Subnet map).
2. Login `admin/123456`.
3. Use the enable toggle. Physical arm shows green 已使能 / `state:2`.
   [addendum-12 §119]

---

## 4. Clear alarms

**Steps:** Factory UI `:9198` is authoritative. Over-the-wire clear
verb was not established this session — treat as UI-only for now.
Physical sequence [addendum-16 area]:

1. Release the e-stop button.
2. Clear alarm on the UI (or via the Clear-Error affordance in the
   Estun Web panel).
3. Re-enable via §3.

**Note:** a limit/condition alarm will NOT clear while its cause
persists (out-of-limit J5/J6 past ±200° blocks jog AND drag — jog
offending joint back into range first, or use rescue mode).
[addendum-13 §126, L80]

---

## 5. WS status probe — read-only alarm/mode/state

**Preconditions:** WS `:9000` reachable (either directly on `.2.x` or
via SSH `-L 9000:192.168.2.136:9000` tunnel).

**Steps:**

1. Open `ws://192.168.2.136:9000`. Origin optional; browser-shaped
   handshake works. No login token required for broadcasts.
   [addendum-12 §116]
2. Send (compact JSON, no spaces, `encoding="utf-8"` — server is
   whitespace-sensitive and frames contain Chinese text; Windows
   cp1252 crashes on 关节/超限): [addendum-12 §116, L69]
   ```
   {"ty":"IOManager/GetIOInfo","id":<nonce>}
   {"ty":"publish/RobotStatus"}
   {"ty":"publish/Error"}
   ```
   Answer any `"ping"` string frames with `"pong"`. [addendum-12 §116]
3. Recv for ~5 s. `publish/RobotStatus` snapshots the state;
   `publish/Error` frames' last non-empty entry is the active alarm
   list.

**publish/RobotStatus.db fields:** [addendum-12 §116; session-2026-08-24]
- `state`: 0=Disabled, 1=Enabling, 2=Enabled, 3=Enabled sub-state
- `stateName`: string
- `mode`: 0=AUTO, 1=MANUAL, 2=REMOTE (session-observed; driver docs
  previously enumerated only 0/1)
- `isMoving`, `moveRate`, `manualMoveRate`, `recoveryState`,
  `isSimulation`, `teachingPendant`, `rescueFlag`, `modeSwitch`
- `ToolId`, `PayloadId`, `CoordinateId`
- `type` (e.g. `"S10-140-ECO-V2"`), `runDuration`, `totalTime`

**publish/Error.db:** list of `[severity:int, code:int, ts:float, text:str]`.
Empty list = no active alarms. Alarm codes: see HARDWARE.md.

---

## 6. Deploy tool warning

- Controller `:8080` is **`部署系统`** (deploy tool, element-ui,
  `api/update/upload`, `api/update/unzip`, `updatesys.pw`).
- **DO NOT USE for operating actions.** Operating panel is `:9198`.
- The Jetson dashboard is on `:8080` too but on the Jetson's IP, not
  the controller's — do not conflate. [session-2026-08-24]

---

## 7. Backend flip (WS ↔ ros2)

### 7a. Flip to `JOG_BACKEND=ros2`

1. `sudo systemctl stop roboai-estun` — verify `systemctl is-active`
   returns `inactive` (doctrine "STOPPED not disabled" is intent;
   observation is truth). [addendum-37 §536, L252]
2. Install drop-in
   `/etc/systemd/system/roboai-dashboard.service.d/campaign-f1.conf`
   with `[Service]\nEnvironment=JOG_BACKEND=ros2\nEnvironment=CAMERAS_DISABLED=1`.
   [addendum-37 §535]
3. `sudo systemctl daemon-reload`.
4. Safe-gated restart (STANDING.md rule 4): confirm `active_holds=0`
   and `program.state != 2` before `sudo systemctl restart
   roboai-dashboard`.
5. Verify: `tr '\0' '\n' < /proc/$(pgrep -f dashboard_server)/environ |
   grep JOG_BACKEND` shows `ros2`; `/health.cri_proxy.backend=ros2`.

### 7b. Flip to `JOG_BACKEND=ws` (fallback)

1. `sudo systemctl start roboai-estun` — verify `is-active` = `active`.
2. Remove/override the `JOG_BACKEND=ros2` drop-in.
3. `sudo systemctl daemon-reload && sudo systemctl restart
   roboai-dashboard` (safe-gated).
4. Verify: `/health` reports `backend=ws`; banner reads WS mode.

---

## 8. jog_bridge — L216/L217/L239 discipline

**Own-shell rule (L217, memory `cobot-jog-bridge-own-shell`):** jog_bridge
runs in its own tmux window (`robot:jog_bridge` or `robot:1`), NEVER in
the same pane as the CRI launch. Same-pane Ctrl-C kills the entire
launch. [addendum-37 §536, L256]

**Restart discipline (L239):** mode-switched daemons require three-part
verification. [addendum-35 §524, L239]

1. `pkill -f jog_bridge_node` — kill ALL instances.
2. `pgrep -af jog_bridge_node` — confirm zero.
3. In `robot:jog_bridge`:
   ```
   source /home/teddy/cri_eval_ws/CodroidROS2/install/setup.bash && \
     JOG_BACKEND=ros2 ros2 run jog_bridge jog_bridge_node
   ```
4. Wait 10 s past the banner to survive the 5 s SAFETY window
   (`/estun/mode.allow_jog=true` under `JOG_BACKEND=ros2` trips a FATAL).
5. **Three-part verify:**
   - Startup banner announces `JOG_BACKEND = 'ros2'` + `this node is
     authoritative for jog`.
   - `tr '\0' '\n' < /proc/<pid>/environ | grep JOG_BACKEND` returns
     `ros2`.
   - `ros2 topic info /dashboard/jog_session_events -v` shows exactly
     ONE subscriber (`jog_bridge`, not a leftover `_ros2cli_*` tap).

**Safety-guard trip fingerprint:** `[FATAL] SAFETY: /estun/mode reports
allow_jog=true while JOG_BACKEND=ros2 ... jog_bridge going passive`.
Root cause is estun_driver publishing allow_jog=true — see §7a step 1.

---

## 9. Dashboard restart / HTTPS gotcha

**URLs:**
- Jetson eno1 (cell side): `https://192.168.2.246:8080`
- Jetson Wi-Fi (house side): `https://192.168.1.246:8080` (or `.143`
  when DHCP is unreserved)
- **HTTPS ONLY on `:8080`.** HTTP gives ERR_EMPTY_RESPONSE; a single
  TCP socket speaks either TLS or plain, not both.
  [addendum-03 §16; addendum-13 §127]
- Self-signed cert at `/opt/cobot/certs/dashboard_cert.pem`; accept
  once per device. Fully Kiosk: enable "Ignore SSL Errors".
  [session-2026-08-24; addendum-03 §16]

**Restart:**
1. Safe-gated (STANDING.md rule 4): confirm no active hold / motion.
2. `sudo systemctl restart roboai-dashboard`.
3. Wait 3–5 s.
4. Verify: `curl -sk https://localhost:8080/health` returns 200 JSON
   with expected `backend`, `cameras_disabled`.

**websockets library pin gotcha:** systemd unit pins the working
version. Manual run with a newer env may hit `websockets 15.x` renamed
`ssl_context` → `ssl` kwarg — TLS handshakes muff silently and dashboard
"hangs". [addendum-35 §524, L237]

---

## 10. Frontend build + serve

**Serving model (post-session-2026-08-24):**
- `_STATIC_DIR = frontend/dist` (was `mock_server/static`).
- vite `outDir: 'dist'` (was `'../mock_server/static'`).
- Single source of truth — no rsync ritual.
- Cache-control on `/`: `no-cache, no-store, must-revalidate`.
  Chunks cache-forever. [session-2026-08-24]

**Steps:** [addendum-36 §528; addendum-37 §535]

1. `cd src/cobot_dashboard/frontend && npm run build`.
2. Bundle emits to `dist/assets/index-<hash>.js` +
   `index-<hash>.css` + `index.html` (with git-describe version string
   baked into the JS via `__BUILD_ID__`).
3. Verify chunk hash changed:
   `curl -sk https://localhost:8080/ | grep -oE 'index-[A-Za-z0-9_-]+\.js'`
4. Any browser tab on the pre-rebuild bundle fires "New app version
   available".

**Rule (L246):** bundle-date audit belongs in EVERY frontend diagnosis
— the browser might be running Aug 6 while you audit Aug 20 source.
[addendum-36 §528]

---

## 11. Injection via `f14_inject.py`

**Location:** `~/cri_eval_ws/f1_2_scenarios/f14_inject.py`
[session-2026-08-24]

**Safety:** operator has e-stop in hand and arm in view before any
injection. Speed capped at `vel_cap_frac=0.15` in the state machine.
Session-scope only — no motion commit lands in the ledger without an
addendum. [session-2026-08-24]

**Event schema (matches dashboard → jog_bridge wire):**
```
{"kind":"start"|"refresh"|"stop","hold_id":"<str>","seq":<int>,
 "server_ts":<float>,"joint":<1..6>,"direction":+1|-1,
 "speed_pct":<0..100>,"mode":"joint"}
```

**Usage:**

```
python3 f14_inject.py --joint 6 --direction 1 --speed_pct 15 \
                     --duration_s 2 --refresh_ms 100 --health --js-delta
```

Publishes on `/dashboard/jog_session_events` with `RELIABLE + VOLATILE`
QoS to match the bridge's subscription.

**Deadman variants:**
- Deadman A: add `--no-stop` — skip terminal stop event; bridge should
  cancel on its own via silence deadman (`silence_ms=300`).
- Deadman B: normal injection; while running, `kill -9 <bridge-pid>`
  from another shell.

---

## 12. Session ritual (three writes + reference-tier update)

Per STANDING.md ledger doctrine + this-file's own preamble:

1. New `docs/ledger/addendum-NN-<slug>.md`. Tail-grep for the next N;
   post-v46 lessons are a single continuous stream (244+).
2. `docs/LESSONS.md` append (one line per lesson).
3. `docs/STATE.md` rewrite (current truth).
4. **Reference-tier update:** if the session established a new
   hardware/procedure/ambient fact, patch it into HARDWARE.md,
   OPERATIONS.md, or FACTS.md IN THE SAME COMMIT. Reference facts are
   first-class, captured immediately, never left as narrative.
   [session-2026-08-24 doctrine addition]
5. Commit + push. STANDING.md rule 1: a commit IS a deploy; no session
   reports "fixed" without a sha.

---

## 13. Ledger self-lint

**Tools:** [addendum-37 §534]

- `tools/ledger_lint.py` — four duties:
  - **CONTIGUITY** — v46 `source_lines` covers 1..13488, no gaps or
    overlaps.
  - **REDACTIONS** — no raw `ghp_*` PATs.
  - **INDEX-RESOLVE** — INDEX.md slugs resolve to real files.
  - **LESSONS-GAPS** — LESSONS.md has `**Gaps**` block + `Extraction
    methodology` note.
- `tools/build_full_ledger.sh` — concatenates `docs/ledger/*.md` in
  canonical order (era-01 first, then addendum-NN with `-a/-b`) →
  `build/full_ledger.md` (gitignored, ~1.22 MB / 14,512 lines / 38
  files).

**Run:** `python3 tools/ledger_lint.py`. All four duties must PASS
before commit.

---

## 14. tmux discipline

- **Claude Code runs in tmux:** `tmux new -s claude` — survives SSH
  drops. [L250; STANDING.md tool doctrine]
- **Motion launches in tmux:** `tmux new -s robot`. Window `:0` is the
  CRI launch's exclusive home; jog_bridge in its own window
  (`:jog_bridge` or `:1`). [addendum-32 §508, L217]
- **Duplicate session** = attach, not create. [addendum-33 §518, L224]
- **Remote Ctrl-C:** `tmux capture-pane -t <target> -p -S -20 | tail`
  FIRST (read what's running), then `tmux send-keys -t <target> C-c`.
  [addendum-34 §522, L230]
