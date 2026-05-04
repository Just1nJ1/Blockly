"""
Extension subprocess manager.

Handles spawning, health-checking, reverse-proxying, and tearing down
extension backends that run in their own virtual environments.

Subprocesses are started **lazily** — only when the first HTTP request
arrives for a given extension, not at app startup.
"""

import atexit
import os
import socket
import subprocess
import threading
import time
import urllib.request
import urllib.error

from flask import request, Response, jsonify


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class _SubprocessInfo:
    __slots__ = ('name', 'port', 'process', 'healthy')

    def __init__(self, name, port, process):
        self.name = name
        self.port = port
        self.process = process
        self.healthy = False


_running = {}        # name -> _SubprocessInfo
_launch_configs = {} # name -> {ext_dir, env_python, main_server_url}
_start_locks = {}    # name -> threading.Lock  (prevents concurrent starts)

_EXT_RUNNER = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                           'ext_runner.py')
_SERVER_ROOT = os.path.dirname(os.path.dirname(__file__))


# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

def _find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def register_ext(name, ext_dir, env_python, main_server_url):
    """Store launch config for lazy startup (called during load_extensions)."""
    _launch_configs[name] = {
        'ext_dir': ext_dir,
        'env_python': env_python,
        'main_server_url': main_server_url,
    }
    _start_locks[name] = threading.Lock()


def _ensure_running(name):
    """Start the extension subprocess if not already running.

    Blocks until the subprocess is healthy (up to 30 s).
    Called by the proxy handler on the first request.
    Returns the port, or None on failure.
    """
    info = _running.get(name)
    if info and info.healthy:
        return info.port

    lock = _start_locks.get(name)
    if not lock:
        return None

    with lock:
        # Re-check after acquiring lock (another thread may have started it)
        info = _running.get(name)
        if info and info.healthy:
            return info.port

        config = _launch_configs.get(name)
        if not config:
            return None

        return _start_and_wait(name, **config)


def _start_and_wait(name, ext_dir, env_python, main_server_url):
    """Spawn the subprocess and block until it responds to /health."""
    port = _find_free_port()

    env = os.environ.copy()
    for key in ('PYTHONHOME', 'PYTHONPATH', 'PYTHONDONTWRITEBYTECODE'):
        env.pop(key, None)

    cmd = [
        env_python, _EXT_RUNNER,
        '--ext-dir', ext_dir,
        '--port', str(port),
        '--main-server', main_server_url,
        '--server-root', _SERVER_ROOT,
    ]

    try:
        proc = subprocess.Popen(
            cmd, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True,
        )
    except Exception as e:
        print(f'[ext_process] Failed to spawn {name}: {e}', flush=True)
        return None

    print(f'[ext_process] {name} starting on port {port} (pid {proc.pid})',
          flush=True)

    # Poll /health until the subprocess is ready
    url = f'http://127.0.0.1:{port}/health'
    deadline = time.monotonic() + 30

    while time.monotonic() < deadline:
        if proc.poll() is not None:
            out = proc.stdout.read() if proc.stdout else ''
            print(f'[ext_process] {name} exited early (rc={proc.returncode})',
                  flush=True)
            if out:
                for line in out.strip().splitlines()[-10:]:
                    print(f'  {line}', flush=True)
            return None
        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=2):
                info = _SubprocessInfo(name, port, proc)
                info.healthy = True
                _running[name] = info
                print(f'[ext_process] {name} ready on port {port}', flush=True)
                return port
        except Exception:
            time.sleep(0.3)

    print(f'[ext_process] {name} failed to start within 30 s', flush=True)
    proc.terminate()
    return None


def stop_ext_subprocess(name):
    info = _running.pop(name, None)
    if info is None:
        return
    try:
        info.process.terminate()
        info.process.wait(timeout=5)
    except Exception:
        try:
            info.process.kill()
        except Exception:
            pass
    print(f'[ext_process] {name} stopped')


def stop_all():
    for name in list(_running):
        stop_ext_subprocess(name)


atexit.register(stop_all)


# ---------------------------------------------------------------------------
# Reverse proxy
# ---------------------------------------------------------------------------

def _forward_request(name, port, subpath):
    """Forward the current Flask request to the subprocess."""
    target = f'http://127.0.0.1:{port}/{subpath}'
    if request.query_string:
        target += '?' + request.query_string.decode()

    body = request.get_data() or None
    headers = {}
    for key, value in request.headers:
        if key.lower() in ('host', 'content-length'):
            continue
        headers[key] = value

    req = urllib.request.Request(
        target, data=body, headers=headers, method=request.method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp_headers = {k: v for k, v in resp.headers.items()
                            if k.lower() not in ('transfer-encoding',)}
            return Response(resp.read(), status=resp.status,
                            headers=resp_headers)
    except urllib.error.HTTPError as e:
        resp_headers = {k: v for k, v in e.headers.items()
                        if k.lower() not in ('transfer-encoding',)}
        return Response(e.read(), status=e.code, headers=resp_headers)
    except Exception:
        return jsonify({
            'success': False,
            'error': f'Extension "{name}" is unavailable',
        }), 502


def register_proxy_route(app, name):
    """Register Flask URL rules that lazy-start and proxy /ext/<name>/*."""

    def _proxy(subpath=''):
        port = _ensure_running(name)
        if port is None:
            return jsonify({
                'success': False,
                'error': f'Extension "{name}" failed to start',
            }), 502
        return _forward_request(name, port, subpath)

    endpoint = f'ext_proxy_{name}'
    app.add_url_rule(
        f'/ext/{name}/<path:subpath>',
        endpoint,
        _proxy,
        methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    )
    app.add_url_rule(
        f'/ext/{name}/',
        f'{endpoint}_root',
        _proxy,
        defaults={'subpath': ''},
        methods=['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    )