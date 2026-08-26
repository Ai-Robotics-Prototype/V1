# FACTS.md — ambient truths
> Always loaded. Facts that aren't lessons or decisions — they're just
> HOW THE SETUP IS. Every entry cites its source. Additions to this file
> are first-class in the "update the ledger" ritual — see STANDING.md.
>
> Companion files: `HARDWARE.md` (constants), `OPERATIONS.md` (procedures).

## UIs and surfaces

- **NO physical teach pendant.** The operator reaches the controller via
  the browser factory UI on `:9198`. Anywhere the project says "pendant",
  it means the browser UI. [session-2026-08-24]
- **UIs to keep straight (all three live on `:8080` or similar — this
  matters):** [session-2026-08-24]
  - `http://192.168.2.136:9198/` = **operating UI** (`Estun Web`;
    alarms, clear-error, mode switch).
  - `http://192.168.2.136:8080/` = **`部署系统` deploy tool**. DO NOT USE
    for operations.
  - `https://192.168.{2.246,1.246}:8080/` = **our dashboard**
    (roboai-dashboard, HTTPS on the JETSON). Port collision on `:8080`
    with the controller's deploy tool — do not conflate.

## What "enabled" means per surface

- **Dashboard ArmEnableControl chip** under `JOG_BACKEND=ros2` = LIVENESS.
  Reads `/joint_states` liveness via cri_proxy. `enabled=True` means the
  ROS feed is alive; it does NOT mean physical servos are on.
  [session-2026-08-24; dashboard_server.py `_apply_cri_proxy_authority`]
- **WS `publish/RobotStatus.state=2`** on `:9000` = PHYSICALLY ENABLED
  (servos on, brakes released). This is authoritative for the arm's
  motion readiness. [addendum-12 §116; session-2026-08-24]
- **`JOG_BACKEND=ros2` cri_proxy semantics:** `_apply_cri_proxy_authority(r)`
  unconditionally writes `allow_jog=True, monitor_only=False, mode="AUTO",
  enabled=True, connected=True` on every `/joint_states` +
  `/estun/status` + `/estun/mode` tick. Called from all three handlers,
  so last-writer-wins races cannot flip authority. Under `JOG_BACKEND=ws`
  the helper is a no-op. [session-2026-08-24]

## Silent classes (things that report success but produce nothing)

- **Silent-mock class (L251).** `use_mock:=true` (launch default)
  synthesizes an entire arm — `/joint_states` at 250 Hz with real zero
  values, ros2_control accepts commands, JTC says "Goal reached,
  success!" — indistinguishable from real. **Only tell is log line 3**
  (`[launch.user]:` variant announcement). Rule: check
  `ros2 control list_hardware_components` for
  `cod_cri_hardware/CriUdpSystem` vs `mock_components/GenericSystem`;
  also `ss -tnp | grep 192.168.2.136`. [addendum-37 §537, L251]
- **Silent-write-accept class (CRI UDP).** CRI UDP is fire-and-forget,
  no NAK. Pre-sync writes return SUCCESS from `write()` without sending
  UDP (`if (!rx_ok_ || !command_synced_) return OK;`). `rx_ok_` and
  `command_synced_` are set once on first UDP RX via
  `sync_commands_to_feedback()` and are NOT reset by arm alarms — only
  reset on plugin init. If the motion controller is disabled or
  alarmed, JTC "Goal reached" reports success but no motion occurs. F3
  hardening item. [session-2026-08-24]
- **Silent-refusal signature (upstream of CRI UDP, L272).** Extends the
  above through the ROS2 motion stack. Against a Disabled arm
  (`RobotStatus.state=0`), three separate command paths all reported
  success in-session while the arm sat still: `jog_servo_adapter`'s
  250 Hz position stream to `/joint_group_position_controller/commands`,
  a direct-write step-publisher to the same topic, and a
  `FollowJointTrajectory` action call to JTC (returned
  `error_string='Goal successfully reached!'`). None of the layers has
  a back-channel for arm-side servo state. **The only wire-truth is
  `ws://192.168.2.136:9000` `publish/RobotStatus` + `publish/Error`.**
  Before *any* real-arm jog or planned-motion test, WS-probe
  `{state, stateName, recoveryState, errors[]}`; treat ROS2-side
  "success" as evidence of the communication path only.
  [addendum-40 §564, L272]
