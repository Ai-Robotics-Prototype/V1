# addendum-57 — 2026-09-18 — device pairing backend (slice 1)

> Session-2026-09-18. Backend-only slice of the customer-facing pairing
> feature. Frontend wizard, mDNS advertisement, and enforcement flip land
> in follow-on sessions. Default flag is OFF — the enforcement ladder is
> built and pinned, but inert until the operator sets
> `COBOT_PAIRING_ENFORCED=1` on the roboai-dashboard drop-in.

## §686 — Pairing security boundary lands (default-off)

### Threat model before

The dashboard shipped with no auth surface. FastAPI at :8080,
`CORS(allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])`,
zero token / bearer / Depends anywhere in `dashboard_server.py`. Anyone
on the LAN could hit `/cmd/jog`, `/api/state`, `/ws/state`, delete
programs, mint a program-run request. The plaintext-credential class
was the *entire* story.

### What landed

Three modules + one middleware + registry entry + pins:

1. **Identity** (`src/cobot_dashboard/cobot_dashboard/identity.py`, new).
   `/opt/cobot/identity.json` = `{serial, model, friendly_name}`; serial
   minted once on first boot as `NR-XXXXXX` (`secrets.token_hex(3)`),
   never rewritten. `set_friendly_name()` mutates the friendly name only;
   serial + model are immutable. Test hook `reset_cache()` for hermetic
   pytest.

2. **Pairing store** (`src/cobot_dashboard/cobot_dashboard/pairing.py`,
   new; pure module, no FastAPI import). `PairingStore` owns:
   - Pending sessions (in-memory dict, 90 s TTL, `_sweep_expired_pending_locked`
     called AFTER lookup so target session's expiry returns `expired`
     rather than `no_session`).
   - Device store on disk (`/opt/cobot/paired_devices.json`),
     `token_id → {token_hash, device_name, created, last_seen}`.
     SHA-256 hash of the raw 256-bit token; raw returned exactly once
     on `confirm` and never persisted.
   - Failure counter per remote_ip with 5-min rolling window; on the
     3rd fail inside the window, IP is locked out for 5 min on BOTH
     `start` and `confirm`. Successful confirm clears the counter.
   - Revoke pubsub (`on_revoke(cb)` → `revoke(token_id)` snapshots +
     fires callbacks off-lock).

3. **HTTP + WS auth middleware**
   (`_pairing_auth_middleware` in `dashboard_server.py`, gated on
   `COBOT_PAIRING_ENFORCED`, default `0`). Runs BEFORE the edition
   gate (Starlette runs LAST-registered first). Unauth allow-list:
   `/api/pair/`, `/api/identity`, `/health`, `/api/deploy_status`,
   `/api/provenance`, plus static SPA prefixes. Localhost
   (`127.0.0.1`, `::1`, `localhost`) always grandfathered — Jetson
   display + the deploy tool at 127.0.0.1 keep working during rollout.
   Non-API paths (SPA routes) pass through unauthenticated so the
   wizard itself renders. Enforced miss → 401 with
   `{ok:false, kind:'pairing_required', reason:<plain>}`. Every /ws/
   handler gains the same guard (10 sites) inline before
   `await websocket.accept()`; unauthorized WS calls `close(code=4401)`.

4. **Revoke drops live WS** — `_pairing_mod.get_store().on_revoke(
   _ws_close_by_token)` registered at `create_app`. `_ws_close_by_token`
   pops the token's peer set from `_ws_by_token_id` and schedules a
   `close(4401)` on every peer via `asyncio.run_coroutine_threadsafe`.

