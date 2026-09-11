# Lua Contract — Estun CC10-A Codegen Specification

**Provenance:**
- Verb whitelist derived from `src/estun_driver/estun_driver/luaenginelib.json`
  (168 verbs, controller-shipped machine-readable spec, snapshot rev
  git-tracked in this repo).
- Semantic constraints extracted from
  `docs/manuals/sw_manual_v1.pdf` §附录 C 脚本编程函数说明
  (S 系列 Gen2 软件用户手册 v1.0, 20260210, corresponds to controller
  firmware v2.2), pages 75–96.
- Wire-observed additions cross-checked against resident
  controller programs (`stopprobe`, `roboaihome`) fetched via
  `GET :9198 /api/robotcode/projectlua_<pid>_lua/select/main/`.

**Authority:** this document is the ONLY authoritative source
for codegen emit rules. `luaenginelib.json` is the syntactic
whitelist that this document layers semantics onto. Nothing
else — i18n bundles, editor highlighter tokens, factory-UI
palette — is authoritative for what may reach the controller.
See lesson `cobot-lua-verb-provenance`.

**Update ritual:** whenever `luaenginelib.json` changes on
controller upgrade OR a new S-series software manual lands,
diff both against this document in the SAME commit that lands
the new spec. Any codegen change that introduces a new emitted
verb requires this document to be updated in the same PR.

---

## 1. Wire path (recap — see `HARDWARE.md > Modbus TCP remote-control map` for the trigger side)

Codegen output flows to the controller via **four HTTP POSTs**
to `192.168.2.136:9198`. Discovered
`src/estun_driver/estun_driver/program_ops.py:5088-5148`:

1. `POST /api/robotcode/projectlua_<pid>_lua/update/<tid>/`
   body: **plain Lua 5.3 source**, `Content-Type: text/plain`
2. `POST /api/robotjson/projectlua_<pid>/update/varspoint/`
   body: JSON dict of named points (see §2)
3. `POST /api/robotjson/projectlua_<pid>/update/project/`
   body: task registry `{<tid>: {nm, tk}}`
4. `POST /api/robotjson/projectlua/update/projectlist/`
   body: project registry (MERGE — preserves other projects)

The controller runs the resident Lua on `1000 启动工程`
rising edge with slot pre-bound via 42000. See `HARDWARE.md`.

---

## 2. Point-value structures (manual §C.1.1, p.75)

Two point kinds — codegen emits both:

**apos (joint position):**
```lua
p1 = { jp = {j1,j2,j3,j4,j5,j6}, ep = {e1,e2,e3,e4,e5,e6} }
```
- `jp` — joint angles in **degrees**
- `ep` — external axis positions (zeros for our 6-DOF S10-140)

**cpos (Cartesian TCP position):**
```lua
p1 = { cp = {x,y,z,a,b,c}, rj = {j1..j6}, ep = {e1..e6} }
```
- `cp` — TCP coordinates + orientation. Position units: **mm**;
  orientation units: **degrees** per fixed-axis X-Y-Z Euler
  convention (see `HARDWARE.md > Euler / TCP conventions`).
- `rj` — reference joint angles, used to break IK ambiguity
- `ep` — external axis positions

**Codegen unit-boundary rule:** codegen and `varspoint` payloads
emit mm/degrees at the wire boundary. Internal representations
throughout `pallet_geometry.py` and executor modules use meters
and radians (see lesson `cobot-pose-unit-canon`). Convert at
emit only.

---

## 3. Motion-command `optional` parameter table (manual §C.1.2, p.75)

Any `movJ/movL/movC/movCircle/movLW/movCW/movTraj` accepts a
second `optional` table with these fields:

