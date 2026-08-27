"""
Device detector for serial-connected robotic arms.
Scans serial ports in parallel and identifies connected robot models.

Caching strategy:
- Once a port is identified as a robot, the result is cached.
- Cached ports are returned immediately without re-probing.
- Only new (unseen) ports are probed via serial.
- Ports that were previously identified as non-robot (returned None)
  are also cached so they aren't re-probed every scan.
- When a cached port disappears from the system's port list, it is
  kept for one extra scan cycle (grace period), then removed.

Background probing:
- New ports are probed in a background thread that waits indefinitely
  for a response (no timeout).
- A watchdog thread monitors the probe and cancels it if the port
  disappears from the system.
"""
import time
import threading

import sys
import serial
import serial.tools.list_ports
from concurrent.futures import ThreadPoolExecutor, as_completed
from .serial_manager import SerialManager
from .robots import FW_PREFIX_MAP
from .virtual_serial import is_virtual_port, virtual_device_entries, VIRTUAL_DEVICES


# Cache: port_device_path -> {model, description}
# model is str (e.g. 'Mirobot') or None (probed but not a robot)
_cache = {}

# Ports that were missing in the previous scan (grace period tracking).
# If a port is missing for two consecutive scans, it gets evicted.
_missing = set()

# Ports currently being probed in background (port -> threading.Event for cancellation)
_probing = {}

# Manually added ports — protected from eviction and unregistration
_manual_ports = set()

# Built-in virtual ports from robots.json (always available, never evicted)
_virtual_ports = {d['port'] for d in VIRTUAL_DEVICES}


def _seed_virtual_ports():
    """Ensure virtual ports from robots.json exist in the cache permanently."""
    for d in virtual_device_entries():
        port = d['port']
        if port not in _cache or _cache[port].get('model') is None:
            _cache[port] = {
                'model': d['model'],
                'description': d.get('description') or '(virtual)',
            }
        _missing.discard(port)


_seed_virtual_ports()


def add_manual_port(port, model, description=''):
    """Register a manually added port. It gets cached and connected
    through the same pipeline as auto-detected ports.

    WiFi endpoints fail loudly (unreachable IP is not kept).
    Serial / named paths always stay registered: a missing device file
    opens as a ghost connection so TX can still be sent (legacy manual-
    port behaviour, e.g. port name ``test``).
    """
    from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

    if is_wifi_endpoint(port):
        port = normalize_wifi_endpoint(port)
        if not description:
            description = '(wifi)'

    if is_virtual_port(port):
        # Virtual ports are always present; just (re)connect with model
        _cache[port] = {
            'model': model or _cache.get(port, {}).get('model'),
            'description': description or '(virtual)',
        }
        mgr = SerialManager.get_instance()
        if model:
            result = mgr.ensure_connected(port, model=model)
            if not result.get('success'):
                raise ConnectionError(
                    result.get('error') or f'Failed to connect to {port}'
                )
        return port

    is_wifi = is_wifi_endpoint(port)
    _cache[port] = {
        'model': model,
        'description': description or ('(wifi)' if is_wifi else '(manual)'),
    }
    _manual_ports.add(port)
    _missing.discard(port)
    mgr = SerialManager.get_instance()
    result = mgr.ensure_connected(port, model=model)
    if not result.get('success'):
        if is_wifi:
            # Unreachable WiFi should not stick in the port list
            _manual_ports.discard(port)
            _cache.pop(port, None)
            try:
                mgr.unregister_port(port)
            except Exception:
                pass
            raise ConnectionError(
                result.get('error') or f'Failed to connect to {port}'
            )
        # Serial / arbitrary names: keep registration even if open failed
        # (ghost path usually makes connect succeed; this is a safety net).
    return port


def remove_manual_port(port):
    """Remove a manually added port and unregister it.
    Built-in virtual ports cannot be removed."""
    from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

    if is_wifi_endpoint(port):
        port = normalize_wifi_endpoint(port)
    if is_virtual_port(port):
        return
    _manual_ports.discard(port)
    _cache.pop(port, None)
    mgr = SerialManager.get_instance()
    mgr.unregister_port(port)


def _probe_firmware(ser, cancel_event=None, max_attempts=120, resend_s=5.0):
    """
    Send $V on an open link and parse FW_PREFIX_MAP responses.

    Returns model name or None. Does not close *ser*.
    """
    model = None
    try:
        if hasattr(ser, 'flushInput'):
            ser.flushInput()
        if hasattr(ser, 'flushOutput'):
            ser.flushOutput()
    except Exception:
        pass

    ser.write(b"$V\r\n")
    time.sleep(0.3)

    attempts = 0
    last_v_time = time.time()

    while attempts < max_attempts:
        if cancel_event and cancel_event.is_set():
            break

        raw = ser.readline()
        if not raw:
            attempts += 1
            if time.time() - last_v_time >= resend_s:
                try:
                    ser.write(b"$V\r\n")
                except Exception:
                    break
                last_v_time = time.time()
            continue

        if isinstance(raw, (bytes, bytearray)):
            message = raw.decode('utf-8', errors='ignore').strip()
        else:
            message = str(raw).strip()
        if not message:
            continue

        # Skip auto-report status messages (start with '<')
        if message.startswith('<'):
            if time.time() - last_v_time >= 2.0:
                try:
                    ser.write(b"$V\r\n")
                except Exception:
                    break
                last_v_time = time.time()
            continue

        for prefix, model_name in FW_PREFIX_MAP.items():
            if message.startswith(prefix):
                model = model_name
                break
        if model:
            break

        attempts += 1

    return model


