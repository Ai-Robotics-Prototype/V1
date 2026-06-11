# motion_optimization

Time-optimal trajectory smoothing and motion profile management for the
RoboAi cobot stack. Built around TOPP-RA for joint-space trajectories,
with a MoveIt2 bridge skeleton that turns on once an Estun URDF lands.

## Architecture

```
                        ┌────────────────────┐
program_executor  ───►  │ /motion/optimize_  │
                        │  trajectory (srv)  │
                        └─────────┬──────────┘
                                  │
              ┌───────────────────┼────────────────────┐
              ▼                   ▼                    ▼
        toppra_engine       trajectory_smoother    moveit_bridge
        (time-optimal       (spline / blend /      (skeleton —
         param., honors      jerk-limited          activates when
         vel/accel limits)   smoothing)            URDF arrives)
              │                   │                    │
              └───────────────────┼────────────────────┘
                                  ▼
                          OptimizedTrajectory
                          (timing + metrics)
```

`profile_manager.py` owns the on-disk profile store and bundles
parameters into reusable presets (Conservative, Balanced, Aggressive) or
custom user profiles.

## Profile system

| Profile      | velocity | acceleration | smoothing | MoveIt2 | Notes |
|--------------|---------:|-------------:|-----------|---------|-------|
| Conservative | 40%      | 30%          | spline    | off     | Teaching, verification |
| Balanced     | 70%      | 60%          | toppra    | off     | Default production |
| Aggressive   | 95%      | 90%          | toppra    | on      | Activates once MoveIt2 has a URDF |

Built-ins live in `config/default_profiles.yaml`. Custom user profiles
are stored at `/opt/cobot/motion/config/profiles.json`. The Configure
tab's Motion section is the canonical UI; raw editing is supported.

## Tuning

1. Update `config/default_robot_limits.yaml` with manufacturer datasheet
   values once Estun confirms them.
2. Start operators at **Conservative**; promote to **Balanced** after a
   handful of supervised cycles.
3. Run **Aggressive** only after MoveIt2 collision-aware planning is
   active (requires URDF + `scripts/setup_moveit_config.sh`).

## MoveIt2 setup steps

When the Estun URDF arrives:

```bash
sudo install -m 644 estun_s10_140.urdf /opt/cobot/models/
bash scripts/setup_moveit_config.sh
sudo systemctl restart roboai-motion-optimization
```

The dashboard's Motion → MoveIt2 indicator will transition red → yellow →
green as files appear on disk.

## Performance targets (Jetson Orin)

| Operation                                 | Target |
|-------------------------------------------|-------:|
| TOPP-RA parameterization (10-20 waypoints) | < 50 ms |
| TOPP-RA parameterization (50+ waypoints)   | < 200 ms |
| Quick cycle-time estimation                | < 5 ms |
| Profile load / save                        | < 10 ms |
| Trajectory validation                      | < 100 ms |
| Service round-trip                         | < 250 ms |

Cycle-time targets vs unoptimized baseline:

| Profile      | Expected cycle savings |
|--------------|-----------------------:|
| Conservative | 0-10% |
| Balanced     | 15-30% |
| Aggressive   | 30-50% |

## Build

```bash
cd ~/cobot_ws
colcon build --packages-select \
  motion_optimization_msgs \
  motion_optimization \
  cobot_dashboard \
  estun_driver \
  --symlink-install
```

`motion_optimization_msgs` is a sibling package because rosidl-generated
interfaces cannot live inside an `ament_python` package — this is a
deviation from the original spec (which assumed `msg/` and `srv/`
directories inside `motion_optimization` itself).

## Deviations from spec

| Spec section | Actual implementation | Why |
|---|---|---|
| Part A: single `motion_optimization` package containing `msg/` and `srv/` | Interfaces moved to sibling `motion_optimization_msgs` (ament_cmake) | rosidl generators require ament_cmake; python-only packages can't host msg/srv |
| Part I: executor calls `/motion/optimize_trajectory` with `trajectory_msgs/JointTrajectory` | Executor scales `speed_pct` per profile on the existing JSON-based `/estun/move` channel | The estun driver doesn't yet receive joint trajectories — moves are JSON commands. Once the driver speaks trajectory_msgs the optimize_trajectory service is ready to plug in |
| Part J: backend on `dashboard_server.py` references `static/index.html` | Frontend is React/Vite under `frontend/`; endpoints land on the existing FastAPI app | Spec assumed a static-HTML dashboard |
| Part C: jerk_limits passed into `parameterize_path` | Accepted but enforced post-hoc by the smoother | TOPP-RA's standard constraint set is vel + accel only |

## Testing

```bash
cd ~/cobot_ws
colcon test --packages-select motion_optimization
colcon test-result --verbose
```

Or run pytest directly:

```bash
cd ~/cobot_ws/src/motion_optimization
python3 -m pytest test/ -v
```

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| Optimizer returns `optimizer_used='fallback'` | toppra wheel missing; `pip3 install --user toppra` |
| Cycle time always equals unoptimized estimate | Profile has `toppra_enabled=False`; pick Balanced/Aggressive |
| MoveIt2 status stays red | `/opt/cobot/models/estun_s10_140.urdf` not present |
| Profiles disappear after reboot | `/opt/cobot/motion/config/profiles.json` not writable by the cobot user |
| Motion stats badge shows red | Actual cycle time > 15% slower than estimate; retune the profile or update robot limits |
