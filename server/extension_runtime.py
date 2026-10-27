"""Per-execution extension runtimes.

An extension may ship ``contributes.runtime.python``. StudioX loads that
module into this process and calls ``create_session(ctx)`` once per run.
The adapter is an HTTP client of its own backend. Importing it must not
open hardware. ``close_all()`` runs before the execution session is marked
finished.

Simulation, G-code export, and code inspection do not start adapters.
They install ``unavailable_extensions()`` so a block that needs a runtime
fails with an explicit message instead of a missing name.

This is not a sandbox. The adapter is trusted code from an installed
extension and runs in the Blockly server process.
"""

from __future__ import annotations

import http.client
import importlib.util
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.request
from types import MappingProxyType

from .extension_deps import normalize_depends
from .extension_registry import get
from .manifest_schema import contained_path

_SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,80}$')
_METHODS = frozenset({'GET', 'POST', 'PUT', 'DELETE', 'PATCH'})

_module_lock = threading.Lock()
_modules = {}
_module_names = set()
_log_lock = threading.Lock()
_logged = set()


class ExtensionResponse:
    """HTTP result. ``body`` stays bytes until the caller asks for JSON."""

    def __init__(self, status, headers, body):
        self.status = int(status)
        self.headers = {str(key): str(value) for key, value in dict(headers or {}).items()}
        if isinstance(body, bytes):
            self.body = body
        elif isinstance(body, bytearray):
            self.body = bytes(body)
        elif body is None:
            self.body = b''
        else:
            self.body = bytes(body)

    def json(self):
        return json.loads(self.body.decode('utf-8'))


class ExtensionRuntimeError(Exception):
    """A runtime could not be loaded or used. ``extension_id`` may be empty."""

    def __init__(self, extension_id, message):
        self.extension_id = extension_id or ''
        self.message = str(message)
        text = self.message
        if self.extension_id and not text.startswith(self.extension_id + ':'):
            text = '%s: %s' % (self.extension_id, text)
        super().__init__(text)


class ExtensionHttpError(ExtensionRuntimeError):
    """The extension backend returned HTTP 4xx or 5xx."""

    def __init__(self, extension_id, response: ExtensionResponse):
        self.response = response
        detail = 'HTTP %s' % response.status
        try:
            payload = response.json()
        except Exception:
            payload = None
        if isinstance(payload, dict) and payload.get('error'):
            detail = str(payload['error'])
        super().__init__(extension_id, detail)


class ExtensionContext:
    """Capabilities given to one adapter session. Paths stay inside that extension."""

    def __init__(self, extension_id, session_id, abort_checker, transport):
        self._extension_id = str(extension_id)
        self._session_id = str(session_id)
        self._abort_checker = abort_checker
        self._transport = transport
        self._cleanups = []

    @property
    def extension_id(self):
        return self._extension_id

    @property
    def session_id(self):
        return self._session_id

    def check_aborted(self):
        """Raise the execution's cancellation exception, if Stop was requested."""
        if self._abort_checker is not None:
            self._abort_checker()

    def request(self, method, relative_path, json=None, timeout=None, ignore_abort=False):
        """Send one request to ``/ext/<this extension>/...`` and return the response.

        Absolute URLs, ``//host``, and ``..`` are rejected before any network
        call. A Stop raised by the checker or the transport propagates as that
        same exception. HTTP 4xx and 5xx raise ``ExtensionHttpError``.

        ``ignore_abort=True`` is only for idempotent cleanup such as disconnect.
        Stop must still be able to release a holder that was already registered.
        """
        if not ignore_abort:
            self.check_aborted()
        try:
            safe = safe_extension_path(relative_path)
        except ValueError as exc:
            raise ExtensionRuntimeError(self._extension_id, str(exc)) from exc
        verb = str(method or 'GET').upper()
        if verb not in _METHODS:
            raise ExtensionRuntimeError(self._extension_id, 'Unsupported method %s.' % verb)
        payload = None
        headers = {}
        if json is not None:
            payload = _json_bytes(json, self._extension_id)
            headers['Content-Type'] = 'application/json'
        try:
            status, resp_headers, body = self._transport(
                self._extension_id, verb, safe, payload, headers, timeout,
            )
        except Exception:
            if not ignore_abort:
                self.check_aborted()
            raise
        if not ignore_abort:
            self.check_aborted()
        response = ExtensionResponse(status, resp_headers, body)
        if response.status >= 400:
            raise ExtensionHttpError(self._extension_id, response)
        return response

    def report_error(self, message):
        """Record one diagnostic. This does not raise and does not print on every frame."""
        text = '%s: %s' % (self._extension_id, message)
        _log_once(text)
        try:
            from .preview_hub import note_failure
            note_failure(text)
        except Exception:
            pass

    def add_cleanup(self, fn):
        """Register an idempotent callback. Callbacks run LIFO after ``close()``."""
        if not callable(fn):
            raise TypeError('cleanup must be callable')
        self._cleanups.append(fn)


