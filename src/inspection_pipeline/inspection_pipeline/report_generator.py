"""PDF inspection-report generation.

Scaffolded with reportlab. The 7-page structure from the spec is
laid out in `generate_report()`; each page renderer is a helper so
templates can opt in/out of specific pages.

reportlab is imported lazily — the module loads cleanly without it so
the rest of the pipeline can still be exercised before reportlab is
installed on the Jetson.
"""

from __future__ import annotations

import io
import os
import time
from typing import Any

from .utils import (
    AUDIT_LOG_FILE, RESULT_FAIL, RESULT_PASS, RESULT_WARN,
    safe_dump_json, safe_load_json,
)

DEFAULT_TEMPLATE = {
    'company_name':      'RoboAi',
    'company_logo_path': None,
    'header_color':      '#1D6FD8',
    'footer_color':      '#6b7280',
    'pages': {
        'cover':         True,
        'summary':       True,
        'visualization': True,
        'measurements':  True,
        'defects':       True,
        'statistics':    True,
        'traceability':  True,
    },
    'language': 'en',
}


def load_template(path: str) -> dict:
    merged = dict(DEFAULT_TEMPLATE)
    merged.update(safe_load_json(path, {}))
    merged.setdefault('pages', DEFAULT_TEMPLATE['pages'])
    return merged


def save_template(path: str, template: dict) -> None:
    safe_dump_json(path, template)


def generate_report(record: dict,
                    output_path: str,
                    template: dict | None = None,
                    screenshots: dict[str, str] | None = None) -> str:
    """Produce a PDF at `output_path`. Returns the path.

    `record` is the inspection record (see utils.InspectionRecord).
    `screenshots` maps view-name → PNG path (iso/top/side/front etc.).
    """
    template = template or DEFAULT_TEMPLATE
    pages = template.get('pages', DEFAULT_TEMPLATE['pages'])

    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.lib.styles import getSampleStyleSheet
        from reportlab.lib.units import inch
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError:
        # Fall back to a tiny "stub" PDF so the dashboard's "Download
        # report" link doesn't 500 on a fresh box. The stub is a
        # one-page text file the operator can replace later by
        # re-running with reportlab installed.
        return _write_stub_pdf(output_path, record)

    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    c = rl_canvas.Canvas(output_path, pagesize=letter)
    width, height = letter

    if pages.get('cover'):
        _draw_cover(c, record, template, width, height)
        c.showPage()
    if pages.get('summary'):
        _draw_summary(c, record, template, width, height)
        c.showPage()
    if pages.get('visualization'):
        _draw_visualization(c, record, screenshots or {}, width, height)
        c.showPage()
    if pages.get('measurements'):
        _draw_measurements(c, record, width, height)
        c.showPage()
    if pages.get('defects'):
        _draw_defects(c, record, width, height)
        c.showPage()
    if pages.get('statistics'):
        _draw_statistics(c, record, width, height)
        c.showPage()
    if pages.get('traceability'):
        _draw_traceability(c, record, template, width, height)
        c.showPage()

    c.save()
    return output_path


# ─── Page renderers ─────────────────────────────────────────────────────

def _draw_cover(c, record, template, w, h):
    c.setFont('Helvetica-Bold', 28)
    c.drawString(72, h - 80, 'Inspection Report')
    c.setFont('Helvetica', 12)
    c.drawString(72, h - 110, f'Company: {template.get("company_name", "")}')
    c.drawString(72, h - 130, f'Part: {record.get("part_id", "")}')
    c.drawString(72, h - 150,
                 f'Date: {time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(record.get("timestamp", time.time())))}')
    c.drawString(72, h - 170,
                 f'Inspection ID: {record.get("inspection_id", "")}')

    result = record.get('overall_result', RESULT_PASS).upper()
    color = _result_color(result)
    c.setFillColorRGB(*color)
    c.rect(72, h - 280, 200, 60, fill=1)
    c.setFillColorRGB(1, 1, 1)
    c.setFont('Helvetica-Bold', 24)
    c.drawString(90, h - 260, result)
    c.setFillColorRGB(0, 0, 0)


