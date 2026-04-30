#!/usr/bin/env python3
"""Download YOLOv8n model to /opt/cobot/models/."""
import os
import urllib.request

MODELS_DIR = '/opt/cobot/models'
MODEL_URL = 'https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.pt'
MODEL_NAME = 'yolov8n.pt'


def _progress_hook(count, block_size, total_size):
    if total_size > 0:
        pct = count * block_size * 100 / total_size
        print(f'\rDownloading {MODEL_NAME}: {min(pct, 100):.1f}%', end='', flush=True)


def main():
    os.makedirs(MODELS_DIR, exist_ok=True)
    dest = os.path.join(MODELS_DIR, MODEL_NAME)
    if os.path.exists(dest):
        print(f'{dest} already exists — skipping download')
        return
    print(f'Downloading {MODEL_NAME} to {dest}...')
    urllib.request.urlretrieve(MODEL_URL, dest, reporthook=_progress_hook)
    print(f'\nSaved to {dest}')


if __name__ == '__main__':
    main()
