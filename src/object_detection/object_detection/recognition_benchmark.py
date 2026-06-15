"""Recognition benchmark harness for synthetic scenes.

Compares a pluggable recognition function against the ground-truth poses
written by synthetic_scene_gen. Same interface for any recognition
backend — PPF + ICP, FoundationPose, Locator — so we can score them
apples-to-apples and reason about identity / pose / pickability accuracy
from numbers, not theory.

The recognition_fn callback returns a list of detections:

    {
        "part_id":     str,        # required
        "pose":        {
            "position":    {"x": float, "y": float, "z": float},
            "orientation": {"x": float, "y": float, "z": float, "w": float},
        },
        "confidence":  float,      # 0..1, optional
        "instance_id": int,        # optional; harness will match by pose otherwise
    }

The harness greedy-matches detections to ground-truth instances by part
type and pose proximity, scores translation + rotation error against the
match, and reports per-part precision/recall/F1 plus a confusion table.

Trivial baseline: `extents_match_recognition_fn` — predicts the
nearest-extent library part at the centroid of every connected cluster
above the table. Lets us verify the harness math runs end-to-end with no
real matcher wired up yet.
"""
from __future__ import annotations

import json
import math
import os
import sys
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import numpy as np

# Resolve the synthetic_scene_gen module both as a package import (when
# colcon symlink-installs the package) and as a script-style sibling.
try:
    from .synthetic_scene_gen import (
        SCENES_DIR, PARTS_DIR, load_scene)
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from synthetic_scene_gen import SCENES_DIR, PARTS_DIR, load_scene


RecognitionFn = Callable[[Dict[str, Any]], List[Dict[str, Any]]]


# Default matching thresholds. Translation threshold scales with the
# largest part dimension at runtime, so big parts don't get punished for
# absolute mm differences a small part would never tolerate.
DEFAULT_TRANSLATION_TOL_M  = 0.020   # 20 mm
DEFAULT_ROTATION_TOL_DEG   = 25.0
DEFAULT_PICKABLE_TOL_DEG   = 25.0


# ---------------------------------------------------------------------------
# Helpers — quaternion + matrix conversions
# ---------------------------------------------------------------------------

def _quat_to_R(q: Dict[str, float]) -> np.ndarray:
    x, y, z, w = float(q["x"]), float(q["y"]), float(q["z"]), float(q["w"])
    n = math.sqrt(x * x + y * y + z * z + w * w)
    if n < 1e-9:
        return np.eye(3)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w),     2 * (x * z + y * w)],
        [2 * (x * y + z * w),     1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w),     2 * (y * z + x * w),     1 - 2 * (x * x + y * y)],
    ])


def _pose_to_R_t(pose: Dict[str, Any]) -> Tuple[np.ndarray, np.ndarray]:
    if pose is None:
        return np.eye(3), np.zeros(3)
    pos = pose.get("position", {})
    if "matrix" in pose and pose["matrix"] is not None:
        R = np.asarray(pose["matrix"], dtype=np.float64).reshape(3, 3)
    else:
        R = _quat_to_R(pose.get("orientation", {"x": 0, "y": 0, "z": 0, "w": 1}))
    t = np.array([float(pos.get("x", 0)),
                   float(pos.get("y", 0)),
                   float(pos.get("z", 0))], dtype=np.float64)
    return R, t


def _rotation_error_deg(R_a: np.ndarray, R_b: np.ndarray) -> float:
    """Angle of the relative rotation R_a^T R_b, in degrees."""
    R = R_a.T @ R_b
    trace = float(np.clip((np.trace(R) - 1.0) / 2.0, -1.0, 1.0))
    return math.degrees(math.acos(trace))


# ---------------------------------------------------------------------------
# Per-scene scoring
# ---------------------------------------------------------------------------

@dataclass
class InstanceScore:
    instance_id: int
    part_id: str
    matched: bool
    correct_identity: bool
    translation_error_m: float
    rotation_error_deg: float
    predicted_part_id: Optional[str]
    pickable_truth: bool
    pickable_pred: Optional[bool]
    visible_fraction: float


