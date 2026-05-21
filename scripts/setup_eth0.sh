#!/usr/bin/env python3
"""
Configure eth0 for Ouster LiDAR direct-ethernet connection.
Assigns 192.168.1.200/24 to eth0 and adds a host route for the LiDAR.
Run as root (or with sudo).

Usage:
  sudo python3 scripts/setup_eth0.sh [LIDAR_IP]
  Default LIDAR_IP: 192.168.1.150
"""
import socket, struct, fcntl, os, sys

LIDAR_IP = sys.argv[1] if len(sys.argv) > 1 else '192.168.1.150'
ETH0_IP  = '192.168.1.200'

SIOCSIFADDR    = 0x8916
SIOCSIFNETMASK = 0x891c
SIOCGIFFLAGS   = 0x8913
SIOCSIFFLAGS   = 0x8914

def ifreq(n, d): return struct.pack('16s', n.encode()) + d
def psa(a): return b'\x02\x00\x00\x00' + socket.inet_aton(a) + b'\x00'*8

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
fcntl.ioctl(s.fileno(), SIOCSIFADDR,    ifreq('eth0', psa(ETH0_IP)))
fcntl.ioctl(s.fileno(), SIOCSIFNETMASK, ifreq('eth0', psa('255.255.255.0')))
# Bring up
res = fcntl.ioctl(s.fileno(), SIOCGIFFLAGS, struct.pack('16sh', b'eth0', 0))
flags = struct.unpack('16sh', res)[1]
fcntl.ioctl(s.fileno(), SIOCSIFFLAGS, struct.pack('16sh', b'eth0', flags | 1))
s.close()
print(f'eth0 configured: {ETH0_IP}/24')

# Add host route for LiDAR via eth0
import os
RTM_NEWROUTE = 24; NLM_F_REQUEST=1; NLM_F_ACK=4; NLM_F_CREATE=0x400; NLM_F_REPLACE=0x100
SIOCGIFINDEX = 0x8933
s2 = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
res = fcntl.ioctl(s2.fileno(), SIOCGIFINDEX, struct.pack('16si', b'eth0', 0))
ifindex = struct.unpack('16si', res)[1]
s2.close()

def align4(n): return (n+3)&~3
def rta(t, d):
    l = 4+len(d)
    return struct.pack('HH', l, t) + d + b'\x00'*(align4(l)-l)

attrs  = rta(1, socket.inet_aton(LIDAR_IP))   # RTA_DST
attrs += rta(4, struct.pack('I', ifindex))     # RTA_OIF
rtm = struct.pack('BBBBBBBBBBBB', 2, 32, 0, 0, 254, 4, 253, 1, 0, 0, 0, 0)
payload = rtm + attrs
total = 16 + len(payload)
flags = NLM_F_REQUEST|NLM_F_ACK|NLM_F_CREATE|NLM_F_REPLACE
nlhdr = struct.pack('IHHII', total, RTM_NEWROUTE, flags, 1, os.getpid())
nl = socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE)
nl.bind((0, 0)); nl.send(nlhdr + payload)
reply = nl.recv(4096); nl.close()
errno_val = struct.unpack('i', reply[16:20])[0]
if errno_val == 0:
    print(f'Host route added: {LIDAR_IP} dev eth0')
elif abs(errno_val) == 17:
    print(f'Host route already exists for {LIDAR_IP}')
else:
    print(f'Route add returned errno={abs(errno_val)} (may be OK if already exists)')

print(f'\nTo launch sensors:')
print(f'  source install/setup.bash && ros2 launch cobot_bringup sensors.launch.py')
