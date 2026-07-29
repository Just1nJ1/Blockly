"""
In-memory virtual serial ports for offline Blockly / teaching use.

Provides VirtualMirobot and VirtualMT4 that speak enough of the robot
protocol (ok, $V, ?, status lines, simple G-code) for the SDK and UI
to work without hardware.
"""

from __future__ import annotations

import collections
import re
import threading
import time


# Port name → model name (matches robots.json "name")
VIRTUAL_DEVICES = (
    {
        'port': 'VirtualMirobot',
        'model': 'Mirobot',
        'description': 'Virtual Mirobot (no hardware)',
    },
    {
        'port': 'VirtualMT4',
        'model': 'MT4',
        'description': 'Virtual MT4 (no hardware)',
    },
)

_VIRTUAL_PORT_SET = {d['port'] for d in VIRTUAL_DEVICES}

# Firmware lines must match wlkatapython's _VERSION_PREFIX checks:
#   Mirobot_UART → startswith "Mirobot"
#   MT4_UART / E4_UART → startswith "E4"
# Version UI shows the part after the first comma via _extract_version.
_FW_LINES = {
    'Mirobot': 'Mirobot fw,virtual',
    'MT4': 'E4 fw,virtual',   # MT4_UART._VERSION_PREFIX == "E4"
    'E4': 'E4 fw,virtual',
}


def is_virtual_port(port: str) -> bool:
    return bool(port) and port in _VIRTUAL_PORT_SET


def virtual_device_entries():
    """Static list used by the detector to always advertise virtual ports."""
    return [dict(d) for d in VIRTUAL_DEVICES]


_AXIS_GCODE = re.compile(
    r'([XYZABCRIJKF])\s*([+-]?(?:\d+\.?\d*|\.\d+))',
    re.IGNORECASE,
)


