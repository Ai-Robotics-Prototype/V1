#!/usr/bin/env python3
import math, socket, struct, sys, threading, time, rclpy
from rclpy.node import Node
from sensor_msgs.msg import PointCloud2, PointField
from std_msgs.msg import Header
import numpy as np

ALTITUDES_32 = [
    16.611, 15.639, 14.667, 13.695, 12.723, 11.751, 10.779, 9.807,
     8.835,  7.863,  6.891,  5.919,  4.947,  3.975,  3.003, 2.031,
     1.059,  0.087, -0.885, -1.857, -2.829, -3.801, -4.773, -5.745,
    -6.717, -7.689, -8.661, -9.633,-10.605,-11.577,-12.549,-13.521,
]
ALTITUDES_16 = [
    15.0, 13.0, 11.0, 9.0, 7.0, 5.0, 3.0, 1.0,
    -1.0, -3.0, -5.0, -7.0, -9.0, -11.0, -13.0, -15.0,
]
ALTITUDES_64 = [
    15.7, 15.1, 14.5, 13.9, 13.3, 12.7, 12.1, 11.5,
    10.9, 10.3,  9.7,  9.1,  8.5,  7.9,  7.3,  6.7,
     6.1,  5.5,  4.9,  4.3,  3.7,  3.1,  2.5,  1.9,
     1.3,  0.7,  0.1, -0.5, -1.1, -1.7, -2.3, -2.9,
    -3.5, -4.1, -4.7, -5.3, -5.9, -6.5, -7.1, -7.7,
    -8.3, -8.9, -9.5,-10.1,-10.7,-11.3,-11.9,-12.5,
   -13.1,-13.7,-14.3,-14.9,-15.5,-16.1,-16.7,-17.3,
   -17.9,-18.5,-19.1,-19.7,-20.3,-20.9,-21.5,-22.1,
]

ALT_BY_BEAMS = {
    16:  [math.radians(a) for a in ALTITUDES_16],
    32:  [math.radians(a) for a in ALTITUDES_32],
    64:  [math.radians(a) for a in ALTITUDES_64],
}


def set_eth0():
    import fcntl
    SIOCSIFADDR    = 0x8916
    SIOCSIFNETMASK = 0x891c
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def psa(a):
        # sockaddr_in: 2-byte family + 2-byte port + 4-byte addr + 8-byte pad = 16 bytes
        return struct.pack('2sH4s8s', b'\x02\x00', 0, socket.inet_aton(a), b'\x00' * 8)

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


def configure_ouster(lidar_ip='192.168.1.150', our_ip='192.168.1.200', udp_port=56201):
    """Try to configure Ouster UDP dest via TCP (7501) then HTTP (80). Falls back gracefully."""
    # Method 1: legacy TCP command interface
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3.0)
        s.connect((lidar_ip, 7501))
        for cmd in [f'set_config_param udp_dest {our_ip}',
                    f'set_config_param udp_port_lidar {udp_port}',
                    'reinitialize']:
            s.sendall((cmd + '\n').encode())
            try:
                resp = s.recv(256).decode(errors='ignore').strip()
            except Exception:
                resp = '?'
            print(f'[ouster] {cmd!r} → {resp!r}')
        s.close()
        print('[ouster] configured via TCP 7501')
        time.sleep(2.0)
        return True
    except Exception as e:
        print(f'[ouster] TCP 7501: {e}')

    # Method 2: HTTP REST API (firmware ≥ 2.0)
    try:
        import http.client as _hc, json as _json
        conn = _hc.HTTPConnection(lidar_ip, 80, timeout=3)
        conn.request('GET', '/api/v1/sensor/config')
        r = conn.getresponse(); r.read()
        if r.status == 200:
            body = _json.dumps({'udp_dest': our_ip, 'udp_port_lidar': udp_port})
            conn.request('PUT', '/api/v1/sensor/config', body=body,
                         headers={'Content-Type': 'application/json'})
            r2 = conn.getresponse(); r2.read()
            print(f'[ouster] HTTP config PUT → {r2.status}')
            conn.request('POST', '/api/v1/system/reinitialize')
            r3 = conn.getresponse(); r3.read()
            print(f'[ouster] HTTP reinit → {r3.status}')
            conn.close()
            time.sleep(2.0)
            return True
    except Exception as e:
        print(f'[ouster] HTTP 80: {e}')

    print('[ouster] config unavailable — binding UDP directly (eth0 fix may be enough)')
    return False