| Field       | Type    | Meaning                        | Units / range      | Codegen use |
|-------------|---------|--------------------------------|--------------------|-------------|
| `v`         | number  | speed                          | joint: deg/s ; cartesian: mm/s | via setSpeedJ/L modal instead |
| `a`         | number  | acceleration                   | joint: deg/s² ; cartesian: mm/s² | via setAccL modal |
| `b`         | number  | blend radius                   | mm                 | not currently used inline |
| `coor`      | int     | coordinate-system ID           | 0 = base           | typically 0 |
| `tool`      | int     | tool ID                        | 0 = flange         | typically 0 |
| `circleNum` | int     | full-circle count              | movCircle only     | not used |
| `search`    | string  | seek-condition expression      | e.g. `"DIO(1) == 1"` | not used |
| `onpercent` | table   | mid-path callback `{pct, "script"}` | e.g. `{30, "DO(3,1) DO(4,1)"}` | not used |

**Modal-vs-inline choice:** codegen prefers modal setters
(`setSpeedJ` before `movJ`) over inline optionals (`movJ(p1, {v=...})`).
Rationale: shared setSpeedJ across a burst of movJ steps produces
smaller diffs and easier operator-facing Lua. Emitted only when
value changes across steps.

---

## 4. Motion-parameter setup instructions (manual §C.2, p.76)

| Verb          | Signature       | Units    | Manual page | luaenginelib | Codegen |
|---------------|------------------|----------|-------------|--------------|---------|
| `setSpeedJ`   | `setSpeedJ(s)`   | deg/s    | 76          | ✓            | **yes** |
| `setAccJ`     | `setAccJ(a)`     | deg/s²   | 76          | ✓            | no      |
| `setSpeedL`   | `setSpeedL(s)`   | mm/s     | 76          | ✓            | **yes** |
| `setAccL`     | `setAccL(a)`     | mm/s²    | 76          | ✓            | **yes** |
| `setBlender`  | `setBlender(b)`  | mm       | 76          | **MISSING**  | **yes** (see §7) |
| `setCoor`     | `setCoor(id)`    | int      | 76          | ✓            | no      |
| `editCoor`    | `editCoor(id, {x,y,z,a,b,c})` | mm/deg | 76 | ✓ | no |
| `setTool`     | `setTool(id)`    | int      | 77          | ✓            | no      |
| `editTool`    | `editTool(id, {x,y,z,a,b,c})`  | 77          | ✓            | no      |
| `setPayload`  | `setPayload(id)` | int      | 77          | **MISSING**  | no      |
| `enableVibrationSuppression`  | `(freq, dampingRatio)` | freq 1–20, damp 0.001–1.0 (default 0.1) | 77 | ✓ | no |
| `disableVibrationSuppression` | `()`             |          | 77          | ✓            | no      |
| `setCollisionDetectionSensitivity` | `(percent)` | percent   | 77          | ✓            | no      |
| `setMoveRate` | `setMoveRate(rate)` | 1–100 | 78          | ✓            | no (Modbus 42001+1010 preferred — see HARDWARE.md) |

---

## 5. Motion instructions (manual §C.3, p.79-80)

| Verb          | Signature                       | Meaning              | Manual page | luaenginelib | Codegen |
|---------------|---------------------------------|----------------------|-------------|--------------|---------|
| `movJ`        | `movJ(p1, optional)`            | joint-move to target | 79          | ✓            | **yes** |
| `movL`        | `movL(p1, optional)`            | linear-move to target| 79          | ✓            | **yes** |
| `movC`        | `movC(p1, p2, optional)`        | arc through p1 to p2 | 79          | ✓            | no      |
| `movCircle`   | `movCircle(p1, p2, optional)`   | full circle          | 79          | ✓            | no      |
| `movLW`       | `movLW(p1, w, optional)`        | linear + weave       | 79-80       | ✓            | no      |
| `movCW`       | `movCW(p1, p2, w, optional)`    | arc + weave          | 80          | ✓            | no      |
| `movTraj`     | `movTraj(name, optional)`       | run named trajectory | 80          | **MISSING**  | no      |
| `movJCoorRel` | `movJCoorRel({cp={dx,dy,dz,da,db,dc}}, {coor, tool})` | joint-move by cartesian delta | (not in Appendix C, wire-observed) | ✓ | **yes** (wrist-lock fallback per program_ops.py §FIX-B v2) |

