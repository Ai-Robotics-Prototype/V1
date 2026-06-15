"""Validation harness for synthetic_scene_gen + recognition_benchmark.

Runs the generator against the real part library on disk and asserts on the
properties the brief calls out. No camera, no Isaac Sim — just CPU + Open3D.

Run directly:
    python3 src/object_detection/test/test_synthetic_scene_gen.py

Or via pytest if you want unittest-style discovery (the asserts are bare so
pytest will pick them up too).
"""
from __future__ import annotations

import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

# Resolve sibling modules whether the package is installed or not.
_PKG = Path(__file__).resolve().parents[1] / "object_detection"
if str(_PKG) not in sys.path:
    sys.path.insert(0, str(_PKG))

import numpy as np

from synthetic_scene_gen import (
    SceneConfig, SensorConfig, BinConfig,
    generate_scene, generate_scene_set,
    load_scene,
)
from recognition_benchmark import (
    evaluate, extents_match_recognition_fn, perfect_oracle_recognition_fn,
    format_report, score_result, aggregate,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pick_real_parts():
    """Pull a sane mix of real part IDs from /opt/cobot/parts/index.json.

    Filters out the no-STEP "camera-only" Delrin entry so we exercise the
    CAD-sampling path with real geometry. Falls back loudly if nothing is
    available so we don't silently pass on an empty library."""
    index_path = Path("/opt/cobot/parts/index.json")
    assert index_path.is_file(), \
        "No /opt/cobot/parts/index.json — synthetic scene gen needs real parts."
    data = json.loads(index_path.read_text())
    pool = [p for p in data["parts"]
            if p.get("source_file") and not all(
                float(v) == 0 for v in (p.get("extents_cm") or []))]
    # Prefer the BT225 variants we care about for L24-vs-L28 discrimination.
    by_name = {p["name"]: p for p in pool}
    preferred_names = ["BT225L24_a", "BT225L28_a", "BT225L13_a", "BT225L22_a"]
    chosen = [by_name[n] for n in preferred_names if n in by_name]
    if len(chosen) < 2:
        chosen = pool[:3]
    assert len(chosen) >= 2, f"Need at least 2 parts with STEP files, got {chosen}"
    return [p["id"] for p in chosen], [p["name"] for p in chosen]


def _print(banner):
    print("\n" + "=" * 70)
    print(f"  {banner}")
    print("=" * 70)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_single_scene(tmp_dir: Path):
    _print("test_single_scene")
    part_ids, names = _pick_real_parts()
    counts = {pid: 2 for pid in part_ids[:2]}   # 2 of two part types
    if len(part_ids) > 2:
        counts[part_ids[2]] = 1                  # plus 1 of a third
    cfg = SceneConfig(
        part_ids=list(counts.keys()),
        counts=counts,
        seed=42,
        clutter_level=0.2,
    )
    scene = generate_scene(cfg, scenes_dir=tmp_dir)

    # 1. scene_cloud is non-empty + has normals + confidence
    assert scene.points.size > 0, "scene_cloud is empty"
    assert scene.points.shape == scene.normals.shape, "normals shape mismatch"
    assert scene.confidence.shape[0] == scene.points.shape[0], \
        "confidence/points length mismatch"
    assert np.all((scene.confidence >= 0) & (scene.confidence <= 1)), \
        "confidence outside [0, 1]"

    # 2. ground_truth covers every placed instance
    assert len(scene.instances) == sum(counts.values()), \
        f"expected {sum(counts.values())} instances, got {len(scene.instances)}"
    for inst in scene.instances:
        assert inst.placed_points > 0
        assert isinstance(inst.is_pickable, bool)

    # 3. HPR culled hidden points — at least one instance has visible < 1.0
    fractions = [inst.visible_fraction() for inst in scene.instances]
    assert any(f < 1.0 for f in fractions), \
        f"no occlusion detected — fractions: {fractions}"
    assert all(0.0 <= f <= 1.0 for f in fractions)

    # 4. render_preview.png produced
    preview = scene.saved_dir / "render_preview.png"
    assert preview.is_file(), f"missing preview at {preview}"
    assert preview.stat().st_size > 5000, "preview too small to be a real image"

    # Persisted files are loadable.
    loaded = load_scene(scene.saved_dir)
    assert loaded["points"].shape[0] == scene.points.shape[0]
    assert loaded["ground_truth"]["scene_id"] == scene.scene_id

    print(f"  scene  pts={len(scene.points):>6}  "
          f"instances={len(scene.instances)}  "
          f"vis_fracs={[round(f, 2) for f in fractions]}")
    print(f"  saved  {scene.saved_dir}")
    return scene


def test_scene_set_variety(tmp_dir: Path):
    _print("test_scene_set_variety  (N=20)")
    part_ids, _ = _pick_real_parts()
    counts = {part_ids[0]: 2}
    if len(part_ids) > 1:
        counts[part_ids[1]] = 2

    cfg = SceneConfig(part_ids=list(counts.keys()), counts=counts, seed=1000)
    out_dir = generate_scene_set(cfg, n_scenes=20, scenes_dir=tmp_dir,
                                   set_name="variety_check")

    # Collect the first-instance translation per scene and require a spread.
    first_xys = []
    for scene_dir in sorted(out_dir.iterdir()):
        if not scene_dir.is_dir() or not (scene_dir / "ground_truth.json").is_file():
            continue
        gt = json.loads((scene_dir / "ground_truth.json").read_text())
        if gt["instances"]:
            pos = gt["instances"][0]["pose"]["position"]
            first_xys.append((pos["x"], pos["y"]))
    assert len(first_xys) == 20, f"expected 20 scenes, got {len(first_xys)}"
    arr = np.array(first_xys)
    spread = arr.std(axis=0)
    assert spread.min() > 0.005, \
        f"scenes look identical — first-inst std={spread}"
    print(f"  generated 20 scenes, first-inst XY spread = "
          f"{spread[0] * 1000:.1f} × {spread[1] * 1000:.1f} mm")
    return out_dir


def test_benchmark_with_trivial_baseline(scene_set_dir: Path):
    _print("test_benchmark_with_trivial_baseline (extents_match)")
    report = evaluate(scene_set_dir, extents_match_recognition_fn,
                       report_path=scene_set_dir / "report_extents.json",
                       verbose=False)
    print(format_report(report))
    # Sanity: the harness produced a report with all numeric fields filled in.
    assert report.n_scenes > 0
    assert report.n_truth > 0
    assert 0.0 <= report.precision <= 1.0
    assert 0.0 <= report.recall    <= 1.0
    assert 0.0 <= report.f1        <= 1.0
    return report


def test_oracle_scores_perfect(scene_set_dir: Path):
    """If the recognition_fn IS the ground-truth, the harness must score
    100% precision/recall/F1 with ~0 pose error. Confirms harness math."""
    _print("test_oracle_scores_perfect")
    report = evaluate(scene_set_dir, perfect_oracle_recognition_fn,
                       report_path=scene_set_dir / "report_oracle.json",
                       verbose=False)
    print(format_report(report, include_confusion=False))
    assert math.isclose(report.precision, 1.0, abs_tol=1e-6), \
        f"oracle precision {report.precision}"
    assert math.isclose(report.recall, 1.0, abs_tol=1e-6), \
        f"oracle recall {report.recall}"
    assert math.isclose(report.f1, 1.0, abs_tol=1e-6), \
        f"oracle f1 {report.f1}"
    assert report.translation_mae_m < 1e-6, \
        f"oracle translation error nonzero: {report.translation_mae_m}"
    assert report.rotation_mae_deg < 1e-3, \
        f"oracle rotation error nonzero: {report.rotation_mae_deg}"
    print("  oracle scored perfect — harness math confirmed.")


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def main():
    tmp_dir = Path(tempfile.mkdtemp(prefix="synth_scene_test_"))
    print(f"  scratch dir: {tmp_dir}")
    try:
        test_single_scene(tmp_dir)
        scene_set = test_scene_set_variety(tmp_dir)
        test_oracle_scores_perfect(scene_set)
        test_benchmark_with_trivial_baseline(scene_set)
        print("\nAll synthetic_scene_gen + benchmark checks PASSED.")
        print(f"Artifacts under {tmp_dir}")
        return 0
    except AssertionError as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        return 1


# pytest discovery hooks — pytest collects `test_*` functions, so wrap each
# with a fresh scratch dir to avoid sharing tmp state across tests.
def _scratch():
    return Path(tempfile.mkdtemp(prefix="synth_scene_pytest_"))


def test_pytest_single_scene():
    test_single_scene(_scratch())


def test_pytest_variety_and_benchmark():
    d = _scratch()
    out = test_scene_set_variety(d)
    test_oracle_scores_perfect(out)
    test_benchmark_with_trivial_baseline(out)


if __name__ == "__main__":
    raise SystemExit(main())
