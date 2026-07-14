#!/usr/bin/env python3
"""Fit standard DH parameters to the Estun controller's FK oracle.

Reads posture JSONL captures (joint APOS in deg, TCP xyz in mm, TCP abc in
deg — fixed-axis X-Y-Z Euler), dedupes to unique poses, then two-stage
nonlinear least-squares fits standard DH.

Vectorized FK across all poses (numpy batched matmul on (N,4,4)). Never
loops pose-by-pose in Python.

Outputs:
  * DH table (stdout + report)
  * ~/cobot_ws/config/estun_s10_140_fitted.urdf
  * ~/cobot_ws/data/dh_fit_report.txt
"""
import json
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from scipy.optimize import least_squares
from scipy.spatial.transform import Rotation as R

HOME = Path.home()
CB   = HOME / 'cobot_ws'
DATA_PATH   = CB / 'data' / 'estun_posture_20260708_161306.jsonl'
REPORT_PATH = CB / 'data' / 'dh_fit_report.txt'
OUT_URDF    = CB / 'config' / 'estun_s10_140_fitted.urdf'
PROV_URDF   = CB / 'models' / 'robots' / 'estun_s10-140' / 's10-140-full.urdf'

DEG = np.pi / 180.0
RAD = 180.0 / np.pi

# ── Dual output (stdout + report buffer) ─────────────────────────
_LOG = []
def L(*args):
    line = ' '.join(str(a) for a in args) if args else ''
    print(line, flush=True)
    _LOG.append(line)


# ── Parse + dedupe ───────────────────────────────────────────────
def parse_and_dedupe(path):
    frames = []
    with open(path) as fh:
        for raw in fh:
            raw = raw.strip()
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if obj.get('ty') != 'publish/RobotPosture':
                continue
            db = obj.get('db', {})
            j  = db.get('joint')
            e  = db.get('end', {})
            if not (isinstance(j, list) and len(j) >= 6):
                continue
            try:
                xyz = [float(e['x']), float(e['y']), float(e['z'])]
                abc = [float(e['a']), float(e['b']), float(e['c'])]
            except (KeyError, TypeError, ValueError):
                continue
            frames.append(([float(v) for v in j[:6]], xyz, abc))
    L(f'parsed {len(frames)} RobotPosture frames from {path.name}')

    kept = []
    last_q = None
    for q, xyz, abc in frames:
        if last_q is not None and np.all(np.abs(np.array(q) - last_q) < 0.05):
            continue
        kept.append((q, xyz, abc))
        last_q = np.array(q)
    L(f'after dedupe (0.05deg threshold): {len(kept)} unique poses')

    q_deg   = np.array([k[0] for k in kept])
    xyz_mm  = np.array([k[1] for k in kept])
    abc_deg = np.array([k[2] for k in kept])
    return q_deg, xyz_mm, abc_deg


# ── Vectorized standard DH FK ────────────────────────────────────
def dh_link_batch(a, alpha, d, theta):
    """(N,4,4) standard-DH transform Rz(theta) Tz(d) Tx(a) Rx(alpha)."""
    N  = theta.shape[0]
    ct = np.cos(theta); st = np.sin(theta)
    ca = np.cos(alpha); sa = np.sin(alpha)
    T  = np.zeros((N, 4, 4))
    T[:, 0, 0] = ct
    T[:, 0, 1] = -st * ca
    T[:, 0, 2] =  st * sa
    T[:, 0, 3] =  a * ct
    T[:, 1, 0] = st
    T[:, 1, 1] =  ct * ca
    T[:, 1, 2] = -ct * sa
    T[:, 1, 3] =  a * st
    T[:, 2, 1] = sa
    T[:, 2, 2] = ca
    T[:, 2, 3] = d
    T[:, 3, 3] = 1.0
    return T


def unpack(params, use_flange):
    dh = params[:24].reshape(6, 4)
    base_z = params[24]
    if use_flange:
        f_rx, f_ry, f_rz = params[25], params[26], params[27]
    else:
        f_rx = f_ry = f_rz = 0.0
    return dh, base_z, f_rx, f_ry, f_rz