**Motion-state preconditions (mode ladder — apply before emitting ANY movJ/L/C):**
- Servos on (Modbus reg 2003 = 1, or `publish/RobotStatus.state = 2`)
- Auto OR Remote mode (reg 2014 = 1 OR reg 2015 = 1)
- Alarm cleared (reg 2010 = 0)
- E-stop not depressed (reg 2012 = 0)

**Zero-length guard (codegen invariant):** never emit `movL(p1)`
when `distance(current_pose, p1) < 1e-3 mm` — the controller
raises a "zero-length blend" refusal (see lesson
`cobot-link-down-honesty` §D15). Emit a no-op or fold into
adjacent step.

---

## 6. IO instructions (manual §C.5, p.87-88)

| Verb          | Signature                              | Notes                     | Manual page | luaenginelib | Codegen |
|---------------|----------------------------------------|---------------------------|-------------|--------------|---------|
| `setDO`       | `setDO(port, val)`                     | val ∈ {0, 1} — enforce   | 87          | ✓            | **yes** |
| `getDI`       | `getDI(port)` → 0/1                    | port int or "DI1"         | 87          | ✓            | **yes** |
| `getDO`       | `getDO(port)` → 0/1                    |                           | 87          | ✓            | no      |
| `setDOGroup`  | `setDOGroup(startPort, endPort, val)`  | val converts to binary    | 87          | ✓            | no      |
| `getDIGroup`  | `getDIGroup(startPort, endPort)`       | returns binary int        | 88          | ✓            | no      |
| `getDOGroup`  | `getDOGroup(startPort, endPort)`       | returns binary int        | 88          | ✓            | no      |
| `setAO`       | `setAO(port, val)`                     | val = float amps/volts    | 88          | ✓            | **yes** |
| `getAI`       | `getAI(port)` → float                  |                           | 88          | ✓            | no      |
| `getAO`       | `getAO(port)` → float                  |                           | 88          | ✓            | no      |
| `waitCondition` | `waitCondition(condition, timeout)` | blocks until condition or timeout | (not in Appendix C) | ✓ | **yes** |

---

## 7. Wire-proven-undocumented verbs

Three verbs the codegen emits that are NOT in `luaenginelib.json`.
Kept behind an explicit allowlist at
`src/estun_driver/estun_driver/program_ops.py:810` (`_WIRE_PROVEN_UNDOCUMENTED`).

| Verb           | Codegen use | Wire evidence | Manual coverage | Recommendation |
|----------------|-------------|----------------|------------------|----------------|
| `setBlender`   | modal blend radius (SMOOTH profile) | resident programs use it; controller executes cleanly | **documented** manual §C.2 p.76 as `setBlender(b)` mm | **Fix `luaenginelib.json`** — this verb IS official; the library is stale. File a controller-side patch request and add a local override entry in the codegen contract loader. |
| `setNoBlender` | modal blend clear | resident programs use it | UNDOCUMENTED in manual | **Migrate to `setBlender(0)`** — mm=0 is the documented "no blend" case. Kill `setNoBlender` from the codegen. |
| `wait`         | dwell + timing | codegen only — no resident program uses `wait`; resident `stopprobe` uses `sys.sleep(5)` | UNDOCUMENTED in manual (Appendix C has no timing verb) | **Migrate to `sys.sleep(n)`** — wire-observed in resident programs, matches Lua standard library. Kill `wait` from the codegen. |

Migration plan is codegen-only (no wire behavior change); a
regression byte-diff before/after the swap must show only the
verb-name change per emitted step.

---

## 8. Complete verb whitelist — 168 entries

