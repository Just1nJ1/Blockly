"""Shared rules for extension manifests.

Version 1 manifests stay valid. Version 2 adds dynamic fields and a runtime
adapter. The browser copy of these rules is js/extensions/manifestValidator.js.
"""

from __future__ import annotations

import os
import re
from typing import Any

HOST_EXTENSION_API = 1
SUPPORTED_MANIFEST_VERSIONS = (1, 2)
RESERVED_NAMES = frozenset({'blockly', 'core'})
PERMISSIONS = frozenset({'camera', 'microphone'})
NAME_RE = re.compile(r'^[a-z][a-z0-9_-]{1,63}$')
SEMVER_RE = re.compile(r'^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$')


def validate_manifest(manifest: Any, directory_name: str = '', root: str = '') -> dict:
    """Return ``{ok, errors, warnings, normalized}``."""
    errors = []
    warnings = []
    if not isinstance(manifest, dict):
        return {'ok': False, 'errors': ['Manifest must be a JSON object.'], 'warnings': [], 'normalized': None}

    version = manifest.get('manifestVersion', 1)
    if version is None:
        version = 1
    if not isinstance(version, int) or isinstance(version, bool) or version not in SUPPORTED_MANIFEST_VERSIONS:
        errors.append('Unsupported manifestVersion %r. Supported versions: 1, 2.' % (manifest.get('manifestVersion'),))
        version = 1

    name = manifest.get('name')
    if not isinstance(name, str) or not NAME_RE.match(name):
        errors.append('Extension name must match %s.' % NAME_RE.pattern)
        name = ''
    elif name in RESERVED_NAMES:
        errors.append('Extension name %r is reserved.' % name)
    if directory_name and name and directory_name != name:
        message = 'Directory %r does not match extension name %r.' % (directory_name, name)
        if version >= 2:
            errors.append(message)
        else:
            warnings.append(message)

    ext_api = manifest.get('extensionApiVersion', 1)
    if ext_api is None:
        ext_api = 1
    if not isinstance(ext_api, int) or isinstance(ext_api, bool) or ext_api < 1:
        errors.append('extensionApiVersion must be a positive integer.')
    elif ext_api > HOST_EXTENSION_API:
        errors.append(
            'Extension %s requires API version %s. This StudioX supports version %s.'
            % (name or directory_name or 'extension', ext_api, HOST_EXTENSION_API)
        )

    declared_version = manifest.get('version', '')
    if not isinstance(declared_version, str) or not SEMVER_RE.match(declared_version):
        message = 'Version %r is not SemVer (for example 1.2.3).' % (declared_version,)
        if version >= 2:
            errors.append(message)
        else:
            warnings.append(message)

    for perm in _permission_list(manifest):
        if perm not in PERMISSIONS:
            errors.append('Unknown permission %r on %s.' % (perm, name or directory_name or 'extension'))

    contributes = manifest.get('contributes') or {}
    if contributes and not isinstance(contributes, dict):
        errors.append('contributes must be an object.')
        contributes = {}

    if root and isinstance(contributes, dict):
        errors.extend(_check_paths(name or directory_name, root, contributes))
        errors.extend(_check_dynamic_fields(name, contributes.get('dynamicFields')))
    errors.extend(_check_python_dependencies(name or directory_name, manifest.get('pythonDependencies')))

    normalized = dict(manifest)
    normalized['manifestVersion'] = version
    normalized['extensionApiVersion'] = ext_api if isinstance(ext_api, int) and not isinstance(ext_api, bool) else 1
    return {
        'ok': not errors,
        'errors': errors,
        'warnings': warnings,
        'normalized': normalized,
    }


def contained_path(root: str, relative: str) -> str:
    """Absolute path inside ``root``, or '' when ``relative`` escapes it."""
    if not root or not isinstance(relative, str) or not relative:
        return ''
    if relative.startswith(('/', '\\')) or os.path.isabs(relative):
        return ''
    if '://' in relative or relative.startswith('//'):
        return ''
    parts = relative.replace('\\', '/').split('/')
    if any(part == '..' or part == '' for part in parts):
        return ''
    full = os.path.realpath(os.path.join(root, *parts))
    base = os.path.realpath(root)
    if full != base and not full.startswith(base + os.sep):
        return ''
    return full


def _permission_list(manifest: dict) -> list:
    raw = manifest.get('permissions') or []
    if isinstance(raw, str):
        return [raw]
    if not isinstance(raw, list):
        return ['<invalid>']
    return [item if isinstance(item, str) else '<invalid>' for item in raw]


