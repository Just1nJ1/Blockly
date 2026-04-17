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
import serial
import threading
import time

# Add the bundled wlkatapython SDK to the path
_SDK_PATH = os.path.join(os.path.dirname(__file__), '..', 'resources', 'python',
                         'lib', 'python3.12', 'site-packages')
if _SDK_PATH not in sys.path:
    sys.path.insert(0, os.path.abspath(_SDK_PATH))

import wlkatapython

# Map model names to SDK classes
_MODEL_CLASSES = {
    'Mirobot': wlkatapython.Mirobot_UART,
    'MT4': wlkatapython.MT4_UART,
    'E4': wlkatapython.E4_UART,
}


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

    # ── Connection lifecycle ──

    def connect(self):
        if self.connected:
            self.disconnect()
        try:
            self._serial = serial.Serial(self.port, self.baudrate, timeout=0.1)
            self.connected = True
            self._stop_event.clear()
            self._read_thread = threading.Thread(
                target=self._read_loop, daemon=True)
            self._read_thread.start()

            # Create SDK robot instance with a ProxySerial
            self._init_robot()

            self.add_history('sys', f'Connected to {self.port} ({self.model or "unknown"})')
            return True
        except Exception as e:
            self.connected = False
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
        self.add_history('sys', f'Disconnected from {self.port}')

    # ── History ──

    def add_history(self, direction, text, source=None):
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
                if self._serial.in_waiting > 0:
                    line = self._serial.readline().decode('utf-8', errors='ignore').strip()
                    if line:
                        self.add_history('rx', line)
                        with self._rx_lock:
                            self._rx_lines.append(line)
                            self._rx_event.set()
                else:
                    time.sleep(0.02)
            except (serial.SerialException, OSError):
                self.add_history('sys', 'Serial read error - connection lost')
                self.connected = False
                break
            except Exception:
                time.sleep(0.02)

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
                msg = command.strip() + '\r\n'
                self._serial.write(msg.encode('utf-8'))
                return {'success': True}
            except Exception as e:
                return {'success': False, 'error': str(e)}

    @property
    def raw_serial(self):
        return self._serial


class ProxySerial:
    """A serial.Serial-compatible wrapper that routes reads through the
    PortConnection's history buffer.

    The SDK calls:
      - self.pSerial.write(...)       -> forwarded to real serial + logged
      - self.pSerial.readline()       -> reads from RX buffer via cursor
      - self.pSerial.in_waiting       -> unread count in RX buffer
      - self.pSerial.flushInput()     -> advances cursor to end
      - self.pSerial.flushOutput()    -> forwarded to real serial
      - self.pSerial.is_open          -> connection status
      - self.pSerial.close()          -> no-op (manager owns the port)
    """

    def __init__(self, port_conn):
        self._conn = port_conn

    def write(self, data):
        if not self._conn.connected or not self._conn.raw_serial:
            raise serial.SerialException('Not connected')
        self._conn.add_history('tx', data.decode('utf-8', errors='ignore').strip(), source='blockly')
        return self._conn.raw_serial.write(data)

    def readline(self):
        timeout = self._conn.raw_serial.timeout if self._conn.raw_serial else 1.0
        return self._conn.rx_readline(timeout=timeout or 1.0)

    @property
    def in_waiting(self):
        return self._conn.rx_unread_count

    def flushInput(self):
        self._conn.rx_flush_input()

    def flushOutput(self):
        self._conn.rx_flush_output()

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

    def ensure_connected(self, port, model=None, baudrate=115200):
        """Ensure a port is connected (register + connect if needed).
        Does NOT change the active port. Used by the detector for
        auto-connecting discovered robots in the background."""
        if port not in self._ports:
            self.register_port(port, model=model, baudrate=baudrate)

        conn = self._ports[port]
        if model:
            conn.model = model

        if conn.connected:
            return {'success': True, 'port': port, 'model': conn.model}

        success = conn.connect()
        return {'success': success, 'port': port, 'model': conn.model}

    def connect(self, port, model=None, baudrate=115200):
        """Connect to a port and set it as the active port.
        Called when the user explicitly selects a port in the UI."""
        result = self.ensure_connected(port, model=model, baudrate=baudrate)
        if result['success']:
            self._active_port = port
        return result

    def disconnect(self, port=None):
        """Disconnect a port (default: active port)."""
        port = port or self._active_port
        if not port or port not in self._ports:
            return {'success': False, 'error': 'No port to disconnect'}

        self._ports[port].disconnect()
        if self._active_port == port:
            self._active_port = None
        return {'success': True}

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
                if port and port in manager._ports:
                    conn = manager._ports[port]
                    if not conn.connected:
                        conn.connect()
                    # Flush stale RX lines so the SDK starts with a clean buffer
                    conn.rx_flush_input()
                    return ProxySerial(conn)
                # Not a managed port - create a real serial connection
                return serial.Serial(port, baudrate, **kwargs)

        return ProxySerialFactory