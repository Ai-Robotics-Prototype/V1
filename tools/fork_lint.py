#!/usr/bin/env python3
"""tools/fork_lint.py — registry-driven fork detector.

Reads `tools/fork_registry.yaml` and, for each registered capability,
scans the forbidden-path globs for the listed patterns. Any hit
outside `known_debt` or `path_exempt` is a lint failure — a fork
cannot deploy.

Also runs a `heuristic_sweep` over the frontend for numeric math on
domain identifiers. Heuristic hits surface as WARNINGS (review
required) unless the file appears in the sweep's `known_ok` list,
in which case they're grandfathered with an owner + reason.

Exit codes:
  0 — no findings (or only heuristic warnings when --heuristic-only
      OR when --allow-warnings)
  1 — one or more registry-driven forks detected
  2 — usage / config error (registry unreadable, canonical missing,
      etc.)

Invocations:
  python3 tools/fork_lint.py            # gate mode: fail on any hit
  python3 tools/fork_lint.py --report   # print findings, exit 0
  python3 tools/fork_lint.py --heuristic-only  # just the sweep

Lesson 180: tooling enforces, documentation describes. This script
IS the enforcement; the registry IS the documentation. Both live in
the same commit so they never drift.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

try:
    import yaml
except ImportError:
    sys.stderr.write(
        'fork_lint: PyYAML is required. `pip install pyyaml`.\n')
    sys.exit(2)


HERE = Path(__file__).resolve().parent
WS   = HERE.parent
REGISTRY = HERE / 'fork_registry.yaml'


@dataclass
class Finding:
    kind:       str         # 'fork' | 'heuristic'
    capability: str
    canonical:  str
    path:       str
    line:       int
    pattern:    str
    excerpt:    str
    severity:   str = 'error'

    def as_dict(self) -> dict:
        return {
            'kind':       self.kind,
            'capability': self.capability,
            'canonical':  self.canonical,
            'path':       self.path,
            'line':       self.line,
            'pattern':    self.pattern,
            'excerpt':    self.excerpt,
            'severity':   self.severity,
        }


def _load_registry(path: Path) -> dict:
    try:
        with open(path) as fh:
            data = yaml.safe_load(fh)
    except Exception as e:
        sys.stderr.write(f'fork_lint: registry read failed: {e}\n')
        sys.exit(2)
    if not isinstance(data, dict):
        sys.stderr.write('fork_lint: registry is not a mapping.\n')
        sys.exit(2)
    return data


def _iter_files(root: Path, glob: str) -> Iterable[Path]:
    """Expand a `dir/**/*.{js,jsx}` style glob against the workspace
    root. Multi-extension `{a,b,c}` groups are supported."""
    # Split ${...,...} groups into distinct glob calls.
    groups = re.findall(r'\{([^}]+)\}', glob)
    if not groups:
        yield from root.rglob(glob.lstrip('./')) \
            if '**' in glob else root.glob(glob.lstrip('./'))
        return
    # For each combination of group values, produce one concrete glob.
    variants = [glob]
    for grp in groups:
        opts = [o.strip() for o in grp.split(',')]
        next_variants = []
        for v in variants:
            for o in opts:
                next_variants.append(v.replace('{' + grp + '}', o, 1))
        variants = next_variants
    seen = set()
    for v in variants:
        for p in root.rglob(v.lstrip('./')) \
                if '**' in v else root.glob(v.lstrip('./')):
            rp = p.resolve()
            if rp in seen:
                continue
            seen.add(rp)
            yield p


def _matches_glob_list(rel_path: str, patterns: list) -> bool:
    """True when rel_path matches any of the fnmatch-style patterns."""
    if not patterns:
        return False
    # Accept `**` semantics — fnmatch's ** doesn't traverse dirs, so
    # fold to prefix + suffix match against the full rel_path.
    for pat in patterns:
        if fnmatch.fnmatch(rel_path, pat):
            return True
        # Fallback for `**/*.ext`: strip the leading `**/` and check
        # basename against the remainder.
        if pat.startswith('**/'):
            if fnmatch.fnmatch(os.path.basename(rel_path), pat[3:]):
                return True
    return False


def _scan_for_patterns(text: str, patterns: list, ctx_sentinel: str | None
                       ) -> list[tuple[int, str, str]]:
    """Return [(line_no, pattern, excerpt), ...] hits. If a context
    sentinel is supplied, the file must first match it — otherwise
    no hits at all (avoids false-positives in unrelated files)."""
    if ctx_sentinel:
        if not re.search(ctx_sentinel, text):
            return []
    hits: list[tuple[int, str, str]] = []
    for pattern in patterns:
        try:
            rx = re.compile(pattern)
        except re.error as e:
            sys.stderr.write(
                f'fork_lint: invalid regex {pattern!r}: {e}\n')
            continue
        for lineno, raw in enumerate(text.splitlines(), start=1):
            m = rx.search(raw)
            if m:
                excerpt = raw.strip()
                if len(excerpt) > 160:
                    excerpt = excerpt[:160] + '…'
                hits.append((lineno, pattern, excerpt))
    return hits


def _strip_comments(src: str) -> str:
    """Best-effort strip of JS/Python comments so a doc string that
    mentions a banned pattern doesn't false-positive."""
    # JS block comments.
    out = re.sub(r'/\*.*?\*/', '', src, flags=re.DOTALL)
    # JS line comments (leave inside strings alone; simplistic).
    out = re.sub(r'(^|[^:])//[^\n]*', r'\1', out)
    # Python docstrings (bare triple-quoted strings at line start).
    out = re.sub(r"'''.*?'''", '', out, flags=re.DOTALL)
    out = re.sub(r'""".*?"""', '', out, flags=re.DOTALL)
    # Python line comments.
    out = re.sub(r'(^|[^:])#[^\n]*', r'\1', out)
    return out


