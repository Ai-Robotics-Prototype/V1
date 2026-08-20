# ADDENDUM 37 — August 20, 2026 — F1 CLOSE PRE-RUNG SETUP: THE LEDGER LEARNED TO SELF-LINT, THE JOG BRIDGE LEARNED TO EAT NULL, AND A LAUNCH DEFAULT SILENTLY SYNTHESIZED AN ENTIRE ARM
*(Ledger file: `ledger/addendum-37-aug-20-f1-pre-rung-setup.md` — appended in full, nothing removed. The session that finished the ledger restructure into a linted living tier, then walked the entire pre-rung stack for F1.4: the frontend rebuild, the two systemd env vars, the jog_bridge crash-on-null, the two-backend safety refusal, the SIGSEGV'd motion stack, the teach-promote red herring, and the launch default that turned the whole ROS layer into a mock without ever lying about it.)*

### Section 534: The ledger learned to self-lint — ATTEMPTS.md + builder + four-duty invariant

Follow-up to §532's restructure. The materialized-view tier still needed three things before it could be trusted: a place to write down *what was tried* separate from the story of *what happened*, a way to read the whole archive end-to-end without grep, and an automated set of invariants that would fail loud if the restructure drifted. All three shipped in one commit (`da4caa4`):

**ATTEMPTS.md** — one line per approach tried, format `<slug> <§section-or-line> — <one-line attempt> — VERDICT: <one-word>`, ~128 entries from an explore-agent sweep of the substantive addenda (era-01, 05, 16, 21, 23, 24, 27, 29, 30, 31, 34, 35, 36). Verdict vocabulary standardized (SHIPPED / REVERTED / ABANDONED / DEFERRED / EXONERATED / FAILED / PASS / INFLIGHT / ADOPTED / REJECTED / …). Skipped-addendum audit list at bottom names the 24 non-tabulated addenda so the gap is honest rather than silent.

**tools/build_full_ledger.sh** — concatenates `docs/ledger/*.md` in canonical order (era-01 first, then addendum-NN numeric with `-a/-b` suffixes) into `build/full_ledger.md` (gitignored, 1.22 MB / 14,512 lines across 38 files). This is the read-end-to-end view when the topic map isn't enough; the individual per-addendum files remain canonical.

**tools/ledger_lint.py** — four duties, all currently PASS:
1. `CONTIGUITY` — every v46-marker file declares `source_lines: N-M`; concatenated ranges cover 1..13488 with no gaps and no overlaps (33 files).
2. `REDACTIONS` — no raw `ghp_*` PAT strings anywhere in `docs/ledger/`; the three known-required placeholders present in era-01 (2× `[REDACTED_GHP_TOKEN_1]`, 1× `[REDACTED_GHP_TOKEN_2]`).
3. `INDEX-RESOLVE` — every `addendum-NN[-a|-b]` slug or `era-01` slug referenced in `INDEX.md` resolves to a file that exists (38 filename refs, 37 shorthand refs).
4. `LESSONS-GAPS` — LESSONS.md contains a `**Gaps**` block AND an `Extraction methodology` section.

The reconstruction test still exists but is now marked superseded — its docstring names `ledger_lint.py` as the authoritative check.

**Extraction-methodology audit — the LESSONS numbering fault.** Same commit added the "**Extraction methodology (2026-08-20 audit)**" section to LESSONS.md, because the 212-entry / 143-gap accounting was genuinely wrong. v46 carries *two* parallel numbering streams: `## N.` headings (section titles, 212 total — what the extraction pulled) and `N. **Title.**` list items (real lessons, 383 total — extraction missed all of them). Sampling: v46:L12644 `146. **Summary statistics hide paths…**`, v46:L13378 `200. **Every investor claim must survive a cabinet inspection…**` — real lesson content, absent from the current index. 65 such misses fall inside the "gap" range 146–243. The finding is documented on the file; backfill deferred to a later session (the lint no longer refuses on the gap because the gap now has a name and a reason).

### Section 535: The F1 close pre-rung setup — three env flips, one bundle rebuild, one crash-on-null fix

The operator's F1 close campaign directive: reconfigure per the earlier recommendation (JOG_BACKEND=ros2, CAMERAS_DISABLED=1, rebuild the frontend, verify the served bundle changed, restart the dashboard, ensure exactly one ROS2-authoritative jog_bridge), then walk rungs 3-6 (J6+/J6- 3 s holds, deadman A, deadman B, 60 s soak). The setup surfaced three defects before the operator's finger was needed once.

**Env flip via systemd drop-in** — new file `/etc/systemd/system/roboai-dashboard.service.d/campaign-f1.conf` sets both `JOG_BACKEND=ros2` and `CAMERAS_DISABLED=1` at the unit level. Marked "remove after F1 CLOSED + F3 formalizes these" so the temporary nature is on-file. After `daemon-reload` + safe-gated restart (checked `active_holds=0` and `program.state=None` first per L4 doctrine), `/proc/$PID/environ` confirmed both vars applied and `/health` reported `backend=ros2, cameras_disabled=True`.

**Frontend rebuild** — bundle was `index-qIqtjOA0.js` (sha `ce10f962…`) before, `index-CPjpRuaL.js` (sha `66f2fab8…`) after. The filename hash embeds the content hash; changed filename ⇒ changed content, which is the load-bearing check. `index.html`'s `<script src>` reference updated automatically. Any tab still running the pre-rebuild bundle now sees the dashboard's `"New app version available"` warning event, unchanged since it shipped.

**jog_bridge crash-on-null** — first attempt to launch the bridge under the new env crashed with `TypeError: int() argument must be … not 'NoneType'` at `jog_bridge_node.py:173`, `int(evt.get("joint", 0))`. The `.get("joint", 0)` idiom returns `0` only when the key is *missing*; when the key is present with value `None`, it returns `None` — and `int(None)` raises. The dashboard's session_event JSON was sending `null` for optional fields on some path. Fix: `int(evt.get("joint") or 0)` (six sites: three fields × start/refresh branches) — nulls now surface as `joint_index=0`, which the state machine already rejects cleanly (line 178: "joint index out of range [1..6]"). Failure mode moved from crash-and-die to rejection-with-log. Package rebuilt via `colcon build --packages-select jog_bridge --symlink-install`; regression path is the state-machine's existing `test_press_with_bad_joint_index_is_rejected`.

### Section 536: The two-backend safety guard — jog_bridge refused authority while estun was still authoritative

Second jog_bridge crash on the next launch: FATAL after ~5 s, `"SAFETY: /estun/mode reports allow_jog=true while JOG_BACKEND=ros2. Two backends must NOT both be authoritative. Cancelling any active session; jog_bridge going passive."` The bridge's own audit refused to arm because `roboai-estun` was still running and its `/estun/mode.allow_jog=true` was live on the wire.

STATE.md's stated doctrine was "WS/Lua stack STOPPED not disabled — fallback" — but the service was `active`, not `inactive`. The stop hadn't been applied this session. `sudo systemctl stop roboai-estun` → `/estun/mode` went silent → jog_bridge's next launch cleared the safety check and came up authoritative. The moral is small but real: **a stated "stopped" is not the same as an observed `is-active inactive`**; the SAFETY guard's job is exactly to fail closed on that gap, and it did.

Tmux window discipline held here — `robot:jog_bridge` is the dedicated window (per L217 own-shell rule, memory `cobot-jog-bridge-own-shell`); the bridge banner was captured pane-side while the CRI motion stack was in a *different* window. Same-pane Ctrl-C would have killed both.

### Section 537: The silent mock — `use_mock:=true` default synthesized an entire arm, and every downstream layer honored it

The CRI motion stack was down when we got to the JTC check: `move_group` and `ros2_control_node` had `SIGSEGV`'d during a prior shutdown (Aug 19), `/joint_states` had 0 publishers, JTC action `/joint_trajectory_controller/follow_joint_trajectory` had 0 servers. `cri_teardown.py` was run (StopControl / StopDataPush failed with "Please enter into remote mode first" — expected because the crashed session had already released remote; `Robot/toManual` succeeded). Launch dispatched: `ros2 launch cod_bringup s10_140_cri_ros2_control.launch.py`.

Everything came up green — resource_manager loaded S10_140System, JTC configured and activated at 250 Hz publish rate, move_group "You can start planning now!", `/joint_states` publishing at 249.6 Hz, JTC action server present. `/health` reported `backend=ros2, flips=0/0, active_holds=0`. Rungs were seconds away.

Then the operator reported: *"Twin renders all joints at 0.0° and jog is dead after the reconfiguration."* The dashboard's `/api/state.joints.positions` returned `[0.0, 0.0, 0.0, 0.0, 0.0, 0.0]`. `/joint_states` echo returned the same — six real messages per second, six real zero values.

The tell was on **line 3 of the launch log**:

```
[INFO] [launch.user]: [s10_140 launch] MOCK variant (mock_components/GenericSystem); no hardware I/O.
```

The launch file's `use_mock` argument defaults to `"true"` — a Phase E4 safety default so planner-only development wouldn't accidentally command a physical arm. My launch invoked no args ⇒ mock hardware plugin ⇒ every ros2_control interface synthesized zeros ⇒ joint_state_broadcaster faithfully published zeros ⇒ `/joint_states` streamed zeros at 250 Hz ⇒ dashboard's CRI proxy mirrored zeros ⇒ twin rendered zeros. **No layer lied.** The whole downstream chain was a truthful reflection of a mock. `ss -tnp | grep 192.168.2.136` (empty) confirmed no TCP connection to the controller — the smoking gun the operator's direction pointed straight at.

Fix: teardown, relaunch as `ros2 launch cod_bringup s10_140_cri_ros2_control.launch.py use_mock:=false`. Now the log carried its earned lines:

```
[cri_tcp_setup] ========== 全部 5 步 TCP 初始化成功 ==========
[CriUdpSystem]:  CRI UDP bind :10086 -> 192.168.2.136:9030  max_step_rad=0.0020 max_err_vs_fb_rad=0.5000
[CriUdpSystem]:  首帧 UDP 反馈已对齐关节指令（暂停下发直至与真机一致，避免启动跳变）
```

`/joint_states` at 245–247 Hz with real positions (J1=-38.9°, J2=52.9°, J3=69.8°, J4=33.7°, J5=90.4°, J6=-69.4° from dashboard's degrees view). `robot.connected/enabled/allow_jog` all True. `cri_proxy.flips` 0/0 with 2731 s of dashboard uptime, `consecutive_stale_ticks=0`, cameras still disabled.

Lesson under the lesson: the operator's diagnostic was correct at every step — twin dead ⇒ state feed values ⇒ /joint_states ⇒ served bundle ⇒ WS ⇒ name the dead link. The dead link was **one line up the launch chain** from where any of those checks look. Log-line-3 audit belongs in the bring-up ritual because a synthesized reality synthesizes an honest reality all the way down.

### Section 538: The teach-session promote refusal — the refusal did its job; the premise didn't

Mid-setup, the operator flagged a separate defect: *"Teach-session promote refused on a New Program (0 steps, payload not set)."* Directive: pull the exact 4xx, decide validation vs ownership, and if ownership, check whether the §490 device-identity fix ever shipped.

Event log had exactly one teach-adjacent refusal today (`events_20260820.jsonl` @ 11:12:06):

```
source:   dashboard
op_msg:   "Teach positions first — this program has untaught positions."
tech_dtl: "Untaught: step 1 (home), step 2 (pick), step 4 (place), step 6 (home).
           Open it in the Program Editor to teach them. | pending_poses"
```

**Validation, not ownership** — HTTP 400, `error: pending_poses`, from `dashboard_server.py:14126` (the single validator door via `program_ops.check_program_pending_poses(merged)`). Ownership refusal is a distinct 403 `not_owner` path (`_teach_claim_or_refuse`, ~L13624), and no such event exists today.

**The premise didn't survive the artifact** — the refused program had ≥6 steps with roles `home/pick/place/home`. That's not a New Program; that's an existing bowl-shaped skeleton (likely PBD-composed) with 4 slots not yet taught. The save endpoint doesn't validate `steps==0` or `payload==null` at all — payload becomes load-bearing at RUN, not save. If a "new-program safety net" is wanted at save-time, that's a new validation to write, separate from this refusal.

**§490 device-identity fix — CONFIRMED SHIPPED** — the operator asked in case the answer to (1) was ownership. It wasn't, but the audit ran anyway:
- Frontend: `useStore.js:1951` — `_getTeachDeviceId` reads `localStorage.getItem('roboai-device-id')` with one-shot migration from the pre-fix `sessionStorage` key. Comment block at 1934–1962 names the fix explicitly.
- Backend: `_teach_claim_or_refuse` (L13629) — null owner is CLAIMABLE by design; refuse only when a different non-null device owns AND its heartbeat is fresh (`_TEACH_STALE_HEARTBEAT_S`); stale-owner triggers auto-swap. That's the ghost-amnesty.
- Heartbeat: `POST /api/teach_session/{pid}/heartbeat` at server L13976; client `heartbeatTeachSession` at `useStore.js:2211`.
- Commit: **`817686a teach-lock: device identity is per-device (root-cause fix)`**.

**§285 toast copy** — already meets the doctrine, and pinned. `loadOutcome.js:127-135` builds the toast with title ("Teach positions first — this program has untaught positions.") + detail ("Untaught: step 1 (home), … Open it in the Program Editor to teach them."). Three pinned frontend tests in `loadOutcome.test.js`: verbatim-title match (L149), 1-based step enumeration (L168), cap-at-5-with-"+N more" (L182). No copy fix needed.

### Section 539: Standing items touched this session

- **Ledger tier now linted at pre-commit-adjacent status** — `ledger_lint.py` all-PASS on HEAD. This can move to a pre-push git hook in a future session; for now it's manual.
- **jog_bridge robust against null-fielded session events** — the crash class is closed; the state-machine's existing bad-argument rejects are the new failure mode.
- **`use_mock:=true` default** — remains as-is in the launch file (correct for planner-only sessions); the discipline is on the *invoker* to pass `use_mock:=false` for hardware runs. Log-line-3 audit is the new bring-up habit.
- **Rungs still owed** — J6+ 3 s, J6- 3 s, deadman A (client keepalive death), deadman B (bridge SIGKILL mid-hold), 60 s soak. Operator's finger required.
- **V1 GitHub repo visibility** — still PUBLIC per addendum-36 flag; still open, still an unbounded credential-rotation debt.
- **DHCP reservation** — still unset (fourth week now).

| Item | Status |
|------|--------|
| Ledger self-lint tier | **SHIPPED** (`ledger_lint.py`, 4/4 PASS) |
| ATTEMPTS.md | **SHIPPED** (~128 entries, skipped-audit list on file) |
| build_full_ledger.sh | **SHIPPED** (38 files → 1.22 MB) |
| LESSONS extraction miss | **DOCUMENTED** (heading vs list format; backfill deferred) |
| Frontend rebuild in served bundle | **SHIPPED** (`index-CPjpRuaL.js`, sha `66f2fab8…`) |
| Dashboard env drop-in `campaign-f1.conf` | **SHIPPED** (`JOG_BACKEND=ros2`, `CAMERAS_DISABLED=1`) |
| jog_bridge null-tolerance | **SHIPPED** (`int(x or 0)` × 6 sites) |
| Two-backend safety refusal | **RESOLVED** (`roboai-estun` stopped) |
| CRI motion stack up (real hardware) | **SHIPPED** (`use_mock:=false`, JS 245–247 Hz, transport bound) |
| Teach-promote refusal audit | **DIAGNOSED** (validation `pending_poses`, not ownership; §490 fix confirmed shipped) |
| F1.4 rungs 3–6 | **PENDING** operator cue |
| V1 repo visibility + credential rotation | STILL OPEN |
| DHCP reservation | STILL OPEN (4th bite) |

## PROCESS LESSONS (251–256)

251. **A launch file's default is part of the deploy state.** `use_mock:=true` synthesized every downstream signal in the ROS layer without lying — `/joint_states` published real zero-position messages at 250 Hz; the dashboard mirrored them faithfully; the twin rendered them accurately. The bug lived at the CONSTRUCTION of the reality, not at any layer that observed it. Bring-up ritual now includes: **read log line 3** (the `[launch.user]:` variant announcement) before trusting any downstream signal.

252. **"Stopped" is a state, not a promise.** STATE.md doctrine said `roboai-estun` is "STOPPED not disabled — fallback"; the actual `systemctl is-active` said `active`. Doctrine describes intent; observation is truth. `jog_bridge`'s two-backend safety guard existed exactly to close that gap — and did. Guards that assume other components have honored their stated state save you when they haven't.

253. **`x or default` beats `dict.get(key, default)` when `key: null` is a real input.** Python's `dict.get("x", 0)` returns `0` only when the key is *missing*; explicit `{"x": null}` returns `None`, and `int(None)` crashes. At JSON-decode boundaries, treat `None` as "no value provided" the same as missing; `int(evt.get("x") or 0)` collapses both cases to the safe default while keeping legitimate zeros intact.

254. **When the frontend looks broken, name the synth flag first.** Dashboard state feed, twin, and jog were all "dead" — but every one of them was reporting the ROS layer's synthetic zeros correctly. The path is: what's *published* → what's *received* → what's *rendered*. If publishers are silent OR synthetic, no frontend fix will help. `ss -tnp | grep <controller-ip>` is a five-second check that separates network-layer truth from application-layer synthesis.

255. **Pull the exact 4xx before speculating on cause.** The operator's premise ("New Program, 0 steps, payload not set") did not match the actual refusal (existing 6-step bowl skeleton, 4 untaught positions, `pending_poses`). Refusal audits go: (1) event_log line for the exact code + operator_message + technical_detail, (2) server endpoint's return, (3) frontend toast composer. The premise is a hypothesis; the artifact is evidence.

256. **A tmux pane's window discipline is a safety guard.** `robot:jog_bridge` had to stay in its own window while the CRI motion launch lived in `robot:0`. Same-pane Ctrl-C would have killed both. `#{pane_current_command}` from `tmux display-message` names the actual command running, which is the check when a launch is "supposed to" be up but the pane looks quiet.

---

*Summary of Addendum 37: the session the ledger itself got a lint, and the finish-line stack got laid out to within one operator's-finger of F1 close. Two invisibles were named: the extraction that had been indexing v46's *section titles* under the name of its *lessons* (383 real lessons still absent from the index, 65 of them inside the "gap" that the lint now documents rather than hides), and a launch default whose `MOCK variant` announcement on line 3 was the only place any code lied about anything — every layer below it faithfully reported the fiction it was constructed on. In between, three smaller doors closed cleanly: a jog_bridge that had crashed on a null joint now surfaces the same input as a clean reject, a roboai-estun that STATE.md called "stopped" is now actually stopped and jog_bridge is authoritative, and a teach-promote refusal that the operator worried might be a class-of-lock regression turned out to be the validator door doing exactly what §285 asked of it — with a title, a detail listing every blocker, and a way out. Rungs 3–6 wait one F5 away.*

*Last updated: August 20, 2026 (Addendum 37 — Sections 534–539, Lessons 251–256)*
