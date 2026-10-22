"""Latest preview frames from a running Blockly program.

The program calls ``__studiox_preview(image, slot)`` directly in this
process. Only the newest frame for each slot is encoded and kept.
"""

import threading

_lock = threading.Lock()
_latest = {}
_jpeg = {}
_rev = 0
_started = False
_error = ''


def _import_cv2():
    """Load OpenCV from this process, then from the camera or blockly env."""
    global _error
    try:
        import cv2
        return cv2
    except Exception as first:
        last = first
    import sys
    try:
        from .environments import get_site_packages
    except Exception:
        from server.environments import get_site_packages
    for name in ('camera', 'blockly'):
        site = get_site_packages(name)
        if site and site not in sys.path:
            sys.path.append(site)
    try:
        import importlib
        importlib.invalidate_caches()
        import cv2
        return cv2
    except Exception as exc:
        _error = (
            'Preview could not load OpenCV (%s). '
            'If Camera was installed by an older app, remove '
            '~/.wlkata-studiox/environments/camera and install it again.'
            % exc
        )
        raise


def _encode_one(image):
    cv2 = _import_cv2()
    if image is None:
        return None
    view = image
    shape = getattr(view, 'shape', None)
    if not shape:
        return None
    h, w = int(shape[0]), int(shape[1])
    longest = h if h > w else w
    if longest > 640:
        scale = 640.0 / float(longest)
        view = cv2.resize(view, (max(1, int(w * scale)), max(1, int(h * scale))))
    ok, buf = cv2.imencode('.jpg', view, [int(cv2.IMWRITE_JPEG_QUALITY), 70])
    if not ok:
        return None
    import base64
    return base64.b64encode(buf.tobytes()).decode('ascii')


def _sender():
    global _started, _rev, _error
    import time
    idle = 0
    while idle < 20:
        time.sleep(0.04)
        with _lock:
            pending = {}
            for slot, image in _latest.items():
                try:
                    pending[slot] = image.copy()
                except Exception:
                    pending[slot] = image
            _latest.clear()
        if not pending:
            idle += 1
            continue
        idle = 0
        encoded = {}
        for slot, image in pending.items():
            try:
                jpg = _encode_one(image)
            except Exception as exc:
                jpg = None
                with _lock:
                    if not _error:
                        _error = 'Preview could not encode a frame (%s)' % exc
            if jpg:
                encoded[slot] = jpg
                with _lock:
                    _error = ''
        if not encoded:
            continue
        with _lock:
            _jpeg.update(encoded)
            _rev += 1
    with _lock:
        if _latest:
            threading.Thread(target=_sender, name='preview-hub', daemon=True).start()
        else:
            _started = False


def submit(image, slot):
    """Keep this frame as the latest for ``slot``. Returns immediately."""
    global _started
    try:
        slot = int(slot)
    except (TypeError, ValueError):
        return
    if image is None:
        return
    with _lock:
        _latest[slot] = image
        start = not _started
        _started = True
    if start:
        threading.Thread(target=_sender, name='preview-hub', daemon=True).start()


def snapshot():
    with _lock:
        frames = [
            {'slot': slot, 'image': image}
            for slot, image in sorted(_jpeg.items())
            if image
        ]
        return _rev, frames, _error
