#!/usr/bin/env bash
# Isaac ROS detection bench — measures FPS, latency, and GPU/memory
# on the actual arm's Orin. Runs alongside the live stack; assumes
# the operator has already flipped the boot path to Isaac (i.e.
# `roboai-depth-segment.service` is running the new
# `depth_detection.launch.py` with the Isaac primary branch).
#
# Usage:
#   bash scripts/isaac_detection_bench.sh [duration_s]
#
# Output: JSONL to /opt/cobot/logs/isaac_bench_<UTC>.jsonl and a
# one-page summary to stdout. The JSONL is what the operator sends
# back — this script does not upload anything.
#
# Bench scenarios the operator's directive names:
#   * bowls on the dark table (COCO-native, day-one detection)
#   * the glare-corner that killed the classical pipeline
# Run this script during each scenario; a comment line in the JSONL
# marks the scenario the operator was staging when they started it.

set -euo pipefail

DUR="${1:-60}"
UTC="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="/opt/cobot/logs/isaac_bench_${UTC}.jsonl"
mkdir -p /opt/cobot/logs

echo "▸ Isaac ROS detection bench — $DUR s window" >&2
echo "  output: $OUT" >&2

# Header stamp — snapshot the running codegen sha, the launch file
# and the resident yolov8n.plan so the operator can correlate later.
{
  echo "{\"phase\":\"start\",\"utc\":\"${UTC}\",\"duration_s\":${DUR}}"
  echo "{\"phase\":\"stack\",\"cam0_launch\":\"$(systemctl show \
     roboai-depth-segment.service -p ExecStart --value | \
     sed 's/"/\\"/g')\"}"
  echo "{\"phase\":\"engine\",\"plan_sha1\":\"$(sha1sum \
     /opt/cobot/models/yolov8n.plan 2>/dev/null | awk '{print $1}')\"}"
} >> "$OUT"

# Detection topic tap — count Detection3DArray messages for DUR
# seconds. Wall-clock rate = detected FPS as seen at the dashboard
# subscription point (the operator's ground truth).
COUNT_FILE="$(mktemp)"
trap 'rm -f "$COUNT_FILE"' EXIT
(
  timeout "${DUR}" ros2 topic hz /perception/detections_3d 2>/dev/null \
     | tee "$COUNT_FILE"
) &

# GPU + memory samples every 1 s. `tegrastats` is the Orin's
# authoritative source; falls back to nvidia-smi on any dev laptop.
(
  timeout "${DUR}" bash -c '
    if command -v tegrastats >/dev/null 2>&1; then
      tegrastats --interval 1000
    else
      while true; do
        nvidia-smi --query-gpu=timestamp,utilization.gpu,\
memory.used,memory.free --format=csv,noheader
        sleep 1
      done
    fi
  ' 2>&1 | while IFS= read -r line; do
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf "{\"phase\":\"gpu\",\"ts\":\"%s\",\"raw\":\"%s\"}\n" \
      "$ts" "${line//\"/\\\"}"
  done >> "$OUT"
) &

wait

# Extract the rate reported by `ros2 topic hz` (typically:
#   "average rate: 14.923\n\tmin: 0.056s max: 0.078s std dev: ...")
RATE="$(grep -m1 'average rate' "$COUNT_FILE" | awk '{print $3}')"
MIN="$( grep -m1 'min:'          "$COUNT_FILE" | awk '{print $2}')"
MAX="$( grep -m1 'min:'          "$COUNT_FILE" | awk '{print $4}')"
{
  echo "{\"phase\":\"topic_hz\",\"rate_hz\":${RATE:-null},\"min_s\":\"${MIN:-}\",\"max_s\":\"${MAX:-}\"}"
  echo "{\"phase\":\"end\",\"utc_end\":\"$(date -u +%Y%m%dT%H%M%SZ)\"}"
} >> "$OUT"

# Summary
echo "▸ Summary" >&2
echo "  detection rate:  ${RATE:-?} Hz" >&2
echo "  window duration: ${DUR} s" >&2
echo "  gpu/mem samples: $(grep -c '"phase":"gpu"' "$OUT") lines" >&2
echo "  detection log:   $OUT" >&2
echo "  → send $OUT back for the numbers write-up" >&2
