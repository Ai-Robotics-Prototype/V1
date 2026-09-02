#!/usr/bin/env python3
"""No-motion Modbus trigger probe.

Precondition: 工程映射 slot 0 bound to `ioconsole` (motion-free:
single setDO(2, 0)).

Sequence (per operator instruction):
  1. Confirm 2015=1 (Remote mode) on the wire.
  2. Baseline snapshot: 42000, 2000, 2001.
  3. Write 42000=0 (FC06), read back to confirm.
  4. Discover 1000 wire-type (FC03 holding vs FC01 coil).
  5. Pulse 1000 high (FC06 or FC05) — arms the "启动工程" edge.
  6. Poll 2000/2001 at 5 Hz for ~4 s — expect 2000 to rise (run
     started) then fall (ioconsole is a single-op, ~ms scale).
  7. Drive 1000 back to 0 (arm the next rising edge).
  8. Post-state snapshot.
"""
import socket, struct, time

HOST = "192.168.2.136"; PORT = 502; UNIT = 1


def mbap(txn, unit, pdu):
    return struct.pack(">HHHB", txn, 0, 1 + len(pdu), unit) + pdu


def _recvn(sock, n):
    buf = b""
    while len(buf) < n:
        c = sock.recv(n - len(buf))
        if not c:
            return None
        buf += c
    return buf


def _txn():
    _txn.n = getattr(_txn, "n", 0) + 1
    return _txn.n


def _send(sock, fc, addr, payload_extra):
    """Send an FC PDU and return either {'ok': True, 'data': bytes}
    or {'ok': False, 'exc': int, 'fc': int}."""
    txn = _txn()
    if fc in (0x01, 0x02, 0x03, 0x04):
        pdu = struct.pack(">BHH", fc, addr, payload_extra)   # qty
    elif fc in (0x05, 0x06):
        pdu = struct.pack(">BHH", fc, addr, payload_extra)   # value
    else:
        raise ValueError(f"unhandled fc={fc}")
    sock.sendall(mbap(txn, UNIT, pdu))
    hdr = _recvn(sock, 8)
    if not hdr:
        return {"ok": False, "exc": None, "fc": fc, "note": "short_header"}
    _, _, ln, _ = struct.unpack(">HHHB", hdr[:7])
    r_fc = hdr[7]
    rest = _recvn(sock, ln - 2) or b""
    if r_fc & 0x80:
        return {"ok": False, "exc": rest[0] if rest else None, "fc": r_fc & 0x7F}
    return {"ok": True, "fc": r_fc, "data": rest}


def read_holding(sock, addr, qty=1):
    r = _send(sock, 0x03, addr, qty)
    if not r["ok"]:
        return r
    bc = r["data"][0]
    regs = struct.unpack(f">{qty}H", r["data"][1:1 + bc])
    return {"ok": True, "regs": list(regs)}


def read_coils(sock, addr, qty=1):
    r = _send(sock, 0x01, addr, qty)
    if not r["ok"]:
        return r
    bc = r["data"][0]
    raw = r["data"][1:1 + bc]
    bits = []
    for byte in raw:
        for b in range(8):
            bits.append((byte >> b) & 1)
    return {"ok": True, "coils": bits[:qty]}


def write_holding(sock, addr, value):
    return _send(sock, 0x06, addr, value & 0xFFFF)


def write_coil(sock, addr, on):
    return _send(sock, 0x05, addr, 0xFF00 if on else 0x0000)


def connect():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2.0)
    s.connect((HOST, PORT))
    return s


def snapshot(sock):
    """Read 42000 + 2000..2001 + 2015 as a bundle. Uses three
    reads because 42000 and the 2000-block are far apart."""
    r_42000 = read_holding(sock, 42000, 1)
    r_2000  = read_holding(sock, 2000, 2)   # running + stopped
    r_2015  = read_holding(sock, 2015, 1)   # remote_mode
    return {
        "42000":       r_42000.get("regs", [None])[0]  if r_42000.get("ok") else f"err {r_42000}",
        "2000_run":    r_2000.get("regs",  [None, None])[0] if r_2000.get("ok")  else f"err {r_2000}",
        "2001_stop":   r_2000.get("regs",  [None, None])[1] if r_2000.get("ok")  else f"err {r_2000}",
        "2015_remote": r_2015.get("regs",  [None])[0]  if r_2015.get("ok") else f"err {r_2015}",
    }


def print_snap(label, snap):
    print(f"  [{label}]  42000={snap['42000']}  "
          f"2000_run={snap['2000_run']}  "
          f"2001_stop={snap['2001_stop']}  "
          f"2015_remote={snap['2015_remote']}")


