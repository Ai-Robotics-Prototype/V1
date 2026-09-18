#!/usr/bin/env python3
"""cobot-pair-cli — operator-side pairing helper.

Usage:
  tools/cobot-pair-cli.py --name "Operator Jetson" \
      [--host 127.0.0.1:8080] [--out /tmp/pair.json]

Runs the /api/pair/start + /api/pair/confirm handshake from the same
host that runs the dashboard, autoreading the code out of the
paired-dashboard pending list (localhost skips the "type it from
the display" step because localhost grandfathers through the auth
middleware). Primary use: mint tokens for the operator's own
tablets/scripts without walking the wizard.

Prints the token JSON on stdout; optionally writes to --out. Never
logs the token except to the requested files.

Fork-registry `device_pairing_auth` — CLI must hit the same
/api/pair endpoints as the wizard, not a bespoke code path.
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request


def _post(host: str, path: str, body: dict, insecure: bool = True) -> dict:
    url = f'https://{host}{path}'
    data = json.dumps(body).encode('utf-8')
    req = urllib.request.Request(
        url, data=data,
        headers={'Content-Type': 'application/json'})
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, context=ctx, timeout=8) as r:
        return json.loads(r.read().decode('utf-8'))


def _get(host: str, path: str, insecure: bool = True) -> dict:
    url = f'https://{host}{path}'
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(url, context=ctx, timeout=8) as r:
        return json.loads(r.read().decode('utf-8'))


def _extract_code(host: str, session_id: str) -> str:
    """Poll /api/pair/pending until this session's code shows up
    (localhost-only surface)."""
    deadline = time.time() + 6
    while time.time() < deadline:
        try:
            j = _get(host, '/api/pair/pending')
            for p in j.get('pending') or []:
                if p.get('session_id') == session_id:
                    return p.get('code') or ''
        except Exception:
            pass
        time.sleep(0.2)
    return ''


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--name', required=True,
                    help='Device name to register.')
    ap.add_argument('--host', default='127.0.0.1:8080',
                    help='Dashboard host (default: 127.0.0.1:8080). '
                         'Localhost is required — the pair code is '
                         'never returned to non-localhost callers.')
    ap.add_argument('--out',
                    help='Optional file to write the pair result to.')
    ap.add_argument('--insecure', action='store_true', default=True,
                    help='Skip TLS verification (default: on, for the '
                         'self-signed dashboard cert).')
    args = ap.parse_args()

    host = args.host
    if not host.startswith(('127.0.0.1', 'localhost', '::1', '[::1]')):
        print('cobot-pair-cli: --host must be localhost — the pair '
              'code is only readable from the paired display and this '
              'CLI reads it via /api/pair/pending which requires the '
              'same auth rung as /api/state.', file=sys.stderr)
        return 2

    try:
        started = _post(host, '/api/pair/start',
                        {'device_name': args.name},
                        insecure=args.insecure)
    except urllib.error.HTTPError as e:
        print(f'start failed: {e}', file=sys.stderr)
        return 3
    if not started.get('ok'):
        print(f'start refused: {started}', file=sys.stderr)
        return 3
    sid  = started['session_id']
    code = _extract_code(host, sid)
    if not code:
        print('code did not appear on the pending list — is the '
              'dashboard on this host + running the new backend?',
              file=sys.stderr)
        return 4
    confirmed = _post(host, '/api/pair/confirm',
                      {'session_id': sid, 'code': code},
                      insecure=args.insecure)
    if not confirmed.get('ok'):
        print(f'confirm refused: {confirmed}', file=sys.stderr)
        return 5

    # Present a compact result; the raw token stays inside the JSON
    # blob so a naive `less` doesn't accidentally paste it into the
    # logs.
    out_blob = json.dumps(confirmed, indent=2)
    if args.out:
        # Write mode 0600 so a stray world-read doesn't hand out the
        # token.
        fd = os.open(args.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, out_blob.encode('utf-8'))
        finally:
            os.close(fd)
        print(f'token written to {args.out} (mode 0600)')
        print(f"  token_id: {confirmed['token_id']}")
        print(f"  device:   {confirmed['device_name']}")
        return 0
    print(out_blob)
    return 0


if __name__ == '__main__':
    sys.exit(main())
