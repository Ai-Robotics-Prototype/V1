"""Programming-by-Demonstration ROS2 node.

The dashboard's /api/pbd/* endpoints do the real orchestration by
importing programming_by_demonstration directly — keeping the work in
the same process avoids ROS-srv plumbing for HTTP-shaped IO and means
the frontend never has to talk rclpy. This node exists for:

  - systemd lifecycle (roboai-pbd.service can target a real node)
  - heartbeat status on /pbd/status so other parts of the stack can
    see "pbd ready" / "pbd processing demo_xxx"
  - a future migration path to a full rclpy service contract
    (srv/GenerateFromDemonstration.srv is staged for that)
"""

from __future__ import annotations

import json
import os
import threading
import time
import traceback
from typing import Any

try:
    import rclpy
    from rclpy.node import Node
    from std_msgs.msg import String
    RCLPY_AVAILABLE = True
except Exception:
    rclpy = None             # type: ignore
    Node = object            # type: ignore
    String = None            # type: ignore
    RCLPY_AVAILABLE = False

from .pipeline import (
    Pipeline,
    PipelineConfig,
    pipeline_config_from_params,
)


class PbdNode(Node if RCLPY_AVAILABLE else object):
    def __init__(self):
        super().__init__('pbd_node')

        # Declare all params with sensible defaults; pipeline_config_from_params
        # below pulls them out and applies defaults again so a partial
        # YAML doesn't tip the node over.
        defaults = [
            ('demonstrations_dir', '/opt/cobot/demonstrations'),
            ('programs_dir',       '/opt/cobot/programs'),
            ('backend',            'api'),
            ('api_model',          'claude-opus-4-7'),
            ('api_max_tokens',     4096),
            ('api_request_timeout_s', 120.0),
            ('api_zero_data_retention', True),
            ('frame_sample_fps',   1.0),
            ('frame_max_count',    20),
            ('frame_resize_long_edge_px', 768),
            ('frame_jpeg_quality', 82),
            ('whisper_model',      'base.en'),
            ('whisper_device',     'auto'),
            ('whisper_compute',    'int8'),
            ('retrieval_enabled',  True),
            ('retrieval_k',        3),
            ('retrieval_min_score', 0.10),
        ]
        for name, default in defaults:
            self.declare_parameter(name, default)

        def _get(name: str) -> Any:
            try:
                return self.get_parameter(name).value
            except Exception:
                return None

        self.cfg: PipelineConfig = pipeline_config_from_params(_get)
        self.pipeline = Pipeline(self.cfg,
                                 logger=lambda m: self.get_logger().info(m))
        self._status_pub = self.create_publisher(String, '/pbd/status', 5)
        self._lock = threading.Lock()
        self._publish_status('IDLE', None)
        self.get_logger().info(
            f'pbd_node ready | backend={self.cfg.backend} | demos={self.cfg.demonstrations_dir}'
        )

    # ── Status ─────────────────────────────────────────────────────

    def _publish_status(self, state: str, demo_id):
        if not RCLPY_AVAILABLE:
            return
        m = String()
        m.data = json.dumps({
            't':        time.time(),
            'state':    state,
            'demo_id':  demo_id,
            'backend':  self.cfg.backend,
        })
        try:
            self._status_pub.publish(m)
        except Exception:
            pass

    # ── Public method the dashboard COULD invoke directly when
    #    running in-process. The current architecture has the dashboard
    #    construct its own Pipeline (single-process, no rclpy needed),
    #    but exposing this here means a future split is trivial.

    def run_demonstration(self, video_path: str, demo_id: str = None) -> dict:
        with self._lock:
            self._publish_status('PROCESSING', demo_id)
            try:
                res = self.pipeline.run_from_upload(video_path, demo_id=demo_id)
            except Exception as e:
                self.get_logger().error(f'pipeline crashed: {e}\n{traceback.format_exc()}')
                self._publish_status('IDLE', None)
                return {'ok': False, 'error': str(e), 'demo_id': demo_id}
            self._publish_status('IDLE', None)
            return {
                'ok':        res.ok,
                'error':     res.error,
                'demo_id':   res.demo_id,
                'intent':    res.intent.to_dict() if res.intent else None,
                'draft':     res.draft.to_program_payload() if res.draft else None,
                'used_examples': res.used_examples,
                'backend_id': res.backend_id,
                'transited_externally': res.transited_externally,
                'stages_done': res.stages_done,
            }


def main(args=None):
    if not RCLPY_AVAILABLE:
        print('rclpy not available — running pbd_node in standalone mode is a no-op.')
        return
    rclpy.init(args=args)
    node = PbdNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            node.destroy_node()
        except Exception:
            pass
        rclpy.shutdown()


if __name__ == '__main__':
    main()
