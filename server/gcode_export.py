"""
Dry-run G-code capture for Blockly programs.

Executes generated Python with the real ``wlkatapython`` robot classes, but
routes serial I/O through an in-memory transport that records every TX line.
``time.sleep`` becomes ``G4 P{seconds}``; ``waitIdle`` is a no-op (no G-code).

Loops/branches run for real along the path taken by the dry-run. Sensor-driven
``if`` conditions and external libraries may not export correctly — the UI warns
users about that.
"""

from __future__ import annotations

import io
import sys
import threading
import time
import traceback
import types
from typing import Any, Dict, List, Optional

# Safety limits (same order of magnitude as move_simulator)
_DEFAULT_TIMEOUT_S = 5.0
_MAX_TRACE_LINES = 200_000
_MAX_GCODE_LINES = 10_000

# Class-level patches on WLKATA_UART / time.sleep must not overlap
_export_lock = threading.Lock()


class _ExportLimitExceeded(Exception):
    """Raised when export hits a safety limit."""


class _RecordingTransport:
    """pyserial-compatible surface that records TX as G-code lines."""

    def __init__(self, lines: List[str]) -> None:
        self._lines = lines
        self._rx: List[bytes] = []
        self._timeout: Optional[float] = 0.1
        self._is_open = True

    def connect(self) -> None:
        self._is_open = True

    def disconnect(self) -> None:
        self._is_open = False

    @property
    def is_connected(self) -> bool:
        return self._is_open

    def write(self, data: bytes) -> int:
        if isinstance(data, str):
            text = data
            n = len(data)
        else:
            text = data.decode("utf-8", errors="replace")
            n = len(data)

        for part in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            part = part.strip()
            if not part:
                continue
            # Strip RS485 multi-drop prefix @N if present
            if part.startswith("@"):
                i = 1
                while i < len(part) and part[i].isdigit():
                    i += 1
                part = part[i:]
            if part:
                if len(self._lines) >= _MAX_GCODE_LINES:
                    raise _ExportLimitExceeded(
                        f"Export exceeded max G-code lines ({_MAX_GCODE_LINES})"
                    )
                self._lines.append(part)

        # Queue an ok so methods that wait for acknowledgement proceed
        self._rx.append(b"ok\r\n")
        return n

    def readline(self) -> bytes:
        if self._rx:
            return self._rx.pop(0)
        # Idle status so waitIdle-event style loops terminate if not no-op'd
        return (
            b"<Idle,Angle(AAAAA,BBBBB,CCCCC,DDDDD,XXXXX,YYYYY,ZZZZZ),"
            b"Cartesian(XXXXX,YYYYY,ZZZZZ,AAAAA,BBBBB,CCCCC),"
            b"PWM(P,V),Mode(M)>\r\n"
        )

    def flushInput(self) -> None:
        self._rx.clear()

    def flushOutput(self) -> None:
        return None

    @property
    def in_waiting(self) -> int:
        return 1 if self._rx else 0

    @property
    def timeout(self) -> Optional[float]:
        return self._timeout

    @timeout.setter
    def timeout(self, value: Optional[float]) -> None:
        self._timeout = value