- **`stateName` can lie; `state` wins.** In-session observation
  2026-08-25: `publish/RobotStatus.db.stateName='Enabled'` while
  `db.state=0` — the numeric `state` field is authoritative;
  `stateName` is a stringified display value that can lag or hold a
  stale value across error transitions. Never gate on `stateName` alone.
  [addendum-40 §564]
- **Action SUCCESS ≠ arrival.** JTC declares "Goal reached, success" at
  default `goal_tolerance = 0.01 rad ≈ 0.573°` while servos keep
  converging. Poll-for-settle (per-joint drift ≤ 2 LSB over 500 ms
  window, 15 s timeout) is required before next action, especially I/O.
  [addendum-33 §515, L220; memory `cobot-jog-bridge-stuck-canceling`]
- **JTC Humble cancel-terminal quirk.** ros2 humble JTC returns
  `return_code=0` (not `ERROR_GOAL_TERMINATED=3`) when cancelling
  already-terminal goals AND the result-callback silently doesn't fire.
  Naive `return_code != 0` shortcuts miss this — use
  `goal_handle.status` + outer deadman. [addendum-34 §522, L229;
  memory `cobot-jtc-humble-cancel-terminal-quirk`]
- **DDS lazy-publisher hazard.** Create ROS2 publishers eagerly in
  `__init__` — lazy first-call publish loses to RELIABLE+VOLATILE
  discovery race. [memory `cobot-dds-lazy-publisher-hazard`]
- **Stopped-vs-active gap.** STATE.md doctrine can say "STOPPED not
  disabled" while `systemctl is-active` says `active`. Doctrine
  describes intent; observation is truth. Every backend flip requires
  `is-active` verification. [addendum-37 §536, L252]

## Wire protocol quirks

- **`publish/<Topic>` on WS `:9000` means SUBSCRIBE, NOT publish.** The
  client asks to receive a topic by "publishing" its interest. Zero
  frames until the subscribe burst is sent. [addendum-12 §116, L65]
- **RobotPosture broadcasts only when `state:2`.** Disabled arm only
  emits RobotStatus + empty Error stream. [addendum-12 §116, L66]
- **Login/auth NOT required to receive broadcasts.** `user/login` is a
  pub/sub echo — password-less (username + level only).
  [addendum-12 §116]
- **Keepalive is literal string frames** `"ping"` / `"pong"`.
  [addendum-12 §116]
- **Compact JSON + UTF-8 required with this firmware.** Server's
  hand-rolled JSON is whitespace-sensitive; frames contain Chinese text
  (关节/超限); Windows cp1252 crashes. Always `encoding="utf-8"`.
  [addendum-12 §116, L69]
- **Sensor's own logs are ground truth.** To reverse-engineer any vendor
  protocol, read the working client's traffic via DevTools (F12 →
  Network → Socket → Messages/Headers) rather than guessing envelopes.
  [addendum-12 §116, L64]

## Kinematics / rendering

- **URDF J3/J5 sign flips are intentional (Option A).** Do NOT correct
  back to CAD. The CRI write path is calibrated against these axes; the
  Phase-D encoder-perfect baseline was earned under this convention.
  [addendum-13 §128; addendum-14 §136; addendum-33 §512;
  memory `cobot-cri-axis-convention`; L77]
- **Twin J5 axis-flip render seam.** Frontend has an ad-hoc J3 sign-fix
  applied (twin J3 renders correctly). J5 does NOT have the equivalent —
  twin renders J5 sign-mirrored. Cosmetic; does not affect motion.
  Queued as Option A atomic session with paired read/write regression
  tests. [session-2026-08-24]
- **JSB joint ordering fallback (2,3,1,4,5,6).** `joint_state_broadcaster.yaml`
  declares `Joint1..Joint6`, but at runtime JSB publishes
  `[Joint2, Joint3, Joint1, Joint4, Joint5, Joint6]` when the spawner
  is not honoring `-p` params file. The yaml's own head comment predicts
  this: `必须由 spawner -p 传入；否则 /joint_state_broadcaster 的 joints 为空，
  顺序会变成 2,3,1…`. Server-side normalization in
  `dashboard_server.py._on_joint_states` (canonical `[Joint1..Joint6]`)
  is the workaround. Root-cause spawner-param investigation queued for
  F3. [session-2026-08-24]
- **DH fit gauge freedom.** d₄ pinned at ±1000 bound. a₁, a₄, d₂, d₅,
  d₆ are unobservable aliases — fit resolves the combination to
  0.025 mm but individual link split is NOT physically unique. Use
  fitted DH for IK; CAD-derived twin owns mesh placement.
  [addendum-13 §122, L78]
