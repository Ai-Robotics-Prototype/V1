# addendum-61 — 2026-09-18 — auth model pivot: open view + login for control

> Operator directive Sep 18: pairing-code flow was wrong for the
> customer story. Pivot: view surfaces open to anyone; control
> surfaces require a username/password login. Pairing infrastructure
> retained but no longer the primary gate.

## §690 — VIEW open, CONTROL login-required

### Route split (VIEW = open, CONTROL = login when enforced)

Classification is method-based with an explicit exception list —
281 routes classify cleanly:

- **VIEW (open in both flag states)** — every `GET/HEAD/OPTIONS`:
  `/api/state`, `/api/identity`, `/api/whoami`, `/api/deploy_status`,
  `/api/provenance`, `/api/paired_devices` (list), `/api/pair/pending`,
  `/api/programs` (list + read), `/api/programs/{id}`, `/api/cells`,
  `/api/cells/*`, `/api/event_log`, `/api/edition`, `/api/tools`,
  `/api/parts` (reads), `/api/collision_guard`, `/api/collision`,
  `/api/motioncam/status`, `/api/motioncam/scene`, `/api/systemcheck`,
  `/api/codegen/status`, `/health`, `/stream/cam0`, `/stream/cam1`,
  `/stream/annotated`, and all 10 `/ws/*` (state streams). Anything
  read-only, in short.

- **CONTROL exceptions (unauth even under enforce)**:
  `/api/login`, `/api/pair/*`, `/cmd/estop`. E-STOP is the safety
  invariant: any view-only client must be able to stop the arm.
  Pinned by `test_estop_is_in_unauth_control_paths`.

- **CONTROL (login when enforced)** — everything else with
  `POST/PUT/DELETE/PATCH`. This includes `/cmd/jog`,
  `/cmd/jog_cartesian`, `/cmd/task`, `/cmd/gripper`, `/cmd/voice`,
  `/cmd/power`, `/cmd/detection_mode`, `/cmd/program/*`,
  `/cmd/generate_program`, `/api/estun/*` (mode, program run/pause/
  stop, orient/face_down), `/api/robot/home`, `/api/collision_guard`
  POST, `/api/collision/mock` POST, `/api/programs/*` writes,
  `/api/paired_devices/{id}` DELETE, `/api/parts/*` writes,
  `/api/motioncam/mode|mock|topics|scene/*`, `/api/gripper/upload`,
  `/api/gripper/{id}` DELETE, `/api/teach_mode/*`, `/api/teach_session/*`,
  `/api/openvocab/prompts`, `/api/io/*` writes,
  `/api/systemcheck/service/restart`, `/api/edition/{unlock,lock}`,
  `/api/tool_hookup` writes, `/api/pair/deny`, and `/api/logout`.

Middleware: `_control_auth_middleware` (`dashboard_server.py:3556-
3588`). Reads `COBOT_AUTH_ENFORCED` at import time; short-circuits
when off. GET/HEAD/OPTIONS always pass. Non-GETs on non-exempt paths
demand a bearer token that `PairingStore.validate_token` accepts.
Localhost always passes.

### User store

`src/cobot_dashboard/cobot_dashboard/user_store.py` (new). Files:

- `/opt/cobot/users.json` mode 0600, JSON dict
  `username → {password_hash, salt, role, created, last_login}`.
- **Hashing:** stdlib `hashlib.scrypt` with `n=2^14, r=8, p=1`,
  16-byte random salt per user. `hmac.compare_digest` on match.
  A dummy scrypt on unknown-user path flattens the timing curve
  against username enumeration.
- **Rate limit:** 5 fails / 5 min / remote_ip → 5-min lockout on
  that IP. `test_five_fails_locks_out` pins.
- **Roles:** `admin`, `operator` (list is intentionally short for
  this session — role gating is out of scope; whoami exposes the
  role but no endpoint currently reads it).

**First-boot admin provisioning** — `provision_default_admin_if_empty()`
runs at dashboard lifespan startup. If the user store is empty:
1. `_mint_random_password()` = `secrets.token_urlsafe(24)[:24]` →
   ~144 bits of entropy.
2. `store.add('admin', <random>, role='admin')`.
3. Writes `/opt/cobot/admin_bootstrap.txt` at mode 0600
   (`os.open(..., 0o600)` — never a `touch-then-chmod` race)
   with the plaintext password and a one-line `shred -u` reminder.
4. Journal breadcrumb `[user_store] default admin provisioned;
   password at /opt/cobot/admin_bootstrap.txt (mode 0600)` — the
   password itself is NEVER logged.
5. If the file write fails (permission, disk), the password IS
   emitted to the journal as a hard-fallback so the installer has
   something to work with.

Pinned by `test_default_admin_provisioned_with_random_password` +
`test_no_fixed_default_admin_password_in_provisioning` — a census
that greps `user_store.py` + `dashboard_server.py` for classic
factory-default literals (`'admin', 'admin'`, `'123456'`, etc.).

### Login / logout / whoami endpoints

- `POST /api/login {username, password}` → `{token, token_id,
  username, role}`. Token minted via
  `PairingStore.mint_user_session(username, role)` — same store
  as pair/confirm, kind='user'. Interceptor seam unchanged.
- `POST /api/logout` (Authorization: Bearer token) → revokes the
  token via `PairingStore.revoke_by_token(raw)`. Idempotent — no
  token = ok, no revoke.
- `GET /api/whoami` → `{authenticated, auth_enforced, kind,
  username, role, token_id}` when signed in; `{authenticated:
  false, auth_enforced}` when not. Used by UserChip on mount.