def fk_batch(params, q_rad, use_flange=False):
    """Vectorized FK. q_rad: (N,6). Returns (N,4,4) in mm/rad."""
    dh, base_z, f_rx, f_ry, f_rz = unpack(params, use_flange)
    N = q_rad.shape[0]

    Tbase = np.eye(4)
    Tbase[:3, 3] = [0.0, 0.0, base_z]
    T = np.broadcast_to(Tbase, (N, 4, 4)).copy()

    for i in range(6):
        A = dh_link_batch(dh[i, 0], dh[i, 1], dh[i, 2],
                          q_rad[:, i] + dh[i, 3])
        T = T @ A

    if use_flange:
        Tf = np.eye(4)
        Tf[:3, :3] = R.from_euler('xyz', [f_rx, f_ry, f_rz]).as_matrix()
        T = T @ Tf
    return T


def residual_pos(params, q_rad, meas_pos_mm):
    T = fk_batch(params, q_rad, use_flange=False)
    return (T[:, :3, 3] - meas_pos_mm).ravel()


def residual_full(params, q_rad, meas_pos_mm, meas_R, use_flange=False,
                  ori_scale=1000.0):
    T = fk_batch(params, q_rad, use_flange=use_flange)
    r_pos = (T[:, :3, 3] - meas_pos_mm).ravel()
    R_fk = T[:, :3, :3]
    # R_err = R_fk @ meas_R.T   (batched via einsum)
    R_err = np.einsum('nij,nkj->nik', R_fk, meas_R)
    rotvec = R.from_matrix(R_err).as_rotvec()
    r_ori = rotvec.ravel() * ori_scale
    return np.concatenate([r_pos, r_ori])


# ── Seed ────────────────────────────────────────────────────────
# ~1400mm reach cobot with a J3 elbow offset and J2/J3/J5 controller-zero
# ~90deg theta offsets. Values are guesses; the fit refines them.
def make_seed(base_z=0.0):
    dh_seed = [
        [   0.0,  np.pi/2,   350.0,   0.0     ],   # J1  base yaw
        [ 700.0,  0.0,         0.0,   np.pi/2 ],   # J2  shoulder pitch
        [   0.0,  np.pi/2,  -221.0,   np.pi/2 ],   # J3  elbow pitch (with elbow offset)
        [   0.0, -np.pi/2,   538.0,   0.0     ],   # J4  wrist tilt
        [   0.0,  np.pi/2,     0.0,   np.pi/2 ],   # J5  wrist pitch
        [   0.0,  0.0,       155.0,   0.0     ],   # J6  flange roll
    ]
    p = np.array(dh_seed).ravel().tolist()
    p.append(base_z)                                # base_z
    return np.array(p, dtype=float)


PARAM_NAMES = []
for i in range(6):
    PARAM_NAMES += [f'a_{i+1}', f'alpha_{i+1}', f'd_{i+1}', f'off_{i+1}']
PARAM_NAMES.append('base_z')


# ── URDF encoding ───────────────────────────────────────────────
def _Rz(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])
def _Rx(a):
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]])
def _Tx(x):
    T = np.eye(4); T[0, 3] = x; return T
def _Tz(z):
    T = np.eye(4); T[2, 3] = z; return T


def dh_to_urdf_origins(dh, base_z):
    """URDF encoding of standard DH: 6 revolute + 1 fixed flange origin.

    Split: URDF joint_i origin absorbs the "post-Rz" static of DH link (i-1)
    (Tz Tx Rx) plus this joint's theta_off (Rz(off_i)). URDF joint axis = z
    of parent link; joint value q_i = APOS_i (rad). Flange fixed joint
    carries the residual Tz(d_6) Tx(a_6) Rx(alpha_6).
    """
    origins = []
    # joint_1: Tbase @ Rz(off_1)
    T = np.eye(4)
    T[:3, 3] = [0.0, 0.0, base_z]
    T = T @ _Rz(dh[0, 3])
    origins.append(T)
    for i in range(1, 6):
        a_p, al_p, d_p = dh[i-1, 0], dh[i-1, 1], dh[i-1, 2]
        off_i = dh[i, 3]
        origins.append(_Tz(d_p) @ _Tx(a_p) @ _Rx(al_p) @ _Rz(off_i))
    a6, al6, d6 = dh[5, 0], dh[5, 1], dh[5, 2]
    origins.append(_Tz(d6) @ _Tx(a6) @ _Rx(al6))
    return origins