def detect_model(port, keep_open=False, cancel_event=None):
    """
    Probe a serial port or WiFi IP to determine the connected robot model.

    The robot may be continuously sending auto-report status messages like:
    <Alarm,Angle(ABCDXYZ):0.000,...>

    We send $V and look for the firmware response (e.g. "Mirobot fw...")
    among the incoming messages. The firmware line starts with "Mirobot" or "E4".

    For serial ports the probe can wait a long time (cancel_event for watchdog).
    For WiFi IPs we fail fast if the host is unreachable.

    Args:
        port (str): Serial path (e.g. 'COM3') or IPv4 (e.g. '192.168.1.10'
                    or '192.168.1.10:7676').
        keep_open (bool): If True, return the open connection along
                          with the model (for reuse by SerialManager).
        cancel_event (threading.Event): If set, abort the probe.

    Returns:
        If keep_open=False: str or None (model name or None if not recognized)
        If keep_open=True: (model, serial_obj) tuple. serial_obj is None if
                           detection failed or model not recognized.
    """
    from .wifi_link import is_wifi_endpoint, open_wifi_link, normalize_wifi_endpoint

    ser = None
    model = None
    wifi = is_wifi_endpoint(port)
    if wifi:
        port = normalize_wifi_endpoint(port)

    try:
        if wifi:
            # Fail fast on bad IP / closed TCP port
            ser = open_wifi_link(port, timeout=0.5)
            # WiFi: shorter wait (~8s) — unreachable hosts already raised
            model = _probe_firmware(
                ser, cancel_event=cancel_event,
                max_attempts=16, resend_s=2.0,
            )
        else:
            # Use a short timeout for readline so we can check cancel_event
            ser = serial.Serial(port, 115200, timeout=0.5)
            model = _probe_firmware(
                ser, cancel_event=cancel_event,
                max_attempts=120, resend_s=5.0,
            )

    except (serial.SerialException, OSError, PermissionError, ConnectionError, TimeoutError, ValueError) as e:
        # PermissionError: on Linux/Chromebook, user may not have serial access.
        # ConnectionError: WiFi host unreachable / connection refused.
        if ser:
            try:
                ser.close()
            except Exception:
                pass
            ser = None
        # Stash last error for probe-port API (thread-local-ish via attribute)
        detect_model.last_error = str(e)
        if keep_open:
            return (None, None)
        return None

    detect_model.last_error = None

    if keep_open:
        if model:
            try:
                ser.timeout = 0.1
            except Exception:
                pass
            return (model, ser)
        else:
            if ser:
                try:
                    ser.close()
                except Exception:
                    pass
            return (None, None)
    else:
        if ser:
            try:
                ser.close()
            except Exception:
                pass
        return model


# Last open/probe error message (for API responses)
detect_model.last_error = None


def _background_probe(port, description):
    """
    Probe a port in the background. Waits indefinitely for response.
    A watchdog monitors if the port disappears and cancels the probe.
    """
    cancel_event = threading.Event()
    _probing[port] = cancel_event

    def watchdog():
        """Monitor if port disappears from system, cancel probe if so."""
        while not cancel_event.is_set():
            time.sleep(1.0)
            current_ports = {p.device for p in serial.tools.list_ports.comports()}
            if port not in current_ports:
                cancel_event.set()
                break

    def probe():
        try:
            print(f"[detector] Starting probe for {port}")
            model, ser = detect_model(port, keep_open=True, cancel_event=cancel_event)
            print(f"[detector] Probe result for {port}: model={model}")
            if model:
                _cache[port] = {'model': model, 'description': description}
                # Register with SerialManager
                mgr = SerialManager.get_instance()
                mgr.ensure_connected(port, model=model, existing_serial=ser)
            else:
                _cache[port] = {'model': None, 'description': description}
                if ser:
                    try:
                        ser.close()
                    except Exception:
                        pass
        except Exception as e:
            print(f"[detector] Probe error for {port}: {e}")
            _cache[port] = {'model': None, 'description': description}
        finally:
            _probing.pop(port, None)
            cancel_event.set()  # Stop watchdog

    watchdog_thread = threading.Thread(target=watchdog, daemon=True)
    probe_thread = threading.Thread(target=probe, daemon=True)

    watchdog_thread.start()
    probe_thread.start()


# Ports to skip on macOS/Linux (Bluetooth, debug consoles, etc.)
_IGNORED_PATTERNS = [
    '/dev/cu.debug-console',
    '/dev/cu.Bluetooth-Incoming-Port',
    '/dev/cu.AirplusPro',
    '/dev/tty.debug-console',
    '/dev/tty.Bluetooth-Incoming-Port',
    '/dev/tty.AirplusPro',
]


