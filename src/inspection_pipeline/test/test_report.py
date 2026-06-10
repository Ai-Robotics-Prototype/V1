"""Report generation tests — runs in stub mode when reportlab is missing."""

import os

from inspection_pipeline.report_generator import generate_report


SAMPLE_RECORD = {
    'inspection_id': '20260610T120000-aaaaaa',
    'part_id':       'bracket_a',
    'plan_id':       'default',
    'timestamp':     1717930000.0,
    'duration_ms':   1234,
    'tier':          2,
    'reference_type': 'step',
    'reference_hash': 'deadbeef' * 8,
    'overall_result': 'pass',
    'measurements': [
        {'name': 'length_mm', 'nominal': 100.0, 'measured': 100.05,
         'deviation': 0.05, 'tolerance_fail': 0.5, 'result': 'pass',
         'units': 'mm', 'category': 'dimensional'},
    ],
    'defects': [],
    'statistics': {'count': 1, 'max': 0.05, 'mean': 0.05, 'rms': 0.05,
                   'std': 0.0, 'p95': 0.05, 'p99': 0.05,
                   'percent_within_tolerance': 100.0},
    'metadata': {'robot_serial': 'cobot-001', 'operator': 'jdoe',
                 'program': 'demo'},
}


def test_generate_report_produces_a_file(tmp_path):
    out = tmp_path / 'report.pdf'
    path = generate_report(SAMPLE_RECORD, str(out))
    assert path and os.path.isfile(path)
    assert os.path.getsize(path) > 0
