#!/usr/bin/env python3
"""Reconstruct v46 by concatenating v46-content-start..v46-content-end blocks
from ledger files in source_lines order, then compare SHA256 against the
canonical source.

Usage:  python3 tools/ledger_reconstruction_test.py [v46_source_path]

Exit non-zero on mismatch.

SUPERSEDED (2026-08-20): the authoritative post-restructure check is now
`tools/ledger_lint.py`, which runs CONTIGUITY + REDACTIONS + INDEX-RESOLVE
+ LESSONS-GAPS duties. This script is preserved for the byte-diff signal
against an original un-redacted v46.

DELIBERATE MISMATCH: era-01 has three GitHub PAT strings redacted (see its
frontmatter `redactions:` field) so the file can live in a scanned repo.
The on-disk v46 copy in ~/Downloads has also been prepended with a
frozen-archive HTML-comment header (see its top). Against that file this
test now reports MISMATCH by design — the delta is (frozen-header bytes)
+ (~91 bytes across three redaction sites in the "GitHub Token" sections).
Contiguity and no-overlap checks still hold; those are the load-bearing
guarantees and are duplicated in `ledger_lint.py::duty_contiguity`.
"""
from __future__ import annotations

import hashlib
import re
import sys
from pathlib import Path

LEDGER_DIR = Path(__file__).resolve().parent.parent / "docs" / "ledger"
DEFAULT_SRC = Path.home() / "Downloads" / "cobot_project_conversation_v46.md"

START = "<!-- v46-content-start (do not edit; used by reconstruction test) -->"
END = "<!-- v46-content-end -->"

FRONTMATTER_RE = re.compile(
    r"\A---\n(.*?\n)---\n", re.DOTALL
)
SOURCE_LINES_RE = re.compile(r"source_lines:\s*(\d+)-(\d+)")


def parse_file(path: Path) -> tuple[int, int, str]:
    raw = path.read_text()
    m = FRONTMATTER_RE.match(raw)
    if not m:
        raise SystemExit(f"{path.name}: missing YAML frontmatter")
    fm = m.group(1)
    lm = SOURCE_LINES_RE.search(fm)
    if not lm:
        raise SystemExit(f"{path.name}: missing source_lines: N-M in frontmatter")
    start_line, end_line = int(lm.group(1)), int(lm.group(2))

    body = raw[m.end():]
    if START not in body or END not in body:
        raise SystemExit(f"{path.name}: missing v46-content markers")

    # Content is between START marker line and END marker line, both stripped.
    lo = body.index(START) + len(START) + 1  # +1 for trailing newline
    hi = body.index(END)
    # Strip the single '\n' that immediately precedes END marker.
    content = body[lo:hi]
    return start_line, end_line, content


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src.exists():
        print(f"source not found: {src}", file=sys.stderr)
        return 2

    # Only ledger files that carry v46-content (skip external addenda 32+).
    files = []
    for p in sorted(LEDGER_DIR.glob("*.md")):
        raw = p.read_text()
        if START in raw and END in raw:
            files.append(p)

    parsed = [(p, *parse_file(p)) for p in files]
    parsed.sort(key=lambda t: t[1])  # by start_line

    # Sanity: contiguous, no overlap, no gaps.
    expected_next = 1
    for p, start_line, end_line, _ in parsed:
        if start_line != expected_next:
            print(
                f"gap or overlap before {p.name}: "
                f"expected line {expected_next}, got {start_line}",
                file=sys.stderr,
            )
            return 3
        expected_next = end_line + 1

    reconstructed = "".join(content for _, _, _, content in parsed)

    src_bytes = src.read_bytes()
    rec_bytes = reconstructed.encode("utf-8")

    src_sha = hashlib.sha256(src_bytes).hexdigest()
    rec_sha = hashlib.sha256(rec_bytes).hexdigest()

    print(f"source     : {src}")
    print(f"src  bytes : {len(src_bytes)}")
    print(f"rec  bytes : {len(rec_bytes)}")
    print(f"src  sha256: {src_sha}")
    print(f"rec  sha256: {rec_sha}")
    if src_sha != rec_sha:
        print("MISMATCH", file=sys.stderr)
        return 1
    print("OK — reconstruction is byte-exact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
