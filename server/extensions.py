"""
Extension loader for the Flask backend.

Scans the extensions directory and loads each extension's backend.
Extensions that have a matching virtual environment under
~/.wlkata-studiox/environments/<name> are launched as subprocesses
(full package isolation).  Others are loaded in-process as Blueprints.
"""

import os
import sys
import json
import importlib.util
import traceback

from .environments import _find_python, _ENVS_BASE
from . import ext_process


_loaded_names = set()


def load_extensions(app, extensions_dir, main_server_url='http://127.0.0.1:5080'):
    """
    Scan extensions_dir, load backend Blueprints, register them on the app.
    Skips extensions already loaded from a previous directory.

    Extensions with a matching venv are spawned as subprocesses and
    reverse-proxied instead of being loaded in-process.
    """
    if not extensions_dir or not os.path.isdir(extensions_dir):
        return

    loaded_in_proc = []
    loaded_subprocess = []

    for entry in sorted(os.listdir(extensions_dir)):
        ext_dir = os.path.join(extensions_dir, entry)
        manifest_path = os.path.join(ext_dir, 'extension.json')

        if not os.path.isfile(manifest_path):
            continue

        try:
            with open(manifest_path, 'r') as f:
                manifest = json.load(f)

            name = manifest.get('name', entry)
            if name in _loaded_names:
                continue
            contributes = manifest.get('contributes', {})
            backend = contributes.get('backend', {})
            main_file = backend.get('main')

            if not main_file:
                continue

            main_path = os.path.join(ext_dir, main_file)
            if not os.path.isfile(main_path):
                print(f"[Extensions] WARNING: {name} backend not found: {main_path}")
                continue

            # Check for a matching virtual environment
            env_dir = os.path.join(_ENVS_BASE, name)
            env_python = _find_python(env_dir) if os.path.isdir(env_dir) else None

            if env_python:
                # --- Subprocess mode (lazy: starts on first request) ---
                ext_process.register_ext(
                    name, ext_dir, env_python, main_server_url)
                ext_process.register_proxy_route(app, name)
                loaded_subprocess.append(name)
            else:
                # --- In-process mode (original behaviour) ---
                _load_in_process(app, name, main_path)
                loaded_in_proc.append(name)

            _loaded_names.add(name)

        except Exception as e:
            print(f"[Extensions] ERROR loading {entry}: {e}")
            traceback.print_exc()

    parts = []
    if loaded_in_proc:
        parts.append(f'{len(loaded_in_proc)} in-process: {", ".join(loaded_in_proc)}')
    if loaded_subprocess:
        parts.append(f'{len(loaded_subprocess)} subprocess: {", ".join(loaded_subprocess)}')
    if parts:
        print(f'[Extensions] {" | ".join(parts)}')


def _load_in_process(app, name, main_path):
    """Load an extension Blueprint into the main Flask app (original path)."""
    backend_dir = os.path.dirname(main_path)
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    spec = importlib.util.spec_from_file_location(
        f"ext_{name}_backend", main_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    blueprint = getattr(module, 'blueprint', None)
    if blueprint is None:
        print(f"[Extensions] WARNING: {name} has no 'blueprint' variable")
        return

    app.register_blueprint(blueprint, url_prefix=f'/ext/{name}')
    print(f"[Extensions] Loaded in-process: {name} -> /ext/{name}/")
