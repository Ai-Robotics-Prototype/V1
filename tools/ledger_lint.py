#!/usr/bin/env python3
"""ledger_lint.py — invariants for the split-ledger layout.

Runs a set of duties against `docs/ledger/` and the distillate tier
(`docs/STANDING.md`, `docs/STATE.md`, `docs/HARDWARE.md`, `docs/INDEX.md`,
`docs/LESSONS.md`). Non-zero exit if any duty fails.

Duties:
  1. CONTIGUITY   — every ledger file that carries `<!-- v46-content-* -->`
                    markers declares `source_lines: N-M` in its
                    frontmatter; concatenated ranges cover [1..end] with
                    no gaps and no overlaps.
  2. REDACTIONS   — the three known-required placeholders exist in
                    era-01 (two `[REDACTED_GHP_TOKEN_1]`, one
                    `[REDACTED_GHP_TOKEN_2]`); NO raw `ghp_*` PAT
                    strings anywhere in `docs/ledger/`.
  3. INDEX-RESOLVE— every `addendum-NN[-a|-b]` slug or `era-01` slug
                    referenced in `docs/INDEX.md` resolves to a file
                    that exists in `docs/ledger/`.
  4. LESSONS-GAPS — `docs/LESSONS.md` has a documented "Gaps" block and
                    an "Extraction methodology" section that explains
                    what the current index does and does NOT cover.

Extends (but does not delete) the guarantees previously enforced by
`tools/ledger_reconstruction_test.py`. That test's byte-exact SHA compare
against the un-redacted v46 is now intentionally MISMATCHED (see its
docstring); this lint is the authoritative post-restructure check.

Usage:  python3 tools/ledger_lint.py
Exit non-zero on any duty failure. Each duty prints one PASS/FAIL line.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LEDGER_DIR = REPO_ROOT / "docs" / "ledger"
INDEX_MD = REPO_ROOT / "docs" / "INDEX.md"
LESSONS_MD = REPO_ROOT / "docs" / "LESSONS.md"

V46_START = "<!-- v46-content-start (do not edit; used by reconstruction test) -->"
V46_END = "<!-- v46-content-end -->"
FRONTMATTER_RE = re.compile(r"\A---\n(.*?\n)---\n", re.DOTALL)
SOURCE_LINES_RE = re.compile(r"source_lines:\s*(\d+)-(\d+)")
# GitHub classic PAT: ghp_ + 36 base62 chars. Match with a length floor.
GHP_TOKEN_RE = re.compile(r"ghp_[A-Za-z0-9]{20,}")


def duty_contiguity() -> tuple[bool, str]:
    """Every v46-marker file has source_lines; ranges cover [1..end] cleanly."""
    entries = []
    for p in sorted(LEDGER_DIR.glob("*.md")):
        raw = p.read_text()
        if V46_START not in raw or V46_END not in raw:
            continue
        m = FRONTMATTER_RE.match(raw)
        if not m:
            return False, f"{p.name}: v46 markers present but no YAML frontmatter"
        lm = SOURCE_LINES_RE.search(m.group(1))
        if not lm:
            return False, f"{p.name}: frontmatter missing source_lines: N-M"
        entries.append((int(lm.group(1)), int(lm.group(2)), p.name))
    if not entries:
        return False, "no v46-marker files found — split archive missing?"
    entries.sort(key=lambda t: t[0])
    expected = 1
    for lo, hi, name in entries:
        if lo != expected:
            return False, f"{name}: expected source_lines starting {expected}, got {lo}"
        if hi < lo:
            return False, f"{name}: source_lines end {hi} < start {lo}"
        expected = hi + 1
    return True, f"{len(entries)} files cover source_lines 1..{expected-1} with no gaps"


def duty_redactions() -> tuple[bool, str]:
    """No raw ghp_* tokens; expected placeholders present in era-01."""
    for p in sorted(LEDGER_DIR.glob("*.md")):
        raw = p.read_text()
        raw_hits = GHP_TOKEN_RE.findall(raw)
        if raw_hits:
            return False, f"{p.name}: raw ghp_* token(s) present: {len(raw_hits)}"
    era = LEDGER_DIR / "era-01-pre-addendum-general-project-docs.md"
    if not era.exists():
        return False, "era-01 file missing"
    text = era.read_text()
    n1 = text.count("[REDACTED_GHP_TOKEN_1]")
    n2 = text.count("[REDACTED_GHP_TOKEN_2]")
    # Two REDACTED_GHP_TOKEN_1 sites (body) + one in the frontmatter docs.
    # One REDACTED_GHP_TOKEN_2 site (body) + one in the frontmatter docs.
    if n1 < 2 or n2 < 1:
        return False, (
            f"era-01: expected ≥2 REDACTED_GHP_TOKEN_1 and ≥1 "
            f"REDACTED_GHP_TOKEN_2 in body; got {n1}, {n2}"
        )
    return True, f"no raw ghp_*; era-01 placeholders present ({n1}, {n2})"


def duty_index_resolve() -> tuple[bool, str]:
    """Every add-NN[-a|-b] or era-01 slug in INDEX.md resolves to a file."""
    if not INDEX_MD.exists():
        return False, "docs/INDEX.md missing"
    idx = INDEX_MD.read_text()
    ledger_files = {p.name for p in LEDGER_DIR.glob("*.md")}
    # Match either the full filename (addendum-NN-*.md) or the shorthand
    # (`addendum-NN` used in the topic block).
    filename_refs = set(re.findall(r"addendum-\d+[a-z]?-[^\s`]*\.md", idx))
    filename_refs.update(re.findall(r"era-01-[^\s`]*\.md", idx))
    missing = [ref for ref in filename_refs if ref not in ledger_files]
    if missing:
        return False, f"INDEX.md references missing files: {sorted(missing)[:5]}"

    # Also verify the shorthand "addendum-NN" mentions correspond to real
    # files (there is at least one file named addendum-NN-*.md).
    shorthand = set(re.findall(r"addendum-(\d+[a-z]?)\b", idx))
    prefixes = {re.match(r"addendum-(\d+[a-z]?)-", n).group(1)
                for n in ledger_files if n.startswith("addendum-")}
    orphan = sorted(shorthand - prefixes)
    if orphan:
        return False, f"INDEX.md shorthand refs with no addendum file: {orphan[:5]}"

    return True, f"all {len(filename_refs)} filename refs resolve; {len(shorthand)} shorthand refs match"


def duty_lessons_gaps() -> tuple[bool, str]:
    """LESSONS.md has a Gaps block and an Extraction methodology section."""
    if not LESSONS_MD.exists():
        return False, "docs/LESSONS.md missing"
    text = LESSONS_MD.read_text()
    if "**Gaps**" not in text:
        return False, "LESSONS.md missing '**Gaps**' block"
    if "Extraction methodology" not in text:
        return False, "LESSONS.md missing 'Extraction methodology' section"
    # The gap block should contain a `\`\`\`` fenced code region with numbers.
    gap_idx = text.index("**Gaps**")
    tail = text[gap_idx:]
    if "```" not in tail:
        return False, "LESSONS.md gap block missing fenced-code number list"
    return True, "Gaps block + Extraction methodology present"


DUTIES = (
    ("CONTIGUITY",    duty_contiguity),
    ("REDACTIONS",    duty_redactions),
    ("INDEX-RESOLVE", duty_index_resolve),
    ("LESSONS-GAPS",  duty_lessons_gaps),
)


def main() -> int:
    failed = 0
    for name, fn in DUTIES:
        ok, msg = fn()
        tag = "PASS" if ok else "FAIL"
        print(f"[{tag}] {name}: {msg}")
        if not ok:
            failed += 1
    if failed:
        print(f"\n{failed} duty failure(s)", file=sys.stderr)
        return 1
    print("\nall duties passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
