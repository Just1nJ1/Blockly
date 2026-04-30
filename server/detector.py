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


# Cache: port_device_path -> {model, description}
# model is str (e.g. 'Mirobot') or None (probed but not a robot)
_cache = {}

# Ports that were missing in the previous scan (grace period tracking).
# If a port is missing for two consecutive scans, it gets evicted.
_missing = set()

# Ports currently being probed in background (port -> threading.Event for cancellation)
_probing = {}


def detect_model(port, keep_open=False, cancel_event=None):
    """
    Probe a serial port to determine the connected robot model.

    The robot may be continuously sending auto-report status messages like:
    <Alarm,Angle(ABCDXYZ):0.000,...>

    We send $V and look for the firmware response (e.g. "Mirobot fw...")
    among the incoming messages. The firmware line starts with "Mirobot" or "E4".

    The probe waits indefinitely for a response (no timeout), but can be
    cancelled via the cancel_event. A watchdog thread monitors the probe
    and sets the cancel_event if the port disappears.

    Args:
        port (str): The serial port path (e.g. 'COM3', '/dev/ttyUSB0').
        keep_open (bool): If True, return the open serial connection along
                          with the model (for reuse by SerialManager).
        cancel_event (threading.Event): If set, abort the probe.

    Returns:
        If keep_open=False: str or None (model name or None if not recognized)
        If keep_open=True: (model, serial_obj) tuple. serial_obj is None if
                           detection failed or model not recognized.
    """
    ser = None
    model = None
    try:
        # Use a short timeout for readline so we can check cancel_event periodically
        ser = serial.Serial(port, 115200, timeout=0.5)
        ser.flushInput()
        ser.flushOutput()

        # Send $V to request firmware version
        # Response will be mixed with auto-report status messages
        ser.write("$V\r\n".encode("utf-8"))
        time.sleep(0.5)  # Give device time to process and respond

        # Read lines and look for firmware response among status messages
        # Max attempts prevents infinite loop if device never responds to $V
        max_attempts = 120  # 120 * 0.5s timeout = 60 seconds max wait
        attempts = 0
        last_v_time = time.time()

        while attempts < max_attempts:
            if cancel_event and cancel_event.is_set():
                break  # Cancelled by watchdog

            raw = ser.readline()
            if not raw:
                # Timeout, no data - send $V again periodically
                attempts += 1
                if time.time() - last_v_time >= 5.0:
                    ser.write("$V\r\n".encode("utf-8"))
                    last_v_time = time.time()
                continue

            message = raw.decode('utf-8', errors='ignore').strip()
            if not message:
                continue

            # Skip auto-report status messages (start with '<')
            if message.startswith('<'):
                # Resend $V periodically even while receiving status
                if time.time() - last_v_time >= 2.0:
                    ser.write("$V\r\n".encode("utf-8"))
                    last_v_time = time.time()
                continue

            # Check for firmware version response
            if message.startswith("Mirobot"):
                model = "Mirobot"
                break
            if message.startswith("E4"):
                model = "MT4"
                break

            attempts += 1

    except (serial.SerialException, OSError, PermissionError):
        # PermissionError: on Linux/Chromebook, user may not have serial access.
        # Fix: add user to 'dialout' group: sudo usermod -aG dialout $USER
        if ser:
            try:
                ser.close()
            except Exception:
                pass
        if keep_open:
            return (None, None)
        return None

    if keep_open:
        if model:
            # Reset timeout for normal operation
            ser.timeout = 0.1
            return (model, ser)
        else:
            if ser:
                ser.close()
            return (None, None)
    else:
        if ser:
            ser.close()
        return model


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

    # --- Evict ports that have been missing for two consecutive scans ---
    still_missing = _missing - current_devices  # missing again
    for port in still_missing:
        _cache.pop(port, None)
    # Ports cached but not present this scan enter the grace period
    _missing = {p for p in _cache if p not in current_devices}

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
            results.append({
                'port': device,
                'description': info['description'],
                'model': info['model']
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
                'model': 'Detecting...'
            })

    # Unregister ports that were previously registered but no longer detected
    for reg in mgr.get_registered_ports():
        if reg['port'] not in current_robot_ports and reg['port'] not in _cache:
            mgr.unregister_port(reg['port'])

    results.sort(key=lambda r: r['port'])
    return {'ports': results}