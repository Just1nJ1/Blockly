"""Latest preview frames from a running Blockly program.

The program calls ``__studiox_preview(image, slot)`` directly in this
process. Only the newest frame for each slot is encoded and kept.
Each execution has a generation so a frame encoded for the previous run
cannot be published after ``reset_for_execution``.
"""

import threading

_lock = threading.Lock()
_latest = {}          # slot -> (generation, image)
_jpeg = {}
_rev = 0
_started = False
_error = ''
_generation = 0

_log_lock = threading.Lock()
_logged = set()


def _log_once(message):
    """Record a diagnostic once. Never write it to the program console."""
    if not message:
        return
    with _log_lock:
        if message in _logged:
            return
        if len(_logged) > 40:
            _logged.clear()
        _logged.add(message)
    import sys
    stream = getattr(sys, '__stderr__', None)
    if stream is None:
        return
    print('[preview] ' + message, file=stream, flush=True)


def reset_for_execution():
    """Drop frames from the previous program and bump the revision.

    Safe while ``_sender`` is encoding: that result is tagged with the old
    generation and is discarded when it finishes.
    """
    global _rev, _error, _generation
    with _lock:
        _generation += 1
        _latest.clear()
        _jpeg.clear()
        _error = ''
        _rev += 1
        return _generation


def _import_cv2():
    """Load OpenCV from this process, then from the camera or blockly env."""
    try:
        import cv2
    except Exception as first:
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
        except Exception as exc:
            raise RuntimeError(
                'Preview could not load OpenCV (%s). '
                'If Camera was installed by an older app, remove '
                '~/.wlkata-studiox/environments/camera and install it again.'
                % exc
            ) from first
    return cv2


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


def _note_locked(message):
    """Set ``_error`` and bump rev. Caller holds ``_lock``. Returns True if new."""
    global _error, _rev
    if not message or _error == message:
        return False
    _error = message
    _rev += 1
    return True


def note_failure(message):
    """Surface a camera or encode failure on ``/preview-frames`` without repeating it."""
    with _lock:
        changed = _note_locked(message)
    if changed:
        _log_once(message)


def _sender():
    global _started, _rev, _error
    import time
    idle = 0
    while True:
        time.sleep(0.04)
        with _lock:
            gen = _generation
            pending = {}
            for slot, item in list(_latest.items()):
                item_gen, image = item
                if item_gen != gen:
                    del _latest[slot]
                    continue
                try:
                    pending[slot] = image.copy()
                except Exception:
                    pending[slot] = image
                del _latest[slot]
        if not pending:
            idle += 1
            if idle < 20:
                continue
            with _lock:
                if _latest:
                    idle = 0
                    continue
                _started = False
                return
        idle = 0
        encoded = {}
        failures = []
        for slot, image in pending.items():
            err = None
            jpg = None
            try:
                jpg = _encode_one(image)
            except Exception as exc:
                err = 'Preview could not encode a frame (%s)' % exc
            else:
                if not jpg:
                    err = 'Preview could not encode a frame'
            with _lock:
                if _generation != gen:
                    encoded.clear()
                    failures.clear()
                    break
                if jpg:
                    encoded[slot] = jpg
                elif err:
                    failures.append(err)
        if not encoded and not failures:
            continue
        logged = None
        with _lock:
            if _generation != gen:
                continue
            if encoded:
                _jpeg.update(encoded)
                _error = ''
                _rev += 1
            elif failures:
                if _note_locked(failures[0]):
                    logged = failures[0]
        if logged:
            _log_once(logged)


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
        _latest[slot] = (_generation, image)
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
