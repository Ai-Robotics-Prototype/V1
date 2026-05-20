#!/usr/bin/env python3
"""
Export YOLOv8 .pt model to TensorRT .engine for Jetson AGX Orin (SM87).

Usage:
  python3 scripts/export_trt.py [--model /opt/cobot/models/yolov8n.pt]
                                 [--imgsz 640]
                                 [--batch 1]
                                 [--fp16]
                                 [--int8]
                                 [--calib-dir /opt/cobot/calib_images]

Output: same directory as input, .pt → .engine
"""

import argparse
import os
import sys
import time


def parse_args():
    p = argparse.ArgumentParser(description='Export YOLOv8 to TensorRT')
    p.add_argument('--model',     default='/opt/cobot/models/yolov8n.pt')
    p.add_argument('--imgsz',     type=int, default=640)
    p.add_argument('--batch',     type=int, default=1)
    p.add_argument('--fp16',      action='store_true', default=True,
                   help='FP16 precision (recommended for Jetson)')
    p.add_argument('--int8',      action='store_true', default=False,
                   help='INT8 precision (requires calibration images)')
    p.add_argument('--calib-dir', default='/opt/cobot/calib_images',
                   help='Directory of calibration images for INT8')
    p.add_argument('--workspace', type=int, default=4,
                   help='TensorRT workspace size in GB')
    return p.parse_args()


def check_prerequisites():
    errors = []
    try:
        import tensorrt as trt
        print(f'TensorRT version: {trt.__version__}')
    except ImportError:
        errors.append('tensorrt not installed (comes with JetPack)')

    try:
        from ultralytics import YOLO
        print('Ultralytics YOLO: available')
    except ImportError:
        errors.append('ultralytics not installed: pip install ultralytics')

    if errors:
        print('\nPrerequisite errors:')
        for e in errors:
            print(f'  ✗ {e}')
        sys.exit(1)


def export(args):
    from ultralytics import YOLO

    if not os.path.exists(args.model):
        print(f'Model not found: {args.model}')
        print('Run: python3 scripts/download_model.py')
        sys.exit(1)

    precision = 'int8' if args.int8 else ('fp16' if args.fp16 else 'fp32')
    print(f'\nExporting {args.model}')
    print(f'  Image size : {args.imgsz}×{args.imgsz}')
    print(f'  Batch size : {args.batch}')
    print(f'  Precision  : {precision}')
    print(f'  SM arch    : 87 (Jetson AGX Orin)\n')

    model = YOLO(args.model)

    kwargs = dict(
        format='engine',
        imgsz=args.imgsz,
        batch=args.batch,
        device='cuda:0',
        workspace=args.workspace,
        verbose=True,
    )
    if args.int8:
        kwargs['int8'] = True
        if os.path.isdir(args.calib_dir):
            kwargs['data'] = args.calib_dir
        else:
            print(f'Warning: calib-dir {args.calib_dir} not found — '
                  f'using random calibration data (accuracy may suffer)')
    elif args.fp16:
        kwargs['half'] = True

    t0 = time.monotonic()
    engine_path = model.export(**kwargs)
    elapsed = time.monotonic() - t0

    print(f'\n✓ Engine saved: {engine_path}')
    size_mb = os.path.getsize(engine_path) / 1e6
    print(f'  Size    : {size_mb:.1f} MB')
    print(f'  Elapsed : {elapsed:.1f} s')

    # Quick latency benchmark via ultralytics TRT backend
    print('\nRunning 100-iteration latency benchmark...')
    import numpy as np
    try:
        from ultralytics import YOLO as _YOLO
        _m = _YOLO(engine_path, task='detect')
        _dummy = np.random.randint(0, 255, (args.imgsz, args.imgsz, 3), dtype=np.uint8)
        for _ in range(10):
            _m.predict(_dummy, verbose=False)
        _times = []
        for _ in range(100):
            _t = time.monotonic()
            _m.predict(_dummy, verbose=False)
            _times.append((time.monotonic() - _t) * 1e3)
        _times.sort()
        print(f'  Latency  p50={_times[49]:.2f}ms  p95={_times[94]:.2f}ms  '
              f'p99={_times[98]:.2f}ms')
        print(f'  FPS (1/p50): {1000/_times[49]:.1f}')
    except Exception as e:
        print(f'  Benchmark skipped: {e}')

    return engine_path


if __name__ == '__main__':
    args = parse_args()
    check_prerequisites()
    export(args)
