"""Proprietary distillation dataset for Programming by Demonstration.

Captures the full input → AI output → human-corrected truth tuple for
every demonstration so a future on-Jetson model can be fine-tuned on
RoboAi's own data. Storage is LOCAL ONLY (/opt/cobot/demonstrations/);
the API receives only the current demonstration's frames+transcript
for interpretation — never the accumulated corpus, never prior
demonstrations' video.

Layout per demo (constant — downstream tooling depends on it):

  /opt/cobot/demonstrations/{demo_id}/
    video.{ext}              original upload
    audio_transcript.txt     Whisper output
    frames/                  sampled frames (the ones sent to the backend)
    structured_intent.json   the AI's grounded interpretation
    program_draft.json       the generated draft program
    human_corrected.json     post-review corrected program (null until reviewed)
    backend_used.json        which backend/model + data provenance
    metadata.json            timestamp, parts, ops, ambiguities, correction flag

Index: /opt/cobot/demonstrations/index.db  (SQLite, single table).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import shutil
import sqlite3
from typing import Any, Dict, Iterable, List, Optional

from .utils import ensure_dir, now_iso, demo_dir


# ── Schema for the index ───────────────────────────────────────────

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS demonstrations (
    demo_id           TEXT PRIMARY KEY,
    created_iso       TEXT NOT NULL,
    updated_iso       TEXT NOT NULL,
    task_summary      TEXT,
    transcript        TEXT,
    backend_id        TEXT,
    transited_externally INTEGER NOT NULL DEFAULT 0,
    part_ids          TEXT,     -- JSON list
    operations        TEXT,     -- JSON list
    confidence        REAL,
    ambiguities       TEXT,     -- JSON list
    correction_made   INTEGER NOT NULL DEFAULT 0,
    program_id        TEXT      -- slug under /opt/cobot/programs if saved
);
CREATE INDEX IF NOT EXISTS demos_created_idx ON demonstrations (created_iso);
CREATE INDEX IF NOT EXISTS demos_correction_idx ON demonstrations (correction_made);
"""


