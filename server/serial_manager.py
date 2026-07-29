"""
Serial manager for shared serial port access.

Provides:
- Per-port connections, each with its own read thread and message history
- A proxy serial object that the SDK can use transparently:
  - readline() reads from a buffered history queue via a cursor
  - flushInput() advances the cursor to the end (discards unread)
  - write() goes through the real serial and logs to history
  - in_waiting reflects unread lines in the buffer
- The active port is the one currently selected in the Command tab
"""

import sys
import os
import re
import serial
import threading
import time
from datetime import datetime

# Add the bundled wlkatapython SDK to the path
_SDK_PATH = os.path.join(os.path.dirname(__file__), '..', 'resources', 'python',
                         'lib', 'python3.12', 'site-packages')
if _SDK_PATH not in sys.path:
    sys.path.insert(0, os.path.abspath(_SDK_PATH))

import wlkatapython

try:
    from wlkatapython.transports.base import Transport as _WlkataTransport
except ImportError:  # pragma: no cover
    _WlkataTransport = object

# ── Session communication log (raw TX/RX for debugging) ──────────
# Written under ~/.wlkata-studiox/logs/comm-YYYYMMDD-HHMMSS.log
_COMM_LOG_DIR = os.path.join(
    os.path.expanduser('~'), '.wlkata-studiox', 'logs'
)
_comm_log_path = None
_comm_log_file = None
_comm_log_lock = threading.Lock()


def _ensure_comm_log():
    """Open (once) a session log file for all port traffic."""
    global _comm_log_path, _comm_log_file
    with _comm_log_lock:
        if _comm_log_file is not None:
            return _comm_log_path
        try:
            os.makedirs(_COMM_LOG_DIR, exist_ok=True)
            stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
            _comm_log_path = os.path.join(_COMM_LOG_DIR, f'comm-{stamp}.log')
            _comm_log_file = open(_comm_log_path, 'a', encoding='utf-8', buffering=1)
            _comm_log_file.write(
                f'# StudioX communication log started {datetime.now().isoformat()}\n'
                f'# Columns: ISO-timestamp | port | dir | source | text\n'
                f'# dir: tx=host→robot, rx=robot→host, auto-status, sys\n'
            )
            _comm_log_file.flush()
            print(f'[SerialManager] Communication log: {_comm_log_path}')
        except Exception as e:
            print(f'[SerialManager] Could not open comm log: {e}')
            _comm_log_path = None
            _comm_log_file = None
        return _comm_log_path


def get_comm_log_path():
    """Return the path of the current session communication log (creates if needed)."""
    return _ensure_comm_log()


def write_comm_log(port, direction, text, source=None):
    """Append one line of raw traffic to the session communication log."""
    path = _ensure_comm_log()
    if not path or _comm_log_file is None:
        return
    try:
        ts = datetime.now().isoformat(timespec='milliseconds')
        # Single-line: collapse newlines in payload for greppability
        payload = (text or '').replace('\r', '\\r').replace('\n', '\\n')
        src = source or '-'
        line = f'{ts}\t{port or "-"}\t{direction}\t{src}\t{payload}\n'
        with _comm_log_lock:
            if _comm_log_file is not None:
                _comm_log_file.write(line)
                _comm_log_file.flush()
    except Exception:
        pass

# Map model names to SDK classes
_MODEL_CLASSES = {
    'Mirobot': wlkatapython.Mirobot_UART,
    'MT4': wlkatapython.MT4_UART,
    'E4': wlkatapython.E4_UART,
}

# Regex for the status line auto-reported by the robot after $40=1
_STATUS_RE = re.compile(
    r'<(\w+),Angle\(ABCDXYZ\):([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),'
    r'Cartesian coordinate\(XYZ RxRyRz\):([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),'
    r'Pump PWM:([\d.-]+),Valve PWM:([\d.-]+),Motion_MODE:([\d.-]+)>'
)


