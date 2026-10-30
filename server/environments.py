"""
Environment manager for StudioX.

Creates and manages Python virtual environments under
~/.wlkata-studiox/environments/ for:

  * **Extensions** — one venv per extension name. An extension that lists
    ``depends`` does not reinstall those libraries; at runtime the dependency
    environment's site-packages are added to its ``sys.path``. Base packages
    flask/flask-cors for backends.
  * **Blockly** — a single reserved env named ``blockly`` used when the user
    runs Blockly-generated code (import blocks). Packages installed there are
    visible to ``import`` during Run / Debug.

Package conflicts:
  * Extension A vs Extension B: none — separate venvs / subprocesses.
  * Two packages in the *same* env (Blockly or one extension): pip resolves at
    install time; the last successful install wins. Incompatible pins fail the
    install with pip's error message.
"""

import os
import sys
import re
import json
import shutil
import subprocess
import tempfile
import urllib.request
import urllib.parse
import glob as _glob


_ENVS_BASE = os.path.join(os.path.expanduser('~'), '.wlkata-studiox', 'environments')
_BASE_PACKAGES = ['flask', 'flask-cors']

# Reserved environment for Blockly Run / Debug / import blocks.
# Not used by extension backends (those use envs named after the extension).
BLOCKLY_ENV_NAME = 'blockly'

# Packages that should never be auto-removed as orphan dependencies.
# Includes base packages and their core transitive dependencies.
_PROTECTED_PACKAGES = frozenset({
    'pip', 'setuptools', 'wheel',
    'flask', 'flask_cors',
    'werkzeug', 'jinja2', 'markupsafe', 'click', 'blinker', 'itsdangerous',
})


def _normalize_pkg_name(name):
    """Normalize a package name for comparison (PEP 503)."""
    return re.sub(r'[-_.]+', '_', name).lower()


def _parse_pip_show(pip, env, package):
    """Run ``pip show`` and return the Requires / Required-by lists."""
    try:
        output = subprocess.check_output(
            [pip, 'show', package],
            env=env, timeout=15, stderr=subprocess.PIPE, text=True,
        )
        requires = []
        required_by = []
        for line in output.splitlines():
            if line.startswith('Requires:'):
                val = line.split(':', 1)[1].strip()
                if val:
                    requires = [r.strip() for r in val.split(',')]
            elif line.startswith('Required-by:'):
                val = line.split(':', 1)[1].strip()
                if val:
                    required_by = [r.strip() for r in val.split(',')]
        return {'requires': requires, 'required_by': required_by}
    except Exception:
        return {'requires': [], 'required_by': []}