5. **Pairing endpoints:**
   - `GET  /api/identity` → serial/model/friendly_name.
   - `POST /api/pair/start` `{device_name}` → `{session_id, code,
     expires_in_s}`. Rate-limit + lockout enforced. Code returned in
     the response *for now* because the paired-dashboard modal that
     shows the code is a follow-on frontend piece; a future session
     hides it from the tablet response and pushes it to the modal via
     the state broadcast.
   - `POST /api/pair/confirm` `{session_id, code}` → `{token, token_id,
     device_name, ca_cert_pem, robot}`. `ca_cert_pem` reads
     `/opt/cobot/certs/ca.pem` best-effort; empty is not fatal.
   - `GET  /api/paired_devices` → device list, no hashes leaked.
   - `DELETE /api/paired_devices/{token_id}` → 204/200 ok, fires revoke.

### Fork registry

New capability `device_pairing_auth` (entry #27, id sequentially after
`provenance`). Canonical = `cobot_dashboard.pairing` +
`cobot_dashboard.identity` + `/api/pair/confirm` (route representative
with siblings block for the other four) + `_pairing_auth_middleware`.
Forbidden:
- `paired_devices\.json` outside `pairing.py` / `dashboard_server.py` /
  tests — no hand-rolled second token store.
- `COBOT_PAIRING_ENFORCED` outside `dashboard_server.py` / tests — no
  parallel auth middleware, no per-endpoint auth check duplicating the
  middleware logic.

`known_debt` under `jog_hold_heartbeat` refreshed: `/cmd/jog` shifted
`4283 → 4466`, `/cmd/jog_cartesian` shifted `4418 → 4601` (fork_lint
comment-stripped lines). Both drift-history entries note the +170 /
+183 line addition from the pairing wiring.

### Pins (all green, 22 pass, 0 fail)

`src/cobot_dashboard/test/test_pairing_backend.py`:

- `test_identity_mint_and_persist` — serial immutable across reloads;
  friendly-name mutation keeps serial + model.
- `test_identity_rejects_empty_name` — ValueError on whitespace-only.
- `test_pair_start_then_confirm_mints_token` — 6-digit code, token
  ≥32 chars, hashed on disk, raw validates via `validate_token`.
- `test_pair_bad_code_is_single_shot` — one wrong guess burns the
  session; retry with correct code = `no_session`.
- `test_three_fails_locks_out` — 4th `start` from same IP inside
  5-min window returns `locked_out` with `retry_after_s > 0`.
- `test_code_expires_at_ttl` — age > TTL returns `expired` (not
  `no_session` — sweep runs AFTER lookup).
- `test_revoke_drops_token_and_fires_callback` — revoke returns
  True once, callback fires with token_id, second revoke returns
  False + does not refire, validate_token returns None post-revoke.
- `test_list_devices_hides_hashes` — list row has no `token_hash`
  or `token` field.
- `test_middleware_flag_semantics` — grep-pins: env flag read,
  default-off short-circuit, 401 pairing_required, unauth prefix
  list contains `/api/pair/`, localhost grandfather tuple,
  WS auth check appears on ≥10 handlers, `close(code=4401)`.

`src/cobot_dashboard/test/test_fork_registry.py`: 13 checks — all
pass, including `test_route_canonicals_declare_method_and_path`
(new capability uses `method:` + `path:` singular with a siblings
list for the other four routes) and `test_linter_exits_zero_on_clean_tree`.

### Security before → after

**Before this commit.** Anyone on the LAN who reaches port 8080 gets
everything: `/api/state`, `/cmd/jog`, program CRUD, `/ws/state`
firehose. No credentials, no rate limit, no audit trail.

**After this commit, `PAIRING_ENFORCED=0` (default this session).**
Behaviourally unchanged from before — new endpoints are additive, the
middleware short-circuits, WS guards return `_ws_auth_check → True`
unconditionally. The enforcement ladder is landed but inert.

**After the operator flips `PAIRING_ENFORCED=1`.** Everything on
port 8080 except the pairing flow + health + deploy_status + provenance
+ localhost demands a valid bearer token or `?token=` query param.
Unpaired LAN attacker can hit `/api/pair/start` but the 3-fail
lockout + 90 s code expiry + single-use code + 256-bit token entropy
mean brute-force is not viable. What they still cannot see even
pre-pair: state, jog, programs, streams. What they still can do
after physically reading a code off the robot display: pair — which
is the intended security model.