def main():
    print(f"=== No-motion Modbus trigger probe → {HOST}:{PORT} unit_id={UNIT} ===\n")

    # ---- Step 1: confirm 2015=1 (Remote mode) ----
    print("[1] Remote-mode check (2015):")
    with connect() as s:
        r = read_holding(s, 2015, 1)
    if not r.get("ok") or r["regs"][0] != 1:
        print(f"    ABORT: 2015={r.get('regs')} — NOT in Remote mode. Full reply: {r}")
        return
    print(f"    OK  2015=1 (Remote)")

    # ---- Step 2: baseline snapshot ----
    print("\n[2] Baseline snapshot:")
    with connect() as s:
        base = snapshot(s)
    print_snap("BASE", base)

    # ---- Step 3: write 42000=0, read back ----
    print("\n[3] Write 42000=0 (FC06):")
    with connect() as s:
        w = write_holding(s, 42000, 0)
    if not w.get("ok"):
        print(f"    FAIL {w}")
        return
    print(f"    OK  echo={w.get('data', b'').hex()}")
    with connect() as s:
        rb = read_holding(s, 42000, 1)
    print(f"    Read-back 42000={rb.get('regs', ['?'])[0]}")
    if rb.get("regs", [None])[0] != 0:
        print("    ABORT: read-back mismatch"); return

    # ---- Step 4: discover 1000 wire-type ----
    print("\n[4] Discover 1000 wire-type (read-only):")
    with connect() as s:
        h1000 = read_holding(s, 1000, 1)
        c1000 = read_coils(s, 1000, 1)
    holding_ok = h1000.get("ok")
    coil_ok    = c1000.get("ok")
    print(f"    FC03 @ 1000: {h1000}")
    print(f"    FC01 @ 1000: {c1000}")
    if coil_ok and not holding_ok:
        wire = "coil"; wire_fn = ("FC05", write_coil)
    elif holding_ok and not coil_ok:
        wire = "holding"; wire_fn = ("FC06", lambda s,a,v: write_holding(s,a,1 if v else 0))
    elif coil_ok and holding_ok:
        # Some controllers respond to both. Manual §Modbus map calls
        # the 1000-series "coil-like" — prefer FC05.
        wire = "both_answer_prefer_coil"; wire_fn = ("FC05", write_coil)
    else:
        print("    ABORT: neither FC01 nor FC03 answers @1000"); return
    print(f"    → wire={wire}, using {wire_fn[0]}")

    # ---- Step 5: pulse 1000 high ----
    print(f"\n[5] Pulse 1000 HIGH via {wire_fn[0]}:")
    t_pulse = time.monotonic()
    with connect() as s:
        w = wire_fn[1](s, 1000, True)
    print(f"    write reply: ok={w.get('ok')}  echo={w.get('data', b'').hex()}  err={w.get('exc')}")
    if not w.get("ok"):
        print("    ABORT: pulse write refused"); return

    # ---- Step 6: poll 2000/2001 for run→done transition (~5 Hz, ~4 s) ----
    print(f"\n[6] Poll 2000/2001 @ 5 Hz for 4 s (starting at t=+{time.monotonic()-t_pulse:.3f} s):")
    transitions = []
    prev = None
    poll_end = t_pulse + 4.0
    with connect() as s:
        while time.monotonic() < poll_end:
            t = time.monotonic() - t_pulse
            r = read_holding(s, 2000, 2)
            if r.get("ok"):
                run, stop = r["regs"]
                cur = (run, stop)
                marker = " *" if cur != prev else ""
                print(f"    t=+{t:5.3f} s  2000_run={run}  2001_stop={stop}{marker}")
                if cur != prev and prev is not None:
                    transitions.append((t, prev, cur))
                prev = cur
            time.sleep(0.2)

    # ---- Step 7: drive 1000 back to LOW ----
    print(f"\n[7] Drive 1000 LOW via {wire_fn[0]} (arm next rising edge):")
    with connect() as s:
        w = wire_fn[1](s, 1000, False)
    print(f"    write reply: ok={w.get('ok')}  echo={w.get('data', b'').hex()}  err={w.get('exc')}")

    # ---- Step 8: post-state snapshot ----
    print("\n[8] Post-state snapshot:")
    with connect() as s:
        post = snapshot(s)
    print_snap("POST", post)

    # ---- Verdict ----
    print("\n=== Verdict ===")
    rose = any(prev == (0, 1) and cur == (1, 0) for _, prev, cur in transitions) or \
           any(cur[0] == 1 for _, prev, cur in transitions)
    print(f"  transitions observed: {transitions or 'NONE'}")
    if rose:
        print("  → 2000 rose during pulse: PROGRAM STARTED. Binding OK.")
    else:
        print("  → 2000 stayed low: program did NOT start.")
        print("    Possible causes: slot 0 unbound / write to 42000 didn't stick /")
        print("    coil-1000 wire type wrong / Remote-mode gate withdrew mid-probe.")
    print(f"\n  ioconsole action: setDO(2, 0). Confirm on ports panel that DO2=0")
    print(f"  after the run (if DO2 was 1 before, this is the visible effect).")


if __name__ == "__main__":
    main()
