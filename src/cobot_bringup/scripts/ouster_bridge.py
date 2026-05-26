#!/usr/bin/env python3
"""Ouster OS1-32 → ROS2 PointCloud2 bridge.

Connects to the Ouster sensor at 192.168.1.100 via the ouster-sdk and
publishes each scan as sensor_msgs/PointCloud2 on /lidar/points.

Requirements:
    pip3 install ouster-sdk numpy

Usage:
    python3 ouster_bridge.py [--host 192.168.1.100]
"""

import argparse
import struct
import sys
import time

import numpy as np
import rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, PointField
from std_msgs.msg import Header

SENSOR_HOST = "192.168.1.100"
LIDAR_TOPIC = "/lidar/points"
FRAME_ID    = "lidar_link"


def _array_to_pointcloud2(node: Node, xyz: np.ndarray) -> PointCloud2:
    """Convert Nx3 float32 XYZ array to a PointCloud2 message."""
    pts = xyz.astype(np.float32)
    n   = len(pts)
    msg = PointCloud2()
    msg.header = Header()
    msg.header.frame_id  = FRAME_ID
    msg.header.stamp     = node.get_clock().now().to_msg()
    msg.height           = 1
    msg.width            = n
    msg.is_dense         = False
    msg.is_bigendian     = False
    msg.point_step       = 12   # 3 × float32
    msg.row_step         = msg.point_step * n
    msg.fields = [
        PointField(name="x", offset=0,  datatype=PointField.FLOAT32, count=1),
        PointField(name="y", offset=4,  datatype=PointField.FLOAT32, count=1),
        PointField(name="z", offset=8,  datatype=PointField.FLOAT32, count=1),
    ]
    msg.data = pts.tobytes()
    return msg


class OusterBridge(Node):
    def __init__(self, host: str):
        super().__init__("ouster_bridge")
        self._pub  = self.create_publisher(PointCloud2, LIDAR_TOPIC, 5)
        self._host = host
        self.get_logger().info(f"Connecting to Ouster at {host} …")

    def run(self):
        try:
            from ouster.sdk import client
        except ImportError:
            self.get_logger().fatal(
                "ouster-sdk not installed. Run: pip3 install ouster-sdk"
            )
            return

        try:
            sensor_config = client.SensorConfig()
            sensor_config.udp_dest = "192.168.1.200"

            with client.Sensor(self._host, 7502, 7503, config=sensor_config) as source:
                self.get_logger().info("Connected. Streaming scans …")
                metadata = source.metadata
                xyzlut   = client.XYZLut(metadata)
                scans    = client.Scans(source)

                for scan in scans:
                    if not rclpy.ok():
                        break

                    xyz = xyzlut(scan)                          # (H, W, 3)
                    pts = xyz.reshape(-1, 3).astype(np.float32) # (N, 3)

                    # Drop invalid returns (all-zero points from Ouster)
                    valid = np.any(pts != 0, axis=1)
                    pts   = pts[valid]

                    if len(pts) == 0:
                        continue

                    msg = _array_to_pointcloud2(self, pts)
                    self._pub.publish(msg)

        except Exception as exc:
            self.get_logger().error(f"Ouster connection failed: {exc}")
            raise


def main():
    parser = argparse.ArgumentParser(description="Ouster OS1-32 → ROS2 bridge")
    parser.add_argument("--host", default=SENSOR_HOST, help="Ouster sensor IP")
    args = parser.parse_args()

    rclpy.init()
    node = OusterBridge(args.host)

    import threading
    spin_thread = threading.Thread(target=rclpy.spin, args=(node,), daemon=True)
    spin_thread.start()

    try:
        node.run()
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()
        sys.exit(0)


if __name__ == "__main__":
    main()