### Rollout steps (for the operator, not this session)

1. Land the frontend wizard + paired-dashboard modal (follow-on
   session). The tablet-side response of `/api/pair/start` will stop
   returning `code` at that point; instead the code broadcasts into
   `STATE.pairing.pending` and the modal renders on every already-paired
   dashboard.
2. Pair the operator's own tablet through the wizard while
   `PAIRING_ENFORCED` is still 0 — the pair happens, the tablet
   stores the token, but the middleware is still permissive.
3. Verify the token works: `curl -H "Authorization: Bearer $TOKEN"
   http://192.168.2.246:8080/api/state | jq .`
4. Flip the flag: create
   `/etc/systemd/system/roboai-dashboard.service.d/pairing.conf`
   with `[Service]\nEnvironment=COBOT_PAIRING_ENFORCED=1` and run
   `sudo systemctl daemon-reload && sudo systemctl restart
   roboai-dashboard`. Localhost stays grandfathered.
5. Watch the paired-dashboard modal fire when the next unpaired
   tablet on the LAN attempts to connect.

### What did NOT land tonight — explicit

- **Frontend wizard** — no `SetupWizard.jsx`, no `/api/pair/*`
  client, no localStorage token plumbing, no 401-re-pair loop. The
  three-page UX + branding is a follow-on session.
- **Avahi `_neurobots._tcp` advertisement** with serial/model/name
  TXT records — no advertisement was in the tree to extend, and
  writing the systemd unit + XML is scoped separately.
- **Device management UI (Settings page with revoke buttons)** —
  backend endpoints exist; UI wire-up follows.
- **CA cert generation pipeline** — `/opt/cobot/certs/ca.pem` is
  read best-effort; if the file is not there `ca_cert_pem` returns
  empty. The mTLS provisioning is out of scope here.
- **Rate-limit on `/api/pair/start`** beyond the lockout — a
  future session may want an outer per-IP QPS ceiling; the current
  model is "3 wrong codes locks out 5 min," which is the pairing-
  specific threat, not the DoS threat. Not blocking.
- **Register-then-unregister-on-WS-close cleanup** in `_ws_by_token_id`
  — under enforced flag, per-token peer set can grow with reconnects
  until the next revoke pops the whole token entry. Bounded, not
  leaking indefinitely; a follow-up can add per-handler
  `finally: _ws_unregister_token`.

## Reference-tier updates this session

- `docs/LESSONS.md` — L320 appended (device pairing backend slice).
- `docs/STATE.md` — session-close block appended for 2026-09-18,
  arm state unchanged (session was code-only, no arm motion).
- `tools/fork_registry.yaml` — new capability #27 `device_pairing_auth`;
  refreshed `jog_hold_heartbeat` known_debt line numbers for the two
  routes that shifted due to the pairing wiring.

## Files touched

```
new  src/cobot_dashboard/cobot_dashboard/identity.py
new  src/cobot_dashboard/cobot_dashboard/pairing.py
new  src/cobot_dashboard/test/test_pairing_backend.py
new  docs/ledger/addendum-57-sep-18-device-pairing-backend.md
mod  src/cobot_dashboard/cobot_dashboard/dashboard_server.py
     — pairing imports + flag + unauth prefix list + WS tracker
       + _ws_auth_check + _ws_register_token + _ws_close_by_token
       (~90 lines below FastAPI imports)
     — _pairing_auth_middleware + revoke callback registration
       (~55 lines after edition-gate middleware)
     — 5 pairing endpoints (~90 lines before /health)
     — per-WS auth guard inline on 10 handlers (~10 lines each)
mod  tools/fork_registry.yaml
     — new capability entry device_pairing_auth
     — jog_hold_heartbeat known_debt line refresh
mod  docs/LESSONS.md
     — L320 appended
mod  docs/STATE.md
     — 2026-09-18 session-close block appended
```
