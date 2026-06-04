# Robot Models

Per-robot directories holding the source CAD, converted meshes, and
articulation metadata used by the dashboard's 3D viewer.

## Layout

```
models/robots/<robot_id>/
    robot.json                  metadata (kinematics, API, dimensions)
    <NAME>_G2.STEP              source CAD from the manufacturer
    <NAME>.glb                  full converted GLB (static fallback)
    <NAME>.stl                  full converted STL (engineering ref)
    parts_inventory.json        per-part vertex / centroid / bbox
    links/
        links.json              joint chain (sentinel for articulated viewer)
        base.stl                per-link split STLs (when authored)
        shoulder.stl
        upper_arm.stl
        forearm.stl
        wrist1.stl
        wrist2.stl
        wrist3.stl
        z_distribution.json     auxiliary geometry analysis
```

## /opt/cobot/models/robot symlink

The dashboard's FastAPI routes read from `/opt/cobot/models/robot/`,
which on the Jetson is a symlink to one of these directories:

```
/opt/cobot/models/robot -> /home/teddy/cobot_ws/models/robots/estun_s10-140
```

Swap the symlink target to switch the active robot.

## Adding a new robot

1. `mkdir -p models/robots/<id>/links`
2. Drop the source STEP into `models/robots/<id>/<NAME>.STEP`.
3. Author `models/robots/<id>/robot.json` (see `estun_s10-140/robot.json`).
4. `python3 scripts/convert_robot_step.py --robot-dir models/robots/<id>`
5. Re-point `/opt/cobot/models/robot` at the new dir.

## Articulated vs static viewer

The dashboard's `ArmViewer3D` probes `/robot/links.json` (which maps
to `models/robots/<active>/links/links.json`):

- **File present** → component mounts the URDF-driven articulated
  viewer with live joint feedback from `STATE.joints.positions`.
- **File missing** (default until link STLs are authored) → component
  mounts a static `GLTFLoader` viewer reading `/robot/model.glb`.

Authoring `links.json` is non-trivial — it needs joint axes pulled
from the manufacturer's spec sheet, per-link STL files split out of
the full mesh, and the joint chain wired up. Tracked as a follow-up.