def _is_ignored_port(device):
    """Return True if this port should be skipped (Bluetooth, debug, etc.)."""
    for pattern in _IGNORED_PATTERNS:
        if device == pattern or device.startswith(pattern):
            return True
    lower = device.lower()
    if 'bluetooth' in lower or 'debug-console' in lower:
        return True
    return False


def _dedup_platform_ports(ports):
    """Platform-specific port deduplication.
    macOS: /dev/cu.X and /dev/tty.X are the same device — prefer /dev/cu.X.
    Linux/Chromebook: no dedup needed (/dev/ttyUSB*, /dev/ttyACM* are unique)."""
    if sys.platform != 'darwin':
        return ports

    cu_set = {p.device for p in ports if p.device.startswith('/dev/cu.')}
    result = []
    for p in ports:
        if p.device.startswith('/dev/tty.'):
            cu_equiv = '/dev/cu.' + p.device[len('/dev/tty.'):]
            if cu_equiv in cu_set:
                continue  # skip tty, cu variant will be kept
        result.append(p)
    return result


def _probe_port(port_info):
    """Probe a single port. Returns (device_path, model, description, serial_obj).
    Skips ports that are already connected or locked for flashing.
    serial_obj is the open serial connection if detection succeeded (for reuse)."""
    mgr = SerialManager.get_instance()
    if port_info.device in mgr._flash_locked:
        return (port_info.device, _cache.get(port_info.device, {}).get('model'), port_info.description or '', None)
    for reg in mgr.get_registered_ports():
        if reg['port'] == port_info.device and reg['connected']:
            # Already connected — return cached model without probing
            return (port_info.device, reg['model'], port_info.description or '', None)

    model, ser = detect_model(port_info.device, keep_open=True)
    return (port_info.device, model, port_info.description or '', ser)


def scan_devices():
    """
    Scan all available serial ports in parallel and return only those
    with a recognized robotic arm. Uses caching to avoid re-probing
    known ports.

    Returns:
        dict: {
            'ports': [
                {
                    'port': 'COM3',
                    'description': 'USB Serial Device',
                    'model': 'Mirobot' | 'MT4'
                },
                ...
            ]
        }
    """
    global _missing

    all_ports = [p for p in serial.tools.list_ports.comports()
                 if not _is_ignored_port(p.device)]
    all_ports = _dedup_platform_ports(all_ports)
    current_devices = {p.device for p in all_ports}

    # Keep virtual devices seeded every scan
    _seed_virtual_ports()

    # --- Evict ports that have been missing for two consecutive scans ---
    # Manual + virtual ports are never evicted.
    still_missing = _missing - current_devices - _manual_ports - _virtual_ports
    for port in still_missing:
        _cache.pop(port, None)
    _missing = {
        p for p in _cache
        if p not in current_devices and p not in _manual_ports and p not in _virtual_ports
    }

    # --- Identify which ports need probing ---
    # Skip ports already cached, already being probed, or locked for flashing
    mgr = SerialManager.get_instance()
    to_probe = []
    for p in all_ports:
        if p.device in _cache:
            continue  # Already probed
        if p.device in _probing:
            continue  # Currently being probed in background
        if p.device in mgr._flash_locked:
            continue  # Locked for firmware flashing
        # Check if already connected
        already_connected = False
        for reg in mgr.get_registered_ports():
            if reg['port'] == p.device and reg['connected']:
                already_connected = True
                break
        if already_connected:
            continue
        to_probe.append(p)

    # --- Start background probes for new ports ---
    # These run indefinitely until device responds or port disappears
    for p in to_probe:
        _background_probe(p.device, p.description or '')

    # --- Build results from cache (already detected devices) ---
    results = []
    current_robot_ports = set()

    for device, info in _cache.items():
        if info['model'] is not None:
            # Ensure robot is registered with SerialManager
            mgr.ensure_connected(device, model=info['model'])
            current_robot_ports.add(device)
            conn = mgr._ports.get(device)
            results.append({
                'port': device,
                'description': info['description'],
                'model': info['model'],
                'connected': conn.connected if conn else False,
                'manual': device in _manual_ports,
                'virtual': device in _virtual_ports,
            })

    # Include ports currently being probed (show as "Detecting...")
    for port in _probing:
        if port not in current_robot_ports:
            # Find description from all_ports
            desc = ''
            for p in all_ports:
                if p.device == port:
                    desc = p.description or ''
                    break
            results.append({
                'port': port,
                'description': desc,
                'model': 'Detecting...',
                'connected': False,
            })

    # Unregister ports that were previously registered but no longer detected
    # Manual + virtual ports are never unregistered by the scan cycle.
    for reg in mgr.get_registered_ports():
        if (reg['port'] not in current_robot_ports
                and reg['port'] not in _cache
                and reg['port'] not in _manual_ports
                and reg['port'] not in _virtual_ports):
            mgr.unregister_port(reg['port'])

    # Virtual ports first so they stay visible even with real hardware
    def _sort_key(r):
        if r.get('virtual'):
            return (0, r['port'])
        return (1, r['port'])

    results.sort(key=_sort_key)
    return {'ports': results}