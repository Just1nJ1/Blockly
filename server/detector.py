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
"""
import time

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


def detect_model(port, keep_open=False):
    """
    Probe a serial port to determine the connected robot model.

    Sends $V twice:
    1. First $V wakes up the device and clears any boot messages
    2. Second $V gets a clean response with model/firmware info

    Args:
        port (str): The serial port path (e.g. 'COM3', '/dev/ttyUSB0').
        keep_open (bool): If True, return the open serial connection along
                          with the model (for reuse by SerialManager).

    Returns:
        If keep_open=False: str or None (model name or None if not recognized)
        If keep_open=True: (model, serial_obj) tuple. serial_obj is None if
                           detection failed or model not recognized.
    """
    ser = None
    model = None
    try:
        ser = serial.Serial(port, 115200, timeout=2)
        ser.flushInput()
        ser.flushOutput()

        # First $V: wake up device and clear any boot/garbage messages
        ser.write("$V\r\n".encode("utf-8"))
        time.sleep(0.3)  # Give device time to respond
        ser.flushInput()  # Discard all responses from first $V

        # Second $V: get clean response
        ser.write("$V\r\n".encode("utf-8"))

        # Read up to 5 lines (timeout=2s per read)
        for _ in range(5):
            raw = ser.readline()
            if not raw:
                break  # timeout, no more data
            message = raw.decode('utf-8', errors='ignore').strip()
            if not message:
                continue
            if message.startswith("Mirobot"):
                model = "Mirobot"
                break
            if message.startswith("E4"):
                model = "MT4"
                break
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

    # --- Identify which ports need probing (not in cache at all) ---
    to_probe = [p for p in all_ports if p.device not in _cache]
    # to_probe = all_ports


    # --- Probe new ports in parallel ---
    # Store open serial connections to pass to SerialManager
    _pending_serials = {}  # device -> serial_obj

    if to_probe:
        with ThreadPoolExecutor(max_workers=min(len(to_probe), 8)) as pool:
            futures = {pool.submit(_probe_port, p): p for p in to_probe}
            for future in as_completed(futures):
                device, model, description, ser = future.result()
                _cache[device] = {'model': model, 'description': description}
                if ser:
                    _pending_serials[device] = ser

    # --- Register detected robots in the SerialManager ---
    mgr = SerialManager.get_instance()
    results = []
    current_robot_ports = set()

    for device, info in _cache.items():
        if info['model'] is not None:
            # Auto-connect detected robots (creates SDK instance + read thread)
            # Uses ensure_connected so it doesn't change the active port
            # Pass the open serial connection if we have one (avoids reconnect)
            existing_ser = _pending_serials.pop(device, None)
            mgr.ensure_connected(device, model=info['model'], existing_serial=existing_ser)
            current_robot_ports.add(device)
            results.append({
                'port': device,
                'description': info['description'],
                'model': info['model']
            })

    # Close any remaining unused serial connections
    for ser in _pending_serials.values():
        try:
            ser.close()
        except Exception:
            pass

    # Unregister ports that were previously registered but no longer detected
    for reg in mgr.get_registered_ports():
        if reg['port'] not in current_robot_ports and reg['port'] not in _cache:
            mgr.unregister_port(reg['port'])

    results.sort(key=lambda r: r['port'])
    return {'ports': results}