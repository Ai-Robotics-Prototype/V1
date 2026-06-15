"""Few-shot retrieval over the LearningStore corpus.

Given a new demonstration's transcript + the parts/operations the
operator's voice mentions, rank past demonstrations by similarity and
return the top-K {past_summary, corrected_program} bundles to inject
into the understanding backend's context. The model uses them as
explicit examples of "how similar tasks were correctly handled
before", which makes the AI output dramatically more consistent
across sessions.

Method: TF-IDF over the past transcripts + a boost on shared
part_ids and shared operation_types. Lightweight (sklearn) and
deterministic — no embedding cache, no model download. Returns
quickly even on a few thousand past demos because sklearn's
TfidfVectorizer is heavily optimised.

If sklearn isn't installed we fall back to a Jaccard token-overlap
score on the raw text — slightly worse quality but works with zero
extra deps so retrieval never breaks the pipeline."""

from __future__ import annotations

import math
import re
from typing import Any, Dict, Iterable, List, Tuple


_WORD_RE = re.compile(r"[A-Za-z0-9_]+")


def _tokens(s: str) -> List[str]:
    return [t.lower() for t in _WORD_RE.findall(s or '')]


# ── Public API ──────────────────────────────────────────────────────

def retrieve_examples(transcript: str,
                      part_ids: Iterable[str],
                      operations: Iterable[str],
                      corpus: List[Dict[str, Any]],
                      k: int = 3,
                      min_score: float = 0.10) -> List[Dict[str, Any]]:
    """`corpus` is whatever LearningStore.iter_corrected_entries() yields:
    each item must carry at least:
      {
        'demo_id': str,
        'transcript': str,
        'part_ids': [str, ...],
        'operations': [str, ...],
        'corrected_program': {...},    # the human-corrected program
        'summary': str (optional),
      }
    Items missing `corrected_program` are skipped — only human-vetted
    examples become few-shot context.

    Returns up to `k` items annotated with `_score` (float) and
    trimmed `corrected_program_summary` so the prompt stays small.
    """
    if not corpus:
        return []
    eligible = [e for e in corpus if e.get('corrected_program')]
    if not eligible:
        return []

    query_text = (transcript or '').strip()
    query_parts = {p for p in (part_ids or []) if p}
    query_ops   = {o for o in (operations or []) if o}

    text_scores = _tfidf_scores(query_text, [e.get('transcript') or '' for e in eligible])

    ranked: List[Tuple[float, Dict[str, Any]]] = []
    for entry, ts in zip(eligible, text_scores):
        score = ts
        shared_parts = len(query_parts & set(entry.get('part_ids') or []))
        shared_ops   = len(query_ops   & set(entry.get('operations') or []))
        # Boost: a shared part is a strong signal that the past demo is
        # actually relevant (TF-IDF on transcripts misses this since
        # operators often say "this bracket" instead of the part_id).
        score += 0.20 * shared_parts
        score += 0.10 * shared_ops
        ranked.append((score, entry))

    ranked.sort(key=lambda t: t[0], reverse=True)

    out: List[Dict[str, Any]] = []
    for score, entry in ranked[:max(0, int(k))]:
        if score < min_score:
            break
        out.append(_summarise_for_prompt(entry, score))
    return out


# ── Implementation ─────────────────────────────────────────────────

def _tfidf_scores(query: str, docs: List[str]) -> List[float]:
    """TF-IDF cosine similarity between the query and each doc. Returns
    `len(docs)` scores. Falls back to Jaccard token overlap if sklearn
    is unavailable."""
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer  # type: ignore
        from sklearn.metrics.pairwise import cosine_similarity        # type: ignore
    except Exception:
        return _jaccard_scores(query, docs)
    if not query.strip() or not any(d.strip() for d in docs):
        return [0.0] * len(docs)
    try:
        vec = TfidfVectorizer(stop_words='english', lowercase=True,
                              token_pattern=r"(?u)\b[A-Za-z0-9_]+\b")
        mat = vec.fit_transform(docs + [query])
        sim = cosine_similarity(mat[-1], mat[:-1]).ravel()
        return [float(x) for x in sim]
    except Exception:
        return _jaccard_scores(query, docs)


def _jaccard_scores(query: str, docs: List[str]) -> List[float]:
    """Token-set overlap. Trivial fallback if sklearn isn't around."""
    q = set(_tokens(query))
    if not q:
        return [0.0] * len(docs)
    out = []
    for d in docs:
        dt = set(_tokens(d))
        if not dt:
            out.append(0.0)
            continue
        out.append(len(q & dt) / max(1, len(q | dt)))
    return out


def _summarise_for_prompt(entry: Dict[str, Any], score: float) -> Dict[str, Any]:
    """Trim a corpus entry into a small prompt-friendly payload — the
    full corrected program is huge, but the model only needs the gist:
    what the operator said, what parts/ops the corrected version used,
    and an inline summary of the operation sequence."""
    prog = entry.get('corrected_program') or {}
    ops_summary = []
    for s in (prog.get('steps') or [])[:24]:        # cap step list
        ops_summary.append({
            'action': s.get('action'),
            'label':  s.get('label'),
        })
    return {
        'demo_id':       entry.get('demo_id'),
        'transcript':    (entry.get('transcript') or '')[:600],
        'task_summary':  entry.get('task_summary') or '',
        'part_ids':      list(entry.get('part_ids') or []),
        'operations':    list(entry.get('operations') or []),
        'corrected_program_summary': {
            'name':       prog.get('name'),
            'tags':       prog.get('tags'),
            'steps':      ops_summary,
            'step_count': len(prog.get('steps') or []),
        },
        '_score': round(float(score), 4),
    }