def validate_urdf_encoding(dh, base_z, q_rad):
    """FK via URDF-chain evaluation; must match fk_batch to numerical eps."""
    origins = dh_to_urdf_origins(dh, base_z)
    N = q_rad.shape[0]
    T = np.broadcast_to(np.eye(4), (N, 4, 4)).copy()
    for i in range(6):
        T = T @ origins[i]
        c, s = np.cos(q_rad[:, i]), np.sin(q_rad[:, i])
        Rz = np.zeros((N, 4, 4))
        Rz[:, 0, 0] = c;  Rz[:, 0, 1] = -s
        Rz[:, 1, 0] = s;  Rz[:, 1, 1] =  c
        Rz[:, 2, 2] = 1;  Rz[:, 3, 3] = 1
        T = T @ Rz
    T = T @ origins[6]
    return T


def write_urdf(path, dh, base_z, rms_pos_mm, n_poses):
    origins = dh_to_urdf_origins(dh, base_z)
    lim_deg = [200.0, 200.0, 166.0, 200.0, 200.0, 200.0]
    vel_dps = [150.0, 150.0, 150.0, 180.0, 180.0, 180.0]

    lines = [
        '<?xml version="1.0"?>',
        '<!--',
        f'  FITTED from controller FK oracle 2026-07-08, RMS {rms_pos_mm:.3f}mm over {n_poses} poses',
        '  Estun S10-140-ECO-V2. Standard DH, tool0 = bare flange (no tool offset).',
        '  Joint limits: J1,J2,J4,J5,J6 = +/-200deg; J3 = +/-166deg.',
        '  Velocity ceilings: J1-J3 = 150deg/s; J4-J6 = 180deg/s.',
        '  URDF encoding: joint_i origin = Tz(d_{i-1}) Tx(a_{i-1}) Rx(alpha_{i-1}) Rz(theta_off_i);',
        '                 flange_fixed origin = Tz(d_6) Tx(a_6) Rx(alpha_6).',
        '-->',
        '<robot name="estun_s10_140_fitted">',
        '  <link name="base_link"/>',
    ]
    for i in range(6):
        parent = 'base_link' if i == 0 else f'link_{i}'
        child  = f'link_{i+1}'
        T = origins[i]
        xyz = T[:3, 3] / 1000.0
        rpy = R.from_matrix(T[:3, :3]).as_euler('xyz')
        lim = lim_deg[i] * DEG
        vel = vel_dps[i] * DEG
        lines += [
            f'  <joint name="joint_{i+1}" type="revolute">',
            f'    <parent link="{parent}"/>',
            f'    <child link="{child}"/>',
            f'    <origin xyz="{xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f}" '
            f'rpy="{rpy[0]:.6f} {rpy[1]:.6f} {rpy[2]:.6f}"/>',
            '    <axis xyz="0 0 1"/>',
            f'    <limit lower="{-lim:.6f}" upper="{lim:.6f}" '
            f'effort="200" velocity="{vel:.6f}"/>',
            '  </joint>',
            f'  <link name="{child}"/>',
        ]

    T = origins[6]
    xyz = T[:3, 3] / 1000.0
    rpy = R.from_matrix(T[:3, :3]).as_euler('xyz')
    lines += [
        '  <joint name="flange_fixed" type="fixed">',
        '    <parent link="link_6"/>',
        '    <child link="tool0"/>',
        f'    <origin xyz="{xyz[0]:.6f} {xyz[1]:.6f} {xyz[2]:.6f}" '
        f'rpy="{rpy[0]:.6f} {rpy[1]:.6f} {rpy[2]:.6f}"/>',
        '  </joint>',
        '  <link name="tool0"/>',
        '</robot>',
    ]

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('\n'.join(lines) + '\n')