@dataclass
class SceneScore:
    scene_id: str
    instances: List[InstanceScore]
    n_predictions: int
    n_truth: int
    true_positives: int
    false_positives: int
    false_negatives: int
    duration_s: float
    per_part_confusion: Dict[str, Dict[str, int]]


def score_result(recognition_output: List[Dict[str, Any]],
                  ground_truth: Dict[str, Any],
                  *,
                  translation_tol_m: float = DEFAULT_TRANSLATION_TOL_M,
                  rotation_tol_deg: float = DEFAULT_ROTATION_TOL_DEG,
                  pickable_tol_deg: float = DEFAULT_PICKABLE_TOL_DEG,
                  duration_s: float = 0.0) -> SceneScore:
    """Greedy-match predictions to truth, count TP / FP / FN, record pose
    error for each matched pair, and build a per-part confusion table."""
    truth_instances = list(ground_truth.get("instances", []))
    n_truth = len(truth_instances)

    # Cache truth poses + part-extent based translation tolerances.
    truth_R_t = []
    for inst in truth_instances:
        R, t = _pose_to_R_t(inst.get("pose"))
        extents = np.asarray(inst.get("extents_m", [0.04, 0.04, 0.04]),
                              dtype=np.float64)
        # Per-instance translation tolerance: max(tol, ~30% of longest axis).
        # A 50 mm bolt should not be considered "well-localised" if the
        # prediction is 25 mm off.
        local_tol = max(translation_tol_m, 0.30 * float(extents.max()))
        truth_R_t.append((R, t, local_tol, inst))

    used_truth = [False] * n_truth
    instance_scores: List[InstanceScore] = []
    confusion: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    tp = fp = 0

    # Sort predictions by confidence DESC so high-confidence detections get
    # first dibs on the truth instances they're closest to.
    preds = sorted(list(recognition_output or []),
                    key=lambda d: -float(d.get("confidence", 0.0)))

    for pred in preds:
        pred_pid = pred.get("part_id")
        R_p, t_p = _pose_to_R_t(pred.get("pose"))

        # Greedy nearest UN-USED truth instance, considering ID match first.
        best_idx = -1
        best_score = math.inf
        for i, (R_t_truth, t_t, local_tol, inst) in enumerate(truth_R_t):
            if used_truth[i]:
                continue
            dist = float(np.linalg.norm(t_p - t_t))
            # Allow pose-only matches across IDs (so we count misclassifications)
            if dist > max(local_tol * 3.0, 0.10):
                continue
            same_pid = (pred_pid == inst.get("part_id"))
            # Prefer same-part matches by halving their distance score.
            sc = dist if same_pid else dist * 1.7
            if sc < best_score:
                best_score = sc
                best_idx = i

        if best_idx == -1:
            fp += 1
            confusion["__none__"][pred_pid or "unknown"] += 1
            continue
        used_truth[best_idx] = True
        truth_R, truth_t, local_tol, truth_inst = truth_R_t[best_idx]

        dist = float(np.linalg.norm(t_p - truth_t))
        rot_err = _rotation_error_deg(truth_R, R_p)
        correct_id = (pred_pid == truth_inst.get("part_id"))

        confusion[truth_inst.get("part_id")][pred_pid or "unknown"] += 1

        # TP / FP / FN measure identity (the brief separates identity from
        # pose: pose error is reported on the correctly-identified subset).
        # Pose accuracy is captured in instance.translation/rotation_error
        # and the aggregated MAE/RMSE for matched correct-id instances.
        if correct_id:
            tp += 1
        else:
            fp += 1

        # Pickability is purely a function of rotation — the recognition
        # output doesn't have to report it, but if it does we score it.
        truth_pickable = bool(truth_inst.get("is_pickable", False))
        face_axis = R_p @ np.array([0, 0, 1.0])
        tilt_deg = math.degrees(math.acos(max(-1.0, min(1.0, face_axis[2]))))
        pred_pickable = tilt_deg < pickable_tol_deg

        instance_scores.append(InstanceScore(
            instance_id=int(truth_inst.get("instance_id", -1)),
            part_id=str(truth_inst.get("part_id")),
            matched=True,
            correct_identity=correct_id,
            translation_error_m=dist,
            rotation_error_deg=rot_err,
            predicted_part_id=pred_pid,
            pickable_truth=truth_pickable,
            pickable_pred=pred_pickable,
            visible_fraction=float(truth_inst.get("visible_point_fraction", 1.0)),
        ))

    # Any truth instance we never matched is a miss (FN).
    fn = 0
    for i, used in enumerate(used_truth):
        if used:
            continue
        truth_inst = truth_R_t[i][3]
        fn += 1
        confusion[truth_inst.get("part_id")]["__none__"] += 1
        instance_scores.append(InstanceScore(
            instance_id=int(truth_inst.get("instance_id", -1)),
            part_id=str(truth_inst.get("part_id")),
            matched=False,
            correct_identity=False,
            translation_error_m=float("nan"),
            rotation_error_deg=float("nan"),
            predicted_part_id=None,
            pickable_truth=bool(truth_inst.get("is_pickable", False)),
            pickable_pred=None,
            visible_fraction=float(truth_inst.get("visible_point_fraction", 1.0)),
        ))

    return SceneScore(
        scene_id=str(ground_truth.get("scene_id", "")),
        instances=instance_scores,
        n_predictions=len(preds),
        n_truth=n_truth,
        true_positives=tp,
        false_positives=fp,
        false_negatives=fn,
        duration_s=duration_s,
        per_part_confusion={k: dict(v) for k, v in confusion.items()},
    )


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