def detect_format(data):
    """Auto-detect Ouster packet format from packet size."""
    n = len(data)
    # Try with assumed 16-byte header first, in priority order
    body = n - 16
    if body > 0:
        for n_beams, px in [(32, 12), (32, 16), (64, 12), (16, 12), (32, 8)]:
            if body % (n_beams * px) == 0:
                cols = body // (n_beams * px)
                if 1 <= cols <= 32:
                    return 16, n_beams, px
    # Fallback: brute-force header sizes
    for hdr in [16, 32, 12]:
        for n_beams, px in [(32, 12), (32, 16), (64, 12), (16, 12), (32, 8)]:
            if n > hdr and (n - hdr) % (n_beams * px) == 0:
                cols = (n - hdr) // (n_beams * px)
                if 1 <= cols <= 32:
                    return hdr, n_beams, px
    return 16, 32, 12


class OusterBridge(Node):
    def __init__(self, port=56201):
        super().__init__('ouster_bridge')
        self.pub    = self.create_publisher(PointCloud2, '/lidar/points', 5)
        self._buf   = []
        self._lock  = threading.Lock()
        self._fid   = -1
        self._last  = time.time()
        self._last_flush = time.time()
        self._fmt   = None   # (hdr, n_beams, px_size) — detected on first packet
        self._flush_count = 0
        self._FLUSH_INTERVAL = 0.5  # flush at least every 500ms (handles stopped-motor case)

        set_eth0()
        configure_ouster()

        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1 << 22)
        self._sock.bind(('0.0.0.0', port))
        self._sock.settimeout(1.0)

        threading.Thread(target=self._recv, daemon=True).start()
        self.get_logger().info(f'Ouster bridge UDP {port} ready')

    def _recv(self):
        while rclpy.ok():
            try:
                data, _ = self._sock.recvfrom(65535)
                self._parse(data)
            except socket.timeout:
                # Flush on timeout if we have accumulated data (handles stopped-motor mode)
                with self._lock:
                    if self._buf and (time.time() - self._last_flush) >= self._FLUSH_INTERVAL:
                        self._flush()
                        self._buf = []
                continue
            except Exception as e:
                self.get_logger().debug(str(e))

    def _parse(self, data):
        if len(data) < 8:
            return
        try:
            # Auto-detect format on first real packet
            if self._fmt is None:
                self._fmt = detect_format(data)
                hdr, n_beams, px = self._fmt
                self.get_logger().info(
                    f'Detected format: hdr={hdr} beams={n_beams} px_size={px} '
                    f'packet_len={len(data)}')

            hdr, n_beams, px = self._fmt
            if len(data) < hdr:
                return

            fid = struct.unpack_from('<H', data, 10)[0] if hdr >= 12 else 0
            enc = struct.unpack_from('<I', data, 12)[0] if hdr >= 16 else 0
            az  = (enc / 90112.0) * 2.0 * math.pi

            alt_rad = ALT_BY_BEAMS.get(n_beams, ALT_BY_BEAMS[32])
            pts = []
            for b in range(n_beams):
                off = hdr + b * px
                if off + 4 > len(data):
                    break
                r = struct.unpack_from('<I', data, off)[0]
                if r == 0:
                    continue
                rm = r / 1000.0
                if rm < 0.1 or rm > 100:
                    continue
                sig = struct.unpack_from('<H', data, off + 4)[0] if px >= 6 else 0
                al  = alt_rad[b] if b < len(alt_rad) else 0.0
                pts.append((
                    rm * math.cos(al) * math.cos(-az),
                    rm * math.cos(al) * math.sin(-az),
                    rm * math.sin(al),
                    float(sig),
                ))

            now = time.time()
            with self._lock:
                self._buf.extend(pts)
                if fid != self._fid or (now - self._last_flush) >= self._FLUSH_INTERVAL:
                    self._flush()
                    self._fid  = fid
                    self._buf  = []
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

            self._last_flush = time.time()
            self._flush_count += 1
            if self._flush_count % 20 == 0:
                hz = 20.0 / max(time.time() - self._last, 0.001)
                self._last = time.time()
                self.get_logger().info(f'{len(pts)} pts/scan  {hz:.1f} Hz')
        except Exception as e:
            self.get_logger().warn(str(e))


def main(args=None):
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 56201
    rclpy.init(args=args)
    node = OusterBridge(port=port)
    rclpy.spin(node)
    node.destroy_node()
    rclpy.shutdown()


if __name__ == '__main__':
    main()
