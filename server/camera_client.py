"""Proxy cv2.VideoCapture to the camera extension process.

The extension environment is the one that has OpenCV and owns the device.
Blockly code still calls ``cv2.VideoCapture`` and ``read``. ``read`` returns
the manager's latest frame.
"""

import json
import os
import threading
import time
import urllib.request

_program_captures = []
_program_lock = threading.Lock()


def _port():
    return os.environ.get('STUDIOX_PORT', '5080')


def _raise_if_aborted():
    """Stop the capture loop between frames. A frame request cannot be interrupted."""
    from .executor import CodeExecutor
    CodeExecutor.raise_if_aborted()


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
        self.client = 'program-%s' % id(self)
        self._held = False
        try:
            raw, _ctype = _call('POST', '/connect', {
                'id': self.index, 'client': self.client,
            }, timeout=20)
            payload = json.loads(raw.decode('utf-8', errors='replace'))
            self._held = bool(payload.get('success'))
        except Exception:
            self._held = False
        if self._held:
            with _program_lock:
                _program_captures.append(self)

    def _fetch(self):
        _raise_if_aborted()
        import cv2
        import numpy as np
        try:
            raw, ctype = _call('GET', '/frame?id=%d' % self.index, timeout=2)
        except Exception:
            return None
        _raise_if_aborted()
        if 'image' not in ctype:
            return None
        frame = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
        if frame is None or getattr(frame, 'size', 0) == 0:
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
            if self in _program_captures:
                _program_captures.remove(self)
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


def release_program_captures():
    """Drop every camera this program opened. Called when the run ends."""
    with _program_lock:
        caps = list(_program_captures)
        _program_captures.clear()
    for cap in caps:
        cap.release()


def patch_cv2_module(mod, capture_cls):
    wrapped = type(mod)('_cv2_proxy')
    wrapped.__dict__.update(mod.__dict__)
    wrapped.VideoCapture = capture_cls
    return wrapped