def _check_paths(name: str, root: str, contributes: dict) -> list:
    errors = []
    backend = contributes.get('backend') or {}
    if isinstance(backend, dict) and backend.get('main'):
        if not contained_path(root, str(backend.get('main'))):
            errors.append('%s backend path escapes the extension directory.' % name)
    runtime = contributes.get('runtime') or {}
    if isinstance(runtime, dict) and runtime.get('python'):
        if not contained_path(root, str(runtime.get('python'))):
            errors.append('%s runtime path escapes the extension directory.' % name)
    blocks = contributes.get('blocks') or {}
    files = []
    if isinstance(blocks, dict):
        files = blocks.get('files') or blocks.get('definitions') or []
        if isinstance(blocks.get('file'), str):
            files = list(files) + [blocks.get('file')]
    elif isinstance(blocks, list):
        files = blocks
    elif isinstance(blocks, str):
        files = [blocks]
    if not isinstance(files, list):
        errors.append('%s block files must be a list of relative paths.' % name)
        files = []
    for rel in files:
        if not contained_path(root, str(rel)):
            errors.append('%s block file %r escapes the extension directory.' % (name, rel))
    window = contributes.get('window') or {}
    if isinstance(window, dict):
        for key in ('html', 'js', 'css'):
            if window.get(key) and not contained_path(root, str(window.get(key))):
                errors.append('%s window %s escapes the extension directory.' % (name, key))
    return errors


def _check_dynamic_fields(name: str, fields: Any) -> list:
    if fields is None:
        return []
    if not isinstance(fields, dict):
        return ['%s dynamicFields must be an object.' % (name or 'extension')]
    errors = []
    allowed = {
        'kind', 'path', 'refreshPath', 'itemsKey', 'labelKey', 'valueKey',
        'refresh', 'cacheMs',
    }
    for provider_id, spec in fields.items():
        if not isinstance(provider_id, str) or not NAME_RE.match(provider_id):
            errors.append('%s has an invalid dynamic field id %r.' % (name, provider_id))
            continue
        if not isinstance(spec, dict):
            errors.append('%s field %s must be an object.' % (name, provider_id))
            continue
        extra = set(spec) - allowed
        if extra:
            errors.append('%s field %s has unknown keys: %s.' % (name, provider_id, ', '.join(sorted(extra))))
        if spec.get('kind') not in (None, 'httpOptions'):
            errors.append('%s field %s kind must be httpOptions.' % (name, provider_id))
        for key in ('path', 'refreshPath'):
            value = spec.get(key)
            if value is None:
                continue
            if not _safe_http_path(value):
                errors.append('%s field %s %s must be a relative extension path.' % (name, provider_id, key))
        if spec.get('refresh') not in (None, 'onOpen', 'explicit'):
            errors.append('%s field %s refresh must be onOpen or explicit.' % (name, provider_id))
    return errors


def blockly_requirement_lines(manifest: Any) -> list:
    """Requirement lines declared for the Blockly environment, or []."""
    if not isinstance(manifest, dict):
        return []
    spec = manifest.get('pythonDependencies')
    if not isinstance(spec, dict):
        return []
    raw = spec.get('blockly') or []
    if not isinstance(raw, list):
        return []
    lines = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            lines.append(item.strip())
    return lines


def _check_python_dependencies(name: str, spec: Any) -> list:
    if spec is None:
        return []
    label = name or 'extension'
    if not isinstance(spec, dict):
        return ['%s pythonDependencies must be an object.' % label]
    errors = []
    for key in spec:
        if key != 'blockly':
            errors.append(
                '%s pythonDependencies key %r is not supported. Use "blockly" for the Blockly environment.'
                % (label, key)
            )
    raw = spec.get('blockly')
    if raw is None:
        return errors
    if not isinstance(raw, list):
        errors.append('%s pythonDependencies.blockly must be a list of requirement strings.' % label)
        return errors
    for item in raw:
        if not isinstance(item, str) or not item.strip():
            errors.append('%s pythonDependencies.blockly entries must be requirement strings.' % label)
            continue
        message = _requirement_line_error(item.strip())
        if message:
            errors.append('%s pythonDependencies.blockly: %s' % (label, message))
    return errors


def _requirement_line_error(line: str) -> str:
    from .req_resolve import ResolveError, _spec_parts, parse_requirement_line

    if '://' in line or 'git+' in line or '@' in line or line.startswith('-'):
        return 'requirement %r must be a package name and version, not a URL or pip option.' % line
    try:
        parsed = parse_requirement_line(line)
    except ResolveError as exc:
        return str(exc)
    if parsed is None:
        return 'requirement %r is empty.' % line
    _name, specifier, _marker = parsed
    try:
        _spec_parts(specifier)
    except ResolveError as exc:
        return str(exc)
    return ''


def _safe_http_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith('/') or value.startswith('//'):
        return False
    if '://' in value or '\\' in value or '..' in value.split('/'):
        return False
    return True