@dataclass
class BenchmarkReport:
    n_scenes: int
    n_truth: int
    true_positives: int
    false_positives: int
    false_negatives: int
    precision: float
    recall: float
    f1: float
    translation_mae_m: float
    translation_rmse_m: float
    rotation_mae_deg: float
    rotation_rmse_deg: float
    pickability_accuracy: float
    per_part: Dict[str, Dict[str, Any]]
    confusion: Dict[str, Dict[str, int]]
    duration_s: float

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def aggregate(scene_scores: List[SceneScore]) -> BenchmarkReport:
    tp = sum(s.true_positives for s in scene_scores)
    fp = sum(s.false_positives for s in scene_scores)
    fn = sum(s.false_negatives for s in scene_scores)
    n_truth = sum(s.n_truth for s in scene_scores)

    precision = tp / max(1, tp + fp)
    recall    = tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-9, precision + recall)

    trans_errs = []
    rot_errs   = []
    pickable_hits = pickable_total = 0
    per_part: Dict[str, Dict[str, Any]] = defaultdict(lambda: {
        "n_truth": 0, "tp": 0, "fp": 0, "fn": 0,
        "translation_errors_m": [],
        "rotation_errors_deg": [],
        "pickability_hits": 0,
        "pickability_total": 0,
    })

    confusion: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for s in scene_scores:
        for truth_pid, pred_map in s.per_part_confusion.items():
            for pred_pid, cnt in pred_map.items():
                confusion[truth_pid][pred_pid] += cnt
        for inst in s.instances:
            pp = per_part[inst.part_id]
            if inst.matched and inst.correct_identity and not math.isnan(
                    inst.translation_error_m):
                pp["tp"] += 1
                pp["translation_errors_m"].append(inst.translation_error_m)
                pp["rotation_errors_deg"].append(inst.rotation_error_deg)
                trans_errs.append(inst.translation_error_m)
                rot_errs.append(inst.rotation_error_deg)
            elif inst.matched and not inst.correct_identity:
                pp["fp"] += 1
            elif not inst.matched:
                pp["fn"] += 1
            pp["n_truth"] += 1
            if inst.pickable_pred is not None:
                pickable_total += 1
                pp["pickability_total"] += 1
                if inst.pickable_pred == inst.pickable_truth:
                    pickable_hits += 1
                    pp["pickability_hits"] += 1

    tr_arr = np.asarray(trans_errs) if trans_errs else np.array([])
    rt_arr = np.asarray(rot_errs)   if rot_errs   else np.array([])

    # Per-part summary numbers.
    per_part_out: Dict[str, Dict[str, Any]] = {}
    for pid, vals in per_part.items():
        te = np.asarray(vals["translation_errors_m"]) if vals["translation_errors_m"] else np.array([])
        re = np.asarray(vals["rotation_errors_deg"])   if vals["rotation_errors_deg"]   else np.array([])
        per_part_out[pid] = {
            "n_truth": vals["n_truth"],
            "tp": vals["tp"], "fp": vals["fp"], "fn": vals["fn"],
            "translation_mae_m":  float(te.mean()) if te.size else None,
            "translation_rmse_m": float(np.sqrt((te ** 2).mean())) if te.size else None,
            "rotation_mae_deg":   float(re.mean()) if re.size else None,
            "rotation_rmse_deg":  float(np.sqrt((re ** 2).mean())) if re.size else None,
            "pickability_accuracy": (vals["pickability_hits"]
                                     / max(1, vals["pickability_total"]))
                                     if vals["pickability_total"] else None,
        }

    return BenchmarkReport(
        n_scenes=len(scene_scores),
        n_truth=n_truth,
        true_positives=tp,
        false_positives=fp,
        false_negatives=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        translation_mae_m=float(tr_arr.mean()) if tr_arr.size else float("nan"),
        translation_rmse_m=float(np.sqrt((tr_arr ** 2).mean())) if tr_arr.size else float("nan"),
        rotation_mae_deg=float(rt_arr.mean()) if rt_arr.size else float("nan"),
        rotation_rmse_deg=float(np.sqrt((rt_arr ** 2).mean())) if rt_arr.size else float("nan"),
        pickability_accuracy=(pickable_hits / max(1, pickable_total))
                              if pickable_total else float("nan"),
        per_part={k: v for k, v in per_part_out.items()},
        confusion={k: dict(v) for k, v in confusion.items()},
        duration_s=float(sum(s.duration_s for s in scene_scores)),
    )


