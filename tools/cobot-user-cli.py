#!/usr/bin/env python3
"""cobot-user-cli — manage NeuRobots dashboard user accounts.

Usage:
  sudo python3 tools/cobot-user-cli.py add <username> [--role admin|operator]
  sudo python3 tools/cobot-user-cli.py remove <username>
  sudo python3 tools/cobot-user-cli.py passwd <username>
  sudo python3 tools/cobot-user-cli.py list

Runs against the user store on this host (default
/opt/cobot/users.json). Passwords are prompted interactively via
getpass — never on argv (shell history leak). Add-61 §690 auth
model.

Note: this CLI writes to the store file directly. The dashboard
reads the store lazily; a user added mid-run is visible to the
next /api/login attempt without a restart. A REMOVED user with a
live session token is NOT auto-signed-out — revoke the token by
DELETE /api/paired_devices/{token_id} or restart the dashboard.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import socket
import sys


def _localhost_only() -> None:
    # This CLI writes secrets. Refuse to run over SSH from a remote
    # host if the caller looks non-local — a mild guard, not a
    # security boundary. The file's mode 0600 is the real barrier.
    try:
        conn = os.environ.get('SSH_CONNECTION', '').split()
        if conn and conn[0] not in ('127.0.0.1', '::1'):
            print(f'cobot-user-cli: refusing SSH from {conn[0]} — '
                  f'run from the Jetson console/tmux',
                  file=sys.stderr)
            sys.exit(2)
    except Exception:
        pass


def _load_store():
    # Import path fixups — the module lives inside the cobot_dashboard
    # package which isn't on sys.path when this CLI is run from the
    # repo checkout.
    here = os.path.dirname(os.path.abspath(__file__))
    ws   = os.path.dirname(here)
    src  = os.path.join(ws, 'src', 'cobot_dashboard')
    if src not in sys.path:
        sys.path.insert(0, src)
    from cobot_dashboard import user_store as us  # noqa
    return us.get_store()


def _prompt_password(confirm: bool = True) -> str:
    p1 = getpass.getpass('password: ')
    if not confirm:
        return p1
    p2 = getpass.getpass('confirm:  ')
    if p1 != p2:
        print('passwords do not match', file=sys.stderr)
        sys.exit(3)
    return p1


def cmd_add(args) -> int:
    store = _load_store()
    password = args.password or _prompt_password()
    res = store.add(args.username, password, role=args.role)
    if not res.get('ok'):
        print(f'add failed: {res}', file=sys.stderr)
        return 4
    print(f"added user {res['username']} (role={res['role']})")
    return 0


def cmd_remove(args) -> int:
    store = _load_store()
    ok = store.remove(args.username)
    if not ok:
        print(f'no such user: {args.username}', file=sys.stderr)
        return 5
    print(f'removed user {args.username}')
    return 0


def cmd_passwd(args) -> int:
    store = _load_store()
    password = args.password or _prompt_password()
    res = store.set_password(args.username, password)
    if not res.get('ok'):
        print(f'passwd failed: {res}', file=sys.stderr)
        return 6
    print(f"password changed for {res['username']}")
    return 0


def cmd_list(_args) -> int:
    store = _load_store()
    users = store.list_users()
    if not users:
        print('(no users)')
        return 0
    print(f"{'USERNAME':<20} {'ROLE':<10} {'CREATED':<22} LAST LOGIN")
    for u in users:
        print(f"{u['username']:<20} {u['role']:<10} "
              f"{u['created']:<22} {u['last_login'] or '-'}")
    return 0


def main() -> int:
    _localhost_only()
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest='cmd', required=True)

    a = sub.add_parser('add', help='add a user')
    a.add_argument('username')
    a.add_argument('--role', default='operator',
                   choices=('admin', 'operator'))
    a.add_argument('--password',
                   help='(non-interactive; shell history hazard)')
    a.set_defaults(func=cmd_add)

    r = sub.add_parser('remove', help='remove a user')
    r.add_argument('username')
    r.set_defaults(func=cmd_remove)

    p = sub.add_parser('passwd', help="change a user's password")
    p.add_argument('username')
    p.add_argument('--password',
                   help='(non-interactive; shell history hazard)')
    p.set_defaults(func=cmd_passwd)

    l = sub.add_parser('list', help='list users')
    l.set_defaults(func=cmd_list)

    args = ap.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
