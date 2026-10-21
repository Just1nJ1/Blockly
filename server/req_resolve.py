"""Pick package versions that satisfy a requirements line and packages
already installed in dependency environments.

The extension's own environment only receives packages it does not already
get from a dependency. A dependency package is never upgraded here: if the
newest release needs a newer OpenCV than Camera has, an older release that
still matches the requirement line is chosen instead.
"""

from __future__ import annotations

import ast
import os
import platform
import re
import sys


class ResolveError(Exception):
    pass


_PRE = {'a': 1, 'alpha': 1, 'b': 2, 'beta': 2, 'rc': 3, 'c': 3, 'preview': 3}


def _release_nums(version):
    text = version.strip().lower()
    if text.startswith('v'):
        text = text[1:]
    if '!' in text:
        text = text.split('!', 1)[1]
    if '+' in text:
        text = text.split('+', 1)[0]
    match = re.match(r'^(\d+(?:\.\d+)*)', text)
    if not match:
        return [0]
    nums = [int(part) for part in match.group(1).split('.')]
    while len(nums) < 8:
        nums.append(0)
    return nums


def _pre_key(version):
    text = version.strip().lower()
    if '+' in text:
        text = text.split('+', 1)[0]
    if '!' in text:
        text = text.split('!', 1)[1]
    match = re.search(r'(a|alpha|b|beta|rc|c|preview)(\d*)', text)
    dev = re.search(r'\.dev(\d+)', text)
    if match:
        pre_num = _PRE[match.group(1)]
        pre_seq = int(match.group(2) or 0)
    else:
        pre_num, pre_seq = 99, 0
    dev_num = int(dev.group(1)) if dev else 999999
    epoch = 0
    if '!' in version:
        epoch = int(version.split('!', 1)[0] or 0)
    return (epoch, _release_nums(version), pre_num, pre_seq, dev_num)


def version_key(version):
    try:
        return _pre_key(version)
    except Exception:
        return (0, [0], 0, 0, 0)


def _is_prerelease(version):
    text = version.lower()
    return bool(re.search(r'(a|alpha|b|beta|rc|c|preview|\.dev)', text))


def _cmp(left, right):
    a = version_key(left)
    b = version_key(right)
    return (a > b) - (a < b)


def _spec_parts(specifier):
    parts = []
    for chunk in (specifier or '').split(','):
        chunk = chunk.strip()
        if not chunk:
            continue
        match = re.match(r'^(===|==|!=|<=|>=|~=|<|>)\s*(.+)$', chunk)
        if not match:
            raise ResolveError('Unsupported version specifier "%s"' % chunk)
        parts.append((match.group(1), match.group(2).strip()))
    return parts


def _prefix_equal(version, want, keep):
    left = _release_nums(version)[:keep]
    right = _release_nums(want)[:keep]
    return left == right


def version_satisfies(version, specifier):
    """True when version matches a PEP 440 specifier set (comma means AND)."""
    if specifier is None or not str(specifier).strip():
        return True
    for op, want in _spec_parts(specifier):
        if op == '===':
            if version != want:
                return False
            continue
        if op == '==' and want.endswith('.*'):
            keep = len([p for p in want[:-2].split('.') if p != ''])
            if not _prefix_equal(version, want[:-2], keep):
                return False
            continue
        cmp = _cmp(version, want)
        if op == '==' and cmp != 0:
            return False
        if op == '!=' and cmp == 0:
            return False
        if op == '>' and cmp <= 0:
            return False
        if op == '<' and cmp >= 0:
            return False
        if op == '>=' and cmp < 0:
            return False
        if op == '<=' and cmp > 0:
            return False
        if op == '~=':
            nums = [p for p in want.split('+')[0].split('!')[-1].split('.') if p[:1].isdigit()]
            if len(nums) < 2 or _cmp(version, want) < 0:
                return False
            if not _prefix_equal(version, want, len(nums) - 1):
                return False
    return True


def parse_requirement_line(line):
    """Return (name, specifier, marker) or None for comments and blank lines."""
    text = line.split('#', 1)[0].strip()
    if not text or text.startswith('-') or text.startswith('.'):
        return None
    marker = ''
    if ';' in text:
        text, marker = text.split(';', 1)
        marker = marker.strip()
    match = re.match(
        r'^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$',
        text.strip(),
    )
    if not match:
        raise ResolveError('Could not parse requirement "%s"' % line.strip())
    return match.group(1), match.group(2).strip(), marker


def _marker_env():
    return {
        'python_version': '%d.%d' % sys.version_info[:2],
        'python_full_version': platform.python_version(),
        'sys_platform': sys.platform,
        'platform_system': platform.system(),
        'platform_machine': platform.machine(),
        'os_name': os.name,
        'implementation_name': sys.implementation.name,
    }


