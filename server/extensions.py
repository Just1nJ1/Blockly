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

from .environments import _find_python, _ENVS_BASE, get_site_packages
from .extension_deps import dependency_chain, normalize_depends, resolve_extensions
from . import ext_process


_loaded_names = set()


def load_extensions(app, extensions_dirs, main_server_url='http://127.0.0.1:5080'):
    """
    Scan every extensions directory, then load backends in dependency order.

    The first directory wins when the same extension name appears twice
    (user install overrides the copy in the app). An extension whose
    ``depends`` list is not fully installed is skipped.

    Extensions with a matching venv are spawned as subprocesses and
    reverse-proxied instead of being loaded in-process. Dependency
    site-packages are added to that process so shared libraries (for
    example OpenCV from the camera extension) can be imported.
    """
    if isinstance(extensions_dirs, str):
        extensions_dirs = [extensions_dirs]
    if not extensions_dirs:
        return

    loaded_in_proc = []
    loaded_subprocess = []
    discovered = {}
    dirs_by_name = {}

    for extensions_dir in extensions_dirs:
        if not extensions_dir or not os.path.isdir(extensions_dir):
            continue
        for entry in sorted(os.listdir(extensions_dir)):
            ext_dir = os.path.join(extensions_dir, entry)
            manifest_path = os.path.join(ext_dir, 'extension.json')
            if not os.path.isfile(manifest_path):
                continue
            try:
                with open(manifest_path, 'r', encoding='utf-8') as f:
                    manifest = json.load(f)
            except Exception as e:
                print(f"[Extensions] ERROR reading {entry}: {e}")
                continue
            name = manifest.get('name', entry)
            if name in _loaded_names or name in discovered:
                continue
            discovered[name] = manifest
            dirs_by_name[name] = ext_dir

    order, skipped = resolve_extensions(discovered)
    for name, reason in skipped.items():
        print(f"[Extensions] Skipping {name}: {reason}")

    for name in order:
        ext_dir = dirs_by_name[name]
        manifest = discovered[name]
        try:
            contributes = manifest.get('contributes', {})
            backend = contributes.get('backend', {})
            main_file = backend.get('main')
            if not main_file:
                continue

            main_path = os.path.join(ext_dir, main_file)
            if not os.path.isfile(main_path):
                print(f"[Extensions] WARNING: {name} backend not found: {main_path}")
                continue

            dep_sites = _dependency_site_packages(name, discovered)
            if normalize_depends(manifest) and not dep_sites:
                print(
                    f"[Extensions] WARNING: {name} depends on "
                    f"{', '.join(normalize_depends(manifest))} but those "
                    "environments have no site-packages yet"
                )

            env_dir = os.path.join(_ENVS_BASE, name)
            env_python = _find_python(env_dir) if os.path.isdir(env_dir) else None

            if env_python:
                ext_process.register_ext(
                    name, ext_dir, env_python, main_server_url,
                    dep_site_packages=dep_sites)
                ext_process.register_proxy_route(app, name)
                loaded_subprocess.append(name)
            else:
                _load_in_process(app, name, main_path, dep_sites)
                loaded_in_proc.append(name)

            _loaded_names.add(name)

        except Exception as e:
            print(f"[Extensions] ERROR loading {name}: {e}")
            traceback.print_exc()

    parts = []
    if loaded_in_proc:
        parts.append(f'{len(loaded_in_proc)} in-process: {", ".join(loaded_in_proc)}')
    if loaded_subprocess:
        parts.append(f'{len(loaded_subprocess)} subprocess: {", ".join(loaded_subprocess)}')
    if parts:
        print(f'[Extensions] {" | ".join(parts)}')
    if loaded_subprocess:
        ext_process.warm_registered()


def _dependency_site_packages(name, manifests):
    """site-packages dirs for dependencies, direct dependencies first."""
    paths = []
    seen = set()
    for dep in dependency_chain(name, manifests):
        site = get_site_packages(dep)
        if site and site not in seen:
            seen.add(site)
            paths.append(site)
    return paths


def _load_in_process(app, name, main_path, dep_site_packages=None):
    """Load an extension Blueprint into the main Flask app (original path)."""
    for site in dep_site_packages or []:
        if site not in sys.path:
            sys.path.append(site)
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
