"""Custom End-of-Arm Tool library — 2026-09-08.

One tool = /opt/cobot/tools/<tool_id>/ with:
  * original.step                  — the operator-uploaded STEP file
  * mesh.glb                       — cascadio-converted viewer mesh
  * tool.json                      — metadata:
      {
        "id":             "<tool_id>",
        "name":           "<operator name>",
        "mesh_asset":     "mesh.glb",
        "mount_transform":{"tx":0,"ty":0,"tz":0,"rx":0,"ry":0,"rz":0},
        "tcp_offset":     {"x":0,"y":0,"z":0,"rx":0,"ry":0,"rz":0},
        "payload_kg":     null,        # populated by wizard step 3d
        "confirmed":      false,       # wizard flips true on finish
        "conversion":     {
            "state":    "pending|converting|converted|failed",
            "error":    null,
            "started":  "<iso>",
            "finished": "<iso>|null",
            "duration_ms": null,
            "src_bytes":  null,
            "glb_bytes":  null,
        },
        "created":        "<iso>",
        "updated":        "<iso>",
      }

Delete follows the same .deleted safeguard pattern the program store
uses (dashboard_server.py:6620): move the entire tool_id directory
into /opt/cobot/tools/.deleted/<tool_id>.<utc_ts>/, prune to
TOOLS_TRASH_CAP most-recent entries.

Conversion runs in a threadpool (cascadio is already installed at 608
KB; smoke-tested at 78 ms for a 37 KB STEP → 23 KB GLB on Jetson). If
the emitted GLB exceeds MESH_TARGET_BYTES, trimesh decimates it in a
second pass. Named refusal on unparseable STEP files:
`"couldn't read this STEP file"`.

Payload_kg is CONFIG-ONLY (per operator directive 2026-09-08): the
luaenginelib.json has no setPayload verb, so payload flows through
program.config into the collision monitor + motion_profile scaling —
no motion verb is emitted. This module holds the payload alongside
the tool for programs that reference tool_id.
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import tempfile
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import Optional


TOOLS_DIR = os.environ.get('COBOT_TOOLS_DIR', '/opt/cobot/tools')
TOOLS_TRASH_DIR = os.path.join(TOOLS_DIR, '.deleted')
TOOLS_TRASH_CAP = 20

# Mesh size ceiling for the served .glb — decimate if the raw
# cascadio output exceeds this. 5 MB per directive item 2.
MESH_TARGET_BYTES = 5 * 1024 * 1024

# Max upload size — refuse before writing to disk.
MAX_STEP_UPLOAD_BYTES = 50 * 1024 * 1024

# Named refusal copy — the operator-visible messages are canonical
# and pinned in tests. Never expose Python exception detail.
REFUSE_UNPARSEABLE = "couldn't read this STEP file"
REFUSE_TOO_LARGE = "STEP file is larger than the 50 MB upload limit"
REFUSE_NOT_STEP = "this doesn't look like a STEP file (expected .step or .stp)"
REFUSE_UNKNOWN_TOOL = "no tool with that id"
REFUSE_MISSING_TCP = "the robot needs to know where this tool works"
REFUSE_MISSING_PAYLOAD = "payload is required so the robot can plan safe motion"

# Global thread lock guarding _INDEX / on-disk writes for a given
# tool_id. cascadio work runs OUTSIDE this lock.
_LOCK = threading.RLock()
_CONVERT_POOL = ThreadPoolExecutor(
    max_workers=2, thread_name_prefix='tools-convert')


def _utcnow_iso() -> str:
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def _new_tool_id() -> str:
    # 8-char hex — matches program_id shape and gives 2^32 slots.
    return secrets.token_hex(4)


def _tool_dir(tool_id: str) -> str:
    return os.path.join(TOOLS_DIR, tool_id)


def _tool_json_path(tool_id: str) -> str:
    return os.path.join(_tool_dir(tool_id), 'tool.json')


def _validate_tool_id(tool_id: str) -> None:
    """Reject anything that isn't a hex id — this prevents path
    traversal (../, absolute paths, dotfiles). The .deleted dir is
    the ONLY dot-prefixed entry we tolerate; listings filter it out."""
    if not tool_id or not isinstance(tool_id, str):
        raise ValueError('tool_id required')
    if not all(c in '0123456789abcdef' for c in tool_id):
        raise ValueError(f'invalid tool_id: {tool_id!r}')
    if not (8 <= len(tool_id) <= 32):
        raise ValueError(f'invalid tool_id length: {tool_id!r}')


def _atomic_write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        prefix='.tool_json_', suffix='.tmp',
        dir=os.path.dirname(path))
    try:
        with os.fdopen(fd, 'w') as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _read_tool_json(tool_id: str) -> dict:
    _validate_tool_id(tool_id)
    p = _tool_json_path(tool_id)
    if not os.path.isfile(p):
        raise FileNotFoundError(REFUSE_UNKNOWN_TOOL)
    with open(p) as fh:
        return json.load(fh)


def _write_tool_json(tool_id: str, doc: dict) -> None:
    doc['updated'] = _utcnow_iso()
    _atomic_write_json(_tool_json_path(tool_id), doc)


def list_tools() -> list:
    """List every non-deleted tool. Sorted by created descending.
    Each entry is the full tool.json doc — the caller decides which
    fields to render."""
    if not os.path.isdir(TOOLS_DIR):
        return []
    out = []
    for entry in os.listdir(TOOLS_DIR):
        if entry.startswith('.'):
            continue
        try:
            _validate_tool_id(entry)
        except ValueError:
            continue
        try:
            doc = _read_tool_json(entry)
        except (FileNotFoundError, json.JSONDecodeError):
            continue
        out.append(doc)
    out.sort(key=lambda d: d.get('created', ''), reverse=True)
    return out


def get_tool(tool_id: str) -> dict:
    return _read_tool_json(tool_id)


def get_tool_mesh_path(tool_id: str) -> str:
    doc = _read_tool_json(tool_id)
    asset = doc.get('mesh_asset') or 'mesh.glb'
    if '/' in asset or asset.startswith('.'):
        raise ValueError(f'invalid mesh_asset in tool.json: {asset!r}')
    p = os.path.join(_tool_dir(tool_id), asset)
    if not os.path.isfile(p):
        raise FileNotFoundError(p)
    return p


def create_tool_from_step(name: str, step_bytes: bytes,
                          filename: str) -> str:
    """Create a NEW tool from an uploaded STEP file. Returns tool_id.
    Conversion runs async — poll get_tool(tool_id)['conversion']['state'].

    Refuses on:
      * empty name           → ValueError('name required')
      * file larger than 50 MB → ValueError(REFUSE_TOO_LARGE)
      * suffix not .step/.stp  → ValueError(REFUSE_NOT_STEP)
    """
    if not name or not str(name).strip():
        raise ValueError('name required')
    if not step_bytes:
        raise ValueError('empty upload')
    if len(step_bytes) > MAX_STEP_UPLOAD_BYTES:
        raise ValueError(REFUSE_TOO_LARGE)
    low = (filename or '').lower()
    if not (low.endswith('.step') or low.endswith('.stp')):
        raise ValueError(REFUSE_NOT_STEP)

    tool_id = _new_tool_id()
    d = _tool_dir(tool_id)
    os.makedirs(d, exist_ok=True)
    step_path = os.path.join(d, 'original.step')
    with open(step_path, 'wb') as fh:
        fh.write(step_bytes)
        fh.flush()
        os.fsync(fh.fileno())

    now = _utcnow_iso()
    doc = {
        'id': tool_id,
        'name': str(name).strip(),
        'mesh_asset': 'mesh.glb',
        'mount_transform': {
            'tx': 0.0, 'ty': 0.0, 'tz': 0.0,
            'rx': 0.0, 'ry': 0.0, 'rz': 0.0,
        },
        'tcp_offset': {
            'x': 0.0, 'y': 0.0, 'z': 0.0,
            'rx': 0.0, 'ry': 0.0, 'rz': 0.0,
        },
        'payload_kg': None,
        'confirmed': False,
        'conversion': {
            'state': 'pending',
            'error': None,
            'started': now,
            'finished': None,
            'duration_ms': None,
            'src_bytes': len(step_bytes),
            'glb_bytes': None,
        },
        'created': now,
        'updated': now,
    }
    _write_tool_json(tool_id, doc)
    _CONVERT_POOL.submit(_convert_worker, tool_id)
    return tool_id


def _convert_worker(tool_id: str) -> None:
    """Background: STEP → GLB via cascadio, optional decimation via
    trimesh. Updates tool.json.conversion.state on entry and exit.
    Never raises — errors land in conversion.error."""
    try:
        with _LOCK:
            doc = _read_tool_json(tool_id)
            doc['conversion']['state'] = 'converting'
            _write_tool_json(tool_id, doc)
    except Exception as e:
        print(f'[tools] {tool_id} pre-convert read failed: '
              f'{type(e).__name__}: {e}', flush=True)
        return

    d = _tool_dir(tool_id)
    step_path = os.path.join(d, 'original.step')
    glb_path = os.path.join(d, 'mesh.glb')
    t0 = time.perf_counter()
    err = None
    try:
        import cascadio  # local import — heavy at process start
        cascadio.step_to_glb(step_path, glb_path)
        if not os.path.isfile(glb_path):
            raise RuntimeError('cascadio produced no output')
        glb_bytes = os.path.getsize(glb_path)
        if glb_bytes > MESH_TARGET_BYTES:
            _decimate_glb(glb_path)
            glb_bytes = os.path.getsize(glb_path)
    except Exception as e:
        # Refuse by name — never leak Python detail to the operator.
        err = REFUSE_UNPARSEABLE
        print(f'[tools] {tool_id} convert failed: '
              f'{type(e).__name__}: {e}\n{traceback.format_exc()}',
              flush=True)
        glb_bytes = None

    dur_ms = int((time.perf_counter() - t0) * 1000)
    try:
        with _LOCK:
            doc = _read_tool_json(tool_id)
            doc['conversion']['state'] = 'converted' if err is None else 'failed'
            doc['conversion']['error'] = err
            doc['conversion']['finished'] = _utcnow_iso()
            doc['conversion']['duration_ms'] = dur_ms
            doc['conversion']['glb_bytes'] = glb_bytes
            _write_tool_json(tool_id, doc)
    except Exception as e:
        print(f'[tools] {tool_id} post-convert write failed: '
              f'{type(e).__name__}: {e}', flush=True)


def _decimate_glb(glb_path: str) -> None:
    """Second-pass mesh decimation when cascadio's default tessellation
    lands above MESH_TARGET_BYTES. Uses trimesh's built-in simplify
    (assimp binding). Best-effort: if simplify fails, leave the raw
    mesh in place — a large-but-valid glb is preferable to none."""
    try:
        import trimesh
        scene = trimesh.load(glb_path)
        # trimesh.load can return Scene or Trimesh depending on input.
        # simplify_quadric_decimation exists on Trimesh only.
        if isinstance(scene, trimesh.Scene):
            for name, geom in list(scene.geometry.items()):
                try:
                    scene.geometry[name] = geom.simplify_quadric_decimation(
                        face_count=max(1500, len(geom.faces) // 3))
                except Exception:
                    pass
            scene.export(glb_path)
        else:
            simplified = scene.simplify_quadric_decimation(
                face_count=max(1500, len(scene.faces) // 3))
            simplified.export(glb_path)
    except Exception as e:
        print(f'[tools] decimation skipped ({type(e).__name__}: {e})',
              flush=True)


def update_mount_transform(tool_id: str, mt: dict) -> dict:
    """Update mount_transform. UI-side, does NOT affect motion — no
    retro-edit guard required (per operator directive item 7 —
    display/geometry work is not motion-affecting)."""
    with _LOCK:
        doc = _read_tool_json(tool_id)
        doc['mount_transform'] = _coerce_mount(mt)
        _write_tool_json(tool_id, doc)
        return doc


def update_tcp(tool_id: str, tcp: dict) -> dict:
    """Update tcp_offset. MOTION-AFFECTING — the caller is responsible
    for surfacing the retro-edit confirm modal via
    programs_referencing_tool() BEFORE calling this. This function
    itself only writes; the guard lives at the endpoint layer."""
    with _LOCK:
        doc = _read_tool_json(tool_id)
        doc['tcp_offset'] = _coerce_tcp(tcp)
        _write_tool_json(tool_id, doc)
        return doc


def update_payload(tool_id: str, payload_kg) -> dict:
    """Update payload_kg. Motion-affecting via config-only path
    (collision monitor + motion_profile scaling read this)."""
    kg = _coerce_payload(payload_kg)
    if kg is None:
        raise ValueError(REFUSE_MISSING_PAYLOAD)
    with _LOCK:
        doc = _read_tool_json(tool_id)
        doc['payload_kg'] = kg
        _write_tool_json(tool_id, doc)
        return doc


def confirm_tool(tool_id: str) -> dict:
    """Wizard step (e): flip confirmed:true. Refuses if TCP or
    payload_kg is still unset — those are mandatory per directive
    3(c) + 3(d)."""
    with _LOCK:
        doc = _read_tool_json(tool_id)
        tcp = doc.get('tcp_offset') or {}
        if not any(abs(float(tcp.get(k, 0) or 0)) > 1e-9
                   for k in ('x', 'y', 'z')):
            # All zeros = the wizard default = TCP never set.
            # Refuse with the operator-visible copy.
            raise ValueError(REFUSE_MISSING_TCP)
        if doc.get('payload_kg') in (None, ''):
            raise ValueError(REFUSE_MISSING_PAYLOAD)
        doc['confirmed'] = True
        _write_tool_json(tool_id, doc)
        return doc


def delete_tool(tool_id: str) -> dict:
    """Soft-delete: move the tool_id directory into .deleted/ with a
    utc timestamp suffix. Prunes trash to TOOLS_TRASH_CAP most-recent
    entries. Mirrors the program-delete safeguard at
    dashboard_server.py:6640."""
    with _LOCK:
        _validate_tool_id(tool_id)
        src = _tool_dir(tool_id)
        if not os.path.isdir(src):
            raise FileNotFoundError(REFUSE_UNKNOWN_TOOL)
        os.makedirs(TOOLS_TRASH_DIR, exist_ok=True)
        ts = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        dest = os.path.join(TOOLS_TRASH_DIR, f'{tool_id}.{ts}')
        os.rename(src, dest)
        _prune_trash()
        return {'tool_id': tool_id, 'trashed_to': dest, 'ts': ts}


def _prune_trash() -> None:
    if not os.path.isdir(TOOLS_TRASH_DIR):
        return
    try:
        entries = []
        for fn in os.listdir(TOOLS_TRASH_DIR):
            full = os.path.join(TOOLS_TRASH_DIR, fn)
            if not os.path.isdir(full):
                continue
            try:
                entries.append((os.path.getmtime(full), full))
            except OSError:
                continue
        if len(entries) <= TOOLS_TRASH_CAP:
            return
        entries.sort(reverse=True)
        for _, full in entries[TOOLS_TRASH_CAP:]:
            try:
                shutil.rmtree(full)
            except OSError as e:
                print(f'[tools] prune {full!r} failed: '
                      f'{type(e).__name__}: {e}', flush=True)
    except Exception as e:
        print(f'[tools] prune sweep failed: '
              f'{type(e).__name__}: {e}', flush=True)


def programs_referencing_tool(tool_id: str,
                              programs_dir: str = '/opt/cobot/programs') -> list:
    """Return [{id, name}, ...] for every non-deleted program whose
    config.tool_id == tool_id. Powers the retro-edit guard (directive
    item 7): 'N programs use this tool; their motion targets will
    change.' The scan reads only <id>.json files (line_map sidecars
    are excluded by suffix)."""
    _validate_tool_id(tool_id)
    if not os.path.isdir(programs_dir):
        return []
    out = []
    for fn in os.listdir(programs_dir):
        if fn.startswith('.'):
            continue
        if not fn.endswith('.json'):
            continue
        if fn.endswith('.line_map.json'):
            continue
        full = os.path.join(programs_dir, fn)
        try:
            with open(full) as fh:
                doc = json.load(fh)
        except (OSError, json.JSONDecodeError):
            continue
        cfg = doc.get('config') or {}
        if cfg.get('tool_id') != tool_id:
            continue
        out.append({
            'id':   doc.get('id') or fn[:-len('.json')],
            'name': doc.get('name') or fn[:-len('.json')],
        })
    out.sort(key=lambda r: (r.get('name') or '').lower())
    return out


# ---------- coercion helpers ---------------------------------------

def _coerce_mount(mt: dict) -> dict:
    """Mount transform is limited to 90° rotation steps + mm nudges
    (directive item 3b). Coerce rotations to the nearest multiple of
    π/2 in radians so downstream math treats them as exact. Nudges
    are stored in METERS internally (matches program pose_unit_canon
    memory) so the frontend must send mm-to-m converted values."""
    if not isinstance(mt, dict):
        raise ValueError('mount_transform must be an object')
    out = {}
    HALF_PI = 3.141592653589793 / 2.0
    for k in ('tx', 'ty', 'tz'):
        try:
            out[k] = float(mt.get(k, 0.0) or 0.0)
        except (TypeError, ValueError):
            out[k] = 0.0
    for k in ('rx', 'ry', 'rz'):
        try:
            raw = float(mt.get(k, 0.0) or 0.0)
        except (TypeError, ValueError):
            raw = 0.0
        # Snap to nearest π/2 multiple.
        steps = round(raw / HALF_PI)
        out[k] = steps * HALF_PI
    return out


def _coerce_tcp(tcp: dict) -> dict:
    """TCP offset — no rotation snap (arbitrary orientation allowed
    for the tool-working point). METERS + RADIANS internally per
    pose-unit canon memory."""
    if not isinstance(tcp, dict):
        raise ValueError('tcp_offset must be an object')
    out = {}
    for k in ('x', 'y', 'z', 'rx', 'ry', 'rz'):
        try:
            out[k] = float(tcp.get(k, 0.0) or 0.0)
        except (TypeError, ValueError):
            out[k] = 0.0
    return out


def _coerce_payload(v) -> Optional[float]:
    if v is None or v == '':
        return None
    try:
        kg = float(v)
    except (TypeError, ValueError):
        return None
    if kg < 0 or kg > 500:
        return None
    return kg
