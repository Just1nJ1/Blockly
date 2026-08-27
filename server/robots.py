"""
Loads the robot model definitions from robots.json.

robots.json is grouped by usage so each field's role is clear:

  identity   — canonical name, UI label, aliases
  library    — wlkatapython SDK class + simulator key (potential library use)
  firmware   — $V probe prefixes + GitHub .hex asset prefix
  blockly    — setup_robot dropdown value, virtual ports
  kinematics — axis count, joint/coord layouts (control panel, teaching, move blocks, IK/FK)
  viewer     — 3D URDF / meshes / TCP offset

On load, nested entries are normalized to a flat internal dict (plus the
original groups) so helpers and the GET /robots API stay easy to consume.
Legacy flat entries are still accepted.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Dict, List, Optional


def _find_robots_json() -> str:
    """Locate robots.json in dev and packaged layouts.

    Dev:          <repo>/robots.json  (parent of server/)
    Packaged:     <Resources>/robots.json  (extraResources, next to server/)
    Also accepts: server/robots.json, cwd, WLKATA_ROBOTS_JSON env override.
    """
    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    env = (os.environ.get('WLKATA_ROBOTS_JSON') or '').strip()
    candidates = [
        env,
        os.path.join(parent, 'robots.json'),
        os.path.join(here, 'robots.json'),
        os.path.join(os.getcwd(), 'robots.json'),
    ]
    for path in candidates:
        if path and os.path.isfile(path):
            return path
    tried = ', '.join(p for p in candidates if p) or '(none)'
    raise FileNotFoundError(
        f'robots.json not found (tried: {tried}). '
        'In packaged builds it must be listed under electron-builder extraResources.'
    )


_json_path = _find_robots_json()


def _as_dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def normalize_robot_entry(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Accept grouped or legacy-flat robots.json entries.
    Returns a flat convenience dict plus nested group copies.
    """
    if not isinstance(raw, dict):
        raise TypeError('robot entry must be an object')

    identity = _as_dict(raw.get('identity'))
    library = _as_dict(raw.get('library'))
    firmware = _as_dict(raw.get('firmware'))
    blockly = _as_dict(raw.get('blockly'))
    kinematics = _as_dict(raw.get('kinematics'))
    viewer = _as_dict(raw.get('viewer'))

    # Prefer nested groups; fall back to legacy top-level keys
    name = (
        identity.get('name')
        or raw.get('name')
        or raw.get('id')
        or ''
    )
    name = str(name).strip()
    if not name:
        raise ValueError('robot entry missing identity.name / name / id')

    label = identity.get('label') or raw.get('label') or name
    aliases = list(_as_list(identity.get('aliases') if 'aliases' in identity else raw.get('aliases')))

    sdk_class = library.get('sdkClass') or raw.get('sdkClass') or None
    sim_key = library.get('simKey') or raw.get('simKey') or name.lower()

    fw_prefix = firmware.get('fwPrefix') if 'fwPrefix' in firmware else raw.get('fwPrefix')
    fw_prefix = list(_as_list(fw_prefix))
    asset_prefix = (
        firmware.get('assetPrefix')
        or raw.get('firmwareAssetPrefix')
        or name
    )

    blockly_value = (
        blockly.get('value')
        or raw.get('blocklyValue')
        or sdk_class
        or (name + '_UART')
    )
    if not sdk_class:
        sdk_class = blockly_value
    virtual_port = blockly.get('virtualPort') if 'virtualPort' in blockly else raw.get('virtualPort')
    virtual_description = (
        blockly.get('virtualDescription')
        if 'virtualDescription' in blockly
        else raw.get('virtualDescription')
    )

    axis_count = kinematics.get('axisCount') if 'axisCount' in kinematics else raw.get('axisCount')
    try:
        axis_count = int(axis_count) if axis_count is not None else 6
    except (TypeError, ValueError):
        axis_count = 6
    joints = kinematics.get('joints') if 'joints' in kinematics else raw.get('joints')
    coords = kinematics.get('coords') if 'coords' in kinematics else raw.get('coords')
    joints = list(joints) if isinstance(joints, list) else []
    coords = list(coords) if isinstance(coords, list) else []

    # Re-assemble nested groups (canonical source shape for API clients that want it)
    groups = {
        'identity': {
            'name': name,
            'label': label,
            'aliases': aliases,
        },
        'library': {
            'sdkClass': sdk_class,
            'simKey': sim_key,
        },
        'firmware': {
            'fwPrefix': fw_prefix,
            'assetPrefix': asset_prefix,
        },
        'blockly': {
            'value': blockly_value,
            'virtualPort': virtual_port,
            'virtualDescription': virtual_description,
        },
        'kinematics': {
            'axisCount': axis_count,
            'joints': joints,
            'coords': coords,
        },
        'viewer': dict(viewer) if viewer else dict(_as_dict(raw.get('viewer'))),
    }

    # Flat convenience fields used throughout StudioX
    flat = {
        'id': raw.get('id') or name,
        'name': name,
        'label': label,
        'aliases': aliases,
        'sdkClass': sdk_class,
        'simKey': sim_key,
        'fwPrefix': fw_prefix,
        'firmwareAssetPrefix': asset_prefix,
        'blocklyValue': blockly_value,
        'virtualPort': virtual_port,
        'virtualDescription': virtual_description,
        'axisCount': axis_count,
        'joints': joints,
        'coords': coords,
        'viewer': groups['viewer'],
        # Nested groups (same data, organized by usage)
        'identity': groups['identity'],
        'library': groups['library'],
        'firmware': groups['firmware'],
        'blockly': groups['blockly'],
        'kinematics': groups['kinematics'],
    }
    return flat