- **Supplier "calibrated" tables are NOT automatically authoritative.**
  Estun's own table disagreed with Estun's own drawing on d₆ (169.5 vs
  150.5); our fit matched the drawing. [addendum-13 §123, L79]

## Access + connectivity

- **The Estun controller has NO SSH access for us.** Only network
  protocols (WS `:9000`, CRI TCP `:9001`, CRI UDP `:9030/:10086`,
  Modbus `:502`, factory UI `:9198`, deploy `:8080`).
  [session-2026-08-24]
- **Wi-Fi/.2.x split.** Operator laptop on `.1.x` cannot reach the
  controller on `.2.x` directly. Two interfaces on same /24 fight; use
  SSH tunneling through the Jetson. [addendum-13 §125, L75/L76;
  session-2026-08-24]

## Planner / executor semantics

- **A planner that CLAMPS instead of REJECTS moves validation to the
  caller.** MoveIt returned SUCCESS for an out-of-limit joint target by
  silently planning to the limit. Executor must validate goals before
  submit; never rely on "planner would have errored" as a safety
  argument. [addendum-33 §512, L222]
- **OMPL vs Pilz.** MoveJ → Pilz PTP; MoveL → Pilz LIN; OMPL reserved
  for collision-aware planning when scene demands search. OMPL
  RRTConnect used goal-tolerance box as an envelope — all "held" joints
  wandered 0.1–0.2°. [addendum-33 §514, L219;
  memory `cobot-cri-planner-intent`]

## Bring-up / diagnosis rituals

- **Log line 3 audit.** Read the `[launch.user]:` variant announcement
  before trusting any downstream signal. `MOCK` vs real is otherwise
  visually identical. [addendum-37 §537, L251]
- **Bundle-date audit belongs in every frontend diagnosis (L246).**
  The browser might be running an Aug 6 build while you audit Aug 20
  source. [addendum-36 §528]
- **jog_bridge L239 three-part verification.** For any mode-switched
  daemon: kill ALL instances, start one fresh, verify banner AND
  `/proc/PID/environ` AND subscriber count. Never trust one of the
  three alone. [addendum-35 §524, L239]
- **Phantom-source class — stale browser tabs on the dashboard.** Before
  any real-arm jog test: `ss -tnp | grep :8080 | awk '{print $5}' |
  sort -u` to enumerate connected client IPs; if more than the operator's
  known IP is present, `sudo systemctl restart roboai-dashboard` to
  force all clients to reconnect (queued hold state on the WS is flushed
  on reconnect and can fire as an uncommanded event ~30 s into the fresh
  motion stack). Then 30 s idle monitor of
  `/dashboard/jog_session_events` must return zero events before jog.
  [addendum-40 §565]
- **Four-tuple pre-flight (WS `:9000`).** For real-arm gate:
  `{state:2, stateName:'Enabled', recoveryState:0, errors:[]}` — all
  four. `state=2` alone is not sufficient (`recoveryState=1` sits under
  a nominally-enabled state and silently blocks motion). `errors:[]`
  after clearing an alarm on the wire; if `recoveryState≠0` persists,
  power-cycle. [addendum-40 §564; addendum-40 §566]

## Standing debts / known-open

These are AMBIENT ongoing conditions, not per-session state:

- **DHCP reservation** `50:2e:91:95:b6:15` → `.246` — requested since
  addendum-32 §506, still unlanded 4 bites later. [STATE.md]
- **Dashboard speed-display bug** (addendum-40 §565). Slider label
  `"15 %"` sends `speed_pct=22.0` on the wire (and other UI values map
  to 22–57 outputs). UI display ≠ wire value on the `speed_pct` field
  emitted by `JogControls.jsx` in dashboard events. Every prior
  speed-labelled test result carries this offset; treat historical
  "5 %" / "15 %" claims as approximate until the UI-to-wire mapping is
  corrected. F3 dashboard session; not on the jog critical path but
  blocks any speed-precision test-report writing. [addendum-40 §565]
- **`/opt/cobot/logs` retention cap** — regrew to 2.0 GB in <2 weeks
  twice; watchdog alerts but nothing prunes; retention cap unimplemented.
  [addendum-32 §506; STATE.md]
- **V1 GitHub repo is PUBLIC** — long-open; make private + rotate
  `aicollabs12`-era credentials; check audit log for exposure window.
  [STATE.md; addendum-36 §533]
