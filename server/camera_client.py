"""Proxy cv2.VideoCapture to the camera extension process.

The extension environment is the one that has OpenCV and owns the device.
Blockly code still calls ``cv2.VideoCapture`` and ``read``. ``read`` returns
the manager's latest frame.

Each execution binds a session id. Cleanup releases only that session's
clients, so a Camera window holder (``window``) and a newer program stay
connected.
"""

import json
import os
import threading
import time
import urllib.request

_program_lock = threading.Lock()
_by_session = {}
_tls = threading.local()


def bind_capture_session(session_id):
    """Tag captures opened on this thread with ``session_id``."""
    _tls.session_id = str(session_id)


def unbind_capture_session():
    if hasattr(_tls, 'session_id'):
        del _tls.session_id


def _capture_session():
    return getattr(_tls, 'session_id', None)


def _port():
    return os.environ.get('STUDIOX_PORT', '5080')


def _raise_if_aborted():
    """Stop the capture loop between frames. A frame request cannot be interrupted."""
    from .executor import CodeExecutor
    CodeExecutor.raise_if_aborted()


def _aborted():
    from .executor import CodeExecutor
    return CodeExecutor._abort_event.is_set()


def _note_failure(message):
    try:
        from .preview_hub import note_failure
        note_failure(message)
    except Exception:
        pass


def _call(method, path, body=None, timeout=8):
    data = None if body is None else json.dumps(body).encode()
    headers = {'Content-Type': 'application/json'} if data is not None else {}
    req = urllib.request.Request(
        'http://127.0.0.1:%s/ext/camera%s' % (_port(), path),
        data=data,
        headers=headers,
        method=method,
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.headers.get('Content-Type', '')


class ManagedCapture:
    def __init__(self, index=0, *args, **kwargs):
        self.index = int(index)
        self.session_id = _capture_session() or ('program-%s' % id(self))
        self.client = 'program-%s-%s' % (self.session_id, id(self))
        self._held = False
        self._last_frame_error = ''
        acquired = False
        try:
            raw, _ctype = _call('POST', '/connect', {
                'id': self.index, 'client': self.client,
            }, timeout=20)
            payload = json.loads(raw.decode('utf-8', errors='replace'))
            acquired = bool(payload.get('success'))
            if not acquired:
                self._last_frame_error = payload.get('error') or 'Could not open the camera'
        except Exception:
            acquired = False
            self._last_frame_error = 'Could not open the camera'
        self._held = acquired
        if acquired:
            with _program_lock:
                _by_session.setdefault(self.session_id, []).append(self)
        else:
            _note_failure(self._last_frame_error)
            # Connect can register the client and then fail on the way back.
            try:
                _call('POST', '/disconnect', {
                    'id': self.index, 'client': self.client,
                })
            except Exception:
                pass

    def _fetch(self):
        _raise_if_aborted()
        import cv2
        import numpy as np
        self._last_frame_error = ''
        try:
            raw, ctype = _call('GET', '/frame?id=%d' % self.index, timeout=2)
        except Exception:
            self._last_frame_error = 'Camera frame request failed'
            return None
        _raise_if_aborted()
        if 'image' not in (ctype or ''):
            self._last_frame_error = 'Camera has no frame yet'
            return None
        # imdecode needs a writable buffer that outlives the call.
        arr = np.frombuffer(raw, dtype=np.uint8)
        try:
            frame = cv2.imdecode(arr.copy(), cv2.IMREAD_COLOR)
        except Exception:
            frame = None
        if frame is None or getattr(frame, 'size', 0) == 0:
            self._last_frame_error = 'Preview could not decode a camera frame'
            return None
        return frame

    def read(self):
        # The first frames after open are often empty. Wait briefly so
        # cvtColor is not handed None.
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            _raise_if_aborted()
            frame = self._fetch()
            if frame is not None:
                return True, frame
            time.sleep(0.05)
        if self._held and not _aborted():
            _note_failure(self._last_frame_error or 'Camera has no frame yet')
        return False, None

    def grab(self):
        return self.isOpened()

    def retrieve(self, *args, **kwargs):
        return self.read()

    def isOpened(self):
        return bool(self._held)

    def release(self):
        if not self._held:
            return
        self._held = False
        with _program_lock:
            caps = _by_session.get(self.session_id)
            if caps and self in caps:
                caps.remove(self)
                if not caps:
                    _by_session.pop(self.session_id, None)
        try:
            _call('POST', '/disconnect', {'id': self.index, 'client': self.client})
        except Exception:
            pass

    def set(self, *args, **kwargs):
        return True

    def get(self, *args, **kwargs):
        return 0

    def __del__(self):
        try:
            self.release()
        except Exception:
            pass


def release_program_captures(session_id=None):
    """Drop cameras opened by one execution. Other sessions and the window stay."""
    if session_id is None:
        session_id = _capture_session()
    if not session_id:
        return
    with _program_lock:
        caps = list(_by_session.pop(session_id, []))
    for cap in caps:
        cap.release()


def patch_cv2_module(mod, capture_cls):
    wrapped = type(mod)('_cv2_proxy')
    wrapped.__dict__.update(mod.__dict__)
    wrapped.VideoCapture = capture_cls
    return wrapped