class ExtensionRuntimeManager:
    """Adapters started for a single execution, closed in reverse order."""

    def __init__(self):
        self._started = []
        self._closed = False
        self.cleanup_errors = []

    @classmethod
    def create_for_session(cls, session_id, extension_ids, abort_checker, transport=None):
        """Validate ids, then start each adapter. On failure, close the ones already started.

        An installed extension with no ``runtime.python`` is skipped. A declared
        runtime that is missing or fails to start aborts the run before user code.
        """
        if not isinstance(session_id, str) or not _SESSION_ID_RE.fullmatch(session_id):
            raise ExtensionRuntimeError('', 'Invalid session id.')
        ids = _dedupe_ids(extension_ids)
        manager = cls()
        transport = transport or urllib_transport
        try:
            for extension_id in ids:
                if abort_checker is not None:
                    abort_checker()
                opened = _open_adapter(extension_id, session_id, abort_checker, transport)
                if opened is not None:
                    manager._started.append(opened)
        except BaseException:
            manager.close_all()
            raise
        return manager

    def namespaces(self):
        """Read-only ``extension id -> session adapter`` map."""
        return MappingProxyType({
            extension_id: adapter for extension_id, adapter, _ctx in self._started
        })

    def close_all(self):
        """Close every adapter once. One failure does not skip the remaining ones."""
        if self._closed:
            return
        self._closed = True
        for extension_id, adapter, ctx in reversed(self._started):
            self._invoke(extension_id, getattr(adapter, 'close', None))
            for fn in reversed(ctx._cleanups):
                self._invoke(extension_id, fn)

    def _invoke(self, extension_id, fn):
        if not callable(fn):
            return
        try:
            fn()
        except Exception as exc:
            self.cleanup_errors.append((extension_id, exc))
            _log_once('%s cleanup failed: %s' % (extension_id, exc))


def unavailable_extensions(mode):
    """Mapping that explains why ``__studiox_extensions`` cannot run in this mode."""

    class _Unavailable(dict):
        def __getitem__(self, key):
            raise RuntimeError(
                'Extension runtime is unavailable in %s. Run the program to use %s.'
                % (mode, key)
            )

    return _Unavailable()


# Constructors that open a physical device. Simulation and G-code export wrap
# these so a missing extension mock cannot reach hardware. This is not a
# per-extension branch.
DEVICE_OPENERS = {
    'cv2': frozenset({'VideoCapture'}),
}


class SimulationUnsupported(Exception):
    """A block has no safe simulation mock, so the dry-run stopped there."""


class SimValue:
    """Truthy stand-in. Attribute access and calls return another stand-in."""

    def __init__(self, label='placeholder'):
        self.label = label

    def __call__(self, *args, **kwargs):
        return SimValue(self.label)

    def __getattr__(self, name):
        if name.startswith('_'):
            raise AttributeError(name)
        return SimValue('%s.%s' % (self.label, name))

    def __getitem__(self, item):
        return SimValue(self.label)

    def __bool__(self):
        return True

    def __iter__(self):
        return iter(())

    def __repr__(self):
        return '<simulation placeholder>'


class _BlockedDeviceOpen:
    def __init__(self, module_name, name, attempts):
        self._label = '%s.%s' % (module_name, name)
        self._attempts = attempts

    def __call__(self, *args, **kwargs):
        self._attempts.append(self._label)
        raise SimulationUnsupported(
            '%s would open a device. Simulation did not open it.' % self._label
        )