def marker_applies(marker):
    """Evaluate a requirement marker. Unknown markers keep the requirement."""
    if not marker or not marker.strip():
        return True
    if re.search(r'\bextra\b', marker):
        return False
    env = _marker_env()
    expr = marker
    for name, value in env.items():
        expr = re.sub(r'\b%s\b' % name, repr(value), expr)
    try:
        tree = ast.parse(expr, mode='eval')
    except SyntaxError:
        return True
    for node in ast.walk(tree):
        if isinstance(node, (ast.Call, ast.Attribute, ast.Subscript, ast.Name)):
            return True
    try:
        return bool(eval(compile(tree, '<marker>', 'eval'), {'__builtins__': {}}, {}))  # noqa: S307
    except Exception:
        return True


def parse_requires_dist(req):
    """Parse one requires_dist entry. None when it does not apply here."""
    parsed = parse_requirement_line(req)
    if not parsed:
        return None
    name, specifier, marker = parsed
    if not marker_applies(marker):
        return None
    return name, specifier


def choose_version(name, specifier, provided, versions, releases):
    """Newest version matching specifier whose shared deps fit `provided`.

    `provided` maps a normalized package name to
    ``{name, version, env, shared}``.
    `releases(version)` returns a list of requires_dist strings.
    """
    allow_pre = _is_prerelease(specifier or '')
    candidates = []
    for version in versions:
        if not allow_pre and _is_prerelease(version):
            continue
        try:
            ok = version_satisfies(version, specifier)
        except ResolveError:
            continue
        if ok:
            candidates.append(version)
    candidates.sort(key=version_key, reverse=True)

    newest_problem = None
    for version in candidates[:100]:
        pending = []
        used = []
        problem = None
        for raw in releases(version) or []:
            parsed = parse_requires_dist(raw)
            if not parsed:
                continue
            dep_name, dep_spec = parsed
            dep_norm = re.sub(r'[-_.]+', '_', dep_name).lower()
            info = provided.get(dep_norm)
            if info and info.get('shared') and not version_satisfies(info['version'], dep_spec):
                problem = (
                    '%s %s needs %s%s, but %s has %s %s'
                    % (name, version, dep_name, dep_spec and (' ' + dep_spec) or '',
                       info.get('env') or 'a dependency', info['name'], info['version'])
                )
                break
            if info and version_satisfies(info['version'], dep_spec):
                if info.get('shared'):
                    used.append(info)
                continue
            pending.append((dep_name, dep_spec))
        if problem:
            if newest_problem is None:
                newest_problem = problem
            continue
        return version, pending, used

    spec_text = (' ' + specifier) if specifier else ''
    if newest_problem:
        raise ResolveError(
            'No %s version satisfies %s%s. %s'
            % (name, name, spec_text, newest_problem)
        )
    raise ResolveError('No %s version satisfies %s%s' % (name, name, spec_text))


def plan_install(requirements_text, provided, versions_for, release_requires):
    """Return install actions. Shared packages are used, not installed again."""
    actions = []
    seen_logged = set()

    def install_one(name, specifier):
        norm = re.sub(r'[-_.]+', '_', name).lower()
        info = provided.get(norm)
        if info and version_satisfies(info['version'], specifier):
            if info.get('shared') and norm not in seen_logged:
                seen_logged.add(norm)
                actions.append({
                    'op': 'use',
                    'name': info['name'],
                    'version': info['version'],
                    'env': info.get('env') or '',
                })
            return
        if info and info.get('shared'):
            raise ResolveError(
                '%s requires %s%s, but %s has %s %s'
                % (name, info['name'], (' ' + specifier) if specifier else '',
                   info.get('env') or 'a dependency', info['name'], info['version'])
            )
        version, pending, used = choose_version(
            name, specifier, provided, versions_for(name),
            lambda ver, package=name: release_requires(package, ver),
        )
        for info in used:
            used_norm = re.sub(r'[-_.]+', '_', info['name']).lower()
            if used_norm in seen_logged:
                continue
            seen_logged.add(used_norm)
            actions.append({
                'op': 'use',
                'name': info['name'],
                'version': info['version'],
                'env': info.get('env') or '',
            })
        actions.append({'op': 'install', 'name': name, 'version': version})
        provided[norm] = {
            'name': name, 'version': version, 'env': '', 'shared': False,
        }
        for dep_name, dep_spec in pending:
            install_one(dep_name, dep_spec)

    for line in (requirements_text or '').splitlines():
        parsed = parse_requirement_line(line)
        if not parsed:
            continue
        name, specifier, marker = parsed
        if not marker_applies(marker):
            continue
        install_one(name, specifier)
    return actions