with open(_json_path, 'r', encoding='utf-8') as f:
    _raw_robots = json.load(f)

if not isinstance(_raw_robots, list):
    raise ValueError('robots.json must be a JSON array')

ROBOTS: List[Dict[str, Any]] = [normalize_robot_entry(r) for r in _raw_robots]

# Lookup: firmware prefix → model name  (used by detector)
FW_PREFIX_MAP: Dict[str, str] = {}
for _r in ROBOTS:
    for _p in (_r.get('fwPrefix') or []):
        if _p:
            FW_PREFIX_MAP[str(_p)] = _r['name']

# name → robot dict
ROBOTS_BY_NAME: Dict[str, Dict[str, Any]] = {r['name']: r for r in ROBOTS if r.get('name')}

DEFAULT_MODEL_NAME = ROBOTS[0]['name'] if ROBOTS else 'Mirobot'


def get_robot(name: Optional[str]) -> Optional[Dict[str, Any]]:
    """Return robot definition by canonical name, or None."""
    if not name:
        return None
    return ROBOTS_BY_NAME.get(name)


def get_default_robot() -> Dict[str, Any]:
    if ROBOTS:
        return ROBOTS[0]
    return {
        'name': 'Mirobot',
        'blocklyValue': 'Mirobot_UART',
        'sdkClass': 'Mirobot_UART',
        'axisCount': 6,
    }


def normalize_model_name(raw: Optional[str]) -> Optional[str]:
    """
    Map setup_robot MODEL / constructor / alias string to canonical robots.json name.
    e.g. 'MT4_UART' → 'MT4', 'wlkatapython.Harobot_UART' → 'MT4', 'E4' → 'E4'
    """
    if raw is None:
        return None
    s = str(raw).strip()
    if not s:
        return None
    s = re.sub(r'^wlkatapython\.', '', s, flags=re.I)

    # Exact name
    if s in ROBOTS_BY_NAME:
        return s

    # Exact blocklyValue or alias (case-sensitive first)
    for r in ROBOTS:
        if s == r.get('blocklyValue'):
            return r['name']
        for a in (r.get('aliases') or []):
            if s == a:
                return r['name']

    # Case-insensitive name / blocklyValue / alias
    sl = s.lower()
    for r in ROBOTS:
        if sl == str(r.get('name', '')).lower():
            return r['name']
        if sl == str(r.get('blocklyValue', '')).lower():
            return r['name']
        for a in (r.get('aliases') or []):
            if sl == str(a).lower():
                return r['name']

    # Strip _UART / _USB and retry name / alias match
    base = re.sub(r'_UART$', '', s, flags=re.I)
    base = re.sub(r'_USB$', '', base, flags=re.I)
    if base in ROBOTS_BY_NAME:
        return base
    bl = base.lower()
    for r in ROBOTS:
        if bl == str(r.get('name', '')).lower():
            return r['name']
        if bl == str(r.get('blocklyValue', '')).lower().replace('_uart', ''):
            return r['name']
        for a in (r.get('aliases') or []):
            if bl == str(a).lower() or bl == str(a).lower().replace('_uart', ''):
                return r['name']

    # Substring heuristics (order: longer / more specific names first)
    ordered = sorted(ROBOTS, key=lambda r: -len(str(r.get('name', ''))))
    for r in ordered:
        n = str(r.get('name', ''))
        if n and re.search(r'\b' + re.escape(n) + r'\b', s, flags=re.I):
            return r['name']
        for a in (r.get('aliases') or []):
            if a and re.search(r'\b' + re.escape(str(a)) + r'\b', s, flags=re.I):
                return r['name']

    return base or s or None


def get_sdk_class_name(model: Optional[str]) -> str:
    r = get_robot(normalize_model_name(model) or '') or get_default_robot()
    return r.get('sdkClass') or (r.get('blocklyValue') or 'Mirobot_UART')


def get_axis_count(model: Optional[str]) -> int:
    r = get_robot(normalize_model_name(model) or '') or get_default_robot()
    try:
        return int(r.get('axisCount') or 6)
    except (TypeError, ValueError):
        return 6


def get_sim_key(model: Optional[str]) -> str:
    r = get_robot(normalize_model_name(model) or '') or get_default_robot()
    return r.get('simKey') or 'mirobot'


def get_firmware_asset_prefix(model: Optional[str]) -> str:
    r = get_robot(normalize_model_name(model) or '') or get_default_robot()
    return r.get('firmwareAssetPrefix') or r.get('name') or 'Mirobot'


def get_virtual_devices() -> List[Dict[str, str]]:
    """Entries for detector / UI: port, model, description."""
    out = []
    for r in ROBOTS:
        vp = r.get('virtualPort')
        if not vp:
            continue
        out.append({
            'port': vp,
            'model': r['name'],
            'description': r.get('virtualDescription') or ('Virtual ' + r['name'] + ' (SDK simulator)'),
        })
    return out


def get_virtual_port_set() -> set:
    return {d['port'] for d in get_virtual_devices()}


def get_sdk_class_names() -> List[str]:
    """All SDK UART class names for dry-run injection etc."""
    names = []
    seen = set()
    for r in ROBOTS:
        c = r.get('sdkClass') or r.get('blocklyValue')
        if c and c not in seen:
            seen.add(c)
            names.append(c)
    return names


def model_to_blockly_value(model: Optional[str]) -> str:
    r = get_robot(normalize_model_name(model) or '') or get_default_robot()
    return r.get('blocklyValue') or (r.get('name', 'Mirobot') + '_UART')
