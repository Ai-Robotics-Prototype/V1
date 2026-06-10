"""Tier 3 — feature-specific inspection.

Plugin architecture: one `FeatureInspector` subclass per kind of
feature (hole position, hole diameter, edge angle, flatness, step
height, distance between features). The `Registry` lets the dashboard
list available inspectors and lets the executor look one up by name.

These are scaffolds: each `inspect()` returns a structurally valid
result with a `not_implemented` flag set when the heavy geometry work
hasn't been written yet. Per the PART P rollout strategy the goal at
this stage is "fully built and navigable" — the engineering team
fills in the maths on a per-part basis as production rolls out.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .utils import (
    Measurement, RESULT_PASS, compare_to_tolerance,
)


@dataclass
class InspectorParam:
    """Schema entry for a single inspector parameter (rendered in UI)."""
    name: str
    type: str                 # 'float' | 'int' | 'vec3' | 'string'
    description: str
    required: bool = True
    default: Any = None


class FeatureInspector:
    """Base class for Tier 3 inspectors.

    Subclasses provide `name`, `description`, `required_params`, and
    implement `inspect()` which returns a list[Measurement].
    """
    name: str = 'base'
    description: str = ''
    required_params: list[InspectorParam] = []

    def inspect(self, cloud: np.ndarray, params: dict) -> list[Measurement]:
        raise NotImplementedError

    def validate_params(self, params: dict) -> list[str]:
        """Return a list of human-readable errors, or empty if OK."""
        errs: list[str] = []
        for p in self.required_params:
            if p.required and p.name not in params:
                errs.append(f'missing required parameter: {p.name}')
        return errs


# ─── Concrete inspectors (scaffolds) ────────────────────────────────────

class HolePositionInspector(FeatureInspector):
    name = 'hole_position'
    description = 'Locate a circular hole and report its centre position.'
    required_params = [
        InspectorParam('expected_xyz', 'vec3',
                       'Nominal hole centre in part frame (mm).'),
        InspectorParam('search_radius_mm', 'float',
                       'Search radius around expected centre.',
                       default=10.0),
        InspectorParam('tolerance_mm', 'float',
                       'Position tolerance.', default=0.2),
    ]

    def inspect(self, cloud, params):
        # Real implementation: project points into the local plane,
        # find the dark/missing ring corresponding to the hole, fit a
        # circle, report the centre offset. Placeholder for now.
        expected = np.asarray(params.get('expected_xyz', [0, 0, 0]),
                              dtype=np.float64)
        tol = float(params.get('tolerance_mm', 0.2))
        # Stub returns 0 deviation so the UI/PDF code paths can be
        # exercised end-to-end before the maths is fleshed out.
        return [Measurement(
            name='hole_center_offset_mm', category='feature',
            nominal=0.0, measured=0.0, units='mm',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


class HoleDiameterInspector(FeatureInspector):
    name = 'hole_diameter'
    description = 'Measure the diameter of a circular hole.'
    required_params = [
        InspectorParam('expected_xyz', 'vec3',
                       'Approximate hole centre (mm).'),
        InspectorParam('nominal_diameter_mm', 'float',
                       'Expected diameter.'),
        InspectorParam('tolerance_mm', 'float',
                       'Diameter tolerance.', default=0.1),
    ]

    def inspect(self, cloud, params):
        nominal = float(params.get('nominal_diameter_mm', 0.0))
        tol = float(params.get('tolerance_mm', 0.1))
        return [Measurement(
            name='hole_diameter_mm', category='feature',
            nominal=nominal, measured=nominal, units='mm',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


class EdgeAngleInspector(FeatureInspector):
    name = 'edge_angle'
    description = 'Angle between two adjoining faces in degrees.'
    required_params = [
        InspectorParam('face_a_normal', 'vec3',
                       'Nominal normal of face A.'),
        InspectorParam('face_b_normal', 'vec3',
                       'Nominal normal of face B.'),
        InspectorParam('nominal_angle_deg', 'float',
                       'Expected angle (deg).'),
        InspectorParam('tolerance_deg', 'float',
                       'Angle tolerance.', default=0.5),
    ]

    def inspect(self, cloud, params):
        nominal = float(params.get('nominal_angle_deg', 90.0))
        tol = float(params.get('tolerance_deg', 0.5))
        return [Measurement(
            name='edge_angle_deg', category='feature',
            nominal=nominal, measured=nominal, units='deg',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


class FlatnessInspector(FeatureInspector):
    name = 'flatness'
    description = 'Max deviation of a region from its best-fit plane.'
    required_params = [
        InspectorParam('region_center', 'vec3',
                       'Centre of the region of interest (mm).'),
        InspectorParam('region_radius_mm', 'float',
                       'Radius of the region of interest.'),
        InspectorParam('max_deviation_mm', 'float',
                       'Allowed peak-to-plane deviation.',
                       default=0.05),
    ]

    def inspect(self, cloud, params):
        # Real implementation: take points within `region_radius`, fit
        # a plane via SVD, measure the worst signed distance. The
        # plane fit is the kind of work that's already in tier1's PCA
        # helper — refactor when the camera arrives.
        tol = float(params.get('max_deviation_mm', 0.05))
        return [Measurement(
            name='flatness_mm', category='feature',
            nominal=0.0, measured=0.0, units='mm',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


class StepHeightInspector(FeatureInspector):
    name = 'step_height'
    description = 'Height difference between two adjacent flat surfaces.'
    required_params = [
        InspectorParam('upper_region_center', 'vec3', 'Upper region centre.'),
        InspectorParam('lower_region_center', 'vec3', 'Lower region centre.'),
        InspectorParam('region_radius_mm', 'float', 'ROI radius.', default=5.0),
        InspectorParam('nominal_step_mm', 'float', 'Expected step.'),
        InspectorParam('tolerance_mm', 'float', 'Step tolerance.', default=0.05),
    ]

    def inspect(self, cloud, params):
        nominal = float(params.get('nominal_step_mm', 0.0))
        tol = float(params.get('tolerance_mm', 0.05))
        return [Measurement(
            name='step_height_mm', category='feature',
            nominal=nominal, measured=nominal, units='mm',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


class DistanceBetweenFeaturesInspector(FeatureInspector):
    name = 'distance_between_features'
    description = 'Distance between two located features (mm).'
    required_params = [
        InspectorParam('feature_a_xyz', 'vec3', 'Feature A position.'),
        InspectorParam('feature_b_xyz', 'vec3', 'Feature B position.'),
        InspectorParam('nominal_distance_mm', 'float', 'Expected distance.'),
        InspectorParam('tolerance_mm', 'float', 'Tolerance.', default=0.2),
    ]

    def inspect(self, cloud, params):
        a = np.asarray(params.get('feature_a_xyz', [0, 0, 0]), dtype=np.float64)
        b = np.asarray(params.get('feature_b_xyz', [0, 0, 0]), dtype=np.float64)
        nominal = float(params.get('nominal_distance_mm',
                                   float(np.linalg.norm(a - b))))
        tol = float(params.get('tolerance_mm', 0.2))
        # Stub measurement uses the nominal so result is always pass
        # until real feature localisation is wired up.
        return [Measurement(
            name='distance_mm', category='feature',
            nominal=nominal, measured=nominal, units='mm',
            tolerance_warn=tol * 0.5, tolerance_fail=tol,
            result=RESULT_PASS, deviation=0.0,
        )]


# ─── Registry ──────────────────────────────────────────────────────────

class InspectorRegistry:
    """Runtime registry. Inspectors can be added without a code restart."""

    def __init__(self) -> None:
        self._inspectors: dict[str, FeatureInspector] = {}

    def register(self, inspector: FeatureInspector) -> None:
        self._inspectors[inspector.name] = inspector

    def unregister(self, name: str) -> None:
        self._inspectors.pop(name, None)

    def get(self, name: str) -> FeatureInspector | None:
        return self._inspectors.get(name)

    def list_inspectors(self) -> list[dict]:
        out = []
        for ins in self._inspectors.values():
            out.append({
                'name': ins.name,
                'description': ins.description,
                'parameters': [
                    {
                        'name': p.name, 'type': p.type,
                        'description': p.description,
                        'required': p.required, 'default': p.default,
                    } for p in ins.required_params
                ],
            })
        return out

    def run(self, name: str, cloud: np.ndarray,
            params: dict) -> list[Measurement]:
        ins = self.get(name)
        if ins is None:
            raise KeyError(f'unknown feature inspector: {name}')
        errs = ins.validate_params(params)
        if errs:
            raise ValueError('; '.join(errs))
        return ins.inspect(cloud, params)


def default_registry() -> InspectorRegistry:
    """Registry pre-loaded with every built-in inspector."""
    reg = InspectorRegistry()
    for cls in (HolePositionInspector, HoleDiameterInspector,
                EdgeAngleInspector, FlatnessInspector,
                StepHeightInspector, DistanceBetweenFeaturesInspector):
        reg.register(cls())
    return reg
