#!/usr/bin/env python3
"""
Run a single extension's Flask backend in its own virtual environment.

Spawned by the main server when an extension has a matching venv under
~/.wlkata-studiox/environments/<ext_name>.  The main server reverse-proxies
/ext/<name>/* to this process.

Usage (invoked automatically — not meant to be run manually):
    <venv_python> ext_runner.py \
        --ext-dir  /path/to/extension \
        --port     5091 \
        --main-server http://127.0.0.1:5080 \
        --server-root /path/to/project
"""

import argparse
import json
import logging
import os
import sys
import importlib.util
import urllib.request
import urllib.parse
import urllib.error


# ---------------------------------------------------------------------------
# Remote proxy for SerialManager — lets existing extension code like
#     from server.serial_manager import SerialManager
#     mgr = SerialManager.get_instance()
#     for conn in mgr.all_connected(): conn.robot.writeCoordinate(...)
# work transparently by routing through HTTP to the main server.
# ---------------------------------------------------------------------------

class _RemoteRobot:
    """Proxy for the SDK robot object, mapping method calls to HTTP."""

    def __init__(self, server_url, port):
        self._url = server_url
        self._port = port

    def _post(self, endpoint, body=None):
        data = json.dumps(body or {}).encode()
        req = urllib.request.Request(
            self._url + endpoint,
            data=data,
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return json.loads(resp.read())
        except Exception:
            return {'success': False}

    def writeCoordinate(self, motion, mode, **kwargs):
        if mode == 1:  # incremental single-axis
            for axis, step in kwargs.items():
                self._post('/cmd/jog', {
                    'port': self._port, 'mode': 'coord',
                    'axis': axis.upper(), 'step': step,
                })
        else:  # absolute
            self._post('/cmd/jog', {
                'port': self._port, 'mode': 'coord',
                'motion': motion, 'values': kwargs,
            })

    def writeAngle(self, mode, **kwargs):
        if mode == 1:
            for axis, step in kwargs.items():
                self._post('/cmd/jog', {
                    'port': self._port, 'mode': 'joint',
                    'axis': axis.upper(), 'step': step,
                })
        else:
            self._post('/cmd/jog', {
                'port': self._port, 'mode': 'joint',
                'motion': 0, 'values': kwargs,
            })

    def homing(self):
        self._post('/cmd/home', {'port': self._port})

    def zero(self):
        self._post('/cmd/zero', {'port': self._port})

    def pump(self, mode):
        self._post('/cmd/pump', {'port': self._port, 'mode': mode})

    def gripper(self, mode):
        self._post('/cmd/gripper', {'port': self._port, 'mode': mode})

    def cancellation(self):
        self._post('/cmd/stop-all')


class _RemoteConnection:
    """Proxy for a PortConnection object."""

    def __init__(self, server_url, port, model=None):
        self.port = port
        self.model = model
        self.connected = True
        self.robot = _RemoteRobot(server_url, port)


class _RemoteSerialManager:
    """Drop-in proxy for SerialManager.get_instance() in subprocesses."""

    _instance = None

    def __init__(self, server_url):
        self._url = server_url

    @classmethod
    def get_instance(cls):
        return cls._instance

    def all_connected(self):
        try:
            req = urllib.request.Request(self._url + '/detect-devices')
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
            conns = []
            for p in data.get('ports', []):
                if p.get('connected'):
                    conns.append(_RemoteConnection(
                        self._url, p['port'], p.get('model')))
            return conns
        except Exception:
            return []

    @property
    def active_connection(self):
        conns = self.all_connected()
        return conns[0] if conns else None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description='StudioX extension runner')
    parser.add_argument('--ext-dir', required=True,
                        help='Path to the extension directory')
    parser.add_argument('--port', type=int, required=True,
                        help='Port to serve on')
    parser.add_argument('--main-server', default='http://127.0.0.1:5080',
                        help='Main StudioX server URL')
    parser.add_argument('--server-root', default='',
                        help='Project root (added to sys.path for server.* imports)')
    args = parser.parse_args()

    # Add project root so `from server.serial_manager import ...` resolves
    if args.server_root and args.server_root not in sys.path:
        sys.path.insert(0, args.server_root)

    # Monkey-patch SerialManager BEFORE the extension imports it
    _RemoteSerialManager._instance = _RemoteSerialManager(args.main_server)
    try:
        from server import serial_manager
        serial_manager.SerialManager = _RemoteSerialManager
    except ImportError:
        pass

    # Read manifest
    manifest_path = os.path.join(args.ext_dir, 'extension.json')
    with open(manifest_path, 'r') as f:
        manifest = json.load(f)

    name = manifest.get('name', os.path.basename(args.ext_dir))
    main_file = manifest.get('contributes', {}).get('backend', {}).get('main')
    if not main_file:
        print(f'[ext_runner] Extension {name} has no backend to run', flush=True)
        sys.exit(1)

    main_path = os.path.join(args.ext_dir, main_file)
    if not os.path.isfile(main_path):
        print(f'[ext_runner] Backend not found: {main_path}', flush=True)
        sys.exit(1)

    # Add backend dir to sys.path for sibling imports
    backend_dir = os.path.dirname(main_path)
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)

    # Dynamic import
    spec = importlib.util.spec_from_file_location(f'ext_{name}_backend', main_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    blueprint = getattr(module, 'blueprint', None)
    if blueprint is None:
        print(f'[ext_runner] {name}: no "blueprint" variable found', flush=True)
        sys.exit(1)

    # Build a minimal Flask app
    from flask import Flask, jsonify
    from flask_cors import CORS

    app = Flask(__name__)
    CORS(app)
    app.register_blueprint(blueprint, url_prefix='/')

    @app.route('/health')
    def _health():
        return jsonify({'status': 'ok', 'extension': name})

    # Suppress request logs
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)

    print(f'[ext_runner] {name} starting on port {args.port}', flush=True)
    app.run(host='127.0.0.1', port=args.port, threaded=True)


if __name__ == '__main__':
    main()