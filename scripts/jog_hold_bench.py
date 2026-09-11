#!/usr/bin/env python3
"""jog_hold_bench — bench observation for the continuous-jog cutout
directive (2026-07-31).

Purpose: name the CAUSE of mid-hold jog stops before shipping any
fix — the week's rule. Reads the client-side jog-stop cause ring
(via GET /api/jog_stop_log) and the driver-side inter-arrival gap
histogram (via /api/state -> robot.jog_hold_gaps_summary), and
produces:
  * cause distribution across the observed window
  * gap histogram + p50/p95/p99/max
  * plain-english verdict naming the top cause(s)

Bench protocol (run at the cell):

  1. Open the dashboard on ONE client (tablet OR PC). Program tab
     → Jog Controls visible.
  2. python3 scripts/jog_hold_bench.py --clear
     (wipes the log ring so this run's window is clean).
  3. Hold ONE jog button steadily for 30 seconds. Do NOT change
     direction or lift your finger.
  4. Release. Wait 2 seconds (server picks up the last stop event).
  5. python3 scripts/jog_hold_bench.py --report
  6. Repeat steps 2–5 twice more, ideally on the OTHER client too.
  7. Attach the report output to the operator directive follow-up.

Options:
  --clear   Empty the /api/jog_stop_log ring. Use before each run.
  --report  Read and analyze. (default when no --clear.)
  --url     Dashboard base URL (default https://127.0.0.1:8080).
  --verify  Skip TLS verification when the cert is self-signed.

Exit codes:
  0  report printed cleanly
  1  server unreachable / API error
  2  usage error
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.request
from collections import Counter
from urllib.error import URLError


def _fetch(url: str, method: str = "GET", verify: bool = False):
    """Small no-deps HTTP helper."""
    ctx = None
    if url.startswith("https") and not verify:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, method=method)
    with urllib.request.urlopen(req, context=ctx, timeout=6) as r:
        raw = r.read().decode("utf-8", errors="replace")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw}


def _pctile(values, p):
    if not values:
        return None
    s = sorted(values)
    i = min(len(s) - 1, max(0, int(round(p * (len(s) - 1)))))
    return s[i]


def _fmt_pct(counter: Counter, total: int) -> str:
    if total == 0:
        return "(no samples)"
    lines = []
    for cause, n in counter.most_common():
        pct = (n / total) * 100.0
        bar = "█" * int(round(pct / 3.0))       # 1 char per 3%
        lines.append(f"  {cause:<20} {n:>4}  {pct:5.1f}%  {bar}")
    return "\n".join(lines)


def _histogram(values, buckets_ms) -> str:
    if not values:
        return "  (no gap samples — driver saw no active hold in this window)"
    counts = [0] * (len(buckets_ms) + 1)   # last bucket = > max
    for v in values:
        placed = False
        for i, b in enumerate(buckets_ms):
            if v <= b:
                counts[i] += 1
                placed = True
                break
        if not placed:
            counts[-1] += 1
    lines = []
    max_c = max(counts) or 1
    prev = 0.0
    for i, b in enumerate(buckets_ms):
        n = counts[i]
        bar = "█" * int(round((n / max_c) * 40))
        lines.append(f"  ≤{b:>4.0f}ms  {n:>4}  {bar}")
        prev = b
    n = counts[-1]
    bar = "█" * int(round((n / max_c) * 40))
    lines.append(f"  >{buckets_ms[-1]:>4.0f}ms  {n:>4}  {bar}")
    return "\n".join(lines)


def cmd_clear(base: str, verify: bool) -> int:
    try:
        r = _fetch(f"{base}/api/jog_stop_log", method="DELETE", verify=verify)
        print(f"cleared: {r}")
        return 0
    except URLError as e:
        print(f"clear failed: {e}", file=sys.stderr)
        return 1


def cmd_report(base: str, verify: bool) -> int:
    try:
        stops_body = _fetch(f"{base}/api/jog_stop_log", verify=verify)
        state_body = _fetch(f"{base}/api/state",         verify=verify)
    except URLError as e:
        print(f"fetch failed: {e}", file=sys.stderr)
        return 1

    stops = stops_body.get("stops") or []
    robot = (state_body.get("robot") or {})
    gaps_current = robot.get("jog_hold_gaps_ms") or []
    gaps_last    = robot.get("jog_last_hold_gaps_ms") or []
    gaps_summary_current = robot.get("jog_hold_gaps_summary")
    gaps_summary_last    = robot.get("jog_last_hold_gaps_summary")

    # Prefer the LAST completed hold's gaps (the operator has
    # released by the time they run --report). Fall back to the
    # live ring if the operator ran the script mid-hold.
    if gaps_last:
        gaps = gaps_last
        gaps_summary = gaps_summary_last
        gap_label = "last completed hold"
    else:
        gaps = gaps_current
        gaps_summary = gaps_summary_current
        gap_label = "live (in-progress hold)"

    total = len(stops)
    cause_counter = Counter(s.get("cause") or "unknown" for s in stops)

    print("=" * 68)
    print("JOG-HOLD BENCH REPORT")
    print("=" * 68)
    print()
    print(f"Client-side jog-stop cause ring — {total} entries")
    print()
    if total > 0:
        print(_fmt_pct(cause_counter, total))
    else:
        print("  (no stops recorded — did any hold complete in this window?)")
    print()

    print(f"Driver inter-arrival gap histogram — {gap_label}")
    print(f"  samples: {len(gaps)}")
    if gaps_summary:
        s = gaps_summary
        over = s.get("over_200ms", 0)
        pct  = (over / s["n"] * 100.0) if s.get("n") else 0.0
        print(f"  n={s['n']}  p50={s['p50']:.0f}ms  p95={s['p95']:.0f}ms  "
              f"p99={s['p99']:.0f}ms  max={s['max']:.0f}ms")
        print(f"  gaps > 200 ms: {over}  ({pct:.1f}% of samples)")
    else:
        print("  (no summary — driver hasn't seen a jog session yet)")
    print()
    print("Gap distribution:")
    print(_histogram(gaps, [10, 25, 50, 100, 150, 200, 300, 500, 1000]))
    print()

    # ── Verdict ─────────────────────────────────────────────────────
    print("-" * 68)
    print("VERDICT")
    print("-" * 68)
    if total == 0:
        print("  No stops recorded. Either no hold completed, or the")
        print("  frontend bundle predates the instrumentation. Run")
        print("  scripts/deploy.sh and retry.")
        return 0

    top_cause, top_n = cause_counter.most_common(1)[0]
    top_pct = (top_n / total) * 100.0
    print(f"  Top cause: {top_cause}  ({top_n}/{total} = {top_pct:.1f}%)")
    hint = {
        "pointer_up":        "operator lifted — not a bug",
        "pointer_cancel":    "OS/browser cancelled the pointer stream — "
                             "palm rejection, phone-call notif, or scroll "
                             "gesture claim. Check tablet Chrome behavior.",
        "pointer_leave":     "finger drifted off the button. Confirm "
                             "setPointerCapture is engaging (§2c of the "
                             "directive).",
        "blur":              "window lost focus — alt-tab, task switcher, "
                             "or embedded WebView losing focus. Check for "
                             "background prompts.",
        "visibility":        "tab hidden or backgrounded. On mobile Chrome, "
                             "WS suspend risk — the visibilitychange path "
                             "already stops proactively.",
        "ws_drop":           "WebSocket dropped mid-hold. Escalate to the "
                             "ACK-channel repair immediately.",
        "keepalive_timeout": "driver's 200 ms freshness deadman fired. "
                             "Cross-reference with the gap histogram: if "
                             "gaps > 200 ms are frequent, the CLIENT "
                             "cadence is the disease — apply §2a "
                             "(keepalive at 50 ms).",
        "freshness_deadman": "same as keepalive_timeout — check the gap "
                             "histogram to distinguish transport gaps from "
                             "backpressure stalls.",
        "server_gate":       "driver refused motion — allow_jog gate, "
                             "alarm, or safety zone. Cross-reference "
                             "last_stop_reason on /api/state.",
        "collision_guard":   "self-collision guard tripped. See the "
                             "operator directive that shrank stop→15 mm.",
        "joint_limit":       "joint approached its limit. Not a transport "
                             "bug.",
        "disabled":          "parent flipped `disabled` mid-hold. Usually "
                             "downstream of ws_drop or a safety event — "
                             "check what fired first.",
    }.get(top_cause, "unknown cause — inspect the raw ring")
    print(f"  Hint:      {hint}")
    if gaps_summary:
        over = gaps_summary.get("over_200ms", 0)
        n    = gaps_summary.get("n", 0)
        if n > 0 and over / n > 0.05:
            print()
            print(f"  ⚠ CHANNEL SICK: {over}/{n} gaps > 200 ms "
                  f"({over/n*100:.1f}%). The transport gapping past the "
                  f"driver's freshness threshold IS the disease. Apply the "
                  f"ACK-channel repair (§2a of the directive).")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--url", default="https://127.0.0.1:8080",
                    help="Dashboard base URL")
    ap.add_argument("--verify", action="store_true",
                    help="Verify TLS certs (default: off; self-signed OK)")
    ap.add_argument("--clear", action="store_true",
                    help="Empty the /api/jog_stop_log ring")
    ap.add_argument("--report", action="store_true",
                    help="Print report (default when --clear absent)")
    args = ap.parse_args()

    if args.clear and args.report:
        print("Pass --clear OR --report, not both", file=sys.stderr)
        return 2
    if args.clear:
        return cmd_clear(args.url, args.verify)
    # Default: --report
    return cmd_report(args.url, args.verify)


if __name__ == "__main__":
    sys.exit(main())
