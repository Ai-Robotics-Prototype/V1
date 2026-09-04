"""ONE detection source — pinned regression after the 2026-08-03
detection-path audit.

The operator's screenshot showed phantom classical detections on an
empty stool while the new Extrinsic-Uncalibrated chip WAS rendering.
Root cause: auto-deploy restarted roboai-dashboard + roboai-estun
only; the classical `depth_segment_node` running under
`roboai-depth-segment.service` was never restarted, so it kept
publishing to `/perception/detections_3d` alongside Isaac.

This suite pins the invariant that got missed: exactly ONE detection
publisher, and it is NOT the classical class-agnostic segmentor.
"""

from __future__ import annotations

import os
import re


BRINGUP_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))),
    'cobot_bringup')


def _read(rel_path: str) -> str:
    p = os.path.join(BRINGUP_DIR, rel_path)
    with open(p) as fh:
        return fh.read()


def test_tracked_systemd_unit_runs_isaac_detection_not_classical():
    """`src/cobot_bringup/systemd/roboai-depth-segment.service` (the
    repo's source-of-truth for the boot unit) must launch
    `isaac_detection.launch.py`, not `depth_detection.launch.py`.

    Depth_detection.launch.py has an Isaac primary branch (retire,
    don't delete) but the service must not enter it via that
    fallback dance — the tracked ExecStart wires Isaac directly so
    a re-flash lands the same behavior."""
    src = _read('systemd/roboai-depth-segment.service')
    assert 'isaac_detection.launch.py' in src, (
        'roboai-depth-segment.service does not run isaac_detection.launch.py; '
        'a fresh flash would restart the classical detector')
    for m in re.finditer(r'^\s*ExecStart\s*=(.*)$', src, re.MULTILINE):
        line = m.group(1)
        # Every ExecStart line must EITHER be the reset (`ExecStart=`
        # with empty rhs) OR reference isaac_detection.
        stripped = line.strip()
        if not stripped:
            continue
        assert 'isaac_detection.launch.py' in line, (
            f'ExecStart line does not point at the Isaac launch: {line!r}')
        assert 'depth_detection.launch.py' not in line, (
            f'ExecStart still references the retired classical launch: '
            f'{line!r}')


def test_isaac_detection_documents_the_stale_plan_rebuild_path():
    """Bench-verified 2026-08-03: the original May-27 `.plan` on disk
    deserialized OK but produced zero output tensors (TRT toolchain
    drift). A one-time rebuild with `force_engine_update=True`
    produced a valid 14 MB plan. That flag also deletes the plan
    on EVERY restart (~8 min rebuild each time), so
    isaac_detection.launch.py now sets it to False (cached plan
    reused). If a future plan goes stale again, the operator
    removes `/opt/cobot/models/yolov8n.plan` and restarts — TRT
    rebuilds from the ONNX. This test pins the comment path in the
    launch file so the rebuild recipe stays discoverable in-tree."""
    src = _read('launch/isaac_detection.launch.py')
    assert re.search(r"'force_engine_update'\s*:\s*False", src), (
        "isaac_detection.launch.py must set force_engine_update=False "
        "(cached plan reuse). Leaving it True rebuilds the engine on "
        "every restart — 8-minute cold start per boot.")
    assert 'stale' in src.lower(), (
        'isaac_detection.launch.py comment path around the '
        'force_engine_update flag must document the stale-plan rebuild '
        'recipe (delete the .plan + restart)')


def test_isaac_detection_publishes_to_the_dashboard_wire():
    """The bridge's remap must land on /perception/detections_3d —
    the ONE topic the dashboard, task_planner, and CameraPanel
    already subscribe to. If this remap drifts, the overlay reads
    a topic that has zero publishers and shows nothing forever."""
    src = _read('launch/isaac_detection.launch.py')
    assert "'/perception/detections_3d'" in src, (
        'isaac_detection bridge remap missing /perception/detections_3d')


def test_no_stale_classical_ExecStart_in_repo_systemd_files():
    """The retirement is repo-wide — no tracked `.service` file in
    the workspace still says `depth_segment_node` in its ExecStart.
    Prevents a follow-up unit from re-introducing the classical
    detector under a different service name."""
    for root, _dirs, files in os.walk(
            os.path.join(BRINGUP_DIR, '..')):
        # Skip build/install trees and any node_modules leftovers.
        if '/build/' in root or '/install/' in root:
            continue
        if '/node_modules/' in root:
            continue
        for name in files:
            if not name.endswith('.service'):
                continue
            path = os.path.join(root, name)
            with open(path) as fh:
                text = fh.read()
            for m in re.finditer(r'^\s*ExecStart\s*=(.*)$', text,
                                 re.MULTILINE):
                line = m.group(1)
                if 'depth_segment_node' in line:
                    raise AssertionError(
                        f'{path}: ExecStart still launches the retired '
                        f'depth_segment_node — {line!r}')