### Frontend

- `components/LoginModal.jsx` — renders on
  `roboai-login-required` event. Copy: "Sign in to control the
  robot. / Viewing does not require a sign-in. Movement and program
  changes do." Username + password fields, submit → `POST
  /api/login`, `storePairing({token,...})` on success, dispatches
  `roboai-auth-changed`. On success the ORIGINAL action does NOT
  auto-fire — the user re-taps (safety directive: no queued
  motion from a login).
- `components/UserChip.jsx` — TopBar right-cluster affordance.
  Renders username + role + Sign out when authenticated. Renders
  a subtle "Sign in" button when `auth_enforced` + unauth. Renders
  nothing under dev posture unauth (chip stays out of the way).
- `lib/pairedDevice.js` — interceptor now reads the 401 body's
  `kind` field. `pairing_required` → `roboai-pair-required`
  (legacy device-trust path). Anything else including
  `login_required` → `roboai-login-required` (new primary path).
  Reason: default to LoginModal so an ambiguous 401 always
  surfaces the primary sign-in surface.
- `App.jsx` — wizard-wall RETIRED. `needsPair` starts `false`
  and only flips true on an explicit `roboai-pair-required`
  event. Dashboard renders for everyone; view-only clients see
  state, 3D, event log, program list. Control taps that 401
  raise the LoginModal.
- `components/TopBar.jsx` — mounts `<UserChip />` in the right
  cluster next to the WS indicator and E-STOP.

### CLI

`tools/cobot-user-cli.py` — sub-commands `add`, `remove`, `passwd`,
`list`. Interactive password prompt via `getpass.getpass` (never
argv, never shell history). Refuses SSH from non-loopback via
`SSH_CONNECTION` sniff (mild guard, not the security boundary —
the file's mode 0600 is).

### Safety invariants preserved

- **E-STOP never behind login.** `/cmd/estop` in
  `_UNAUTH_CONTROL_PATHS`. Any view-only client can still hit it.
  Physical E-STOP wiring untouched.
- **Deadman semantics unchanged.** The middleware checks auth at
  command acceptance. Once a jog hold is registered on the
  server, keepalives from an authenticated session keep it
  alive. If the user logs out mid-hold:
  - Their token is revoked in the store.
  - Their next keepalive POST returns 401.
  - Client-side deadman fires (freshness_deadman path) → server-
    side deadman fires → arm stops via the SAME code path as a
    tab-close or WS-drop.
  - The stop_cause is `freshness_deadman`, not a bespoke
    "auth_killed" — no new mask class.

  What we do NOT yet have: hold_id-aware middleware that would
  let keepalives + releases bypass auth once a hold_id is
  accepted, so an unauth mid-motion revoke stops the arm via
  release rather than freshness. Noted as a follow-up.

### Pairing repurposed

Pairing infrastructure survives as the device-trust layer:

- Add-57 §686 backend, add-58 §687 wizard + Avahi + CA, add-59
  §688 client-reachability, add-60 §689 first-device grace — all
  still live.
- Wizard is no longer a wall. It renders only when
  `roboai-pair-required` fires — which under the new model
  requires the backend to actively refuse with
  `kind: pairing_required` (only happens when
  `COBOT_PAIRING_ENFORCED=1`).
- The wizard's "Continue without pairing" skip path stays.
- Follow-on session lands a "Pair a device" affordance in
  Settings that dispatches `roboai-pair-required` on demand, for
  the Capacitor CA install flow.

### Store-reset commands

- Users: `sudo shred -u /opt/cobot/users.json &&
  sudo systemctl restart roboai-dashboard` — next boot re-mints
  the default admin with a fresh random password.
- Pairing: `sudo python3 tools/cobot-pair-cli.py --reset-store`
  (unchanged from add-60 §689).

### Flag-state proof

Both states behaviourally correct in-suite (14 auth pins + 9
pairing session pins + 24 pre-existing pairing pins = 47 pins
total on this stack). Live wire proof in the report.

## Reference-tier updates this session

- `docs/LESSONS.md` — L324 appended.
- `docs/STATE.md` — 2026-09-18 close block extended.
- `tools/fork_registry.yaml` — jog line refresh
  (4514 → 4584, 4649 → 4719, drift from the added auth surface).

## Files touched

```
new  src/cobot_dashboard/cobot_dashboard/user_store.py
new  src/cobot_dashboard/frontend/src/components/LoginModal.jsx
new  src/cobot_dashboard/frontend/src/components/UserChip.jsx
new  src/cobot_dashboard/test/test_auth_model.py
new  tools/cobot-user-cli.py
new  docs/ledger/addendum-61-sep-18-auth-model-pivot.md
mod  src/cobot_dashboard/cobot_dashboard/pairing.py
     — resolve_token, mint_user_session, revoke_by_token
mod  src/cobot_dashboard/cobot_dashboard/dashboard_server.py
     — AUTH_ENFORCED flag; _UNAUTH_CONTROL_PATHS;
       _control_auth_middleware; /api/login, /api/logout,
       /api/whoami; provision_default_admin_if_empty at
       lifespan startup
mod  src/cobot_dashboard/frontend/src/lib/pairedDevice.js
     — 401 kind-aware dispatch (login vs pairing);
       CA-preservation on login
mod  src/cobot_dashboard/frontend/src/App.jsx
     — wizard-wall retired; needsPair off by default;
       LoginModal mounted
mod  src/cobot_dashboard/frontend/src/components/TopBar.jsx
     — UserChip mounted in right cluster
mod  tools/fork_registry.yaml
     — jog known_debt line refresh
```