Source: `luaenginelib.json`. Reproduced here so the contract is
grep-able without also opening the JSON. If the JSON changes,
regenerate this table via `scripts/regen_lua_contract.py` (owed).

### Codegen-active verbs (10, in-library)

| Verb | Required args | Optional args | Canonical template |
|------|---------------|----------------|---------------------|
| `movJ` | p1 | vv, av | `movJ(p1)` |
| `movL` | p1 | vv, av | `movL(p1)` |
| `movJCoorRel` | — | vv, av | `movJCoorRel($1)` |
| `setSpeedJ` | vvd | — | `setSpeedJ(${vvd})` |
| `setSpeedL` | vvd | — | `setSpeedL(${vvd})` |
| `setAccL` | avd | — | `setAccL(${avd})` |
| `setDO` | port | — | `setDO($1,$2)` |
| `setAO` | port | — | `setAO($1,$2)` |
| `getDI` | port, var | — | `$2 = getDI($1)` |
| `waitCondition` | var | — | `${var} = waitCondition(${condition},${timeout})` |

### Remaining 158 library verbs (codegen may not emit without explicit contract addition)

See `luaenginelib.json` — every top-level key is an accepted
verb name. Highlights (grouped by manual appendix section):

- **Math / arithmetic** (C.4): `arrayAdd`, `arraySub`, `arrayToStr`,
  `acos`, `asin`, `atan`, `atan2`, `cos`, `sin`, `tan`, `distance`,
  `interPos`, `posInverse`, `planeTrans`
- **Kinematics / coord** (C.4): `getJoint`, `getTCP`, `aposToCpos`,
  `cposToApos`, `cposToCpos`, `getCoor`, `getToor`, `coorTrans`,
  `userOffset`, `toolOffset`, `coorRel`, `toolRel`, `jointRel`,
  `getJointTorque`, `getJointExternalTorque`
- **Tray / palletize** (C.4): `createTray`, `getTrayPos`,
  `createSingleWeldTemplate`, `createMultiWeld`, `weldSingle`,
  `weldMulti`, `palletizerRun`, `setLeftPallet`, `setRightPallet`
- **Trajectory** (C.4): `getTrajStart`, `getTrajEnd`
- **Motion setup** (C.2): `setAccJ`, `setCoor`, `editCoor`, `setTool`,
  `editTool`, `enableVibrationSuppression`, `disableVibrationSuppression`,
  `setCollisionDetectionSensitivity`, `initComplianceControl`,
  `enableComplianceControl`, `disableComplianceControl`,
  `forceControlZeroCalibrate`, `setFilterPeriod`, `searchSuccessed`,
  `setMoveRate`
- **IO** (C.5): `getDO`, `setDOGroup`, `getDIGroup`, `getDOGroup`,
  `getAI`, `getAO`
- **Socket** (C.6): `createSocketClient`, `connectSocketClient`,
  `writeSocketClient`, `readSocketClient`, `closeSocketClient`,
  `createSocketServer`, `waitConnectSocketServer`, `writeSocketServer`,
  `readSocketServer`, `closeSocketServer`,
  `writeByteSocketClient`, `writeByteSocketServer`
- **Modbus master** (C.7): (implicit via `ModbusTCP.alias = value` sugar
  — NOT function-form. Codegen does not currently use this.)
- **Register-block** (C.8): `getRegisterBool`, `setRegisterBool`,
  `getRegisterInt`, `setRegisterInt`, `getRegisterFloat`,
  `setRegisterFloat`, `getExtendArrayData`
- **RS485** (C.9): `RS485init`, `RS485flush`, `RS485write`, `RS485read`
- **Control flow** (Lua stdlib): `break`, `if`, `elseif`, `else`,
  `for`, `while`, `repeat`, `goto`
