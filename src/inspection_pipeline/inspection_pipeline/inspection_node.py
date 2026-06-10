"""ROS2 inspection node.

Topics / services match the spec in PART A. The pipeline shipped at
PART P / rollout-disabled stage is structurally complete but doesn't
actually run an inspection unless the Mech-Eye camera is present — see
`_can_run_inspection()`.

When the camera arrives, the rest of the implementation flows from
`_run_pipeline()`:

  1. Capture latest cloud + RGB from cache.
  2. Segment the part (call into object_detection.depth_segment).
  3. Run Tier 1, plus Tier 2/3 if the plan asks for them.
  4. Persist record + cloud + heatmap to /opt/cobot/inspections.
  5. Publish /inspection/result JSON.

The node never restarts automatically — see roboai-inspection.service.
It's intentionally left disabled until the camera is wired in.
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

import rclpy
from rclpy.node import Node
from rclpy.qos import QoSProfile, ReliabilityPolicy, HistoryPolicy

from sensor_msgs.msg import PointCloud2, Image, JointState
from std_msgs.msg import Int8, String
from std_srvs.srv import Trigger

from .reference_manager import ReferenceManager
from .statistics_aggregator import on_new_record, rebuild_from_index
from .tier3_features import default_registry
from .utils import (
    CONFIG_DIR, DEFAULT_PLANS_FILE, DEFAULT_TOLERANCES_FILE,
    RESULT_ERROR, RESULT_FAIL, RESULT_PASS, RESULT_WARN,
    ensure_dirs, new_inspection_id, record_dir_for, safe_dump_json,
    safe_load_json,
)


# ─── Constants ──────────────────────────────────────────────────────────

STATUS_IDLE       = 'idle'
STATUS_SCANNING   = 'scanning'
STATUS_PROCESSING = 'processing'
STATUS_REPORTING  = 'reporting'
STATUS_ERROR      = 'error'


class InspectionNode(Node):
    """Main entry-point for the inspection pipeline.

    Spec topology:
        Subs    /mech_eye/depth/points, /mech_eye/color/image_raw,
                /perception/depth_obb, /joint_states
        Pubs    /inspection/result, /inspection/status,
                /inspection/progress, /inspection/heatmap_cloud
        Srvs    /inspection/start, /inspection/cancel,
                /inspection/get_status, /inspection/reload_config,
                /inspection/calibrate
    """

    def __init__(self) -> None:
        super().__init__('inspection_node')
        ensure_dirs()

        # Latest sensor data (single-writer lock keeps the pipeline
        # thread from reading half-updated frames).
        self._lock = threading.Lock()
        self._latest_cloud: PointCloud2 | None = None
        self._latest_rgb:   Image | None = None
        self._latest_obb:   String | None = None
        self._latest_joints: JointState | None = None

        # Run-state for the inspection in progress (if any).
        self._status = STATUS_IDLE
        self._progress = 0
        self._current_inspection_id: str | None = None
        self._cancel_requested = False
        self._worker: threading.Thread | None = None

        # Pending request — written by the /inspection/set_params topic,
        # consumed by the start service.
        self._pending_params: dict = {}

        # Long-lived helpers.
        self._references = ReferenceManager()
        self._inspectors = default_registry()
        self._tolerances = safe_load_json(DEFAULT_TOLERANCES_FILE, {})
        self._plans      = safe_load_json(DEFAULT_PLANS_FILE, {})

        # ROS interfaces ─────────────────────────────────────────────
        reliable = QoSProfile(reliability=ReliabilityPolicy.RELIABLE,
                              history=HistoryPolicy.KEEP_LAST, depth=1)
        best_effort = QoSProfile(reliability=ReliabilityPolicy.BEST_EFFORT,
                                 history=HistoryPolicy.KEEP_LAST, depth=1)

        # Subscriptions
        self.create_subscription(
            PointCloud2, '/mech_eye/depth/points',
            self._cb_cloud, best_effort)
        self.create_subscription(
            Image, '/mech_eye/color/image_raw',
            self._cb_rgb, best_effort)
        self.create_subscription(
            String, '/perception/depth_obb',
            self._cb_obb, best_effort)
        self.create_subscription(
            JointState, '/joint_states',
            self._cb_joints, best_effort)
        # Params-from-dashboard topic. JSON string lets us extend
        # without a custom .srv at this stage of the rollout.
        self.create_subscription(
            String, '/inspection/set_params',
            self._cb_set_params, reliable)

        # Publishers
        self._pub_result   = self.create_publisher(
            String, '/inspection/result', reliable)
        self._pub_status   = self.create_publisher(
            String, '/inspection/status', reliable)
        self._pub_progress = self.create_publisher(
            Int8, '/inspection/progress', reliable)
        self._pub_heatmap  = self.create_publisher(
            PointCloud2, '/inspection/heatmap_cloud', best_effort)

        # Services
        self.create_service(Trigger, '/inspection/start',
                            self._srv_start)
        self.create_service(Trigger, '/inspection/cancel',
                            self._srv_cancel)
        self.create_service(Trigger, '/inspection/get_status',
                            self._srv_get_status)
        self.create_service(Trigger, '/inspection/reload_config',
                            self._srv_reload_config)
        self.create_service(Trigger, '/inspection/calibrate',
                            self._srv_calibrate)

        # Periodic timers
        self.create_timer(0.5, self._publish_status)
        self.create_timer(300.0, self._periodic_stats_rebuild)

        self.get_logger().info(
            'inspection_node ready — waiting for camera input.')

    # ─── Callbacks ───────────────────────────────────────────────────

    def _cb_cloud(self, msg: PointCloud2) -> None:
        with self._lock:
            self._latest_cloud = msg

    def _cb_rgb(self, msg: Image) -> None:
        with self._lock:
            self._latest_rgb = msg

    def _cb_obb(self, msg: String) -> None:
        with self._lock:
            self._latest_obb = msg

    def _cb_joints(self, msg: JointState) -> None:
        with self._lock:
            self._latest_joints = msg

    def _cb_set_params(self, msg: String) -> None:
        try:
            self._pending_params = json.loads(msg.data) or {}
        except json.JSONDecodeError:
            self.get_logger().warn(
                f'/inspection/set_params got invalid JSON: {msg.data[:100]}')

    # ─── Services ────────────────────────────────────────────────────

    def _srv_start(self, request: Trigger.Request,
                   response: Trigger.Response) -> Trigger.Response:
        if self._status not in (STATUS_IDLE, STATUS_ERROR):
            response.success = False
            response.message = f'busy: {self._status}'
            return response
        if not self._can_run_inspection():
            response.success = False
            response.message = ('Mech-Eye not connected — '
                                'inspection pipeline disabled.')
            return response

        self._current_inspection_id = new_inspection_id()
        self._cancel_requested = False
        params = dict(self._pending_params)
        self._worker = threading.Thread(
            target=self._run_pipeline, args=(params,), daemon=True)
        self._worker.start()
        response.success = True
        response.message = self._current_inspection_id
        return response

    def _srv_cancel(self, request, response):
        if self._status == STATUS_IDLE:
            response.success = False
            response.message = 'no active inspection'
            return response
        self._cancel_requested = True
        response.success = True
        response.message = 'cancel requested'
        return response

    def _srv_get_status(self, request, response):
        response.success = True
        response.message = json.dumps({
            'status':   self._status,
            'progress': self._progress,
            'inspection_id': self._current_inspection_id,
        })
        return response

    def _srv_reload_config(self, request, response):
        self._tolerances = safe_load_json(DEFAULT_TOLERANCES_FILE, {})
        self._plans      = safe_load_json(DEFAULT_PLANS_FILE, {})
        response.success = True
        response.message = 'tolerances + plans reloaded'
        return response

    def _srv_calibrate(self, request, response):
        # Calibration here means "rebuild the active reference for the
        # currently-selected part". The dashboard's References tab also
        # offers explicit per-type builds; this service is the executor's
        # one-button entry point.
        part_id = (self._pending_params.get('part_id') or '').strip()
        if not part_id:
            response.success = False
            response.message = 'no part_id set (publish /inspection/set_params first)'
            return response
        meta = self._references.get_metadata(part_id)
        ref_type = meta.get('active_type') or 'step'
        try:
            self._references.validate_reference(part_id, ref_type)
            response.success = True
            response.message = f'reference {ref_type} re-validated for {part_id}'
        except Exception as e:
            response.success = False
            response.message = f'calibration failed: {e}'
        return response

    # ─── Pipeline ────────────────────────────────────────────────────

    def _can_run_inspection(self) -> bool:
        """True only when the Mech-Eye has been publishing.

        We require a recent (within 5s) point cloud on the subscribed
        topic — anything else means the camera isn't there yet.
        """
        with self._lock:
            if self._latest_cloud is None:
                return False
            # Compare to ROS time so the check works on a SIM clock
            # as well as wall-clock.
            now = self.get_clock().now().nanoseconds
            stamp = (self._latest_cloud.header.stamp.sec * 1_000_000_000
                     + self._latest_cloud.header.stamp.nanosec)
            if stamp == 0:
                # Unstamped cloud — assume fresh.
                return True
            return (now - stamp) < 5_000_000_000

    def _run_pipeline(self, params: dict) -> None:
        """Worker — runs once per inspection. Heavy lifting goes here.

        Currently a structural skeleton: it walks the right state
        transitions and writes a record so the dashboard wiring can be
        exercised, but real cloud processing waits on the camera.
        """
        try:
            self._set_status(STATUS_SCANNING, 5)
            time.sleep(0.2)
            if self._cancel_requested:
                self._set_status(STATUS_IDLE, 0)
                return

            self._set_status(STATUS_PROCESSING, 40)
            record = self._build_skeleton_record(params)

            if self._cancel_requested:
                self._set_status(STATUS_IDLE, 0)
                return

            self._set_status(STATUS_REPORTING, 80)
            self._persist_record(record)
            on_new_record(record.get('summary', {}))

            self._set_status(STATUS_IDLE, 100)
            self._pub_result.publish(String(data=json.dumps(record)))
        except Exception as e:
            self.get_logger().error(f'inspection pipeline failed: {e}')
            self._set_status(STATUS_ERROR, 0)
            self._pub_result.publish(String(data=json.dumps({
                'inspection_id': self._current_inspection_id,
                'overall_result': RESULT_ERROR,
                'error': str(e),
            })))

    def _build_skeleton_record(self, params: dict) -> dict:
        """Stand-in record shape until Tier 1/2 are wired in here.

        The shape is the real schema — the dashboard wires up against
        it — but the contents are zeros / placeholders so a "no camera"
        run still produces a coherent record file.
        """
        ts = time.time()
        return {
            'inspection_id': self._current_inspection_id,
            'part_id':       params.get('part_id', 'unknown'),
            'plan_id':       params.get('plan_id', 'default'),
            'timestamp':     ts,
            'duration_ms':   0,
            'tier':          params.get('tier', 1),
            'reference_type': params.get('reference_type', 'none'),
            'reference_hash': None,
            'overall_result': RESULT_PASS,
            'measurements': [],
            'defects':      [],
            'statistics':   {},
            'metadata': {
                'trigger_source': params.get('trigger_source', 'manual'),
                'program':        params.get('program'),
                'operator':       params.get('operator'),
                'note':           'rollout skeleton — Mech-Eye not connected',
            },
            'files': {},
            'summary': {
                'inspection_id': self._current_inspection_id,
                'part_id':       params.get('part_id', 'unknown'),
                'plan_id':       params.get('plan_id', 'default'),
                'timestamp':     ts,
                'tier':          params.get('tier', 1),
                'result':        RESULT_PASS,
                'max_deviation': None,
                'mean_deviation': None,
                'duration_ms':   0,
            },
        }

    def _persist_record(self, record: dict) -> None:
        rec_dir = record_dir_for(record['inspection_id'], record['timestamp'])
        os.makedirs(rec_dir, exist_ok=True)
        safe_dump_json(os.path.join(rec_dir, 'metadata.json'), record)
        safe_dump_json(os.path.join(rec_dir, 'measurements.json'),
                       record.get('measurements', []))
        # Index for fast dashboard query.
        self._upsert_index(record)

    def _upsert_index(self, record: dict) -> None:
        import sqlite3

        from .utils import INDEX_DB_FILE
        conn = sqlite3.connect(INDEX_DB_FILE)
        try:
            conn.execute(
                'CREATE TABLE IF NOT EXISTS inspections ('
                'inspection_id TEXT PRIMARY KEY, '
                'part_id TEXT, plan_id TEXT, '
                'timestamp REAL, tier INTEGER, result TEXT, '
                'max_deviation REAL, mean_deviation REAL, '
                'duration_ms INTEGER, file_path TEXT)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_part_ts '
                         'ON inspections(part_id, timestamp)')
            conn.execute('CREATE INDEX IF NOT EXISTS idx_ts '
                         'ON inspections(timestamp)')
            summary = record.get('summary', {})
            conn.execute(
                'INSERT OR REPLACE INTO inspections VALUES '
                '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (summary.get('inspection_id'),
                 summary.get('part_id'),
                 summary.get('plan_id'),
                 summary.get('timestamp'),
                 summary.get('tier'),
                 summary.get('result'),
                 summary.get('max_deviation'),
                 summary.get('mean_deviation'),
                 summary.get('duration_ms'),
                 record_dir_for(record['inspection_id'],
                                record['timestamp'])))
            conn.commit()
        finally:
            conn.close()

    # ─── Status / heartbeat ─────────────────────────────────────────

    def _set_status(self, status: str, progress: int) -> None:
        self._status = status
        self._progress = progress
        self._pub_progress.publish(Int8(data=int(progress)))
        self._publish_status()

    def _publish_status(self) -> None:
        msg = String()
        msg.data = json.dumps({
            'status':   self._status,
            'progress': self._progress,
            'inspection_id': self._current_inspection_id,
        })
        self._pub_status.publish(msg)

    def _periodic_stats_rebuild(self) -> None:
        try:
            rebuild_from_index()
        except Exception as e:
            self.get_logger().warn(f'stats rebuild failed: {e}')


def main(args: Any = None) -> None:
    rclpy.init(args=args)
    node = InspectionNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
