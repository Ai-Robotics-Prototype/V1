#!/usr/bin/env python3
import math, socket, struct, threading, time, rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, PointField
from std_msgs.msg import Header
import numpy as np

ALTITUDES = [
    16.611, 15.639, 14.667, 13.695, 12.723, 11.751, 10.779, 9.807,
     8.835,  7.863,  6.891,  5.919,  4.947,  3.975,  3.003, 2.031,
     1.059,  0.087, -0.885, -1.857, -2.829, -3.801, -4.773, -5.745,
    -6.717, -7.689, -8.661, -9.633,-10.605,-11.577,-12.549,-13.521,
]
ALT_RAD = [math.radians(a) for a in ALTITUDES]


def set_eth0():
    import fcntl
    SIOCSIFADDR    = 0x8916
    SIOCSIFNETMASK = 0x891c
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def psa(a):
        return struct.pack('2s14s', b'\x02\x00', socket.inet_aton(a) + b'\x00' * 10)

    try:
        fcntl.ioctl(s.fileno(), SIOCSIFADDR,
                    struct.pack('16s', b'eth0') + psa('192.168.1.200'))
        fcntl.ioctl(s.fileno(), SIOCSIFNETMASK,
                    struct.pack('16s', b'eth0') + psa('255.255.255.0'))
        print('eth0=192.168.1.200/24')
    except Exception as e:
        print(f'eth0 ioctl: {e}')
    finally:
        s.close()


class OusterBridge(Node):
    def __init__(self):
        super().__init__('ouster_bridge')
        self.pub   = self.create_publisher(PointCloud2, '/lidar/points', 5)
        self._buf  = []
        self._lock = threading.Lock()
        self._fid  = -1
        self._last = time.time()

        set_eth0()

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(('0.0.0.0', 56201))
        self._sock.settimeout(1.0)

        threading.Thread(target=self._recv, daemon=True).start()
        self.get_logger().info('Ouster bridge UDP 56201 ready')

    def _recv(self):
        while rclpy.ok():
            try:
                data, _ = self._sock.recvfrom(65535)
                self._parse(data)
            except socket.timeout:
                continue
            except Exception as e:
                self.get_logger().debug(str(e))

    def _parse(self, data):
        if len(data) < 16:
            return
        try:
            fid = struct.unpack_from('<H', data, 10)[0]
            enc = struct.unpack_from('<I', data, 12)[0]
            az  = (enc / 90112.0) * 2.0 * math.pi
            pts = []
            for b in range(32):
                off = 16 + b * 12
                if off + 4 > len(data):
                    break
                r   = struct.unpack_from('<I', data, off)[0]
                sig = struct.unpack_from('<H', data, off + 4)[0]
                if r == 0:
                    continue
                rm = r / 1000.0
                if rm < 0.1 or rm > 100:
                    continue
                al = ALT_RAD[b]
                pts.append((
                    rm * math.cos(al) * math.cos(-az),
                    rm * math.cos(al) * math.sin(-az),
                    rm * math.sin(al),
                    float(sig),
                ))
            with self._lock:
                self._buf.extend(pts)
                if fid != self._fid:
                    self._flush()
                    self._fid = fid
                    self._buf = list(pts)
        except Exception as e:
            self.get_logger().debug(str(e))

    def _flush(self):
        pts = self._buf
        if not pts:
            return
        try:
            arr = np.array(pts, dtype=np.float32)
            msg = PointCloud2()
            msg.header = Header()
            msg.header.stamp    = self.get_clock().now().to_msg()
            msg.header.frame_id = 'lidar_link'
            msg.height    = 1
            msg.width     = len(pts)
            msg.is_dense  = False
            msg.is_bigendian = False
            msg.point_step   = 16
            msg.row_step     = 16 * len(pts)
            msg.fields = [
                PointField(name='x',         offset=0,  datatype=PointField.FLOAT32, count=1),
                PointField(name='y',         offset=4,  datatype=PointField.FLOAT32, count=1),
                PointField(name='z',         offset=8,  datatype=PointField.FLOAT32, count=1),
                PointField(name='intensity', offset=12, datatype=PointField.FLOAT32, count=1),
            ]
            msg.data = arr.tobytes()
            self.pub.publish(msg)
            hz = 1.0 / max(time.time() - self._last, 0.001)
            self._last = time.time()
            self.get_logger().info(f'{len(pts)} pts {hz:.1f}Hz')
        except Exception as e:
            self.get_logger().warn(str(e))


def main():
    rclpy.init()
    node = OusterBridge()
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
