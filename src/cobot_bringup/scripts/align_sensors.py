#!/usr/bin/env python3
"""Interactive translation tweaker for the lidar->camera transforms.

Reads src/cobot_bringup/config/sensor_transforms.yaml, lets the operator
nudge the cam0 (and optionally cam1) translation in 1 cm or 5 cm steps,
saves on every change, and restarts roboai-tf + roboai-depth-segment so
the new transform is picked up live. Watch the dashboard while
adjusting; quit (q) when objects line up with the point cloud.

Commands (case-sensitive: lowercase = 1 cm, uppercase = 5 cm):
    x+ x-    nudge X (forward)
    y+ y-    nudge Y (left)
    z+ z-    nudge Z (up)
    1        switch to cam0  (default)
    2        switch to cam1
    show     print current values for both cameras
    q        quit (changes are auto-saved as you go)

The script will sudo systemctl restart roboai-tf roboai-depth-segment
on every nudge, so make sure you can run sudo without a password — or
just review the YAML at the end and restart manually.
"""
import os
import subprocess
import sys

import yaml

CONFIG = '/home/teddy/cobot_ws/src/cobot_bringup/config/sensor_transforms.yaml'
SERVICES = ['roboai-tf', 'roboai-depth-segment']


def _load():
    with open(CONFIG, 'r') as f:
        return yaml.safe_load(f) or {}


def _save(cfg):
    with open(CONFIG, 'w') as f:
        yaml.safe_dump(cfg, f, default_flow_style=False, sort_keys=False)


def _restart():
    try:
        subprocess.run(['sudo', '-n', 'systemctl', 'restart', *SERVICES],
                       check=False, timeout=5)
    except Exception as e:
        print(f'(systemctl restart skipped: {e})')


def _show(cfg):
    for key in ('cam0_to_lidar', 'cam1_to_lidar'):
        block = cfg.get(key) or {}
        t = block.get('translation') or [0.0, 0.0, 0.0]
        q = block.get('rotation')    or [0.5, -0.5, 0.5, 0.5]
        print(f'  {key}: t=[{t[0]:+.3f},{t[1]:+.3f},{t[2]:+.3f}] '
              f'q=[{q[0]:+.3f},{q[1]:+.3f},{q[2]:+.3f},{q[3]:+.3f}]')


def main():
    if not os.path.isfile(CONFIG):
        print(f'config not found: {CONFIG}', file=sys.stderr)
        sys.exit(1)
    cfg = _load()
    active = 'cam0_to_lidar'
    _show(cfg)
    print()
    print('Commands: x+ x- y+ y- z+ z- (1cm); X+ X- Y+ Y- Z+ Z- (5cm); '
          '1=cam0 2=cam1 show q=quit')

    while True:
        prompt = f'{active.replace("_to_lidar","")}> '
        try:
            cmd = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not cmd:
            continue
        if cmd in ('q', 'quit', 'exit'):
            return
        if cmd == 'show':
            _show(cfg); continue
        if cmd == '1':
            active = 'cam0_to_lidar'; continue
        if cmd == '2':
            active = 'cam1_to_lidar'; continue

        step = 0.01 if cmd[0].islower() else 0.05
        c = cmd.lower()
        axis_map = {'x+': (0, +1), 'x-': (0, -1),
                    'y+': (1, +1), 'y-': (1, -1),
                    'z+': (2, +1), 'z-': (2, -1)}
        if c not in axis_map:
            print(f'unknown command: {cmd!r}')
            continue
        idx, sign = axis_map[c]
        block = cfg.setdefault(active, {})
        t = list(block.get('translation') or [0.0, 0.0, 0.0])
        t[idx] = round(t[idx] + sign * step, 4)
        block['translation'] = t
        if 'rotation' not in block:
            block['rotation'] = [0.5, -0.5, 0.5, 0.5]
        _save(cfg)
        print(f'  {active} t={t}')
        _restart()


if __name__ == '__main__':
    main()
