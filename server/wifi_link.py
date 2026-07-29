"""
WiFi endpoint helpers + serial-compatible facade over wlkatapython WifiTransport.

StudioX treats an IPv4 address (optional ``:port``) the same way as a serial
port name: one logical ``port`` string in the UI/manager, I/O via Transport.

Default protocol is **UDP** (WLKATA extender WiFi mode).
"""

from __future__ import annotations

import os
import re
import sys
from typing import Optional, Tuple

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

# Default UDP port when the user types only an IP (override via host:port).
# WLKATA WiFi / extender UDP port; users can set e.g. 192.168.1.10:8899 when needed.
DEFAULT_WIFI_TCP_PORT = 8234  # name kept for callers; used as default UDP port too
DEFAULT_WIFI_PORT = 8234
DEFAULT_WIFI_PROTOCOL = "udp"

# IPv4 with optional :port  (e.g. 192.168.1.100 or 192.168.1.100:8899)
_IPV4_ENDPOINT_RE = re.compile(
    r"^\s*"
    r"(?P<host>(?:\d{1,3}\.){3}\d{1,3})"
    r"(?::(?P<port>\d{1,5}))?"
    r"\s*$"
)


def is_wifi_endpoint(value: Optional[str]) -> bool:
    """True if *value* looks like an IPv4 address (optional ``:port``)."""
    if not value or not isinstance(value, str):
        return False
    m = _IPV4_ENDPOINT_RE.match(value)
    if not m:
        return False
    # Validate each octet 0–255
    parts = m.group("host").split(".")
    try:
        if any(not (0 <= int(p) <= 255) for p in parts):
            return False
    except ValueError:
        return False
    if m.group("port") is not None:
        p = int(m.group("port"))
        if not (1 <= p <= 65535):
            return False
    return True


def parse_wifi_endpoint(value: str) -> Tuple[str, int]:
    """
    Parse ``host`` or ``host:port`` into (host, udp_port).

    Raises:
        ValueError: if not a valid WiFi endpoint string.
    """
    if not is_wifi_endpoint(value):
        raise ValueError(f"Not a WiFi IP endpoint: {value!r}")
    m = _IPV4_ENDPOINT_RE.match(value)
    host = m.group("host")
    port_s = m.group("port")
    udp_port = int(port_s) if port_s else DEFAULT_WIFI_PORT
    return host, udp_port


def normalize_wifi_endpoint(value: str) -> str:
    """
    Canonical port-key for manager/cache: always ``ip`` or ``ip:port``
    (omit ``:port`` when it equals the default).
    """
    host, udp_port = parse_wifi_endpoint(value)
    if udp_port == DEFAULT_WIFI_PORT:
        return host
    return f"{host}:{udp_port}"


class WifiLink:
    """
    pyserial-shaped wrapper around ``WifiTransport`` for PortConnection.

    Defaults to **UDP**. Provides ``is_open``, ``write``, ``readline``,
    ``in_waiting``, ``timeout``, and ``close`` so the existing read thread /
    ProxySerial path works unchanged.
    """

    # Tell PortConnection to poll via readline (socket in_waiting is buffer-only)
    _poll_always = True

    def __init__(
        self,
        endpoint: str,
        baudrate: int = 115200,
        timeout: float = 0.1,
        protocol: str = None,
    ):
        # baudrate ignored (API parity with serial.Serial)
        self.port = normalize_wifi_endpoint(endpoint)
        self.baudrate = baudrate
        self.protocol = (protocol or DEFAULT_WIFI_PROTOCOL).lower()
        self._timeout = timeout if timeout is not None else 0.1
        host, udp_port = parse_wifi_endpoint(endpoint)
        self.host = host
        self.tcp_port = udp_port  # attribute name kept; value is UDP port
        self.udp_port = udp_port
        self._transport = None
        self.is_open = False
        self.open()

    def open(self):
        if self.is_open and self._transport is not None:
            return
        from wlkatapython.transports import WifiTransport

        t = WifiTransport(
            self.host,
            self.udp_port,
            protocol=self.protocol,
            timeout=self._timeout,
        )
        t.connect()
        self._transport = t
        self.is_open = True

    def close(self):
        self.is_open = False
        t = self._transport
        self._transport = None
        if t is not None:
            try:
                t.disconnect()
            except Exception:
                pass

    def _require_open(self):
        if not self.is_open or self._transport is None:
            raise OSError(f"WiFi link {self.port!r} is closed")

    def write(self, data):
        self._require_open()
        if isinstance(data, str):
            data = data.encode("utf-8")
        return self._transport.write(data)

    def readline(self):
        self._require_open()
        return self._transport.readline()

    def read(self, size: int = 1):
        # Not used by PortConnection; best-effort single-byte via readline path
        self._require_open()
        line = self._transport.readline()
        return line[:size] if line else b""

    @property
    def in_waiting(self) -> int:
        if not self.is_open or self._transport is None:
            return 0
        return int(self._transport.in_waiting)

    def flushInput(self):
        if self._transport is not None:
            self._transport.flushInput()

    def flushOutput(self):
        if self._transport is not None:
            self._transport.flushOutput()

    def reset_input_buffer(self):
        self.flushInput()

    def reset_output_buffer(self):
        self.flushOutput()

    @property
    def timeout(self):
        if self._transport is not None:
            return self._transport.timeout
        return self._timeout

    @timeout.setter
    def timeout(self, value):
        self._timeout = value
        if self._transport is not None:
            self._transport.timeout = value


def open_wifi_link(endpoint: str, timeout: float = 0.1, protocol: str = None) -> WifiLink:
    """Open a WifiLink (default UDP) or raise a clear ConnectionError on failure."""
    try:
        return WifiLink(
            endpoint,
            timeout=timeout,
            protocol=protocol or DEFAULT_WIFI_PROTOCOL,
        )
    except ValueError:
        raise
    except Exception as e:
        host, udp_port = parse_wifi_endpoint(endpoint)
        raise ConnectionError(
            f"Cannot reach WiFi robot at {host}:{udp_port} via "
            f"{(protocol or DEFAULT_WIFI_PROTOCOL).upper()} ({e})"
        ) from e
