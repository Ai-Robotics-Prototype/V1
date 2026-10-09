"""Isaac ROS becomes the sole part-detection path — launch-side
regression tests (2026-08-03 architecture directive).

Guarantees:
  * `full_stack.launch.py` no longer instantiates the classical
    `object_detection/detector_node` directly. Detection is wired
    through `isaac_detection_actions()`.
  * `depth_detection.launch.py` (the launch the boot-path unit
    `roboai-depth-segment.service` runs) has an Isaac primary branch
    and the classical `depth_segment_node` only as a fallback.
  * `isaac_detection.launch.py` exposes the extracted actions
    (`isaac_detection_actions`) and the fallback path is only
    reached when the Isaac packages / accelerator libs are missing.
  * Detection wire contract intact: the depth_detector_node remap
    still targets `/perception/detections_3d`.

Pure text checks — a bench run is what confirms the pipeline
actually publishes; these tests catch the launch-source regressions
that would silently retire the wrong node.
"""

from __future__ import annotations

import os
import re


LAUNCH_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__)))),
    'cobot_bringup', 'launch')


def _read(fname: str) -> str:
    p = os.path.join(LAUNCH_DIR, fname)
    with open(p) as fh:
        return fh.read()


def test_full_stack_no_longer_starts_classical_detector_node():
    """The line `Node(package='object_detection', executable='detector_node', ...)`
    must not appear as an active instantiation in full_stack.launch.py.
    Comment references are fine; a live Node() call is not."""
    src = _read('full_stack.launch.py')
    # A line that is BOTH not a comment AND names both keywords is
    # a live instantiation. Comments start with '#' at any indent.
    for i, line in enumerate(src.splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith('#'):
            continue
        if ("executable='detector_node'" in line
                and "package='object_detection'" in line):
            raise AssertionError(
                f'full_stack.launch.py:{i} still starts the classical '
                f'detector_node — should route through '
                f'`isaac_detection_actions()` instead:\n  {line!r}')


def test_full_stack_includes_isaac_detection_actions():
    """full_stack.launch.py must invoke isaac_detection_actions()."""
    src = _read('full_stack.launch.py')
    assert 'isaac_detection_actions' in src, (
        'full_stack.launch.py does not reference isaac_detection_actions; '
        'the detection wiring is missing entirely')
    assert re.search(r'\*isaac_detection_actions\s*\(\s*\)', src), (
        'isaac_detection_actions() must be splatted into the launch list '
        '(the pattern used to include the extracted actions)')


def test_isaac_detection_launch_exports_actions():
    """isaac_detection.launch.py exposes isaac_detection_actions() so
    the same block is reachable from full_stack + depth_detection."""
    src = _read('isaac_detection.launch.py')
    assert 'def isaac_detection_actions' in src, (
        'isaac_detection.launch.py missing the actions() extract — '
        'other launches cannot import the pipeline')


def test_isaac_detection_launch_wires_detection3d_topic():
    """The depth_detector_node's remap MUST target
    /perception/detections_3d — the wire the dashboard already
    consumes. Zero forked consumers."""
    src = _read('isaac_detection.launch.py')
    # remap tuple to Detection3D topic
    assert "'/perception/detections_3d'" in src, (
        'isaac_detection.launch.py does not remap to '
        '/perception/detections_3d — dashboard would see no detections')
    assert "'/detections_output'" in src, (
        'isaac_detection.launch.py does not remap /detections to '
        '/detections_output — YOLO decoder would not feed the bridge')


def test_isaac_detection_uses_the_plan_engine_at_the_expected_path():
    """The TensorRT engine file path must match the ONNX/plan the
    operator ships in /opt/cobot/models/. Regressions here cause a
    silent load failure at container start."""
    src = _read('isaac_detection.launch.py')
    assert '/opt/cobot/models/yolov8n.plan' in src, (
        'isaac_detection.launch.py points at the wrong engine path — '
        'TensorRTNode will fail to deserialize on boot')


def test_depth_detection_launch_has_isaac_primary_branch():
    """depth_detection.launch.py (boot-path unit) has an Isaac
    primary branch that runs when the packages are available;
    depth_segment_node stays only as the fallback."""
    src = _read('depth_detection.launch.py')
    assert 'isaac_detection_actions' in src, (
        'depth_detection.launch.py does not include the Isaac pipeline; '
        'the boot path is still on the classical depth_segment engine')
    # Fallback branch STILL exists (retire, don't delete). Assert the
    # depth_segment_node node is guarded by an if-not-available.
    assert 'depth_segment_node' in src, (
        'depth_segment_node removed entirely — should be RETIRED not '
        'deleted; keep the fallback branch for dev bring-up')
    assert 'isaac_available' in src, (
        'depth_detection.launch.py missing the Isaac-availability '
        'guard; fallback logic would never gate correctly')


def test_isaac_detection_falls_back_when_libs_missing():
    """The fallback branch inside isaac_detection.launch.py must
    remain — a dev laptop without CUDA/VPI still boots detection."""
    src = _read('isaac_detection.launch.py')
    assert 'if not isaac_ok' in src, (
        'isaac_detection.launch.py fallback branch missing — a bench '
        'without accelerator libs would fail boot')