def _extract_version(raw):
    """Return the part after the first comma, e.g. 'EXbox,20230710' -> '20230710'.
    Returns the original string unchanged if there is no comma."""
    idx = raw.find(',')
    return raw[idx + 1:].strip() if idx != -1 else raw.strip()


class PortConnection:
    """Manages a single serial port connection with history and read thread."""

    def __init__(self, port, model=None, baudrate=115200):
        self.port = port
        self.model = model
        self.baudrate = baudrate

        self._serial = None
        self.connected = False

        # Background read thread
        self._read_thread = None
        self._stop_event = threading.Event()

        # Thread-safe write lock
        self.write_lock = threading.Lock()

        # Message history for this port: list of {id, dir, text, source, ts}
        self._history = []
        self._history_lock = threading.Lock()
        self._next_id = 0

        # RX line buffer: the read thread appends lines here.
        # The SDK proxy reads from this via a cursor (_rx_cursor).
        self._rx_lines = []        # list of received line strings
        self._rx_lock = threading.Lock()
        self._rx_event = threading.Event()  # signaled when a new line arrives
        self._rx_cursor = 0        # SDK's read position in _rx_lines

        # SDK robot instance (initialized on connect)
        self.robot = None

        # Silent mode: when True, add_history is suppressed
        self._silent = False

        # Cached status from auto-report ($40=1) or explicit ? query
        self._last_status = None
        self._last_status_ts = 0

        # When True, the next status line should be recorded in history
        # (set when sending explicit ? query from command tab)
        self._awaiting_query = False

        # Cached firmware version fetched once on connect
        # None = not yet fetched; dict = {extender, robot} after fetch
        self._firmware_version = None

    # ── Connection lifecycle ──

    def connect(self, existing_serial=None):
        """Connect to the port. If existing_serial is provided, reuse it
        instead of opening a new connection (faster, avoids reconnect delay).

        Backends:
          - VirtualMirobot / VirtualMT4 → VirtualSerial (SDK simulator)
          - IPv4 / IPv4:port → WifiLink (wlkatapython WifiTransport, UDP)
          - otherwise → pyserial serial.Serial
        """
        if self.connected:
            self.disconnect()
        try:
            from .virtual_serial import is_virtual_port, VirtualSerial
            from .wifi_link import is_wifi_endpoint, open_wifi_link, normalize_wifi_endpoint

            # Canonicalize WiFi keys (e.g. "192.168.1.1:8234" → "192.168.1.1")
            if is_wifi_endpoint(self.port):
                self.port = normalize_wifi_endpoint(self.port)

            if existing_serial and getattr(existing_serial, 'is_open', False):
                self._serial = existing_serial
                if hasattr(self._serial, 'timeout'):
                    self._serial.timeout = 0.1
            elif is_virtual_port(self.port):
                self._serial = VirtualSerial(
                    self.port, model=self.model or 'Mirobot',
                    baudrate=self.baudrate, timeout=0.1,
                )
            elif is_wifi_endpoint(self.port):
                self._serial = open_wifi_link(self.port, timeout=0.1)
            else:
                self._serial = serial.Serial(self.port, self.baudrate, timeout=0.1)

            self.connected = True
            self._stop_event.clear()
            self._read_thread = threading.Thread(
                target=self._read_loop, daemon=True)
            self._read_thread.start()

            # Create SDK robot instance with a ProxySerial
            self._init_robot()

            # Enable auto-report: robot sends status after each movement completes
            if is_virtual_port(self.port):
                time.sleep(0.05)
            elif is_wifi_endpoint(self.port):
                time.sleep(0.15)
            else:
                time.sleep(0.3)
            self._serial.write(b'$40=1\r\n')
            self.add_history('tx', '$40=1', source='connect')

            if is_virtual_port(self.port):
                kind = 'virtual'
            elif is_wifi_endpoint(self.port):
                kind = 'wifi'
            else:
                kind = 'serial'
            self.add_history(
                'sys',
                f'Connected to {self.port} ({self.model or "unknown"}, {kind})',
            )
            return True
        except Exception as e:
            self.connected = False
            # Clean up partial open
            if self._serial is not None:
                try:
                    self._serial.close()
                except Exception:
                    pass
                self._serial = None
            self.add_history('sys', f'Connection failed: {e}')
            return False

    def _init_robot(self):
        """Create and initialize the SDK robot instance for this port."""
        cls = _MODEL_CLASSES.get(self.model, wlkatapython.Mirobot_UART)
        self.robot = cls()
        proxy = ProxySerial(self)
        self.robot.init(proxy, -1)

    def disconnect(self):
        self._stop_event.set()
        if self._read_thread and self._read_thread.is_alive():
            self._read_thread.join(timeout=2)
        if self._serial and self._serial.is_open:
            try:
                self._serial.close()
            except Exception:
                pass
        self.connected = False
        self._serial = None
        self._firmware_version = None
        self.add_history('sys', f'Disconnected from {self.port}')

    # ── History ──

    def add_history(self, direction, text, source=None):
        # Always append to session file log (even in silent mode for true raw trail)
        try:
            write_comm_log(self.port, direction, text, source=source)
        except Exception:
            pass

        if self._silent:
            return
        with self._history_lock:
            entry = {
                'id': self._next_id,
                'dir': direction,
                'text': text,
                'ts': time.time()
            }
            if source:
                entry['source'] = source
            self._history.append(entry)
            self._next_id += 1

    def get_history(self, since=0):
        with self._history_lock:
            return [e for e in self._history if e['id'] >= since]

    # ── Background read thread ──

    def _read_loop(self):
        while not self._stop_event.is_set():
            if not self._serial or not self._serial.is_open:
                time.sleep(0.1)
                continue
            try:
                # Serial: only read when OS buffer has bytes.
                # WiFi / some adapters set _poll_always and rely on readline timeout.
                poll_always = bool(getattr(self._serial, '_poll_always', False))
                waiting = 0
                try:
                    waiting = int(self._serial.in_waiting or 0)
                except Exception:
                    waiting = 0

                if waiting > 0 or poll_always:
                    raw = self._serial.readline()
                    if not raw:
                        if not poll_always:
                            time.sleep(0.02)
                        continue
                    line = raw.decode('utf-8', errors='ignore').strip() if isinstance(raw, (bytes, bytearray)) else str(raw).strip()
                    if line:
                        # Check if this is an auto-reported status line
                        m = _STATUS_RE.match(line)
                        if m:
                            self._parse_and_cache_status(m)
                            if self._awaiting_query:
                                # Explicit ? query: show as normal rx in Command tab
                                self._awaiting_query = False
                                self.add_history('rx', line)
                            else:
                                # Auto-report after motion ($40=1): gray in Command tab
                                self.add_history('auto-status', line)
                            # ALWAYS deliver status to the SDK RX buffer.
                            # waitIdle(event) blocks on pSerial.readline() →
                            # ProxySerial.rx_readline and must see Idle here.
                            # Previously auto-status was UI-only, so waitIdle
                            # sat until the full timeout (~30s) even though
                            # Idle already appeared in the Command log.
                            with self._rx_lock:
                                self._rx_lines.append(line)
                                self._rx_event.set()
                        else:
                            self.add_history('rx', line)
                            if line.lower() != 'ok':
                                with self._rx_lock:
                                    self._rx_lines.append(line)
                                    self._rx_event.set()
                else:
                    time.sleep(0.02)
            except (serial.SerialException, OSError, ConnectionError, TimeoutError):
                self.add_history('sys', 'Read error - connection lost')
                self.connected = False
                break
            except Exception:
                time.sleep(0.02)

    def _parse_and_cache_status(self, match):
        """Parse a status regex match and cache the result."""
        self._last_status = {
            'state': match.group(1),
            'angles': {
                'A': float(match.group(2)), 'B': float(match.group(3)),
                'C': float(match.group(4)), 'D': float(match.group(5)),
                'X': float(match.group(6)), 'Y': float(match.group(7)),
                'Z': float(match.group(8)),
            },
            'coordinates': {
                'X': float(match.group(9)), 'Y': float(match.group(10)),
                'Z': float(match.group(11)), 'Rx': float(match.group(12)),
                'Ry': float(match.group(13)), 'Rz': float(match.group(14)),
            },
            'pump': float(match.group(15)),
            'valve': float(match.group(16)),
            'mode': float(match.group(17)),
        }
        self._last_status_ts = time.time()

    # ── SDK-compatible read interface ──

    @property
    def rx_unread_count(self):
        """Number of unread lines in the RX buffer (like in_waiting)."""
        with self._rx_lock:
            return len(self._rx_lines) - self._rx_cursor

    def rx_readline(self, timeout=1.0):
        """Read the next unread line from the RX buffer.
        Blocks up to timeout seconds if no line is available.
        Returns the line string, or b'' if timeout."""
        deadline = time.time() + timeout
        while True:
            with self._rx_lock:
                if self._rx_cursor < len(self._rx_lines):
                    line = self._rx_lines[self._rx_cursor]
                    self._rx_cursor += 1
                    return (line + '\n').encode('utf-8')
            remaining = deadline - time.time()
            if remaining <= 0:
                return b''
            self._rx_event.clear()
            self._rx_event.wait(timeout=min(remaining, 0.1))

    def rx_flush_input(self):
        """Advance the read cursor to the end (discard unread lines)."""
        with self._rx_lock:
            self._rx_cursor = len(self._rx_lines)
            self._rx_event.clear()

    def rx_flush_output(self):
        """No-op for output flush (writes go directly to serial)."""
        if self._serial and self._serial.is_open:
            self._serial.flushOutput()

    # ── Send commands ──

    def send_raw(self, command, source='command'):
        """Send a raw command. The response will appear in history via
        the read thread — the Command tab polls history to see it."""
        if not self.connected or not self._serial:
            return {'success': False, 'error': 'Not connected'}

        with self.write_lock:
            try:
                self.add_history('tx', command, source=source)
                if command.strip() == '?':
                    self._awaiting_query = True
                msg = command.strip() + '\r\n'
                self._serial.write(msg.encode('utf-8'))
                return {'success': True}
            except Exception as e:
                return {'success': False, 'error': str(e)}

    def send_and_wait(self, command, timeout=1.5):
        """Send a command, flush stale rx, then block until the first
        response line arrives (or timeout).  Returns the response text."""
        if not self.connected or not self._serial:
            return {'success': False, 'error': 'Not connected'}

        try:
            with self.write_lock:
                self.rx_flush_input()
                self.add_history('tx', command, source='command')
                if command.strip() == '?':
                    self._awaiting_query = True
                self._serial.write((command.strip() + '\r\n').encode('utf-8'))
        except Exception as e:
            return {'success': False, 'error': str(e)}

        line = self.rx_readline(timeout=timeout)
        response = line.decode('utf-8', errors='ignore').strip() if line else ''
        return {'success': True, 'response': response}

    def fetch_firmware_version(self):
        """Call version() on the robot and cache the result.
        Returns dict with keys: extender (str or None), robot (str or None).
        Version strings like 'EXbox,20230710' are trimmed to the part after the comma."""
        if self._firmware_version is not None:
            print(f'[FW-DEBUG] {self.port}: returning cached version: {self._firmware_version}')
            return {'success': True, **self._firmware_version}
        if not self.robot:
            print(f'[FW-DEBUG] {self.port}: no robot instance')
            return {'success': False, 'error': 'No robot instance'}
        try:
            print(f'[FW-DEBUG] {self.port}: calling robot.version()...')
            v = self.robot.version()
            print(f'[FW-DEBUG] {self.port}: raw version response: {repr(v)} (type: {type(v).__name__})')

            if isinstance(v, (list, tuple)) and len(v) >= 2:
                ext_raw, robot_raw = str(v[0]), str(v[1])
                ext_parsed = _extract_version(ext_raw)
                robot_parsed = _extract_version(robot_raw)
                print(f'[FW-DEBUG] {self.port}: list/tuple with 2+ items')
                print(f'[FW-DEBUG]   extender raw: {repr(ext_raw)} -> parsed: {repr(ext_parsed)}')
                print(f'[FW-DEBUG]   robot raw: {repr(robot_raw)} -> parsed: {repr(robot_parsed)}')
                self._firmware_version = {
                    'extender': ext_parsed,
                    'robot':    robot_parsed,
                }
            elif isinstance(v, str) and '查询失败' in v:
                print(f'[FW-DEBUG] {self.port}: query failed (查询失败)')
                self._firmware_version = {'extender': None, 'robot': None}
            else:
                robot_parsed = _extract_version(str(v)) if v is not None else None
                print(f'[FW-DEBUG] {self.port}: single value or other type')
                print(f'[FW-DEBUG]   raw: {repr(v)} -> robot parsed: {repr(robot_parsed)}')
                self._firmware_version = {
                    'extender': None,
                    'robot':    robot_parsed,
                }
            print(f'[FW-DEBUG] {self.port}: final result: {self._firmware_version}')
            return {'success': True, **self._firmware_version}
        except Exception as e:
            import traceback
            print(f'[FW-DEBUG] {self.port}: exception: {e}')
            traceback.print_exc()
            return {'success': False, 'error': str(e)}

    @property
    def raw_serial(self):
        return self._serial


