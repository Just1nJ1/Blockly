"""
Virtual ports for offline StudioX use (VirtualMirobot / VirtualMT4).

Backed by ``wlkatapython.simulator`` (not a separate protocol stub).
Named ports stay app-facing; connect opens the SDK sim + MockSerial.
"""

from __future__ import annotations

import os
import sys
import threading
from typing import Any, Dict, Optional, Tuple

# Bundled SDK on path (same as serial_manager)
_SDK_PATH = os.path.join(
    os.path.dirname(__file__),
    "..",
    "resources",
    "python",
    "lib",
    "python3.12",
    "site-packages",
)
_SDK_PATH = os.path.abspath(_SDK_PATH)
if _SDK_PATH not in sys.path:
    sys.path.insert(0, _SDK_PATH)

# Port name → model name (matches robots.json "name")
VIRTUAL_DEVICES = (
    {
        "port": "VirtualMirobot",
        "model": "Mirobot",
        "description": "Virtual Mirobot (SDK simulator)",
    },
    {
        "port": "VirtualMT4",
        "model": "MT4",
        "description": "Virtual MT4 (SDK simulator)",
    },
)

_VIRTUAL_PORT_SET = {d["port"] for d in VIRTUAL_DEVICES}

# StudioX model name → create_simulator() key
_MODEL_TO_SIM = {
    "Mirobot": "mirobot",
    "MT4": "mt4",
    "E4": "e4",
}

# Keep one running sim per logical port so reconnect reuses cleanly
_sessions: Dict[str, Tuple[Any, Any]] = {}  # port -> (sim, mock)
_sessions_lock = threading.Lock()


def is_virtual_port(port: str) -> bool:
    return bool(port) and port in _VIRTUAL_PORT_SET


def virtual_device_entries():
    """Static list used by the detector to always advertise virtual ports."""
    return [dict(d) for d in VIRTUAL_DEVICES]


def _stop_session(port: str) -> None:
    with _sessions_lock:
        pair = _sessions.pop(port, None)
    if not pair:
        return
    sim, mock = pair
    try:
        if mock is not None:
            mock.close()
    except Exception:
        pass
    try:
        if sim is not None:
            sim.stop()
    except Exception:
        pass


def _start_session(port: str, model: str, baudrate: int, timeout: float):
    """Start SDK simulator + MockSerial for this logical port."""
    from wlkatapython.simulator import create_simulator, MockSerial

    sim_key = _MODEL_TO_SIM.get(model or "Mirobot", "mirobot")
    sim = create_simulator(sim_key, address=-1)

    # StudioX enables auto-report with $40=1 on connect; library sim needs a
    # handler + set_auto_report (not in default command tables).
    def _handle_auto_report(cmd, match, state):
        sim.set_auto_report(True)
        return "ok"

    sim.add_command_response(r"^\$40(=.*)?$", "", _handle_auto_report)

    # Friendly version strings for StudioX FW UI (substring after first comma)
    if hasattr(sim, "set_firmware_version"):
        if sim_key == "mirobot":
            sim.set_firmware_version("Mirobot fw,virtual", "EXbox,virtual")
        elif sim_key in ("mt4", "e4"):
            sim.set_firmware_version("E4 fw,virtual", "EXbox,virtual")

    port_path = sim.start()
    mock = MockSerial(
        port_path,
        baudrate=baudrate,
        timeout=timeout if timeout is not None else 0.1,
        virtual_port=getattr(sim, "_virtual_port", None),
    )
    with _sessions_lock:
        old = _sessions.pop(port, None)
        _sessions[port] = (sim, mock)
    if old:
        try:
            old[1].close()
        except Exception:
            pass
        try:
            old[0].stop()
        except Exception:
            pass
    return sim, mock


class VirtualSerial:
    """
    pyserial-compatible facade over ``wlkatapython.simulator``.

    ``port`` remains the logical name (VirtualMirobot / VirtualMT4) for the UI;
    I/O goes to the simulator's MockSerial / PTY.
    """

    def __init__(self, port, model="Mirobot", baudrate=115200, timeout=0.1):
        self.port = port
        self.model = model or "Mirobot"
        self.baudrate = baudrate
        self._timeout = timeout if timeout is not None else 0.1
        self._sim = None
        self._mock = None
        self.is_open = False
        self.open()

    def open(self):
        if self.is_open and self._mock is not None:
            return
        self._sim, self._mock = _start_session(
            self.port, self.model, self.baudrate, self._timeout
        )
        self.is_open = True

    def close(self):
        self.is_open = False
        _stop_session(self.port)
        self._sim = None
        self._mock = None

    def _require_open(self):
        if not self.is_open or self._mock is None:
            raise OSError(f"Virtual serial port {self.port!r} is closed")

    def write(self, data):
        self._require_open()
        return self._mock.write(data)

    def readline(self):
        self._require_open()
        return self._mock.readline()

    def read(self, size: int = 1):
        self._require_open()
        return self._mock.read(size)

    @property
    def in_waiting(self) -> int:
        if not self.is_open or self._mock is None:
            return 0
        return int(self._mock.in_waiting)

    def flushInput(self):
        if self._mock is not None:
            self._mock.flushInput()

    def flushOutput(self):
        if self._mock is not None:
            self._mock.flushOutput()

    def reset_input_buffer(self):
        self.flushInput()

    def reset_output_buffer(self):
        self.flushOutput()

    @property
    def timeout(self):
        if self._mock is not None:
            return self._mock.timeout
        return self._timeout

    @timeout.setter
    def timeout(self, value):
        self._timeout = value
        if self._mock is not None:
            self._mock.timeout = value

    def __getattr__(self, name: str):
        # Forward rare pyserial attrs to MockSerial when present
        if name.startswith("_"):
            raise AttributeError(name)
        mock = object.__getattribute__(self, "_mock")
        if mock is not None and hasattr(mock, name):
            return getattr(mock, name)
        raise AttributeError(f"VirtualSerial has no attribute {name!r}")
