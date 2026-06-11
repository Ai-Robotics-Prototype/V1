# lidar_object_identifier

Static-object identification from accumulated LiDAR clouds. Runs in parallel
with the motion / safety pipeline — different jobs, different topics, no
conflict.

## Pipeline

```
/lidar/points_filtered (sensor_msgs/PointCloud2, denser cloud)
        │
        ▼
[1] Preprocessing      crop to workspace box (base_link)
        │
[2] Ground RANSAC      ±15° from +Z, 1.5 cm inlier band
        │
[3] Workspace mask     optional polygon filter
        │
[4] Euclidean cluster  2 cm tolerance, ≥50 points, sanity volume/density
        │
[5] Shape analysis     PCA OBB + sphericity/flatness/elongation/...
        │
[6] Parts match        size + volume + shape, cached library
        │
[7] Persistence        N-frame confirmation, kills spurious clusters
        │
        ▼
/lidar_objects/identified   (IdentifiedObjectArray)
/lidar_objects/visualization (MarkerArray)
/lidar_objects/stats         (ObjectIdentificationStats)
```

## Profiles & tuning

All tunable knobs live in `config/identifier_params.yaml` and are
hot-reloaded when the dashboard saves changes. The profile defaults
target:

| Setting | Value |
|---|---:|
| Process rate | 5 Hz |
| Workspace crop | ±3 m XY, 0–2 m Z |
| Ground inlier band | 1.5 cm |
| Cluster tolerance | 2 cm |
| Persistence buffer | 10 cycles |
| Confirm streak | 5 cycles |

## Workspace mask

Polygon (any number of vertices ≥ 3) lives at
`/opt/cobot/lidar/config/workspace_mask.yaml`:

```yaml
polygon:
  - [-0.5, -0.5]
  - [ 1.0, -0.5]
  - [ 1.0,  0.8]
  - [-0.5,  0.8]
```

The dashboard's Configure → Workspace Mask section is the canonical
editor; the on-disk file is the source of truth.

## Performance budget (Jetson Orin)

| Stage | Target |
|---|---:|
| Preprocessing | < 5 ms |
| Ground RANSAC | < 25 ms |
| Workspace mask | < 5 ms |
| Clustering | < 80 ms |
| Shape analysis (all clusters) | < 60 ms |
| Parts match (all clusters) | < 50 ms |
| Persistence | < 10 ms |
| **Total** | **< 200 ms** |

## Topics

| Topic | Type | Rate |
|---|---|---:|
| `/lidar/points_filtered` (subscribed) | `sensor_msgs/PointCloud2` | 10 Hz |
| `/lidar_objects/identified` | `lidar_object_identifier_msgs/IdentifiedObjectArray` | 5 Hz |
| `/lidar_objects/visualization` | `visualization_msgs/MarkerArray` | 5 Hz |
| `/lidar_objects/stats` | `lidar_object_identifier_msgs/ObjectIdentificationStats` | 5 Hz |

## Build

```bash
cd ~/cobot_ws
colcon build --packages-select \
  lidar_object_identifier_msgs \
  lidar_object_identifier \
  cobot_dashboard \
  --symlink-install
```

`lidar_object_identifier_msgs` is a sibling package — required because
ament_python cannot host rosidl-generated interfaces.

## Tests

```bash
cd ~/cobot_ws/src/lidar_object_identifier
PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest test/ -v
```

## Deviations from spec

| Spec section | Actual | Why |
|---|---|---|
| Parts A & B (nvblox + accumulator) | Not built — out of scope by user direction | nvblox is intentionally using camera depth (LiDAR mode is documented broken with non-repetitive Livox MID-360). Accumulator already runs at 50/5 frames, not the 15/3 baseline the spec assumed |
| `lidar_perception` package coordination | Stub-level — that package does not exist in this workspace | Spec claimed it was built "yesterday"; no trace under `src/`. We publish on independent topics so when it lands, there's no conflict |
| Interfaces inside `lidar_object_identifier` | Split into `lidar_object_identifier_msgs` | rosidl generators require ament_cmake |
| sklearn dependency | Replaced with Open3D `cluster_dbscan` (with scipy KD-tree fallback) | sklearn isn't installed on this Jetson |
| `scene_graph_node` integration | Not implemented in this pass | Out of scope for the focused build; consume `/lidar_objects/identified` from scene_graph when ready |
| `depth_segment_node` arbitration | Not implemented | Same reason — keep this package self-contained for now |

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `objects: []` from `/api/lidar_objects/identified` | Identifier service not running; `sudo systemctl status roboai-lidar-identifier` |
| All objects show 0% confidence | Parts library empty or path cache stale; check `/opt/cobot/lidar/cache/parts_features.json` |
| Persistent false positives in a fixed location | Add an ignore region via `POST /api/lidar_objects/ignore` or edit `/opt/cobot/lidar/config/ignore_list.json` |
| Identifier never reaches CONFIRMED for real objects | Reduce `persistence_confirm_streak` in `identifier_params.yaml` (default 5) |
| Open3D import error | `pip3 install --user open3d` (the fallback path will still produce correct results, just slower) |