class ProxySerial(_WlkataTransport):
    """Serial-compatible / Transport-compatible wrapper for Blockly + SDK.

    Routes reads through PortConnection's history buffer; writes go to the
    real backend (serial, VirtualSerial/SDK sim, or future WiFi transport).

    Subclasses ``wlkatapython.transports.Transport`` so ``robot.init(proxy)``
    accepts this object under the library's Connection type.
    """

    def __init__(self, port_conn):
        self._conn = port_conn
        self._timeout = 1.0
        if port_conn.raw_serial is not None and hasattr(port_conn.raw_serial, 'timeout'):
            try:
                self._timeout = port_conn.raw_serial.timeout
            except Exception:
                pass

    # ── Transport lifecycle (manager owns the link) ──

    def connect(self):
        return None

    def disconnect(self):
        return None

    @property
    def is_connected(self):
        return bool(self._conn.connected)

    def write(self, data):
        if not self._conn.connected or not self._conn.raw_serial:
            raise serial.SerialException('Not connected')
        text = data.decode('utf-8', errors='ignore') if isinstance(data, (bytes, bytearray)) else str(data)
        self._conn.add_history('tx', text.strip(), source='blockly')
        # Status replies match the auto-report regex; mark query so the line
        # is also delivered to the SDK RX buffer (waitIdle / getstatus).
        if text.strip().rstrip('\r\n') == '?':
            self._conn._awaiting_query = True
        return self._conn.raw_serial.write(data)

    def readline(self):
        timeout = self.timeout
        if timeout is None:
            timeout = 1.0
        return self._conn.rx_readline(timeout=timeout or 1.0)

    @property
    def in_waiting(self):
        return self._conn.rx_unread_count

    def flushInput(self):
        self._conn.rx_flush_input()

    def flushOutput(self):
        self._conn.rx_flush_output()

    @property
    def timeout(self):
        raw = self._conn.raw_serial
        if raw is not None and hasattr(raw, 'timeout'):
            try:
                return raw.timeout
            except Exception:
                pass
        return self._timeout

    @timeout.setter
    def timeout(self, value):
        self._timeout = value
        raw = self._conn.raw_serial
        if raw is not None and hasattr(raw, 'timeout'):
            try:
                raw.timeout = value
            except Exception:
                pass

    @property
    def is_open(self):
        return self._conn.connected

    def close(self):
        # No-op: the manager owns the connection lifecycle
        pass

    # Forward any other attribute access to the real serial object
    def __getattr__(self, name):
        if self._conn.raw_serial:
            return getattr(self._conn.raw_serial, name)
        raise AttributeError(f'ProxySerial has no attribute {name}')


