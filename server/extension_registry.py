"""Enabled extensions and the block types each one owns.

The renderer keeps the same map in js/extensions/extensionRegistry.js.
A block type belongs to one extension. The first discovered directory wins
when two copies share an extension name.
"""

from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

from .manifest_schema import contained_path, validate_manifest

_records: Dict[str, dict] = {}
_block_owners: Dict[str, str] = {}


def clear() -> None:
    _records.clear()
    _block_owners.clear()


def records() -> Dict[str, dict]:
    return dict(_records)


def get(extension_id: str) -> Optional[dict]:
    return _records.get(extension_id)


def block_owner(block_type: str) -> Optional[str]:
    return _block_owners.get(block_type)


def block_owners() -> Dict[str, str]:
    return dict(_block_owners)


def set_enabled(extension_id: str, enabled: bool) -> None:
    """Remember a disabled extension. Startup still has to be restarted to unload it."""
    record = _records.get(extension_id)
    if record is not None:
        record['enabled'] = bool(enabled)


def discover(extensions_dirs: List[str]) -> dict:
    """Validate manifests. The earlier directory wins for a duplicate name."""
    clear()
    accepted = []
    rejected = []
    seen = set()
    for extensions_dir in extensions_dirs:
        if not extensions_dir or not os.path.isdir(extensions_dir):
            continue
        for entry in sorted(os.listdir(extensions_dir)):
            ext_dir = os.path.join(extensions_dir, entry)
            manifest_path = os.path.join(ext_dir, 'extension.json')
            if not os.path.isfile(manifest_path):
                continue
            try:
                with open(manifest_path, 'r', encoding='utf-8') as handle:
                    manifest = json.load(handle)
            except Exception as exc:
                rejected.append({
                    'id': entry,
                    'path': ext_dir,
                    'errors': ['Could not read extension.json: %s' % exc],
                })
                continue
            name = manifest.get('name') if isinstance(manifest, dict) else ''
            if name in seen:
                continue
            result = validate_manifest(manifest, directory_name=entry, root=ext_dir)
            if not result['ok']:
                rejected.append({
                    'id': name or entry,
                    'path': ext_dir,
                    'errors': result['errors'],
                })
                continue
            seen.add(name)
            record = _record(result['normalized'], ext_dir, result['warnings'])
            _records[name] = record
            accepted.append(record)
    return {'accepted': accepted, 'rejected': rejected}


def _record(manifest: dict, ext_dir: str, warnings: list) -> dict:
    contributes = manifest.get('contributes') if isinstance(manifest.get('contributes'), dict) else {}
    backend = contributes.get('backend') if isinstance(contributes.get('backend'), dict) else {}
    runtime = contributes.get('runtime') if isinstance(contributes.get('runtime'), dict) else {}
    fields = contributes.get('dynamicFields') if isinstance(contributes.get('dynamicFields'), dict) else {}
    block_types = _block_types(manifest['name'], ext_dir, contributes.get('blocks'))
    for block_type in block_types:
        owner = _block_owners.get(block_type)
        if owner and owner != manifest['name']:
            warnings = list(warnings) + [
                'Block type %s is already owned by %s.' % (block_type, owner)
            ]
        else:
            _block_owners[block_type] = manifest['name']
    return {
        'id': manifest['name'],
        'path': ext_dir,
        'manifest': manifest,
        'enabled': True,
        'warnings': list(warnings),
        'has_backend': bool(backend.get('main')),
        'runtime_python': runtime.get('python') or '',
        'dynamic_fields': fields,
        'block_types': block_types,
    }


def _block_types(extension_id: str, ext_dir: str, blocks) -> list:
    files = []
    if isinstance(blocks, dict):
        files = list(blocks.get('files') or blocks.get('definitions') or [])
        if isinstance(blocks.get('file'), str):
            files.append(blocks['file'])
    elif isinstance(blocks, list):
        files = list(blocks)
    elif isinstance(blocks, str):
        files = [blocks]
    found = []
    for rel in files:
        full = contained_path(ext_dir, str(rel))
        if not full or not os.path.isfile(full):
            continue
        try:
            with open(full, 'r', encoding='utf-8') as handle:
                data = json.load(handle)
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for item in data:
            if isinstance(item, dict) and isinstance(item.get('type'), str):
                found.append(item['type'])
    return found