def check_provisional(prov_path, new_lim_deg):
    if not prov_path.exists():
        L(f'no provisional URDF at {prov_path} (skipping backup + discrepancy check)')
        return []
    ts = time.strftime('%Y%m%d_%H%M%S')
    backup = prov_path.parent / f'{prov_path.name}.bak-fit-{ts}'
    shutil.copy2(prov_path, backup)
    L(f'backed up provisional URDF -> {backup}')

    txt = prov_path.read_text()
    discrepancies = []
    for i, nl in enumerate(new_lim_deg, start=1):
        m = re.search(
            rf'<joint\s+name="joint_{i}"[^>]*type="revolute"[^>]*>'
            rf'.*?<limit[^/>]*?lower="(-?[\d.eE+-]+)"[^/>]*?upper="(-?[\d.eE+-]+)"',
            txt, re.DOTALL)
        if m:
            plo = float(m.group(1)); phi = float(m.group(2))
            nlo = -nl * DEG;         nhi = nl * DEG
            if abs(plo - nlo) > 1e-3 or abs(phi - nhi) > 1e-3:
                discrepancies.append(
                    f'joint_{i}: provisional [{plo*RAD:+.2f}, {phi*RAD:+.2f}] deg  '
                    f'-> fitted [-{nl:.0f}, +{nl:.0f}] deg'
                )
    if discrepancies:
        L('joint-limit discrepancies vs provisional URDF:')
        for d in discrepancies:
            L(f'   {d}')
    else:
        L('joint limits in provisional URDF match new spec')
    return discrepancies


# ── Metrics ─────────────────────────────────────────────────────
def rms_max(errors):
    norms = np.linalg.norm(errors, axis=1) if errors.ndim == 2 else errors
    return float(np.sqrt(np.mean(norms ** 2))), float(norms.max()), norms