class SerialManager:
    """Manages multiple port connections. One port is 'active' at a time."""

    _instance = None

    @classmethod
    def get_instance(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance

    def __init__(self):
        # All known port connections: port_path -> PortConnection
        self._ports = {}
        self._active_port = None   # currently selected port path
        self._busy = False
        self._flash_locked = set()  # ports locked for firmware flashing

    # ── Port registration (called by detector) ──

    def register_port(self, port, model=None, baudrate=115200):
        """Register a detected port. Does not connect yet."""
        if port not in self._ports:
            self._ports[port] = PortConnection(port, model=model, baudrate=baudrate)
        else:
            self._ports[port].model = model

    def unregister_port(self, port):
        """Remove a port that is no longer detected."""
        if port in self._ports:
            conn = self._ports[port]
            if conn.connected:
                conn.disconnect()
            del self._ports[port]
            if self._active_port == port:
                self._active_port = None

    def get_registered_ports(self):
        """Return list of registered port info dicts."""
        return [
            {'port': p, 'model': c.model, 'connected': c.connected}
            for p, c in self._ports.items()
        ]

    # ── Connection lifecycle ──

    def ensure_connected(self, port, model=None, baudrate=115200, existing_serial=None):
        """Ensure a port is connected (register + connect if needed).
        Does NOT change the active port. Used by the detector for
        auto-connecting discovered robots in the background.

        If existing_serial is provided, reuse that open serial connection
        instead of opening a new one (avoids disconnect/reconnect delay).

        Accepts serial paths and WiFi IPs (``192.168.x.x`` / ``ip:tcpPort``).
        """
        from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

        if port and is_wifi_endpoint(port):
            port = normalize_wifi_endpoint(port)

        if port in self._flash_locked:
            if existing_serial:
                try:
                    existing_serial.close()
                except Exception:
                    pass
            return {'success': False, 'port': port, 'model': model, 'locked': True}

        if port not in self._ports:
            self.register_port(port, model=model, baudrate=baudrate)

        conn = self._ports[port]
        if model:
            conn.model = model

        if conn.connected:
            if existing_serial:
                try:
                    existing_serial.close()
                except Exception:
                    pass
            return {'success': True, 'port': port, 'model': conn.model}

        success = conn.connect(existing_serial=existing_serial)
        result = {'success': success, 'port': conn.port, 'model': conn.model}
        if not success:
            # Surface last sys history line as error (e.g. WiFi unreachable)
            try:
                hist = conn.get_history(since=0)
                for entry in reversed(hist):
                    if entry.get('dir') == 'sys' and 'fail' in (entry.get('text') or '').lower():
                        result['error'] = entry['text']
                        break
            except Exception:
                pass
            if 'error' not in result:
                result['error'] = f'Connection failed for {conn.port}'
        return result

    def connect(self, port, model=None, baudrate=115200):
        """Connect to a port and set it as the active port.
        Called when the user explicitly selects a port in the UI."""
        result = self.ensure_connected(port, model=model, baudrate=baudrate)
        if result['success']:
            self._active_port = port
        return result

    def disconnect(self, port=None):
        """Disconnect a port (default: active port)."""
        from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

        port = port or self._active_port
        if port and is_wifi_endpoint(port):
            port = normalize_wifi_endpoint(port)
        if not port or port not in self._ports:
            return {'success': False, 'error': 'No port to disconnect'}

        self._ports[port].disconnect()
        if self._active_port == port:
            self._active_port = None
        return {'success': True}

    def reconnect(self, port=None, model=None, baudrate=115200):
        """Hard refresh: force-close the link and open a new serial/WiFi session.

        Use after a quick power-cycle when the OS path is still present but
        the previous serial handle is dead (no more responses).
        """
        from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

        port = port or self._active_port
        if not port:
            return {'success': False, 'error': 'No port to reconnect'}
        if is_wifi_endpoint(port):
            port = normalize_wifi_endpoint(port)

        # Preserve model from existing registration if not provided
        prev_model = None
        if port in self._ports:
            prev_model = self._ports[port].model
            try:
                self._ports[port].disconnect()
            except Exception:
                pass
            # Drop robot/FW cache so version() and $40 re-run cleanly
            try:
                self._ports[port]._firmware_version = None
                self._ports[port].robot = None
            except Exception:
                pass

        use_model = model or prev_model
        # Normalize Blockly dropdown values (Mirobot_UART → Mirobot)
        if isinstance(use_model, str) and use_model.endswith('_UART'):
            use_model = use_model[:-5]
        result = self.ensure_connected(port, model=use_model, baudrate=baudrate)
        if result.get('success'):
            self._active_port = port
            result['reconnected'] = True
            result['model'] = self._ports[port].model if port in self._ports else use_model
        return result

    def lock_for_flash(self, port):
        """Disconnect a port and prevent the detector from reconnecting it."""
        self._flash_locked.add(port)
        if port in self._ports and self._ports[port].connected:
            self._ports[port].disconnect()
        if self._active_port == port:
            self._active_port = None

    def unlock_port(self, port):
        """Allow the detector to reconnect a port after flashing is done."""
        self._flash_locked.discard(port)

    def all_connected(self):
        """Return list of all PortConnections that are currently connected."""
        return [c for c in self._ports.values() if c.connected]

    @property
    def active_port(self):
        return self._active_port

    @property
    def active_connection(self):
        if self._active_port and self._active_port in self._ports:
            return self._ports[self._active_port]
        return None

    @property
    def connected(self):
        conn = self.active_connection
        return conn.connected if conn else False

    @property
    def port(self):
        return self._active_port

    @property
    def model(self):
        conn = self.active_connection
        return conn.model if conn else None

    @property
    def busy(self):
        return self._busy

    @busy.setter
    def busy(self, val):
        self._busy = val

    def status(self):
        conn = self.active_connection
        return {
            'connected': conn.connected if conn else False,
            'port': self._active_port,
            'model': conn.model if conn else None,
            'busy': self._busy
        }

    # ── History (delegates to active port) ──

    def get_history(self, port=None, since=0):
        port = port or self._active_port
        if port and port in self._ports:
            return self._ports[port].get_history(since=since)
        return []

    # ── Send (delegates to active port) ──

    def send_raw(self, command, source='command'):
        conn = self.active_connection
        if not conn:
            return {'success': False, 'error': 'No active connection'}
        return conn.send_raw(command, source=source)

    # ── SDK integration ──

    def get_proxy_serial_class(self):
        """Return a class that, when instantiated with a managed port,
        returns a ProxySerial instead of opening a new serial.Serial."""
        manager = self

        class ProxySerialFactory:
            def __new__(cls, port=None, baudrate=115200, **kwargs):
                from .wifi_link import is_wifi_endpoint, normalize_wifi_endpoint

                key = port
                if port and is_wifi_endpoint(port):
                    key = normalize_wifi_endpoint(port)

                if key and key in manager._ports:
                    conn = manager._ports[key]
                    if not conn.connected:
                        conn.connect()
                    # Flush stale RX lines so the SDK starts with a clean buffer
                    conn.rx_flush_input()
                    return ProxySerial(conn)

                # Unmanaged WiFi IP: open via manager so history / proxy stay consistent
                if key and is_wifi_endpoint(key):
                    result = manager.ensure_connected(key, baudrate=baudrate)
                    if not result.get('success'):
                        raise serial.SerialException(
                            f"Cannot connect to WiFi robot at {key}"
                        )
                    conn = manager._ports[key]
                    conn.rx_flush_input()
                    return ProxySerial(conn)

                # Not a managed port - create a real serial connection
                return serial.Serial(port, baudrate, **kwargs)

        return ProxySerialFactory