def _rel(p: Path) -> str:
    try:
        return str(p.resolve().relative_to(WS))
    except ValueError:
        return str(p)


# ── Canonical-owner resolution ──────────────────────────────────────

def _canonical_summary(cap: dict) -> str:
    canon = cap.get('canonical') or {}
    parts = []
    if 'python' in canon:
        p = canon['python']
        parts.append(
            f"python: {p.get('module','?')} → "
            + ', '.join(p.get('functions') or []))
    if 'javascript' in canon:
        j = canon['javascript']
        parts.append(f"js: {j.get('module','?')} → "
                     + ', '.join(j.get('exports') or []))
    if 'route' in canon:
        r = canon['route']
        parts.append(f"route: {r.get('method','?')} {r.get('path','?')}")
    if 'file' in canon:
        parts.append(f"file: {canon['file'].get('path','?')}")
    return '; '.join(parts) or '<unset>'


def resolve_canonical(cap: dict) -> list[str]:
    """Return a list of PROBLEMS with the canonical block (empty when
    the block resolves to real code on disk). Used by the test that
    ensures the registry never lists dead code."""
    problems: list[str] = []
    canon = cap.get('canonical') or {}
    if not canon:
        problems.append('no canonical block declared')
        return problems
    if 'python' in canon:
        mod = canon['python'].get('module')
        if mod:
            # Try imports rooted at each src/<pkg> path.
            try:
                _import_python_module(mod)
            except Exception as e:
                problems.append(f'python import {mod!r}: {e}')
            # Function resolution — best-effort. Missing function
            # names are a soft warning (may be private, may live in
            # a submodule); we don't fail the resolve on those.
    if 'javascript' in canon:
        path = canon['javascript'].get('module')
        if path:
            abs_ = WS / path
            if not abs_.exists():
                problems.append(f'javascript module missing: {path}')
    if 'file' in canon:
        path = canon['file'].get('path')
        if path and not path.startswith('/'):
            abs_ = WS / path
            if '*' not in path and not abs_.exists():
                problems.append(f'file missing: {path}')
    return problems


def _import_python_module(dotted: str):
    """Try to import a dotted module by placing every src/<pkg>
    directory on sys.path. Raises on failure."""
    for src_pkg in (WS / 'src').iterdir():
        if src_pkg.is_dir():
            p = str(src_pkg)
            if p not in sys.path:
                sys.path.insert(0, p)
    import importlib
    importlib.import_module(dotted)


# ── Core scans ─────────────────────────────────────────────────────

def scan_capability(cap: dict) -> list[Finding]:
    """Registry-driven scan for one capability entry."""
    findings: list[Finding] = []
    cap_id = cap.get('id', '<unset>')
    canon  = _canonical_summary(cap)
    debt   = {(d.get('path'), d.get('line')) for d in cap.get('known_debt') or []
              if isinstance(d, dict)}
    for f_entry in cap.get('forbidden') or []:
        glob        = f_entry.get('path_glob', '')
        patterns    = f_entry.get('patterns') or []
        sentinel    = f_entry.get('context_sentinel')
        exempts     = f_entry.get('path_exempt') or []
        for path in _iter_files(WS, glob):
            rel = _rel(path)
            if _matches_glob_list(rel, exempts):
                continue
            try:
                text = path.read_text(encoding='utf-8', errors='replace')
            except Exception:
                continue
            clean = _strip_comments(text)
            hits  = _scan_for_patterns(clean, patterns, sentinel)
            for lineno, pattern, excerpt in hits:
                if (rel, lineno) in debt:
                    continue
                findings.append(Finding(
                    kind='fork', capability=cap_id, canonical=canon,
                    path=rel, line=lineno, pattern=pattern,
                    excerpt=excerpt, severity='error'))
    return findings


