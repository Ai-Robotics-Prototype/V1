#!/usr/bin/env python3
"""Re-extract geometric_features for every part in /opt/cobot/parts.

Used after a step_parser change so existing library entries get the
new fingerprint without requiring a re-upload. Idempotent: rerunning
just overwrites the geometric_features block on each metadata file.
"""
import glob
import json
import os
import sys

WS = '/home/teddy/cobot_ws'
sys.path.insert(0, os.path.join(WS, 'src/object_detection'))

from object_detection.step_parser import parse_step_file  # noqa: E402

LIBRARY = '/opt/cobot/parts'


def main() -> int:
    metas = sorted(glob.glob(os.path.join(LIBRARY, 'metadata', '*.json')))
    if not metas:
        print('no parts found in', LIBRARY)
        return 0
    for meta_path in metas:
        with open(meta_path) as f:
            meta = json.load(f)
        src = meta.get('source_file', '')
        step_path = os.path.join(LIBRARY, 'step', src)
        if not os.path.exists(step_path):
            print(f'skip {meta.get("name")}: source STEP missing ({step_path})')
            continue
        try:
            data = parse_step_file(step_path)
        except Exception as e:
            print(f'fail {meta.get("name")}: {e}')
            continue
        gf = data.get('geometric_features') or {}
        meta['geometric_features'] = gf
        with open(meta_path, 'w') as f:
            json.dump(meta, f, indent=2)
        print(f'{meta.get("name")}: holes={gf.get("num_holes")} '
              f'aspect={gf.get("aspect_ratio")} '
              f'w={gf.get("part_width_m")}m h={gf.get("part_height_m")}m')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