def _draw_summary(c, record, template, w, h):
    _heading(c, 'Summary', h)
    y = h - 100
    line_height = 18

    lines = [
        f'Inspection tier: {record.get("tier", "?")}',
        f'Reference type: {record.get("reference_type", "?")}',
        f'Reference hash: {(record.get("reference_hash") or "")[:16]}',
        f'Plan: {record.get("plan_id", "?")}',
    ]
    measurements = record.get('measurements', [])
    passed = sum(1 for m in measurements if m.get('result') == RESULT_PASS)
    warned = sum(1 for m in measurements if m.get('result') == RESULT_WARN)
    failed = sum(1 for m in measurements if m.get('result') == RESULT_FAIL)
    lines += [
        f'Total measurements: {len(measurements)}',
        f'  Passed: {passed}',
        f'  Warned: {warned}',
        f'  Failed: {failed}',
        f'Pass rate: '
        f'{(100.0 * passed / len(measurements)) if measurements else 0:.1f}%',
    ]
    c.setFont('Helvetica', 11)
    for line in lines:
        c.drawString(72, y, line)
        y -= line_height


def _draw_visualization(c, record, screenshots, w, h):
    _heading(c, '3D Visualization', h)
    # Place up to four screenshots in a 2x2 grid.
    views = ['iso', 'top', 'side', 'front']
    cell_w = (w - 144) / 2
    cell_h = (h - 200) / 2
    for i, v in enumerate(views):
        path = screenshots.get(v)
        x = 72 + (i % 2) * cell_w
        y = h - 100 - cell_h - (i // 2) * cell_h
        c.setFont('Helvetica', 9)
        c.drawString(x, y + cell_h + 4, v.upper())
        if path and os.path.isfile(path):
            try:
                c.drawImage(path, x, y, cell_w - 12, cell_h - 12,
                            preserveAspectRatio=True)
            except Exception:
                c.rect(x, y, cell_w - 12, cell_h - 12)
        else:
            c.rect(x, y, cell_w - 12, cell_h - 12)
            c.drawString(x + 10, y + cell_h / 2, '(screenshot pending)')


def _draw_measurements(c, record, w, h):
    _heading(c, 'Measurements', h)
    measurements = record.get('measurements', [])
    c.setFont('Helvetica-Bold', 10)
    headers = ['Name', 'Nominal', 'Measured', 'Deviation', 'Tol±', 'Result']
    col_x = [72, 220, 290, 360, 430, 500]
    y = h - 100
    for i, hdr in enumerate(headers):
        c.drawString(col_x[i], y, hdr)
    y -= 16

    c.setFont('Helvetica', 9)
    for m in measurements[:40]:  # 40 rows fits comfortably on one page
        c.drawString(col_x[0], y, str(m.get('name', '')))
        c.drawString(col_x[1], y, _fmt_num(m.get('nominal')))
        c.drawString(col_x[2], y, _fmt_num(m.get('measured')))
        c.drawString(col_x[3], y, _fmt_num(m.get('deviation')))
        c.drawString(col_x[4], y, _fmt_num(m.get('tolerance_fail')))
        result = m.get('result', '')
        rc = _result_color(result.upper())
        c.setFillColorRGB(*rc)
        c.drawString(col_x[5], y, result.upper())
        c.setFillColorRGB(0, 0, 0)
        y -= 13
        if y < 80:
            break


def _draw_defects(c, record, w, h):
    _heading(c, 'Defects', h)
    defects = record.get('defects', [])
    if not defects:
        c.setFont('Helvetica', 12)
        c.drawString(72, h - 110, 'No defects detected.')
        return
    c.setFont('Helvetica', 10)
    y = h - 110
    for d in defects[:25]:
        line = (f'{d.get("defect_type", "?")} '
                f'at ({d["center_xyz"][0]:.1f}, '
                f'{d["center_xyz"][1]:.1f}, '
                f'{d["center_xyz"][2]:.1f}) — '
                f'dev {d.get("deviation_mm", 0):+.2f} mm, '
                f'extent {d.get("extent_mm", 0):.1f} mm, '
                f'{d.get("severity", "")}')
        c.drawString(72, y, line[:200])
        y -= 14
        if y < 80:
            break


def _draw_statistics(c, record, w, h):
    _heading(c, 'Statistical Summary', h)
    stats = record.get('statistics', {})
    if not stats:
        c.setFont('Helvetica', 12)
        c.drawString(72, h - 110, 'No statistics available.')
        return
    c.setFont('Helvetica', 11)
    y = h - 110
    for k in ('count', 'max', 'min', 'mean', 'rms', 'std',
              'p95', 'p99', 'percent_within_tolerance'):
        if k in stats:
            c.drawString(72, y, f'{k}: {_fmt_num(stats[k])}')
            y -= 16


def _draw_traceability(c, record, template, w, h):
    _heading(c, 'Traceability', h)
    meta = record.get('metadata', {})
    lines = [
        f'Inspection ID: {record.get("inspection_id", "")}',
        f'Robot serial: {meta.get("robot_serial", "")}',
        f'Camera serial: {meta.get("camera_serial", "")}',
        f'Camera calibration: {meta.get("camera_calibration", "")}',
        f'Reference SHA-256: {(record.get("reference_hash") or "")}',
        f'Software version: {meta.get("software_version", "")}',
        f'Operator: {meta.get("operator", "")}',
        f'Program: {meta.get("program", "")}',
    ]
    c.setFont('Helvetica', 10)
    y = h - 110
    for line in lines:
        c.drawString(72, y, line)
        y -= 16


def _heading(c, text, h):
    c.setFont('Helvetica-Bold', 18)
    c.drawString(72, h - 60, text)
    c.setLineWidth(0.5)
    c.line(72, h - 70, 540, h - 70)


def _fmt_num(v) -> str:
    if v is None:
        return '—'
    try:
        return f'{float(v):.3f}'
    except Exception:
        return str(v)


def _result_color(result: str) -> tuple[float, float, float]:
    """RGB 0..1 for the named result string."""
    r = result.upper()
    if r == 'PASS':
        return (0.13, 0.64, 0.27)
    if r == 'WARN':
        return (0.85, 0.65, 0.13)
    if r == 'FAIL':
        return (0.86, 0.15, 0.15)
    return (0.4, 0.4, 0.4)


def _write_stub_pdf(output_path: str, record: dict) -> str:
    """Minimal 'PDF' for environments without reportlab.

    Not a true PDF — a `.pdf` file with plain text. Means the dashboard
    download link still resolves; an operator who actually opens it
    sees a clear "install reportlab" message instead of a 500.
    """
    os.makedirs(os.path.dirname(output_path) or '.', exist_ok=True)
    body = (
        'Inspection report stub.\n\n'
        'reportlab is not installed on this host — only a text stub '
        'was generated.\n'
        'Install reportlab and re-run to get the full PDF.\n\n'
        f'inspection_id: {record.get("inspection_id")}\n'
        f'part_id:       {record.get("part_id")}\n'
        f'result:        {record.get("overall_result")}\n'
    )
    with open(output_path, 'w') as f:
        f.write(body)
    return output_path


# ─── Audit log helpers ──────────────────────────────────────────────────

def audit(action: str, who: str | None, details: dict | None = None) -> None:
    """Append an entry to the audit log. Used by config endpoints."""
    log = safe_load_json(AUDIT_LOG_FILE, [])
    log.append({
        'ts': time.time(),
        'action': action,
        'who': who,
        'details': details or {},
    })
    # Keep the log bounded — 50k entries is plenty for normal operation.
    if len(log) > 50_000:
        log = log[-50_000:]
    safe_dump_json(AUDIT_LOG_FILE, log)
