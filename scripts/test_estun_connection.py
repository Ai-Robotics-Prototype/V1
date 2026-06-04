#!/usr/bin/env python3
"""Test direct WebSocket connection to Estun Codroid controller."""
import websockets.sync.client as ws
import json
import sys

ROBOT_IP = sys.argv[1] if len(sys.argv) > 1 else '192.168.101.100'
url = f'ws://{ROBOT_IP}:9000'

print(f'Connecting to {url}...')
try:
    conn = ws.connect(url, open_timeout=3)
    print('Connected!')

    # Get robot state
    conn.send(json.dumps({'id': 1, 'type': 'common', 'action': 'getRobotStates', 'data': {}}))
    resp = json.loads(conn.recv(timeout=2))
    print(f'Robot state: {json.dumps(resp, indent=2)}')

    # Get joint positions
    conn.send(json.dumps({'id': 2, 'type': 'common', 'action': 'getCurAPos', 'data': []}))
    resp = json.loads(conn.recv(timeout=2))
    print(f'Joint positions: {json.dumps(resp, indent=2)}')

    # Get TCP position
    conn.send(json.dumps({'id': 3, 'type': 'common', 'action': 'getCurCPos', 'data': []}))
    resp = json.loads(conn.recv(timeout=2))
    print(f'TCP position: {json.dumps(resp, indent=2)}')

    conn.close()
    print('Test passed!')
except Exception as e:
    print(f'Connection failed: {e}')
    sys.exit(1)