# ---------------------------------------------------------------------------
# Pretty-printing the report
# ---------------------------------------------------------------------------

def format_report(report: BenchmarkReport, *, include_confusion: bool = True) -> str:
    lines: List[str] = []
    lines.append("=" * 72)
    lines.append(f"  Recognition benchmark — {report.n_scenes} scene(s), "
                  f"{report.n_truth} truth instance(s)")
    lines.append("=" * 72)
    lines.append(
        f"  TP / FP / FN  : {report.true_positives:>4} / "
        f"{report.false_positives:>4} / {report.false_negatives:>4}")
    lines.append(
        f"  Precision     : {report.precision:.3f}   "
        f"Recall: {report.recall:.3f}   F1: {report.f1:.3f}")
    if not math.isnan(report.translation_mae_m):
        lines.append(
            f"  Translation   : MAE {report.translation_mae_m * 1000:6.2f} mm   "
            f"RMSE {report.translation_rmse_m * 1000:6.2f} mm  (matched only)")
    else:
        lines.append("  Translation   : —")
    if not math.isnan(report.rotation_mae_deg):
        lines.append(
            f"  Rotation      : MAE {report.rotation_mae_deg:6.2f}°   "
            f"RMSE {report.rotation_rmse_deg:6.2f}°  (matched only)")
    else:
        lines.append("  Rotation      : —")
    if not math.isnan(report.pickability_accuracy):
        lines.append(f"  Pickability   : {report.pickability_accuracy * 100:5.1f}%")
    lines.append(f"  Total runtime : {report.duration_s:.2f} s")
    lines.append("-" * 72)
    lines.append(f"  Per-part breakdown")
    lines.append(f"    {'part_id':<14} {'truth':>5} {'TP':>4} {'FP':>4} {'FN':>4} "
                  f"{'pose mm':>9} {'pose °':>8}")
    for pid, pp in sorted(report.per_part.items()):
        pose_mm = (f"{pp['translation_mae_m'] * 1000:6.2f}"
                   if pp["translation_mae_m"] is not None else "    —")
        pose_dg = (f"{pp['rotation_mae_deg']:6.2f}"
                   if pp["rotation_mae_deg"] is not None else "   —")
        lines.append(f"    {pid:<14} {pp['n_truth']:>5} {pp['tp']:>4} "
                      f"{pp['fp']:>4} {pp['fn']:>4} {pose_mm:>9} {pose_dg:>8}")
    if include_confusion and report.confusion:
        lines.append("-" * 72)
        lines.append("  Confusion (rows = truth, cols = predicted, '__none__' = miss)")
        # Build a stable column ordering.
        all_cols = set()
        for cols in report.confusion.values():
            all_cols.update(cols.keys())
        col_order = sorted(c for c in all_cols if c != "__none__") + ["__none__"]
        header = "    " + "truth\\pred".ljust(14)
        header += "  ".join(c[:10].ljust(10) for c in col_order)
        lines.append(header)
        for truth_pid in sorted(report.confusion.keys()):
            row = report.confusion[truth_pid]
            line = "    " + truth_pid.ljust(14)
            line += "  ".join(str(row.get(c, 0)).ljust(10) for c in col_order)
            lines.append(line)
    lines.append("=" * 72)
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Top-level evaluate()
# ---------------------------------------------------------------------------