- **Bit / string / utility**: `bitAnd`, `bitOr`, `bitXOr`, `bitNot`,
  `bitLSH`, `bitRSH`, `ByteWrapper`, `bwadd`, `bwappend`, `bwcopy`,
  `bwget`, `bwset`, `bwsize`, `bwresize`, `bwprintByte`,
  `bwsetBigEndian`, `bwsetLittleEndian`, `append`,
  `writeSingleCoil`, `writeMultipleCoils`, `writeSingleRegister`,
  `writeMultipleRegisters`, `readCoils`, `readDiscreteInputs`,
  `readHoldingRegisters`, `readInputRegisters`, `callModule`,
  `setConveyorOffset`, `print`, `popUp`, `movAS`, `movAST`, `movLW`

(For any verb NOT explicitly listed above that appears in
`luaenginelib.json`, treat as **library-known, codegen-inactive**
— safe as a lint whitelist entry, requires this doc update and
manual-page citation to become a codegen emit-site.)

---

## 9. Validation pipeline (codegen → wire)

```
    taught step
        │
        ▼
  ┌──────────────────────┐
  │  1. Contract lookup  │   verb ∈ (luaenginelib + wire-proven-undocumented allowlist)
  │                      │   arity + required-arg check
  │                      │   optional-arg range check (§3, §4)
  │                      │   unit-boundary conversion (§2 mm/deg wire, meters/rad internal)
  └───────────┬──────────┘
              │
              ▼
  ┌──────────────────────┐
  │  2. Emit             │   f-string template fill (until refactored to
  │                      │   pull from luaenginelib.json `lua` field directly)
  └───────────┬──────────┘
              │
              ▼
  ┌──────────────────────┐
  │  3. Syntax gate      │   liblua5.3 `luaL_loadstring` — must return 0
  │                      │   error surfaces `[string ...]:LINE:COL:` context
  └───────────┬──────────┘
              │
              ▼
  ┌──────────────────────┐
  │  4. Semantic lint    │   existing luaenginelib-based validator
  │                      │   (D14 pending-pose, arity quarantine,
  │                      │    _KNOWN_BAD_PATTERNS, mov* v.size()>=6 etc)
  └───────────┬──────────┘
              │
              ▼
  ┌──────────────────────┐
  │  5. HTTP POST (§1)   │   Lua source + varspoint + project + projectlist
  └───────────┬──────────┘
              │
              ▼
  ┌──────────────────────┐
  │  6. Round-trip verify│   GET /api/robotcode/.../select/<tid>/
  │                      │   byte-diff MUST match the emitted text
  │                      │   (already in place — Part G)
  └──────────────────────┘
```

**Fail-closed semantics:** any stage refusal terminates the save
BEFORE stage 5 (network); the operator sees a named refusal via
the outcome-copy layer (`namedLoadError`, `namedSaveError`).
No stage may be bypassed without an explicit env-var + operator
override (`ESTUN_BYPASS_LUA_CONTRACT=1`, off by default, telemetry
alert if used).

**Syntax gate implementation** (§9 stage 3): `liblua5.3.so.0` via
ctypes calling `luaL_loadstring`. No `luac` binary install
required. See `src/estun_driver/estun_driver/lua_syntax_gate.py`
(owed by task #15).

---

## 10. Known deviations / open items

- **`setBlender` in library:** `luaenginelib.json` is missing this
  documented verb. Filed as codegen-side override; upstream
  library patch owed.
- **`setPayload` in library:** manual documents it (p.77); library
  is missing. Not currently a codegen dependency — noted for
  future adoption when payload wiring lands (see `cobot-nanoowl`
  hardware note re payload UNSET warnings in `roboaihome`).
- **`movTraj` in library:** manual documents (p.80); library
  missing. Future adoption if we ship trajectory-file execution.
- **`wait` migration to `sys.sleep`:** codegen-only change, tracked
  as a follow-up. When landed, wire behavior identical, diffs
  are name-only.
- **`setNoBlender` migration to `setBlender(0)`:** same as above.