def guard_imported_module(module_name, module, attempts):
    """Return ``module``, or a proxy whose device constructors refuse to run."""
    blocked = DEVICE_OPENERS.get(module_name)
    if not blocked or module is None:
        return module

    class _Guarded:
        def __getattr__(self, attr):
            if attr in blocked:
                return _BlockedDeviceOpen(module_name, attr, attempts)
            return getattr(module, attr)

    return _Guarded()


def simulation_extensions(warnings):
    """Extension calls during a dry-run. They record a warning and open nothing."""

    class _Extension:
        def __init__(self, extension_id):
            self._extension_id = extension_id

        def __getattr__(self, name):
            def call(*args, **kwargs):
                warnings.append(
                    '%s.%s is not simulated; a placeholder was used and no device was opened.'
                    % (self._extension_id, name)
                )
                return SimValue('%s.%s' % (self._extension_id, name))
            return call

    class _Namespace:
        def __getitem__(self, extension_id):
            return _Extension(str(extension_id))

    return _Namespace()


def simulation_note(warnings, message, value=None):
    """Record one dry-run warning and return ``value`` unchanged."""
    text = str(message)
    if text and text not in warnings:
        warnings.append(text)
    return value


def simulation_placeholder(warnings, extension_id, operation):
    """Safe stand-in for a hardware call an extension declared for simulation."""
    warnings.append(
        '%s.%s uses a simulation placeholder. No device was opened.'
        % (extension_id, operation)
    )
    return SimValue('%s.%s' % (extension_id, operation))


def simulation_unsupported(message):
    """Stop the dry-run at a hardware block that has no simulation mock."""
    raise SimulationUnsupported(str(message))


def safe_extension_path(relative) -> str:
    """Accept ``/frame?id=0``. Reject absolute URLs, ``//host``, and ``..``."""
    if not isinstance(relative, str) or not relative:
        raise ValueError('Extension request path is required.')
    if not relative.startswith('/') or relative.startswith('//'):
        raise ValueError('Extension request path must start with a single /.')
    if '://' in relative or '\\' in relative or '\n' in relative or '\r' in relative:
        raise ValueError('Extension request path is not a relative extension path.')
    path, _sep, query = relative.partition('?')
    parts = path.split('/')
    if any(part in ('', '.', '..') for part in parts[1:]):
        raise ValueError('Extension request path is not a relative extension path.')
    if query and ('://' in query or '\\' in query or '\n' in query or '\r' in query):
        raise ValueError('Extension request path is not a relative extension path.')
    return relative


def urllib_transport(extension_id, method, relative, body, headers, timeout):
    """Reach an extension without opening a new TCP connection per call.

    A registered extension is called in this process, then over one reusable
    connection to the extension server. ``urllib`` remains only for a caller
    that is not hosting the extension itself.
    """
    try:
        from .ext_process import local_extension_request
        local = local_extension_request(
            extension_id, method, relative, body, headers, timeout,
        )
    except (OSError, http.client.HTTPException) as exc:
        raise ExtensionRuntimeError(
            extension_id, 'Extension backend is unavailable: %s' % exc,
        ) from exc
    if local is not None:
        return local
    port = os.environ.get('STUDIOX_PORT', '5080')
    if not str(port).isdigit():
        raise ExtensionRuntimeError(extension_id, 'StudioX port is not configured.')
    url = 'http://127.0.0.1:%s/ext/%s%s' % (port, extension_id, relative)
    request = urllib.request.Request(
        url,
        data=body,
        headers=dict(headers or {}),
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=8 if timeout is None else timeout) as response:
            payload = response.read()
            response_headers = {key: value for key, value in response.headers.items()}
            return response.status, response_headers, payload
    except urllib.error.HTTPError as exc:
        payload = exc.read() if exc.fp is not None else b''
        response_headers = {}
        if exc.headers is not None:
            response_headers = {key: value for key, value in exc.headers.items()}
        return exc.code, response_headers, payload
    except urllib.error.URLError as exc:
        raise ExtensionRuntimeError(
            extension_id, 'Extension backend is unavailable: %s' % exc.reason,
        ) from exc


def runtime_module_name(extension_id: str) -> str:
    safe = re.sub(r'[^0-9A-Za-z_]', '_', extension_id)
    return 'studiox_ext_%s_runtime' % safe