def evaluate(scene_set_dir: Path,
              recognition_fn: RecognitionFn,
              *,
              translation_tol_m: float = DEFAULT_TRANSLATION_TOL_M,
              rotation_tol_deg: float = DEFAULT_ROTATION_TOL_DEG,
              pickable_tol_deg: float = DEFAULT_PICKABLE_TOL_DEG,
              report_path: Optional[Path] = None,
              verbose: bool = True) -> BenchmarkReport:
    """Load every scene under `scene_set_dir`, run `recognition_fn` on each,
    score against ground truth, and return the aggregated report.

    A "scene set" is any directory containing scene subdirectories that
    each have ground_truth.json + scene_cloud.ply (matches what
    generate_scene_set writes).
    """
    scene_set_dir = Path(scene_set_dir)
    scene_dirs = sorted(d for d in scene_set_dir.iterdir()
                         if d.is_dir() and (d / "ground_truth.json").is_file())
    if not scene_dirs:
        raise FileNotFoundError(
            f"No scenes (with ground_truth.json) under {scene_set_dir}")

    scene_scores: List[SceneScore] = []
    for sd in scene_dirs:
        scene = load_scene(sd)
        t0 = time.time()
        try:
            preds = recognition_fn(scene)
        except Exception as e:
            print(f"[benchmark] recognition_fn failed on {sd.name}: {e}",
                  file=sys.stderr)
            preds = []
        dt = time.time() - t0
        ss = score_result(preds, scene["ground_truth"],
                           translation_tol_m=translation_tol_m,
                           rotation_tol_deg=rotation_tol_deg,
                           pickable_tol_deg=pickable_tol_deg,
                           duration_s=dt)
        scene_scores.append(ss)

    report = aggregate(scene_scores)
    if verbose:
        print(format_report(report))
    if report_path is not None:
        report_path = Path(report_path)
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report.to_dict(), indent=2))
    return report


# ---------------------------------------------------------------------------
# Built-in baselines
# ---------------------------------------------------------------------------

def _library_extents() -> Dict[str, np.ndarray]:
    """Read /opt/cobot/parts/index.json and return {part_id: sorted_extents_m}.

    Sorted extents give a rotation-invariant signature — that's what the
    nearest-extent baseline matches against.
    """
    index_path = Path(PARTS_DIR) / "index.json"
    if not index_path.is_file():
        return {}
    data = json.loads(index_path.read_text())
    out: Dict[str, np.ndarray] = {}
    for p in data.get("parts", []):
        ext = p.get("extents_cm")
        if not ext or all(float(v) == 0.0 for v in ext):
            continue
        sorted_m = np.sort(np.asarray(ext, dtype=np.float64) * 0.01)[::-1]
        out[p["id"]] = sorted_m
    return out