def _collect_orphan_deps(pip, env, initial_deps):
    """Remove orphaned dependencies one-by-one, recursing into sub-deps.

    After the target package has already been uninstalled, walk its former
    dependency list.  For each dep that is no longer required by any other
    installed package *and* is not protected, uninstall it and recurse into
    its own dependencies.

    Returns a list of package names that were successfully removed.
    """
    removed = []
    queue = list(initial_deps)
    seen = set()

    while queue:
        pkg = queue.pop(0)
        norm = _normalize_pkg_name(pkg)
        if norm in seen or norm in _PROTECTED_PACKAGES:
            continue
        seen.add(norm)

        info = _parse_pip_show(pip, env, pkg)
        if info['required_by']:
            continue  # still needed by another package

        sub_deps = info['requires']

        try:
            result = subprocess.run(
                [pip, 'uninstall', '-y', pkg],
                env=env, capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0:
                removed.append(pkg)
                queue.extend(sub_deps)
        except Exception:
            pass

    return removed


def _find_uv():
    """Locate uv next to this interpreter, or anywhere on PATH."""
    base = os.path.dirname(sys.executable)
    for candidate in [
        os.path.join(base, 'uv'),
        os.path.join(base, 'uv.exe'),
        os.path.join(base, 'Scripts', 'uv.exe'),
        os.path.join(base, 'Scripts', 'uv'),
    ]:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return shutil.which('uv')


def _ensure_base_dir():
    os.makedirs(_ENVS_BASE, exist_ok=True)


def _clean_env():
    """Return a copy of os.environ without embedded-Python variables
    that interfere with venv creation and pip operations."""
    env = os.environ.copy()
    for key in ('PYTHONHOME', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE'):
        env.pop(key, None)
    return env


def _find_pip(env_dir):
    if sys.platform == 'win32':
        pip = os.path.join(env_dir, 'Scripts', 'pip.exe')
    else:
        pip = os.path.join(env_dir, 'bin', 'pip')
    return pip if os.path.isfile(pip) else None


def _find_python(env_dir):
    if sys.platform == 'win32':
        py = os.path.join(env_dir, 'Scripts', 'python.exe')
    else:
        py = os.path.join(env_dir, 'bin', 'python')
    return py if os.path.isfile(py) else None


def get_site_packages(env_name_or_dir):
    """
    Return the site-packages directory for an environment name or path.
    Works for Windows (Lib/site-packages) and Unix (lib/pythonX.Y/site-packages).
    """
    env_dir = env_name_or_dir
    if not os.path.isdir(env_dir) or not os.path.isabs(env_dir):
        env_dir = os.path.join(_ENVS_BASE, env_name_or_dir)
    if not os.path.isdir(env_dir):
        return None

    if sys.platform == 'win32':
        sp = os.path.join(env_dir, 'Lib', 'site-packages')
        return sp if os.path.isdir(sp) else None

    matches = sorted(_glob.glob(os.path.join(env_dir, 'lib', 'python*', 'site-packages')))
    for sp in matches:
        if os.path.isdir(sp):
            return sp
    return None


def is_blockly_env(name):
    return name == BLOCKLY_ENV_NAME


def get_blockly_env_name():
    return BLOCKLY_ENV_NAME


def get_blockly_site_packages():
    """site-packages for the Blockly env, or None if missing/invalid."""
    return get_site_packages(BLOCKLY_ENV_NAME)


def ensure_blockly_environment():
    """
    Ensure the reserved ``blockly`` venv exists (create if needed).
    Does not install flask (not required for Blockly Run).
    """
    _ensure_base_dir()
    env_dir = os.path.join(_ENVS_BASE, BLOCKLY_ENV_NAME)
    if os.path.isdir(env_dir) and _find_pip(env_dir):
        return {
            'success': True,
            'path': env_dir,
            'created': False,
            'name': BLOCKLY_ENV_NAME,
            'site_packages': get_site_packages(env_dir),
        }

    result = create_environment(
        BLOCKLY_ENV_NAME,
        install_base_packages=False,
    )
    if result.get('success'):
        result['created'] = True
        result['name'] = BLOCKLY_ENV_NAME
        result['site_packages'] = get_site_packages(BLOCKLY_ENV_NAME)
    return result


def get_envs_base():
    _ensure_base_dir()
    return _ENVS_BASE


def list_environments():
    _ensure_base_dir()
    # Always try to present the Blockly env (create lazily so UI can show it)
    try:
        ensure_blockly_environment()
    except Exception:
        pass

    envs = []
    for name in sorted(os.listdir(_ENVS_BASE)):
        env_dir = os.path.join(_ENVS_BASE, name)
        if not os.path.isdir(env_dir):
            continue
        role = 'blockly' if is_blockly_env(name) else 'custom'
        # Extension envs are conventionally named after the extension
        if role != 'blockly':
            # Heuristic only for UI badge — still a normal env
            role = 'environment'
        envs.append({
            'name': name,
            'path': env_dir,
            'valid': _find_pip(env_dir) is not None,
            'role': role,
            'is_blockly': is_blockly_env(name),
            'site_packages': get_site_packages(env_dir),
        })
    return envs


def create_environment(name, python_version=None, install_base_packages=True):
    _ensure_base_dir()

    if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$', name):
        return {'success': False,
                'error': 'Invalid name. Use letters, numbers, hyphens, '
                         'and underscores. Must start with a letter or number.'}

    env_dir = os.path.join(_ENVS_BASE, name)
    if os.path.exists(env_dir):
        return {'success': False, 'error': f'Environment "{name}" already exists'}

    uv = _find_uv()
    # An explicit Python version needs uv to download it. The default
    # interpreter can still create a venv with the standard library.
    if python_version and not uv:
        return {'success': False,
                'error': 'uv was not found, so another Python version cannot be downloaded. '
                         'Install uv, or leave the Python version empty to use the app interpreter.'}

    if uv:
        cmd = [uv, 'venv', '--seed', '--python', python_version or sys.executable, env_dir]
    else:
        cmd = [sys.executable, '-m', 'venv', env_dir]

    env = _clean_env()
    try:
        subprocess.check_call(
            cmd, env=env, timeout=300,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as e:
        stderr = ''
        if e.stderr:
            stderr = e.stderr if isinstance(e.stderr, str) else e.stderr.decode()
        if os.path.exists(env_dir):
            shutil.rmtree(env_dir, ignore_errors=True)
        return {'success': False,
                'error': f'Failed to create environment: {stderr or e}'}
    except Exception as e:
        if os.path.exists(env_dir):
            shutil.rmtree(env_dir, ignore_errors=True)
        return {'success': False, 'error': f'Failed to create environment: {e}'}

    pip = _find_pip(env_dir)
    warning = None
    if pip and install_base_packages:
        try:
            subprocess.check_call(
                [pip, 'install', '--quiet'] + _BASE_PACKAGES,
                env=env, timeout=300,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        except Exception as e:
            warning = f'Created, but base packages failed to install: {e}'

    result = {
        'success': True,
        'path': env_dir,
        'is_blockly': is_blockly_env(name),
        'site_packages': get_site_packages(env_dir),
    }
    if warning:
        result['warning'] = warning
    return result


def delete_environment(name):
    env_dir = os.path.join(_ENVS_BASE, name)
    if not os.path.isdir(env_dir):
        return {'success': False, 'error': 'Environment not found'}
    try:
        shutil.rmtree(env_dir)
        # Recreate empty Blockly env so Run still has a target
        if is_blockly_env(name):
            ensure_blockly_environment()
            return {
                'success': True,
                'recreated_blockly': True,
                'message': 'Blockly environment reset (recreated empty).',
            }
        return {'success': True}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def list_packages(env_name):
    env_dir = os.path.join(_ENVS_BASE, env_name)
    pip = _find_pip(env_dir)
    if not pip:
        return {'success': False, 'error': 'Environment not found or invalid'}

    env = _clean_env()
    try:
        output = subprocess.check_output(
            [pip, 'list', '--format=json'],
            env=env, timeout=30, stderr=subprocess.PIPE, text=True,
        )
        return {'success': True, 'packages': json.loads(output)}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def install_package(env_name, package, version=None, extra_index_url=None):
    env_dir = os.path.join(_ENVS_BASE, env_name)
    pip = _find_pip(env_dir)
    if not pip:
        return {'success': False, 'error': 'Environment not found or invalid'}

    pkg_spec = f'{package}=={version}' if version else package
    cmd = [pip, 'install', pkg_spec]
    if extra_index_url:
        cmd += ['--extra-index-url', extra_index_url]

    env = _clean_env()
    try:
        result = subprocess.run(
            cmd, env=env, capture_output=True, text=True, timeout=300,
        )
        if result.returncode == 0:
            return {'success': True, 'output': result.stdout}
        return {'success': False, 'error': result.stderr or result.stdout}
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Installation timed out (5 min)'}
    except Exception as e:
        return {'success': False, 'error': str(e)}


def uninstall_package(env_name, package, remove_deps=False):
    env_dir = os.path.join(_ENVS_BASE, env_name)
    pip = _find_pip(env_dir)
    if not pip:
        return {'success': False, 'error': 'Environment not found or invalid'}

    env = _clean_env()

    # Collect the target's dependencies before removing it.
    deps_to_check = []
    if remove_deps:
        info = _parse_pip_show(pip, env, package)
        deps_to_check = info.get('requires', [])

    try:
        result = subprocess.run(
            [pip, 'uninstall', '-y', package],
            env=env, capture_output=True, text=True, timeout=60,
        )
        if result.returncode != 0:
            return {'success': False, 'error': result.stderr or result.stdout}
    except Exception as e:
        return {'success': False, 'error': str(e)}

    removed = [package]

    # Walk former dependencies and remove any that are now orphaned.
    if remove_deps and deps_to_check:
        orphans = _collect_orphan_deps(pip, env, deps_to_check)
        removed.extend(orphans)

    return {'success': True, 'removed': removed}


def _install_requirements_direct(env_name, requirements_text):
    """Install packages from requirements.txt content using ``pip install -r``."""
    env_dir = os.path.join(_ENVS_BASE, env_name)
    pip = _find_pip(env_dir)
    if not pip:
        return {'success': False, 'error': 'Environment not found or invalid'}

    fd, req_path = tempfile.mkstemp(suffix='.txt', prefix='req_')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(requirements_text)

        env = _clean_env()
        result = subprocess.run(
            [pip, 'install', '-r', req_path],
            env=env, capture_output=True, text=True, timeout=600,
        )
        if result.returncode == 0:
            return {'success': True, 'output': result.stdout, 'log': []}
        return {'success': False, 'error': result.stderr or result.stdout, 'log': []}
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Installation timed out (10 min)', 'log': []}
    except Exception as e:
        return {'success': False, 'error': str(e), 'log': []}
    finally:
        try:
            os.unlink(req_path)
        except OSError:
            pass


def _provided_from_envs(env_names, target_env):
    """Packages visible from dependency envs, then packages already in target.

    Dependency versions win when both have the same package, so a copy that
    was previously installed into the extension env cannot hide the shared one.
    """
    provided = {}
    log = []
    for env_name in env_names:
        listed = list_packages(env_name)
        if not listed.get('success'):
            log.append('%s has no package list (%s)' % (
                env_name, listed.get('error') or 'environment missing'))
            continue
        for pkg in listed.get('packages') or []:
            norm = _normalize_pkg_name(pkg.get('name') or '')
            if not norm or norm in provided:
                continue
            provided[norm] = {
                'name': pkg.get('name') or norm,
                'version': str(pkg.get('version') or ''),
                'env': env_name,
                'shared': True,
            }
    own = list_packages(target_env)
    if own.get('success'):
        for pkg in own.get('packages') or []:
            norm = _normalize_pkg_name(pkg.get('name') or '')
            if not norm or norm in provided:
                continue
            provided[norm] = {
                'name': pkg.get('name') or norm,
                'version': str(pkg.get('version') or ''),
                'env': target_env,
                'shared': False,
            }
    return provided, log


_PYPI_CACHE = {}


def _pypi_json(url):
    if url in _PYPI_CACHE:
        return _PYPI_CACHE[url]
    req = urllib.request.Request(url, headers={'User-Agent': 'WLKATA-StudioX'})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode())
    _PYPI_CACHE[url] = data
    return data


def _pypi_versions(name):
    quoted = urllib.parse.quote(name)
    data = _pypi_json('https://pypi.org/pypi/%s/json' % quoted)
    versions = []
    for version, files in (data.get('releases') or {}).items():
        if not files:
            continue
        if all(item.get('yanked') for item in files):
            continue
        versions.append(version)
    return versions


def _pypi_requires(name, version):
    quoted = urllib.parse.quote(name)
    ver = urllib.parse.quote(version)
    data = _pypi_json('https://pypi.org/pypi/%s/%s/json' % (quoted, ver))
    return (data.get('info') or {}).get('requires_dist') or []


def _pip_install_exact(pip, name, version):
    env = _clean_env()
    result = subprocess.run(
        [pip, 'install', '--disable-pip-version-check',
         '%s==%s' % (name, version), '--no-deps'],
        env=env, capture_output=True, text=True, timeout=600,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or 'pip install failed').strip()
        raise RuntimeError(detail)


def requirements_not_satisfied(env_name, requirements_text):
    """Requirement lines whose installed version is missing or too old.

    Packages that already match are listed in ``satisfied`` and are not
    returned for installation. A missing environment is an error, not a
    request to install into the application Python.
    """
    from .req_resolve import ResolveError, marker_applies, parse_requirement_line, version_satisfies

    listed = list_packages(env_name)
    if not listed.get('success'):
        return {
            'success': False,
            'error': listed.get('error') or 'Environment not found or invalid',
        }
    installed = {}
    for pkg in listed.get('packages') or []:
        norm = _normalize_pkg_name(pkg.get('name') or '')
        if norm:
            installed[norm] = str(pkg.get('version') or '')
    missing = []
    satisfied = []
    try:
        for raw in str(requirements_text or '').splitlines():
            parsed = parse_requirement_line(raw)
            if parsed is None:
                continue
            name, specifier, marker = parsed
            if not marker_applies(marker):
                continue
            current = installed.get(_normalize_pkg_name(name))
            if current and version_satisfies(current, specifier):
                satisfied.append('%s %s' % (name, current))
                continue
            missing.append(raw.split('#', 1)[0].strip())
    except ResolveError as exc:
        return {'success': False, 'error': str(exc)}
    return {'success': True, 'missing': missing, 'satisfied': satisfied}


def install_requirements(env_name, requirements_text, share_from=None, only_missing=False):
    """Install requirements into ``env_name``.

    Without ``share_from``, this is a normal ``pip install -r``.
    ``only_missing`` skips lines the environment already satisfies and does
    not remove packages that are too new or shared with another extension.
    With dependency environment names, packages those environments already
    provide are reused. Each other package is pinned to a release whose
    own requirements match those installed versions and this file.
    """
    if not share_from:
        if only_missing:
            checked = requirements_not_satisfied(env_name, requirements_text)
            if not checked.get('success'):
                return checked
            log = ['Already satisfied: %s' % item for item in checked.get('satisfied') or []]
            if not checked.get('missing'):
                return {
                    'success': True,
                    'installed': [],
                    'skipped': checked.get('satisfied') or [],
                    'log': log,
                    'output': '\n'.join(log),
                }
            result = _install_requirements_direct(env_name, '\n'.join(checked['missing']))
            result['log'] = log + list(result.get('log') or [])
            result['skipped'] = checked.get('satisfied') or []
            if result.get('success'):
                result['installed'] = list(checked['missing'])
                result['log'].append('Installed ' + ', '.join(checked['missing']))
            return result
        return _install_requirements_direct(env_name, requirements_text)

    from .req_resolve import ResolveError, plan_install

    env_dir = os.path.join(_ENVS_BASE, env_name)
    pip = _find_pip(env_dir)
    if not pip:
        return {'success': False, 'error': 'Environment not found or invalid', 'log': []}

    names = []
    for item in share_from:
        text = str(item or '').strip()
        if text and text not in names and text != env_name:
            names.append(text)

    provided, log = _provided_from_envs(names, env_name)
    try:
        actions = plan_install(
            requirements_text, provided, _pypi_versions, _pypi_requires)
    except ResolveError as exc:
        return {'success': False, 'error': str(exc), 'log': log}
    except Exception as exc:
        return {'success': False, 'error': 'Could not resolve packages: %s' % exc, 'log': log}

    installed = []
    try:
        for action in actions:
            if action['op'] == 'use':
                log.append('Using %s %s from %s' % (
                    action['name'], action['version'], action['env']))
                continue
            log.append('Installing %s==%s' % (action['name'], action['version']))
            _pip_install_exact(pip, action['name'], action['version'])
            installed.append('%s==%s' % (action['name'], action['version']))
    except Exception as exc:
        return {'success': False, 'error': str(exc), 'log': log, 'installed': installed}

    return {
        'success': True,
        'log': log,
        'installed': installed,
        'output': '\n'.join(log),
    }


def search_pypi(query):
    """Look up a package on PyPI by exact name."""
    try:
        url = f'https://pypi.org/pypi/{urllib.parse.quote(query)}/json'
        req = urllib.request.Request(url, headers={'User-Agent': 'WLKATA-StudioX'})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            info = data.get('info', {})
            all_versions = sorted(data.get('releases', {}).keys())
            versions = all_versions[-20:] if len(all_versions) > 20 else all_versions
            return {
                'success': True,
                'found': True,
                'name': info.get('name', query),
                'version': info.get('version', ''),
                'summary': info.get('summary', ''),
                'versions': versions,
            }
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {'success': True, 'found': False}
        return {'success': False, 'error': str(e)}
    except Exception as e:
        return {'success': False, 'error': str(e)}