def clear_module_cache() -> None:
    """Drop cached adapter modules. Used by tests so a rewritten file is reloaded."""
    with _module_lock:
        _modules.clear()
        names = list(_module_names)
        _module_names.clear()
    for name in names:
        sys.modules.pop(name, None)


def _dedupe_ids(extension_ids):
    if extension_ids is None:
        return []
    if not isinstance(extension_ids, (list, tuple)):
        raise ExtensionRuntimeError('', 'extension_ids must be a list of strings.')
    ids = []
    for item in extension_ids:
        if not isinstance(item, str) or not item:
            raise ExtensionRuntimeError('', 'extension_ids must be a list of strings.')
        if item not in ids:
            ids.append(item)
    return ids


def _open_adapter(extension_id, session_id, abort_checker, transport):
    record = get(extension_id)
    if record is None:
        raise ExtensionRuntimeError(
            extension_id,
            'Missing extension: %s. Install it and restart StudioX.' % extension_id,
        )
    if not record.get('enabled', True):
        raise ExtensionRuntimeError(
            extension_id,
            'Extension %s is disabled. Enable it and restart StudioX.' % extension_id,
        )
    missing = []
    for dep in normalize_depends(record.get('manifest') or {}):
        other = get(dep)
        if other is None or not other.get('enabled', True):
            missing.append(dep)
    if missing:
        raise ExtensionRuntimeError(
            extension_id,
            'Extension %s is missing dependencies: %s.' % (extension_id, ', '.join(missing)),
        )
    relative = record.get('runtime_python') or ''
    if not relative:
        return None
    full = contained_path(record.get('path') or '', str(relative))
    if not full or not os.path.isfile(full):
        raise ExtensionRuntimeError(
            extension_id,
            'Runtime file %s is missing or outside the extension.' % relative,
        )
    try:
        module = _load_module(extension_id, full)
    except ExtensionRuntimeError:
        raise
    except Exception as exc:
        raise ExtensionRuntimeError(extension_id, 'Runtime failed to load: %s' % exc) from exc
    factory = getattr(module, 'create_session', None)
    if not callable(factory):
        raise ExtensionRuntimeError(extension_id, 'Runtime must define create_session(ctx).')
    ctx = ExtensionContext(extension_id, session_id, abort_checker, transport)
    try:
        adapter = factory(ctx)
    except ExtensionRuntimeError:
        raise
    except Exception as exc:
        raise ExtensionRuntimeError(
            extension_id, 'Runtime failed to start: %s' % exc,
        ) from exc
    if not callable(getattr(adapter, 'close', None)):
        raise ExtensionRuntimeError(extension_id, 'Runtime adapter must provide close().')
    _log_once('loaded %s runtime from %s' % (extension_id, full))
    return extension_id, adapter, ctx


def _load_module(extension_id, file_path):
    key = os.path.realpath(file_path)
    with _module_lock:
        cached = _modules.get(key)
        if cached is not None:
            return cached
        name = runtime_module_name(extension_id)
        existing = sys.modules.get(name)
        existing_file = os.path.realpath(getattr(existing, '__file__', '') or '') if existing else ''
        if existing is not None and existing_file != key:
            name = '%s_%s' % (name, threading.get_ident())
        spec = importlib.util.spec_from_file_location(name, key)
        if spec is None or spec.loader is None:
            raise ExtensionRuntimeError(extension_id, 'Could not load runtime %s.' % file_path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        _module_names.add(name)
        try:
            spec.loader.exec_module(module)
        except Exception:
            sys.modules.pop(name, None)
            _module_names.discard(name)
            raise
        _modules[key] = module
        return module


def _json_bytes(payload, extension_id) -> bytes:
    try:
        return json.dumps(payload).encode('utf-8')
    except (TypeError, ValueError) as exc:
        raise ExtensionRuntimeError(
            extension_id, 'Extension request JSON could not be encoded: %s' % exc,
        ) from exc


def _log_once(message: str) -> None:
    if not message:
        return
    with _log_lock:
        if message in _logged:
            return
        if len(_logged) > 80:
            _logged.clear()
        _logged.add(message)
    stream = getattr(sys, '__stderr__', None)
    if stream is not None:
        print('[extensions] ' + message, file=stream, flush=True)
