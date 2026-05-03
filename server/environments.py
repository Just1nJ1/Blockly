"""
Environment manager for StudioX.

Creates and manages Python virtual environments under
~/.wlkata-studiox/environments/ for use by extensions.
Each environment is a standard venv with base packages (flask, flask-cors)
pre-installed so extension backends can run immediately.
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


_ENVS_BASE = os.path.join(os.path.expanduser('~'), '.wlkata-studiox', 'environments')
_BASE_PACKAGES = ['flask', 'flask-cors']

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
    """Locate the uv binary (installed via pip as a project dependency)."""
    uv = shutil.which('uv')
    if uv:
        return uv
    # Fallback: check alongside the embedded Python (pip installs scripts there)
    base = os.path.dirname(sys.executable)
    for candidate in [
        os.path.join(base, 'uv'),
        os.path.join(base, 'uv.exe'),
        os.path.join(base, 'Scripts', 'uv.exe'),
        os.path.join(base, 'Scripts', 'uv'),
    ]:
        if os.path.isfile(candidate):
            return candidate
    return None


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


def get_envs_base():
    _ensure_base_dir()
    return _ENVS_BASE


def list_environments():
    _ensure_base_dir()
    envs = []
    for name in sorted(os.listdir(_ENVS_BASE)):
        env_dir = os.path.join(_ENVS_BASE, name)
        if not os.path.isdir(env_dir):
            continue
        envs.append({
            'name': name,
            'path': env_dir,
            'valid': _find_pip(env_dir) is not None,
        })
    return envs


def create_environment(name, python_version=None):
    _ensure_base_dir()

    if not re.match(r'^[a-zA-Z0-9][a-zA-Z0-9_-]*$', name):
        return {'success': False,
                'error': 'Invalid name. Use letters, numbers, hyphens, '
                         'and underscores. Must start with a letter or number.'}

    env_dir = os.path.join(_ENVS_BASE, name)
    if os.path.exists(env_dir):
        return {'success': False, 'error': f'Environment "{name}" already exists'}

    uv = _find_uv()
    if not uv:
        return {'success': False,
                'error': 'uv not found. It should be installed as a project dependency.'}

    cmd = [uv, 'venv', '--seed']
    if python_version:
        cmd += ['--python', python_version]
    cmd.append(env_dir)

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
    if pip:
        try:
            subprocess.check_call(
                [pip, 'install', '--quiet'] + _BASE_PACKAGES,
                env=env, timeout=300,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
        except Exception as e:
            warning = f'Created, but base packages failed to install: {e}'

    result = {'success': True, 'path': env_dir}
    if warning:
        result['warning'] = warning
    return result


def delete_environment(name):
    env_dir = os.path.join(_ENVS_BASE, name)
    if not os.path.isdir(env_dir):
        return {'success': False, 'error': 'Environment not found'}
    try:
        shutil.rmtree(env_dir)
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


def install_requirements(env_name, requirements_text):
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
            return {'success': True, 'output': result.stdout}
        return {'success': False, 'error': result.stderr or result.stdout}
    except subprocess.TimeoutExpired:
        return {'success': False, 'error': 'Installation timed out (10 min)'}
    except Exception as e:
        return {'success': False, 'error': str(e)}
    finally:
        try:
            os.unlink(req_path)
        except OSError:
            pass


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