def extents_match_recognition_fn(scene: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Trivial baseline — clusters above the table, matches each cluster's
    sorted bbox extents against the part library, returns the centroid as
    pose. Useless for production but proves the harness math runs."""
    import open3d as o3d

    points = scene["points"]
    if points is None or len(points) == 0:
        return []
    pc = o3d.geometry.PointCloud()
    pc.points = o3d.utility.Vector3dVector(points.astype(np.float64))
    # Remove the dominant horizontal plane (the table).
    try:
        plane_model, inliers = pc.segment_plane(distance_threshold=0.003,
                                                  ransac_n=3, num_iterations=200)
        above = pc.select_by_index(inliers, invert=True)
    except Exception:
        above = pc
    # Drop anything below the table.
    pts_above = np.asarray(above.points)
    if len(pts_above) == 0:
        return []
    z_median = np.median(pts_above[:, 2])
    keep = pts_above[:, 2] > (z_median - 0.005)
    above.points = o3d.utility.Vector3dVector(pts_above[keep])

    labels = np.array(above.cluster_dbscan(eps=0.010, min_points=30,
                                             print_progress=False))
    extents_lib = _library_extents()
    if not extents_lib:
        return []

    detections: List[Dict[str, Any]] = []
    pts_above = np.asarray(above.points)
    for cluster_id in sorted(set(int(x) for x in labels if x >= 0)):
        idx = np.where(labels == cluster_id)[0]
        cluster = pts_above[idx]
        if len(cluster) < 30:
            continue
        bb_min = cluster.min(axis=0)
        bb_max = cluster.max(axis=0)
        ext = np.sort(bb_max - bb_min)[::-1]
        centroid = cluster.mean(axis=0)
        # Nearest-extent — match by Euclidean distance in sorted-extent
        # space; score becomes a confidence in (0, 1].
        best_id = None
        best_score = -math.inf
        for pid, ref in extents_lib.items():
            d = float(np.linalg.norm(ext - ref))
            # Convert distance to a soft confidence: 1 at d=0, → 0 at d=20mm.
            s = math.exp(-(d / 0.020))
            if s > best_score:
                best_score = s
                best_id = pid
        if best_id is None:
            continue
        detections.append({
            "part_id": best_id,
            "pose": {
                "position":    {"x": float(centroid[0]),
                                 "y": float(centroid[1]),
                                 "z": float(centroid[2])},
                "orientation": {"x": 0.0, "y": 0.0, "z": 0.0, "w": 1.0},
            },
            "confidence": float(best_score),
        })
    return detections


def perfect_oracle_recognition_fn(scene: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Sanity-check baseline: returns the ground-truth poses directly.

    Useful for confirming the harness math — a perfect oracle should score
    100% precision/recall/F1 with ~0 mm / ~0° pose error."""
    out: List[Dict[str, Any]] = []
    for inst in scene["ground_truth"].get("instances", []):
        out.append({
            "part_id":     inst["part_id"],
            "pose":        inst["pose"],
            "confidence":  1.0,
            "instance_id": inst.get("instance_id"),
        })
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _cli(argv: Optional[List[str]] = None) -> int:
    import argparse
    p = argparse.ArgumentParser(description="Score a recognition function "
                                              "against a synthetic scene set")
    p.add_argument("scene_set", type=str,
                   help="Path to a scene set directory (output of "
                        "generate_scene_set)")
    p.add_argument("--baseline", choices=["extents", "oracle"], default="extents",
                   help="Built-in baseline recognition_fn to run")
    p.add_argument("--report", type=str, default=None,
                   help="Path to save the JSON report")
    args = p.parse_args(argv)

    fn = {"extents": extents_match_recognition_fn,
          "oracle":  perfect_oracle_recognition_fn}[args.baseline]
    evaluate(Path(args.scene_set), fn,
              report_path=Path(args.report) if args.report else None)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