# ── Main ────────────────────────────────────────────────────────
def main():
    np.set_printoptions(precision=4, suppress=True, linewidth=140)

    L('=== fit_dh.py — Estun S10-140-ECO-V2 DH identification ===')
    L(f'input: {DATA_PATH}')

    q_deg, xyz_mm, abc_deg = parse_and_dedupe(DATA_PATH)
    N = q_deg.shape[0]

    L('\njoint coverage (deg):')
    for i in range(6):
        lo, hi = q_deg[:, i].min(), q_deg[:, i].max()
        L(f'  J{i+1}: {lo:+8.2f} .. {hi:+8.2f}  (span {hi-lo:6.2f})')

    q_rad = q_deg * DEG
    abc_rad = abc_deg * DEG
    meas_R_fixed = R.from_euler('xyz', abc_rad).as_matrix()  # extrinsic xyz
    meas_R_intr  = R.from_euler('XYZ', abc_rad).as_matrix()  # intrinsic XYZ

    # 80/20 split (deterministic)
    rng = np.random.default_rng(20260708)
    order = np.arange(N); rng.shuffle(order)
    n_tr = int(0.8 * N)
    tr, te = order[:n_tr], order[n_tr:]
    q_tr, xyz_tr, R_tr = q_rad[tr], xyz_mm[tr], meas_R_fixed[tr]
    q_te, xyz_te, R_te = q_rad[te], xyz_mm[te], meas_R_fixed[te]
    L(f'\nsplit: {n_tr} train / {N-n_tr} test  (seed 20260708)')

    # ── Stage (a) — position-only ─────────────────
    seed = make_seed()
    r0 = residual_pos(seed, q_tr, xyz_tr).reshape(-1, 3)
    rms0, mx0, _ = rms_max(r0)
    L(f'\n[STAGE A] position-only fit  (seed reach ~1.4m, J2/J3/J5 pi/2 theta offsets)')
    L(f'  seed residual (train):   RMS={rms0:9.2f}mm   MAX={mx0:9.2f}mm')

    # Bounds to force a physically-sensible parametrization. Standard DH
    # has a well-known gauge ambiguity when consecutive z-axes are
    # parallel (here: elbow J2/J3), so an unbounded fit can wander into
    # d/a magnitudes that reproduce the FK but place link frames far
    # outside the arm. Constraining |a|, |d| < 1000 mm picks the
    # physical representative from that family without shrinking the
    # (arbitrarily many) other valid solutions' residual.
    lo = []; hi = []
    for _ in range(6):
        lo += [-1000.0, -np.pi - 1e-3, -1000.0, -np.pi - 1e-3]
        hi += [ 1000.0,  np.pi + 1e-3,  1000.0,  np.pi + 1e-3]
    lo.append(-1000.0); hi.append(1000.0)  # base_z
    bounds_a = (np.array(lo), np.array(hi))

    t0 = time.time()
    res_a = least_squares(
        residual_pos, seed, args=(q_tr, xyz_tr),
        method='trf', bounds=bounds_a,
        x_scale='jac', max_nfev=200000,
        xtol=1e-14, ftol=1e-14, gtol=1e-14,
    )
    dt = time.time() - t0
    p_a = res_a.x

    r_tr_a = residual_pos(p_a, q_tr, xyz_tr).reshape(-1, 3)
    r_te_a = residual_pos(p_a, q_te, xyz_te).reshape(-1, 3)
    rmsA_tr, mxA_tr, _ = rms_max(r_tr_a)
    rmsA_te, mxA_te, _ = rms_max(r_te_a)
    L(f'  fitted residual:')
    L(f'    train:  RMS={rmsA_tr:9.5f}mm   MAX={mxA_tr:9.5f}mm')
    L(f'    test:   RMS={rmsA_te:9.5f}mm   MAX={mxA_te:9.5f}mm')
    L(f'  status={res_a.status}  nfev={res_a.nfev}  cost={res_a.cost:.3e}  time={dt:.1f}s')

    # ── Convention comparison ─────────────────────
    L(f'\n[CONVENTION] full stage-B fit under BOTH conventions')
    conv = {}
    for label, meas_R_all, tag in [
        ('fixed-xyz (extrinsic)', meas_R_fixed, 'fixed'),
        ('intrinsic XYZ',         meas_R_intr,  'intr'),
    ]:
        R_tr_c = meas_R_all[tr]
        t0 = time.time()
        res_c = least_squares(
            residual_full, p_a, args=(q_tr, xyz_tr, R_tr_c),
            method='lm', max_nfev=20000, xtol=1e-10, ftol=1e-10, gtol=1e-10,
        )
        dt = time.time() - t0
        rf = residual_full(res_c.x, q_tr, xyz_tr, R_tr_c).reshape(-1, 3)
        rp = rf[:n_tr]; ro = rf[n_tr:] / 1000.0
        rmsP, mxP, _ = rms_max(rp)
        rmsO, mxO, _ = rms_max(ro)
        L(f'  {label:>30s}: pos RMS={rmsP:8.3f}mm  MAX={mxP:8.3f}mm  |  '
          f'ori RMS={rmsO*RAD:8.4f}deg  MAX={mxO*RAD:8.4f}deg   '
          f'nfev={res_c.nfev}  t={dt:.1f}s')
        conv[tag] = (rmsP, rmsO, res_c)

    if conv['fixed'][0] < conv['intr'][0]:
        L(f'  => fixed-xyz WINS (pos RMS {conv["fixed"][0]:.3f}mm vs '
          f'{conv["intr"][0]:.2f}mm intrinsic). Using fixed-xyz for stage B.')
    else:
        L(f'  !!! WARN: fixed-xyz did NOT beat intrinsic XYZ - review convention !!!')

    # ── Stage (b) — full fit with fixed-xyz ───────
    L(f'\n[STAGE B] full pose fit (fixed-xyz), bounded to keep DH physical')
    t0 = time.time()
    res_b = least_squares(
        residual_full, p_a, args=(q_tr, xyz_tr, R_tr),
        method='trf', bounds=bounds_a,
        x_scale='jac', max_nfev=200000,
        xtol=1e-14, ftol=1e-14, gtol=1e-14,
    )
    dt = time.time() - t0
    p_b = res_b.x

    def eval_full(p, q, xyz, Rm):
        rf = residual_full(p, q, xyz, Rm).reshape(-1, 3)
        n  = q.shape[0]
        return rf[:n], rf[n:] / 1000.0

    rp_tr, ro_tr = eval_full(p_b, q_tr, xyz_tr, R_tr)
    rp_te, ro_te = eval_full(p_b, q_te, xyz_te, R_te)
    rmsP_tr, mxP_tr, _        = rms_max(rp_tr)
    rmsO_tr, mxO_tr, _        = rms_max(ro_tr)
    rmsP_te, mxP_te, npos_te  = rms_max(rp_te)
    rmsO_te, mxO_te, nori_te  = rms_max(ro_te)

    L(f'  train  pos: RMS={rmsP_tr:9.5f}mm   MAX={mxP_tr:9.5f}mm')
    L(f'  train  ori: RMS={rmsO_tr*RAD:9.5f}deg  MAX={mxO_tr*RAD:9.5f}deg')
    L(f'  test   pos: RMS={rmsP_te:9.5f}mm   MAX={mxP_te:9.5f}mm')
    L(f'  test   ori: RMS={rmsO_te*RAD:9.5f}deg  MAX={mxO_te*RAD:9.5f}deg')
    L(f'  status={res_b.status}  nfev={res_b.nfev}  cost={res_b.cost:.3e}  time={dt:.1f}s')

    accepted = rmsP_te < 2.0
    if not accepted:
        L(f'\n!!! FIT WARNING: test pos RMS = {rmsP_te:.3f}mm > 2mm threshold !!!')
        w = np.argsort(npos_te)[::-1][:5]
        L(f'   top-5 worst test poses (idx in test_set, |err_mm|, q_deg):')
        for i in w:
            L(f'     idx={i}  |err|={npos_te[i]:8.3f}mm  '
              f'q_deg={np.array2string(q_te[i]*RAD, precision=2)}')

    # Least-constrained params via Jacobian column norms
    J = getattr(res_b, 'jac', None)
    if J is not None and hasattr(J, 'shape') and J.ndim == 2:
        cn = np.linalg.norm(J, axis=0)
        order_c = np.argsort(cn)
        L(f'   least-constrained params (5 smallest Jacobian column norms):')
        for k in order_c[:5]:
            L(f'     {PARAM_NAMES[k]:14s}  col_norm={cn[k]:.3e}')

    # ── URDF encoding sanity check ────────────
    dh_final = p_b[:24].reshape(6, 4)
    base_z   = float(p_b[24])
    T_fk   = fk_batch(p_b, q_te)
    T_urdf = validate_urdf_encoding(dh_final, base_z, q_te)
    diff = float(np.max(np.abs(T_fk - T_urdf)))
    L(f'\n[urdf-encoding sanity] max |FK - URDF-chain| on test set: {diff:.3e}  '
      f'(should be < 1e-6)')

    # ── DH table ──────────────────────────────
    L(f'\n===== FITTED DH TABLE (standard DH) =====')
    hdr = f'{"joint":6s}  {"a (mm)":>12s}  {"alpha (deg)":>13s}  {"d (mm)":>12s}  {"theta_off (deg)":>18s}   note'
    L(hdr)
    for i in range(6):
        a, al, d, off = dh_final[i]
        off_deg = off * RAD
        # Normalize to [-180, 180]
        while off_deg > 180: off_deg -= 360
        while off_deg < -180: off_deg += 360
        note = ''
        if abs(abs(off_deg) - 90.0) < 20.0:
            note = 'controller-zero theta offset (~90deg)'
        elif abs(off_deg) < 5.0:
            note = 'no theta offset'
        L(f'joint_{i+1}  {a:12.5f}  {al*RAD:13.5f}  {d:12.5f}  {off_deg:18.5f}   {note}')
    L(f'base_z = {base_z:.5f} mm')

    # ── Write URDF ────────────────────────────
    disc = check_provisional(PROV_URDF, [200, 200, 166, 200, 200, 200])
    write_urdf(OUT_URDF, dh_final, base_z, rmsP_te, N)
    L(f'\nwrote fitted URDF: {OUT_URDF}')

    # ── Save report ───────────────────────────
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text('\n'.join(_LOG) + '\n')
    L(f'wrote report: {REPORT_PATH}')

    return 0 if accepted else 2


if __name__ == '__main__':
    sys.exit(main())