class LearningStore:
    def __init__(self, root: str = '/opt/cobot/demonstrations'):
        self.root = root
        ensure_dir(self.root)
        self._index_path = os.path.join(self.root, 'index.db')
        self._init_index()

    # ── Index ───────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._index_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _init_index(self) -> None:
        with self._connect() as conn:
            conn.executescript(_SCHEMA_SQL)

    # ── Layout helpers ─────────────────────────────────────────────

    def dir_for(self, demo_id: str) -> str:
        return demo_dir(self.root, demo_id)

    def ensure_demo_dir(self, demo_id: str) -> str:
        d = self.dir_for(demo_id)
        ensure_dir(d)
        ensure_dir(os.path.join(d, 'frames'))
        return d

    # ── Write hooks (one per stage of the pipeline) ────────────────

    def save_upload(self, demo_id: str, src_video_path: str,
                    original_filename: str = 'upload.mp4') -> str:
        d = self.ensure_demo_dir(demo_id)
        ext = os.path.splitext(original_filename)[1].lower() or '.mp4'
        target = os.path.join(d, f'video{ext}')
        shutil.copyfile(src_video_path, target)
        return target

    def save_transcript(self, demo_id: str, transcript: Dict[str, Any]) -> None:
        d = self.ensure_demo_dir(demo_id)
        with open(os.path.join(d, 'audio_transcript.txt'), 'w') as f:
            f.write(transcript.get('text') or '')
        with open(os.path.join(d, 'audio_transcript.json'), 'w') as f:
            json.dump(transcript, f, indent=2)

    def save_intent(self, demo_id: str, intent_dict: Dict[str, Any]) -> None:
        d = self.ensure_demo_dir(demo_id)
        with open(os.path.join(d, 'structured_intent.json'), 'w') as f:
            json.dump(intent_dict, f, indent=2)

    def save_draft(self, demo_id: str, draft_payload: Dict[str, Any]) -> None:
        d = self.ensure_demo_dir(demo_id)
        with open(os.path.join(d, 'program_draft.json'), 'w') as f:
            json.dump(draft_payload, f, indent=2)

    def save_backend_used(self, demo_id: str, backend_id: str,
                          transited_externally: bool,
                          extra: Optional[Dict[str, Any]] = None) -> None:
        d = self.ensure_demo_dir(demo_id)
        payload = {
            'backend_id':           backend_id,
            'transited_externally': bool(transited_externally),
            'recorded_at':          now_iso(),
        }
        if extra:
            payload['extra'] = extra
        with open(os.path.join(d, 'backend_used.json'), 'w') as f:
            json.dump(payload, f, indent=2)

    def save_metadata(self, demo_id: str, meta: Dict[str, Any]) -> None:
        d = self.ensure_demo_dir(demo_id)
        meta = dict(meta or {})
        meta.setdefault('updated_at', now_iso())
        with open(os.path.join(d, 'metadata.json'), 'w') as f:
            json.dump(meta, f, indent=2)
        self._upsert_index_from_meta(demo_id, meta)

    def save_correction(self, demo_id: str, corrected_program: Dict[str, Any],
                        program_id: Optional[str] = None,
                        corrected_scene: Optional[Dict[str, Any]] = None,
                        corrected_intent: Optional[Dict[str, Any]] = None) -> None:
        """Write the human-corrected program — the highest-value signal
        for training the future local model. ALWAYS write the file even
        if it matches the draft exactly (confirms the AI was right).

        `corrected_scene` (optional) is the operator-corrected Scene
        block — captured separately so the future local model can train
        on scene-extraction targets, not just the final program.
        `corrected_intent` (optional) is the full intent object the
        operator confirmed; we persist it under the same demo dir."""
        d = self.ensure_demo_dir(demo_id)
        payload = {
            'corrected_at':      now_iso(),
            'program':           corrected_program,
            'program_id':        program_id,
        }
        if corrected_scene is not None:
            payload['scene'] = corrected_scene
        if corrected_intent is not None:
            payload['intent'] = corrected_intent
        with open(os.path.join(d, 'human_corrected.json'), 'w') as f:
            json.dump(payload, f, indent=2)
        # Mark the index correction-made + record the saved program id.
        with self._connect() as conn:
            conn.execute(
                'UPDATE demonstrations '
                'SET correction_made=1, updated_iso=?, program_id=? '
                'WHERE demo_id=?',
                (now_iso(), program_id, demo_id),
            )

    # ── Read hooks ─────────────────────────────────────────────────

    def load_all_files(self, demo_id: str) -> Dict[str, Any]:
        d = self.dir_for(demo_id)
        out: Dict[str, Any] = {'demo_id': demo_id, 'dir': d, 'exists': os.path.isdir(d)}
        if not out['exists']:
            return out
        out['files'] = sorted(os.listdir(d))
        for fname, key in [
            ('structured_intent.json', 'structured_intent'),
            ('program_draft.json',     'program_draft'),
            ('human_corrected.json',   'human_corrected'),
            ('backend_used.json',      'backend_used'),
            ('metadata.json',          'metadata'),
        ]:
            path = os.path.join(d, fname)
            if os.path.isfile(path):
                try:
                    with open(path) as f:
                        out[key] = json.load(f)
                except Exception:
                    out[key] = None
        tpath = os.path.join(d, 'audio_transcript.txt')
        if os.path.isfile(tpath):
            with open(tpath) as f:
                out['transcript'] = f.read()
        return out

    def list_demos(self, limit: int = 200) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                'SELECT * FROM demonstrations '
                'ORDER BY created_iso DESC LIMIT ?', (int(limit),),
            ).fetchall()
        return [dict(r) for r in rows]

    def iter_corrected_entries(self) -> Iterable[Dict[str, Any]]:
        """Yield {demo_id, transcript, part_ids, operations,
        task_summary, corrected_program} entries — used by retrieval_augment
        to build the few-shot example pool. Only entries with a saved
        human_corrected.json are included (vetted truth only)."""
        with self._connect() as conn:
            rows = conn.execute(
                'SELECT demo_id, transcript, task_summary, part_ids, operations '
                'FROM demonstrations WHERE correction_made=1 '
                'ORDER BY created_iso DESC'
            ).fetchall()
        for r in rows:
            corrected_path = os.path.join(self.dir_for(r['demo_id']),
                                          'human_corrected.json')
            if not os.path.isfile(corrected_path):
                continue
            try:
                with open(corrected_path) as f:
                    payload = json.load(f) or {}
            except Exception:
                continue
            yield {
                'demo_id':       r['demo_id'],
                'transcript':    r['transcript'] or '',
                'task_summary':  r['task_summary'] or '',
                'part_ids':      json.loads(r['part_ids'] or '[]'),
                'operations':    json.loads(r['operations'] or '[]'),
                'corrected_program': payload.get('program') or {},
            }

    # ── Stats / export ─────────────────────────────────────────────

    def stats(self) -> Dict[str, Any]:
        with self._connect() as conn:
            total = conn.execute(
                'SELECT COUNT(*) FROM demonstrations').fetchone()[0]
            corrected = conn.execute(
                'SELECT COUNT(*) FROM demonstrations WHERE correction_made=1'
            ).fetchone()[0]
            external = conn.execute(
                'SELECT COUNT(*) FROM demonstrations WHERE transited_externally=1'
            ).fetchone()[0]
            ops_rows = conn.execute(
                'SELECT operations FROM demonstrations').fetchall()
            parts_rows = conn.execute(
                'SELECT part_ids FROM demonstrations').fetchall()
        op_counts: Dict[str, int] = {}
        for r in ops_rows:
            for o in json.loads(r['operations'] or '[]'):
                op_counts[o] = op_counts.get(o, 0) + 1
        part_counts: Dict[str, int] = {}
        for r in parts_rows:
            for p in json.loads(r['part_ids'] or '[]'):
                part_counts[p] = part_counts.get(p, 0) + 1
        return {
            'total_demonstrations': int(total),
            'corrected':            int(corrected),
            'correction_rate':      (corrected / total) if total else 0.0,
            'externally_processed': int(external),
            'operations_seen':      op_counts,
            'parts_seen':           part_counts,
            'root':                 self.root,
        }

    def export_training_bundle(self, out_path: str) -> Dict[str, Any]:
        """Write a single JSONL file where each line is one supervised
        training example:

            { "input":  { transcript, frames_count, parts_library_snapshot,
                          context, retrieved_examples (snapshot) },
              "target": { corrected_program },
              "meta":   { demo_id, created_iso, backend_id, ambiguities,
                          correction_made } }

        Only correction_made=1 entries are exported (vetted truth)."""
        n = 0
        with open(out_path, 'w') as out:
            for entry in self.iter_corrected_entries():
                files = self.load_all_files(entry['demo_id'])
                row = {
                    'input': {
                        'transcript':            entry['transcript'],
                        'task_summary':          entry['task_summary'],
                        'parts_library_snapshot':
                            (files.get('structured_intent') or {}).get(
                                'raw_understanding_notes', ''),
                        'retrieved_examples': (
                            (files.get('metadata') or {}).get('retrieval', {})
                            .get('used_examples', [])
                        ),
                    },
                    'target': {
                        'corrected_program': entry['corrected_program'],
                    },
                    'meta': {
                        'demo_id':         entry['demo_id'],
                        'created_iso':     (files.get('metadata') or {}).get('created_at'),
                        'backend_id':      (files.get('backend_used') or {}).get('backend_id'),
                        'transited_externally':
                            (files.get('backend_used') or {}).get('transited_externally'),
                        'ambiguities':     (files.get('structured_intent') or {}).get('ambiguities') or [],
                        'correction_made': True,
                    },
                }
                out.write(json.dumps(row) + '\n')
                n += 1
        return {'examples': n, 'path': out_path}

    # ── Internals ──────────────────────────────────────────────────

    def _upsert_index_from_meta(self, demo_id: str, meta: Dict[str, Any]) -> None:
        created_iso = meta.get('created_at') or now_iso()
        updated_iso = meta.get('updated_at') or created_iso
        backend = (meta.get('backend') or {})
        params = (
            demo_id,
            created_iso,
            updated_iso,
            str(meta.get('task_summary') or ''),
            str(meta.get('transcript') or ''),
            str(backend.get('backend_id') or ''),
            1 if backend.get('transited_externally') else 0,
            json.dumps(meta.get('part_ids') or []),
            json.dumps(meta.get('operations') or []),
            float(meta.get('confidence') or 0.0),
            json.dumps(meta.get('ambiguities') or []),
            1 if meta.get('correction_made') else 0,
            meta.get('program_id'),
        )
        with self._connect() as conn:
            conn.execute(
                'INSERT INTO demonstrations '
                '(demo_id, created_iso, updated_iso, task_summary, transcript, '
                ' backend_id, transited_externally, part_ids, operations, '
                ' confidence, ambiguities, correction_made, program_id) '
                'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) '
                'ON CONFLICT(demo_id) DO UPDATE SET '
                ' updated_iso=excluded.updated_iso, '
                ' task_summary=excluded.task_summary, '
                ' transcript=excluded.transcript, '
                ' backend_id=excluded.backend_id, '
                ' transited_externally=excluded.transited_externally, '
                ' part_ids=excluded.part_ids, '
                ' operations=excluded.operations, '
                ' confidence=excluded.confidence, '
                ' ambiguities=excluded.ambiguities, '
                ' correction_made=excluded.correction_made, '
                ' program_id=excluded.program_id',
                params,
            )