class VirtualSerial:
    """serial.Serial-compatible fake port with simple robot responses."""

    def __init__(self, port, model='Mirobot', baudrate=115200, timeout=0.1):
        self.port = port
        self.model = model or 'Mirobot'
        self.baudrate = baudrate
        self.timeout = timeout
        self.is_open = True

        self._rx = collections.deque()
        self._lock = threading.Lock()
        self._event = threading.Event()

        # Joint-ish and Cartesian state (degrees / mm)
        self._angles = {
            'A': 0.0, 'B': 0.0, 'C': 0.0, 'D': 0.0,
            'X': 0.0, 'Y': 0.0, 'Z': 0.0,
        }
        self._coords = {
            'X': 200.0, 'Y': 0.0, 'Z': 150.0,
            'Rx': 0.0, 'Ry': 0.0, 'Rz': 0.0,
        }
        self._pump = 0.0
        self._valve = 0.0
        self._mode = 0.0
        self._auto_status = False
        self._state = 'Idle'

    # ── serial.Serial surface ──────────────────────────────────

    def open(self):
        self.is_open = True

    def close(self):
        self.is_open = False
        with self._lock:
            self._rx.clear()
            self._event.set()

    def write(self, data):
        if not self.is_open:
            raise OSError('Virtual serial port is closed')
        if isinstance(data, str):
            text = data
            n = len(data.encode('utf-8'))
        else:
            text = data.decode('utf-8', errors='ignore')
            n = len(data)
        for line in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
            cmd = line.strip()
            if cmd:
                self._handle_command(cmd)
        return n

    def readline(self):
        deadline = time.time() + (self.timeout if self.timeout and self.timeout > 0 else 0.1)
        while True:
            with self._lock:
                if self._rx:
                    return (self._rx.popleft() + '\n').encode('utf-8')
            remaining = deadline - time.time()
            if remaining <= 0:
                return b''
            self._event.clear()
            self._event.wait(timeout=min(remaining, 0.05))

    @property
    def in_waiting(self):
        with self._lock:
            return len(self._rx)

    def flushInput(self):
        with self._lock:
            self._rx.clear()
            self._event.clear()

    def flushOutput(self):
        pass

    def reset_input_buffer(self):
        self.flushInput()

    def reset_output_buffer(self):
        pass

    # ── command handling ───────────────────────────────────────

    def _push(self, line: str):
        with self._lock:
            self._rx.append(line.rstrip('\n'))
            self._event.set()

    def _status_line(self) -> str:
        a = self._angles
        c = self._coords
        return (
            f'<{self._state},Angle(ABCDXYZ):'
            f'{a["A"]:.3f},{a["B"]:.3f},{a["C"]:.3f},{a["D"]:.3f},'
            f'{a["X"]:.3f},{a["Y"]:.3f},{a["Z"]:.3f},'
            f'Cartesian coordinate(XYZ RxRyRz):'
            f'{c["X"]:.3f},{c["Y"]:.3f},{c["Z"]:.3f},'
            f'{c["Rx"]:.3f},{c["Ry"]:.3f},{c["Rz"]:.3f},'
            f'Pump PWM:{self._pump:.0f},Valve PWM:{self._valve:.0f},'
            f'Motion_MODE:{self._mode:.0f}>'
        )

    def _handle_command(self, cmd: str):
        upper = cmd.upper()

        # Firmware version — SDK may read robot line and/or EXbox line
        if upper.startswith('$V') or upper == 'V':
            fw = _FW_LINES.get(self.model, _FW_LINES['Mirobot'])
            # Optional extender line first (real stacks often send EXbox then robot)
            self._push('EXbox,virtual')
            self._push(fw)
            self._push('ok')
            return

        # Enable auto-report after motion
        if upper.startswith('$40'):
            self._auto_status = True
            self._push('ok')
            return

        # Status query
        if cmd.strip() == '?':
            self._push(self._status_line())
            return

        # Homing
        if upper.startswith('$H') or upper.startswith('G28'):
            for k in self._angles:
                self._angles[k] = 0.0
            self._coords.update({'X': 200.0, 'Y': 0.0, 'Z': 150.0, 'Rx': 0.0, 'Ry': 0.0, 'Rz': 0.0})
            self._push('ok')
            if self._auto_status:
                self._push(self._status_line())
            return

        # Zero / go home-ish
        if upper.startswith('M21') or 'ZERO' in upper:
            for k in self._angles:
                self._angles[k] = 0.0
            self._push('ok')
            if self._auto_status:
                self._push(self._status_line())
            return

        # Pump / gripper style M-codes (best-effort)
        if upper.startswith('M3') or upper.startswith('M03'):
            self._pump = 500.0
            self._push('ok')
            return
        if upper.startswith('M5') or upper.startswith('M05'):
            self._pump = 0.0
            self._push('ok')
            return

        # Motion G-codes — update state from axis words when present
        if upper.startswith('G0') or upper.startswith('G1') or upper.startswith('G5'):
            self._apply_axis_words(cmd)
            self._push('ok')
            if self._auto_status:
                self._push(self._status_line())
            return

        # Default acknowledge so the SDK does not hang
        self._push('ok')

    def _apply_axis_words(self, cmd: str):
        """Update joint/cartesian state from axis letters in the command."""
        for letter, value_s in _AXIS_GCODE.findall(cmd):
            L = letter.upper()
            try:
                val = float(value_s)
            except ValueError:
                continue
            if L in ('X', 'Y', 'Z'):
                # Prefer cartesian for XYZ when in G0/G1 style moves
                self._coords[L] = val
                self._angles[L] = val
            elif L == 'A':
                self._coords['Rx'] = val
                self._angles['A'] = val
            elif L == 'B':
                self._coords['Ry'] = val
                self._angles['B'] = val
            elif L == 'C':
                self._coords['Rz'] = val
                self._angles['C'] = val
            elif L == 'D':
                self._angles['D'] = val
