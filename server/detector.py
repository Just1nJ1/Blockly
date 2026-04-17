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


def detect_model(port):
    """
    Probe a serial port to determine the connected robot model.

    Args:
        port (str): The serial port path (e.g. 'COM3', '/dev/ttyUSB0').

    Returns:
        str or None: The model name (e.g. 'Mirobot', 'MT4') if a known
                     robotic arm is detected, or None if the device is
                     not recognized.
    """
    try:
        with serial.Serial(port, 115200, timeout=5) as ser:
            ser.flushInput()
            ser.flushOutput()
            ser.write("$V\r\n".encode("utf-8"))
            # Read up to 5 lines (timeout=5s per read handles slow responses)
            for _ in range(5):
                raw = ser.readline()
                if not raw:
                    break  # timeout, no more data
                message = raw.decode('utf-8', errors='ignore').strip()
                if not message:
                    continue
                if message.startswith("Mirobot"):
                    return "Mirobot"
                if message.startswith("E4"):
                    return "MT4"
    except (serial.SerialException, OSError):
        return None

    return None


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


def _dedup_macos_ports(ports):
    """On macOS, /dev/cu.X and /dev/tty.X are the same device.
    Prefer /dev/cu.X (opens without waiting for carrier detect).
    Drop /dev/tty.X when a matching /dev/cu.X exists."""
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
    """Probe a single port. Returns (device_path, model, description).
    Skips ports that are already connected in the SerialManager."""
    mgr = SerialManager.get_instance()
    for reg in mgr.get_registered_ports():
        if reg['port'] == port_info.device and reg['connected']:
            # Already connected — return cached model without probing
            return (port_info.device, reg['model'], port_info.description or '')

    model = detect_model(port_info.device)
    return (port_info.device, model, port_info.description or '')


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
    all_ports = _dedup_macos_ports(all_ports)
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
    if to_probe:
        with ThreadPoolExecutor(max_workers=min(len(to_probe), 8)) as pool:
            futures = {pool.submit(_probe_port, p): p for p in to_probe}
            for future in as_completed(futures):
                device, model, description = future.result()
                _cache[device] = {'model': model, 'description': description}

    # --- Register detected robots in the SerialManager ---
    mgr = SerialManager.get_instance()
    results = []
    current_robot_ports = set()

    for device, info in _cache.items():
        if info['model'] is not None:
            # Auto-connect detected robots (creates SDK instance + read thread)
            # Uses ensure_connected so it doesn't change the active port
            mgr.ensure_connected(device, model=info['model'])
            current_robot_ports.add(device)
            results.append({
                'port': device,
                'description': info['description'],
                'model': info['model']
            })

    # Unregister ports that were previously registered but no longer detected
    for reg in mgr.get_registered_ports():
        if reg['port'] not in current_robot_ports and reg['port'] not in _cache:
            mgr.unregister_port(reg['port'])

    results.sort(key=lambda r: r['port'])
    return {'ports': results}