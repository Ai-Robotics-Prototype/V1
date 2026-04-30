#!/bin/bash
# Perception pipeline benchmark for Jetson AGX Orin
# Run after `cbs` (source install/setup.bash)
# Usage: bash scripts/benchmark_perception.sh [duration_seconds]

DURATION=${1:-30}
echo "=== Cobot Perception Benchmark (${DURATION}s) ==="
echo ""

# ── GPU info ──────────────────────────────────────────────────────────────────
echo "--- GPU Info ---"
nvidia-smi --query-gpu=name,memory.total,memory.free,temperature.gpu,power.draw \
  --format=csv,noheader 2>/dev/null || echo "nvidia-smi not available"
echo ""

# ── Topic Hz measurements ────────────────────────────────────────────────────
echo "--- Topic Hz (${DURATION}s window) ---"
declare -A TOPICS=(
  ["/perception/fused_cloud"]="target 15Hz"
  ["/perception/fused_cloud_gpu"]="target 15Hz GPU"
  ["/perception/detections"]="target 30Hz"
  ["/perception/scene_graph"]="target 10Hz"
  ["/safety/human_proximity"]="target 50Hz"
  ["/safety/zone"]="target 10Hz"
  ["/safety/speed_scale"]="target 50Hz"
  ["/map/status"]="target 1Hz"
)

pids=()
for topic in "${!TOPICS[@]}"; do
  label="${TOPICS[$topic]}"
  timeout "$DURATION" ros2 topic hz "$topic" 2>&1 \
    | tail -1 \
    | awk -v t="$topic" -v l="$label" '{printf "%-40s %s  [%s]\n", t, $0, l}' &
  pids+=($!)
done
wait "${pids[@]}"
echo ""

# ── Latency: cuda_pointcloud pipeline ────────────────────────────────────────
echo "--- cuda_pointcloud_node log (last 5 lines) ---"
ros2 topic echo /rosout --once 2>/dev/null | grep cuda_pointcloud | tail -5 || true
echo ""

# ── GPU memory ───────────────────────────────────────────────────────────────
echo "--- GPU Memory After ${DURATION}s ---"
nvidia-smi --query-gpu=memory.used,memory.free --format=csv,noheader 2>/dev/null || true
echo ""

# ── CPU/RAM ───────────────────────────────────────────────────────────────────
echo "--- System Resources ---"
free -h
echo ""
top -bn1 | head -5
echo ""

# ── TensorRT engine info ──────────────────────────────────────────────────────
ENGINE=/opt/cobot/models/yolov8n.engine
if [ -f "$ENGINE" ]; then
  echo "--- TensorRT Engine ---"
  ls -lh "$ENGINE"
  echo "Export with: python3 scripts/export_trt.py --fp16"
fi

echo "=== Benchmark Complete ==="