def sweep_heuristic(entry: dict) -> list[Finding]:
    """Frontend-math-on-domain-identifiers sweep."""
    findings: list[Finding] = []
    glob     = entry.get('path_glob', '')
    idents   = entry.get('domain_identifiers') or []
    prims    = entry.get('math_primitives') or []
    exempts  = entry.get('path_exempt') or []
    known_ok = {ok.get('path'): ok for ok in entry.get('known_ok') or []
                if isinstance(ok, dict)}
    if not (idents and prims):
        return findings
    ident_rx = re.compile('|'.join(idents))
    prim_rx  = re.compile('|'.join(prims))
    for path in _iter_files(WS, glob):
        rel = _rel(path)
        if _matches_glob_list(rel, exempts):
            continue
        if rel in known_ok:
            continue
        try:
            text = path.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        clean = _strip_comments(text)
        if not ident_rx.search(clean):
            continue
        for lineno, raw in enumerate(clean.splitlines(), start=1):
            if prim_rx.search(raw):
                excerpt = raw.strip()[:160]
                findings.append(Finding(
                    kind='heuristic',
                    capability='frontend_numeric_math_on_domain_objects',
                    canonical='backend-owned; register the pattern OR '
                              'move to sweep known_ok with an owner',
                    path=rel, line=lineno,
                    pattern='domain-identifier + math primitive',
                    excerpt=excerpt, severity='warning'))
    return findings


# ── Reporting ───────────────────────────────────────────────────────

def format_findings(findings: list[Finding], mode: str) -> str:
    if not findings:
        return ''
    lines = []
    lines.append('')
    lines.append('=' * 72)
    lines.append('fork_lint findings')
    lines.append('=' * 72)
    for f in findings:
        marker = '✗' if f.severity == 'error' else '⚠'
        lines.append(f'{marker} [{f.capability}] {f.path}:{f.line}')
        lines.append(f'    canonical : {f.canonical}')
        lines.append(f'    pattern   : {f.pattern}')
        lines.append(f'    excerpt   : {f.excerpt}')
        lines.append('')
    lines.append(f'Total: {len(findings)} '
                 + ('finding' if len(findings) == 1 else 'findings') + '.')
    lines.append('=' * 72)
    return '\n'.join(lines)


# ── deploy_log helpers ─────────────────────────────────────────────

_DEPLOY_LOG = '/opt/cobot/deploy_log.jsonl'


def _emit_deploy_phase(phase: str, sha: str, extra: dict) -> None:
    """Best-effort append to the deploy log. Silent on write error
    (running outside the deploy env)."""
    from datetime import datetime, timezone
    entry = {
        'ts':    datetime.now(timezone.utc).isoformat(timespec='seconds')
                        .replace('+00:00', 'Z'),
        'phase': phase, 'sha': sha,
        **extra,
    }
    try:
        with open(_DEPLOY_LOG, 'a') as fh:
            fh.write(json.dumps(entry) + '\n')
    except Exception:
        pass


# ── Entry point ─────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='fork_lint',
        description=__doc__.strip().splitlines()[0])
    ap.add_argument('--report', action='store_true',
        help='print findings, exit 0 regardless (for triage runs)')
    ap.add_argument('--heuristic-only', action='store_true',
        help='run only the heuristic sweep; skip registered patterns')
    ap.add_argument('--json', action='store_true',
        help='machine-readable output (JSON array of findings)')
    ap.add_argument('--deploy-phase', metavar='SHA', default=None,
        help='when a fork is detected, ALSO emit a deploy_log JSONL '
             'entry with phase="lint_failed" for the given sha')
    ap.add_argument('--registry', default=str(REGISTRY),
        help='registry file (default: tools/fork_registry.yaml)')
    args = ap.parse_args(argv)

    reg = _load_registry(Path(args.registry))
    findings: list[Finding] = []

    if not args.heuristic_only:
        for cap in reg.get('capabilities') or []:
            findings.extend(scan_capability(cap))

    sweep_entry = (reg.get('heuristic_sweep') or {}) \
        .get('frontend_numeric_math_on_domain_objects')
    if sweep_entry:
        findings.extend(sweep_heuristic(sweep_entry))

    fork_findings = [f for f in findings if f.severity == 'error']

    if args.json:
        print(json.dumps([f.as_dict() for f in findings], indent=2))
    elif findings:
        sys.stderr.write(format_findings(findings, 'gate'))
        sys.stderr.write('\n')

    if args.report:
        return 0

    if fork_findings:
        if args.deploy_phase:
            _emit_deploy_phase(
                'lint_failed', args.deploy_phase,
                {'reason': 'fork_registry',
                 'count':  len(fork_findings),
                 'first_capability': fork_findings[0].capability,
                 'first_path':       fork_findings[0].path})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
