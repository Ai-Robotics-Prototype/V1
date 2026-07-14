#!/usr/bin/env python3
"""Test direct WebSocket connection to the Estun Codroid controller.

Ordered candidate connect: if the shipping firmware IP is uncertain,
pass more than one --ip and the script tries them in order, returning
success on the first that answers.

Defaults are read from src/estun_driver/config/estun.yaml so this tool
and the ROS2 driver share one source of truth. Env var ESTUN_ROBOT_IP
overrides the YAML default (same precedence as the driver).

NOTE: This uses the LEGACY action-schema and does NOT match the shipped
Codroid v2.3 firmware. For the live v2.3 protocol test (subscribe burst
+ RobotPosture stream) use scripts/posture.py instead. This script is
kept only for legacy-firmware probing.

Examples
--------
    ./scripts/test_estun_connection.py                    # use yaml default
    ./scripts/test_estun_connection.py --ip 192.168.2.136 # single override
    ESTUN_ROBOT_IP=192.168.2.136 ./scripts/test_estun_connection.py
"""
import argparse
import json
import os
import sys

try:
    import websockets.sync.client as ws
except ImportError:
    sys.stderr.write('websockets not installed: pip install websockets\n')
    sys.exit(2)

REPO_ROOT   = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_YAML = os.path.join(
    REPO_ROOT, 'src', 'estun_driver', 'config', 'estun.yaml')


def _read_yaml_defaults(path):
    """Best-effort read of robot_ip / robot_port from the driver YAML.

    Uses a tiny hand-parser so this script can run without PyYAML
    installed (fresh Jetson bring-up scenario). Falls back to the same
    hardcoded default the driver uses.
    """
    ip = '192.168.2.136'
    port = 9000
    if not os.path.isfile(path):
        return ip, port
    try:
        with open(path) as f:
            in_ros_params = False
            for raw in f:
                line = raw.rstrip()
                if not line or line.lstrip().startswith('#'):
                    continue
                stripped = line.strip()
                if stripped.startswith('ros__parameters:'):
                    in_ros_params = True
                    continue
                if in_ros_params:
                    if stripped.startswith('robot_ip:'):
                        val = stripped.split(':', 1)[1].strip().strip('"').strip("'")
                        if val:
                            ip = val
                    elif stripped.startswith('robot_port:'):
                        val = stripped.split(':', 1)[1].strip()
                        try:
                            port = int(val)
                        except ValueError:
                            pass
    except Exception as e:
        print(f'warn: could not parse {path}: {e}', file=sys.stderr)
    return ip, port


def _probe(ip, port, timeout):
    """Try one candidate. Return True on success."""
    url = f'ws://{ip}:{port}'
    print(f'--- Trying {url} (timeout {timeout}s) ---')
    try:
        conn = ws.connect(url, open_timeout=timeout)
        print('Connected.')

        conn.send(json.dumps({'id': 1, 'type': 'common',
                              'action': 'getRobotStates', 'data': {}}))
        resp = json.loads(conn.recv(timeout=2))
        print(f'Robot state: {json.dumps(resp, indent=2)}')

        conn.send(json.dumps({'id': 2, 'type': 'common',
                              'action': 'getCurAPos', 'data': []}))
        resp = json.loads(conn.recv(timeout=2))
        print(f'Joint positions: {json.dumps(resp, indent=2)}')

        conn.send(json.dumps({'id': 3, 'type': 'common',
                              'action': 'getCurCPos', 'data': []}))
        resp = json.loads(conn.recv(timeout=2))
        print(f'TCP position: {json.dumps(resp, indent=2)}')

        # Try version query - speculative, may fail; log either way.
        conn.send(json.dumps({'id': 4, 'type': 'common',
                              'action': 'getparam',
                              'data': ['Robot/System/version']}))
        try:
            resp = json.loads(conn.recv(timeout=2))
            print(f'Version query: {json.dumps(resp, indent=2)}')
        except Exception as e:
            print(f'Version query no-response (ok): {e}')

        conn.close()
        print(f'OK on {url}')
        return True
    except Exception as e:
        print(f'FAIL {url}: {e}')
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().split('\n')[0])
    ap.add_argument('--ip', action='append', default=None,
                    help='Robot IP to try (may be given multiple times, '
                         'tried in order)')
    ap.add_argument('--port', type=int, default=None,
                    help='TCP port (default from yaml / 9000)')
    ap.add_argument('--config', default=DEFAULT_YAML,
                    help=f'YAML with driver defaults (default: {DEFAULT_YAML})')
    ap.add_argument('--timeout', type=float, default=3.0,
                    help='Per-attempt connect timeout in seconds')
    # Legacy positional support: `./test_estun_connection.py 1.2.3.4`
    ap.add_argument('positional_ip', nargs='?', default=None,
                    help=argparse.SUPPRESS)
    args = ap.parse_args()

    yaml_ip, yaml_port = _read_yaml_defaults(args.config)
    env_ip = os.environ.get('ESTUN_ROBOT_IP')

    port = args.port if args.port is not None else yaml_port

    if args.ip:
        candidates = args.ip
    elif args.positional_ip:
        candidates = [args.positional_ip]
    elif env_ip:
        candidates = [env_ip]
    else:
        candidates = [yaml_ip]

    print(f'Candidate order: {candidates}  port={port}')
    for ip in candidates:
        if _probe(ip, port, args.timeout):
            print(f'\n== Success on {ip}:{port} ==')
            sys.exit(0)
    print('\n== All candidates failed. ==', file=sys.stderr)
    sys.exit(1)


if __name__ == '__main__':
    main()
