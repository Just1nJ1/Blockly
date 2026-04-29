"""
Extension loader for the Flask backend.

Scans the extensions directory, imports each extension's backend/main.py,
and registers its Flask Blueprint under /ext/{name}/.

Each extension's backend/main.py must export a module-level `blueprint`
variable that is a Flask Blueprint instance.
"""

import os
import sys
import json
import importlib.util
import traceback


_loaded_names = set()


def load_extensions(app, extensions_dir):
    """
    Scan extensions_dir, load backend Blueprints, register them on the app.
    Skips extensions already loaded from a previous directory.
    """
    if not extensions_dir or not os.path.isdir(extensions_dir):
        return

    loaded = []
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

            # Add extension's backend dir to sys.path for sibling imports
            backend_dir = os.path.dirname(main_path)
            if backend_dir not in sys.path:
                sys.path.insert(0, backend_dir)

            # Dynamic import
            spec = importlib.util.spec_from_file_location(
                f"ext_{name}_backend", main_path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

            blueprint = getattr(module, 'blueprint', None)
            if blueprint is None:
                print(f"[Extensions] WARNING: {name} has no 'blueprint' variable")
                continue

            app.register_blueprint(blueprint, url_prefix=f'/ext/{name}')
            _loaded_names.add(name)
            loaded.append(name)
            print(f"[Extensions] Loaded backend: {name} -> /ext/{name}/")

        except Exception as e:
            print(f"[Extensions] ERROR loading {entry}: {e}")
            traceback.print_exc()

    if loaded:
        print(f"[Extensions] {len(loaded)} backend(s) loaded: {', '.join(loaded)}")