class _FakeSerial:
    """Duck-type serial.Serial used by generated ``serial.Serial(port, baud)``."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.port = args[0] if args else kwargs.get("port")
        self.baudrate = args[1] if len(args) > 1 else kwargs.get("baudrate", 115200)
        self.is_open = True
        self.timeout = kwargs.get("timeout", 0.1)
        self._transport: Optional[_RecordingTransport] = None

    def open(self) -> None:
        self.is_open = True

    def close(self) -> None:
        self.is_open = False

    def write(self, data: bytes) -> int:
        if self._transport:
            return self._transport.write(data)
        return 0

    def readline(self) -> bytes:
        if self._transport:
            return self._transport.readline()
        return b"ok\r\n"

    def flushInput(self) -> None:
        if self._transport:
            self._transport.flushInput()

    def flushOutput(self) -> None:
        if self._transport:
            self._transport.flushOutput()

    @property
    def in_waiting(self) -> int:
        return self._transport.in_waiting if self._transport else 0


def _format_g4(seconds: float) -> str:
    if seconds <= 0:
        return ""
    if float(seconds).is_integer():
        return f"G4 P{int(seconds)}"
    # Trim trailing zeros for readability (e.g. 1.50 -> 1.5)
    text = f"{seconds:.6f}".rstrip("0").rstrip(".")
    return f"G4 P{text}"


def _safe_builtins() -> dict:
    return {
        "print": print,
        "len": len,
        "range": range,
        "enumerate": enumerate,
        "zip": zip,
        "map": map,
        "filter": filter,
        "sum": sum,
        "min": min,
        "max": max,
        "abs": abs,
        "round": round,
        "pow": pow,
        "divmod": divmod,
        "int": int,
        "float": float,
        "str": str,
        "bool": bool,
        "list": list,
        "dict": dict,
        "tuple": tuple,
        "set": set,
        "type": type,
        "isinstance": isinstance,
        "hasattr": hasattr,
        "getattr": getattr,
        "setattr": setattr,
        "dir": dir,
        "chr": chr,
        "ord": ord,
        "hex": hex,
        "bin": bin,
        "oct": oct,
        "format": format,
        "sorted": sorted,
        "reversed": reversed,
        "any": any,
        "all": all,
        "vars": vars,
        "locals": locals,
        "globals": globals,
        "repr": repr,
        "ascii": ascii,
        "callable": callable,
        "classmethod": classmethod,
        "staticmethod": staticmethod,
        "property": property,
        "slice": slice,
        "complex": complex,
        "frozenset": frozenset,
        "bytearray": bytearray,
        "bytes": bytes,
        "memoryview": memoryview,
        "hash": hash,
        "id": id,
        "iter": iter,
        "next": next,
        "object": object,
        "super": super,
        "Exception": Exception,
        "BaseException": BaseException,
        "ValueError": ValueError,
        "TypeError": TypeError,
        "RuntimeError": RuntimeError,
        "StopIteration": StopIteration,
        "IndexError": IndexError,
        "KeyError": KeyError,
        "AttributeError": AttributeError,
        "NameError": NameError,
        "ZeroDivisionError": ZeroDivisionError,
        "True": True,
        "False": False,
        "None": None,
        "__name__": "__main__",
        "__doc__": None,
        "__build_class__": __build_class__,
    }


class GcodeExporter:
    """Dry-run Blockly/Python and collect G-code TX lines."""

    @staticmethod
    def export(code: str, timeout_s: float = _DEFAULT_TIMEOUT_S) -> dict:
        """
        Returns:
          {
            success: bool,
            lines: [str, ...],
            gcode: str,          # joined with \\n
            stdout: str,
            stderr: str,
            error?: str,
            timed_out?: bool,
            truncated?: bool,
          }
        """
        code = code or ""
        if not str(code).strip():
            return {
                "success": True,
                "lines": [],
                "gcode": "",
                "stdout": "",
                "stderr": "",
            }

        try:
            timeout_s = float(timeout_s)
        except (TypeError, ValueError):
            timeout_s = _DEFAULT_TIMEOUT_S
        timeout_s = max(0.5, min(timeout_s, 30.0))

        lines: List[str] = []
        transport = _RecordingTransport(lines)

        # Import real library (must be available in the server env)
        try:
            import wlkatapython  # noqa: F401
            from wlkatapython.robots.base import WLKATA_UART
        except Exception as e:
            return {
                "success": False,
                "lines": [],
                "gcode": "",
                "stdout": "",
                "stderr": "",
                "error": f"wlkatapython not available: {e}",
            }

        with _export_lock:
            return GcodeExporter._export_locked(
                code, timeout_s, lines, transport, WLKATA_UART
            )

    @staticmethod
    def _export_locked(
        code: str,
        timeout_s: float,
        lines: List[str],
        transport: _RecordingTransport,
        WLKATA_UART: Any,
    ) -> dict:
        # ── Patch robot I/O for capture ──────────────────────────
        orig_init = WLKATA_UART.init
        orig_send_msg = WLKATA_UART.sendMsg
        orig_wait_idle = WLKATA_UART.waitIdle
        orig_get_state = getattr(WLKATA_UART, "getState", None)

        def _patched_init(self, p=None, adr=-1):  # noqa: ANN001
            # Always bind the shared recording transport (ignore real ports)
            self.pSerial = transport
            self.address = adr if adr is not None else -1

        def _patched_send_msg(self, message=""):  # noqa: ANN001
            if self.address != -1:
                payload = f"@{self.address}{message}\r\n"
            else:
                payload = f"{message}\r\n"
            self.pSerial.write(payload.encode("utf-8"))
            # intentionally no time.sleep(0.1)

        def _patched_wait_idle(self, timeout=30):  # noqa: ANN001
            return True

        def _patched_get_state(self):  # noqa: ANN001
            return "Idle"

        WLKATA_UART.init = _patched_init  # type: ignore[method-assign]
        WLKATA_UART.sendMsg = _patched_send_msg  # type: ignore[method-assign]
        WLKATA_UART.waitIdle = _patched_wait_idle  # type: ignore[method-assign]
        if orig_get_state is not None:
            WLKATA_UART.getState = _patched_get_state  # type: ignore[method-assign]

        # ── Mock serial + time ───────────────────────────────────
        mock_serial = types.ModuleType("serial")
        mock_serial.Serial = _FakeSerial  # type: ignore[attr-defined]
        mock_serial.EIGHTBITS = 8
        mock_serial.PARITY_NONE = "N"
        mock_serial.STOPBITS_ONE = 1

        real_time = __import__("time")
        mock_time = types.ModuleType("time")
        for attr in dir(real_time):
            if attr.startswith("__"):
                continue
            try:
                setattr(mock_time, attr, getattr(real_time, attr))
            except Exception:
                pass

        def _export_sleep(seconds=0, *a, **k):  # noqa: ANN001
            try:
                s = float(seconds)
            except (TypeError, ValueError):
                s = 0.0
            g4 = _format_g4(s)
            if g4:
                if len(lines) >= _MAX_GCODE_LINES:
                    raise _ExportLimitExceeded(
                        f"Export exceeded max G-code lines ({_MAX_GCODE_LINES})"
                    )
                lines.append(g4)

        mock_time.sleep = _export_sleep  # type: ignore[attr-defined]

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        old_stdout, old_stderr = sys.stdout, sys.stderr
        builtins_dict = _safe_builtins()
        orig_import = __import__

        def _patched_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "serial" or name.startswith("serial."):
                return mock_serial
            if name == "time":
                return mock_time
            # Allow real wlkatapython + stdlib
            return orig_import(name, globals, locals, fromlist, level)

        builtins_dict["__import__"] = _patched_import

        safe_globals: Dict[str, Any] = {
            "__builtins__": builtins_dict,
            "serial": mock_serial,
            "time": mock_time,
        }

        start = time.monotonic()
        line_count = 0
        timed_out = False
        truncated = False
        error: Optional[str] = None
        tb: Optional[str] = None

        def _trace(frame, event, arg):  # noqa: ANN001
            nonlocal line_count, timed_out, truncated
            if event != "line":
                return _trace
            line_count += 1
            if line_count > _MAX_TRACE_LINES:
                truncated = True
                raise _ExportLimitExceeded(
                    f"Export exceeded max lines ({_MAX_TRACE_LINES}); "
                    "possible infinite loop"
                )
            if (time.monotonic() - start) > timeout_s:
                timed_out = True
                raise _ExportLimitExceeded(
                    f"Export timed out after {timeout_s:.1f}s"
                )
            return _trace

        try:
            sys.stdout = stdout_buf
            sys.stderr = stderr_buf
            # Also patch real time.sleep in case library code imported it already
            real_sleep = real_time.sleep
            real_time.sleep = _export_sleep  # type: ignore[assignment]
            try:
                compiled = compile(code, "<export-gcode>", "exec")
                sys.settrace(_trace)
                try:
                    exec(compiled, safe_globals)
                finally:
                    sys.settrace(None)
            finally:
                real_time.sleep = real_sleep  # type: ignore[assignment]
        except _ExportLimitExceeded as e:
            error = str(e)
        except Exception as e:
            error = str(e)
            tb = traceback.format_exc()
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            sys.settrace(None)
            # Restore robot class methods
            WLKATA_UART.init = orig_init  # type: ignore[method-assign]
            WLKATA_UART.sendMsg = orig_send_msg  # type: ignore[method-assign]
            WLKATA_UART.waitIdle = orig_wait_idle  # type: ignore[method-assign]
            if orig_get_state is not None:
                WLKATA_UART.getState = orig_get_state  # type: ignore[method-assign]

        success = error is None
        # Partial success when we hit a limit but still recorded lines
        if error and lines:
            success = True

        gcode_text = "\n".join(lines)
        if gcode_text and not gcode_text.endswith("\n"):
            gcode_text += "\n"

        result = {
            "success": success,
            "lines": list(lines),
            "gcode": gcode_text,
            "stdout": stdout_buf.getvalue(),
            "stderr": stderr_buf.getvalue(),
            "timed_out": timed_out,
            "truncated": truncated,
        }
        if error:
            result["error"] = error
        if tb:
            result["traceback"] = tb
        return result
