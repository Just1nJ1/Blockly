"""
Code execution module for the Blockly server.

Supports:
  - Batch execute() — run to completion, return full stdout/stderr (legacy).
  - Interactive sessions — live stdout/stderr streaming + stdin for input().
"""

from __future__ import annotations

import io
import os
import queue
import sys
import threading
import time
import traceback
import uuid
from typing import Any, Callable, Dict, List, Optional, Tuple

from .serial_manager import SerialManager


class _AbortExecution(Exception):
    """Raised when execution is aborted via emergency stop."""
    pass


class _LiveStream(io.TextIOBase):
    """Text stream that pushes every write to a session event list.

    Also keeps an in-memory buffer so legacy-style full-capture still works.
    """

    encoding = "utf-8"
    errors = "replace"

    def __init__(self, emit: Callable[[str, str], None], stream_name: str):
        super().__init__()
        self._emit = emit
        self._stream_name = stream_name
        self._buf: List[str] = []

    def write(self, s) -> int:
        if s is None:
            return 0
        if not isinstance(s, str):
            s = str(s)
        if not s:
            return 0
        self._buf.append(s)
        try:
            self._emit(self._stream_name, s)
        except Exception:
            pass
        return len(s)

    def flush(self) -> None:
        pass

    def getvalue(self) -> str:
        return "".join(self._buf)

    def readable(self) -> bool:
        return False

    def writable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return False

    def isatty(self) -> bool:
        # Pretend TTY so print() flushes promptly in more edge cases
        return True


class InteractiveSession:
    """One running (or finished) interactive code execution."""

    def __init__(self, session_id: str):
        self.id = session_id
        self.stdin_queue: "queue.Queue[Optional[str]]" = queue.Queue()
        self.waiting_for_input = False
        self.done = False
        self.success: Optional[bool] = None
        self.error: Optional[str] = None
        self.created_at = time.time()
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._history: List[dict] = []

    def emit(self, event_type: str, data: str = "", **extra: Any) -> None:
        evt: Dict[str, Any] = {"type": event_type, "data": data}
        evt.update(extra)
        with self._cv:
            self._history.append(evt)
            if len(self._history) > 5000:
                # Drop oldest; SSE clients use an index so they skip gaps only if
                # they connected extremely late — rare for this app.
                drop = len(self._history) - 2500
                self._history = self._history[drop:]
            self._cv.notify_all()

    def wait_events(self, index: int, timeout: float = 15.0) -> Tuple[List[dict], int]:
        """
        Block until history grows past index (or timeout / done).
        Returns (new_events, new_index).
        """
        with self._cv:
            if index < 0:
                index = 0
            deadline = time.time() + timeout
            while index >= len(self._history) and not self.done:
                remaining = deadline - time.time()
                if remaining <= 0:
                    return [], index
                self._cv.wait(timeout=remaining)
            new_events = self._history[index:]
            return new_events, index + len(new_events)

    def feed_input(self, line: str) -> bool:
        """Deliver one line of stdin (strips one trailing newline)."""
        if self.done:
            return False
        if line.endswith("\r\n"):
            line = line[:-2]
        elif line.endswith("\n"):
            line = line[:-1]
        self.stdin_queue.put(line)
        return True

    def interactive_input(self, prompt: str = "") -> str:
        """Python input() replacement — emits prompt and blocks for UI line."""
        if prompt:
            self.emit("stdout", str(prompt))
        self.waiting_for_input = True
        self.emit("stdin_request", str(prompt or ""))
        try:
            line = self.stdin_queue.get()
        finally:
            self.waiting_for_input = False
        if line is None:
            raise EOFError("Execution aborted while waiting for input")
        self.emit("stdin_echo", line + "\n")
        return line


class CodeExecutor:
    """Handles safe execution of Python code (batch + interactive)."""

    _abort_event = threading.Event()
    _sessions: Dict[str, InteractiveSession] = {}
    _sessions_lock = threading.Lock()
    _SESSION_TTL_S = 600

    @classmethod
    def abort(cls):
        """Signal running execution to abort and unblock any input() waiters."""
        cls._abort_event.set()
        with cls._sessions_lock:
            for sess in cls._sessions.values():
                if not sess.done:
                    try:
                        sess.stdin_queue.put_nowait(None)
                    except Exception:
                        pass

    @classmethod
    def get_session(cls, session_id: str) -> Optional[InteractiveSession]:
        with cls._sessions_lock:
            return cls._sessions.get(session_id)

    @classmethod
    def _register_session(cls, sess: InteractiveSession) -> None:
        with cls._sessions_lock:
            cls._sessions[sess.id] = sess
            cls._prune_sessions_locked()

    @classmethod
    def _prune_sessions_locked(cls) -> None:
        now = time.time()
        dead = [
            sid
            for sid, s in cls._sessions.items()
            if s.done and (now - s.created_at) > cls._SESSION_TTL_S
        ]
        for sid in dead:
            del cls._sessions[sid]

    @staticmethod
    def _safe_globals(extra_builtins: Optional[dict] = None) -> dict:
        builtins_dict = {
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
            "help": help,
            "id": id,
            "input": input,
            "iter": iter,
            "next": next,
            "object": object,
            "super": super,
            "__import__": __import__,
            "__name__": "__main__",
            "__doc__": None,
        }
        if extra_builtins:
            builtins_dict.update(extra_builtins)
        return {"__builtins__": builtins_dict}

    @staticmethod
    def _prepare_blockly_packages() -> Optional[str]:
        """
        Put the reserved Blockly venv site-packages on ``sys.path`` so
        ``import`` blocks resolve user-installed libraries.

        Returns the path that was inserted (or None). Caller should remove
        it after execution when appropriate.
        """
        try:
            from . import environments as _envs
            _envs.ensure_blockly_environment()
            site = _envs.get_blockly_site_packages()
        except Exception:
            return None
        if not site or not os.path.isdir(site):
            return None
        # Prefer user packages over older copies already on path
        while site in sys.path:
            sys.path.remove(site)
        sys.path.insert(0, site)
        return site

    @staticmethod
    def _cleanup_blockly_packages(site: Optional[str]) -> None:
        if not site:
            return
        try:
            while site in sys.path:
                sys.path.remove(site)
        except Exception:
            pass

    @staticmethod
    def _import_module_resolved(module_path: str):
        """
        Import a module for inspect / toolbox listing.

        Tries the **server process** environment first (wlkatapython, flask,
        etc.), then temporarily adds the reserved **blockly** venv
        site-packages and retries (opencv-python and other user packages).

        Matches Run/Debug resolution so ``import cv2`` works when the package
        is installed only in the blockly env.
        """
        import importlib

        try:
            return importlib.import_module(module_path)
        except ImportError:
            pass

        site = CodeExecutor._prepare_blockly_packages()
        try:
            importlib.invalidate_caches()
            # Drop failed/partial entries for this module so retry can load
            # from the blockly site-packages path.
            for key in list(sys.modules.keys()):
                if key == module_path or key.startswith(module_path + '.'):
                    # Only purge if the module failed to fully load
                    mod = sys.modules.get(key)
                    if mod is None or getattr(mod, '__file__', None) is None:
                        sys.modules.pop(key, None)
            return importlib.import_module(module_path)
        finally:
            CodeExecutor._cleanup_blockly_packages(site)

    @staticmethod
    def _prepare_serial_proxy(safe_globals: dict) -> None:
        mgr = SerialManager.get_instance()
        if not mgr.connected:
            return
        mgr.busy = True
        for conn in mgr.all_connected():
            conn.add_history("sys", "Blockly started")
        import serial as _serial_module

        _patched_serial = type(_serial_module)("_patched_serial")
        _patched_serial.__dict__.update(_serial_module.__dict__)
        _patched_serial.Serial = mgr.get_proxy_serial_class()
        safe_globals["__serial_proxy__"] = _patched_serial

        _orig_import = __import__
        _proxy = _patched_serial

        def _patched_import(name, *args, **kwargs):
            if name == "serial":
                return _proxy
            return _orig_import(name, *args, **kwargs)

        safe_globals["__builtins__"]["__import__"] = _patched_import

    @staticmethod
    def _release_serial() -> None:
        try:
            mgr = SerialManager.get_instance()
            for conn in mgr.all_connected():
                conn.add_history("sys", "Blockly stopped")
            mgr.busy = False
        except Exception:
            pass

    @staticmethod
    def _eval_last_expression(code: str, safe_globals: dict):
        result = None
        lines = code.strip().split("\n")
        if not lines:
            return None
        last_line = lines[-1].strip()
        is_skip = (
            last_line.startswith(
                (
                    "def ",
                    "class ",
                    "if ",
                    "for ",
                    "while ",
                    "import ",
                    "from ",
                    "#",
                    "print(",
                    "try:",
                    "except",
                    "finally",
                    "with ",
                    "return ",
                    "pass",
                    "break",
                    "continue",
                    "raise ",
                )
            )
            or "=" in last_line.split("(")[0]
            or last_line.endswith(")")
        )
        if last_line and not is_skip:
            try:
                result = eval(last_line, safe_globals)
            except Exception:
                pass
        return result

    @staticmethod
    def execute(code: str) -> dict:
        """Batch-execute Python code and return full results (legacy API)."""
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()
        old_stdout, old_stderr = sys.stdout, sys.stderr

        blockly_site = None
        try:
            sys.stdout = stdout_buffer
            sys.stderr = stderr_buffer
            blockly_site = CodeExecutor._prepare_blockly_packages()
            safe_globals = CodeExecutor._safe_globals()
            CodeExecutor._prepare_serial_proxy(safe_globals)

            try:
                CodeExecutor._abort_event.clear()

                def _abort_trace(frame, event, arg):
                    if CodeExecutor._abort_event.is_set():
                        raise _AbortExecution("Execution aborted by emergency stop")
                    return _abort_trace

                compiled = compile(code, "<blockly>", "exec")
                sys.settrace(_abort_trace)
                try:
                    exec(compiled, safe_globals)
                finally:
                    sys.settrace(None)

                result = CodeExecutor._eval_last_expression(code, safe_globals)
                return {
                    "success": True,
                    "stdout": stdout_buffer.getvalue(),
                    "stderr": stderr_buffer.getvalue(),
                    "result": repr(result) if result is not None else None,
                }
            except _AbortExecution:
                return {
                    "success": False,
                    "error": "Execution aborted by emergency stop",
                    "stdout": stdout_buffer.getvalue(),
                    "stderr": stderr_buffer.getvalue(),
                }
            except SyntaxError as e:
                return {
                    "success": False,
                    "error": f"Syntax Error: {e.msg} at line {e.lineno}",
                    "stdout": stdout_buffer.getvalue(),
                    "stderr": stderr_buffer.getvalue(),
                }
            except Exception as e:
                return {
                    "success": False,
                    "error": str(e),
                    "traceback": traceback.format_exc(),
                    "stdout": stdout_buffer.getvalue(),
                    "stderr": stderr_buffer.getvalue(),
                }
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            CodeExecutor._cleanup_blockly_packages(blockly_site)
            CodeExecutor._release_serial()

    @classmethod
    def start_interactive(cls, code: str) -> dict:
        """Start code in a background thread. Returns {success, session_id}."""
        if not code or not str(code).strip():
            return {"success": False, "error": "No code provided"}

        with cls._sessions_lock:
            for s in cls._sessions.values():
                if not s.done:
                    return {
                        "success": False,
                        "error": "Another program is already running. Stop it first.",
                    }

        session_id = uuid.uuid4().hex[:12]
        sess = InteractiveSession(session_id)
        cls._register_session(sess)
        cls._abort_event.clear()

        def runner():
            old_stdout, old_stderr = sys.stdout, sys.stderr
            live_out = _LiveStream(sess.emit, "stdout")
            live_err = _LiveStream(sess.emit, "stderr")
            blockly_site = None
            try:
                sys.stdout = live_out
                sys.stderr = live_err
                blockly_site = CodeExecutor._prepare_blockly_packages()

                def _ui_input(prompt: str = "") -> str:
                    return sess.interactive_input(prompt if prompt is not None else "")

                # Use a flush-friendly print that always hits our LiveStream
                def _ui_print(*args, **kwargs):
                    kwargs.setdefault("file", sys.stdout)
                    kwargs.setdefault("flush", True)
                    return print(*args, **kwargs)

                safe_globals = CodeExecutor._safe_globals({
                    "input": _ui_input,
                    "print": _ui_print,
                })
                CodeExecutor._prepare_serial_proxy(safe_globals)

                def _abort_trace(frame, event, arg):
                    if CodeExecutor._abort_event.is_set():
                        raise _AbortExecution("Execution aborted by emergency stop")
                    return _abort_trace

                compiled = compile(code, "<blockly>", "exec")
                sys.settrace(_abort_trace)
                try:
                    exec(compiled, safe_globals)
                finally:
                    sys.settrace(None)

                result = CodeExecutor._eval_last_expression(code, safe_globals)
                if result is not None:
                    sess.emit("result", repr(result))
                sess.success = True
                sess.emit("done", "", success=True)
            except _AbortExecution:
                sess.success = False
                sess.error = "Execution aborted by emergency stop"
                sess.emit("error", sess.error)
                sess.emit("done", "", success=False)
            except SyntaxError as e:
                sess.success = False
                sess.error = f"Syntax Error: {e.msg} at line {e.lineno}"
                sess.emit("error", sess.error)
                sess.emit("done", "", success=False)
            except EOFError as e:
                sess.success = False
                sess.error = str(e) or "EOF while reading input"
                sess.emit("error", sess.error)
                sess.emit("done", "", success=False)
            except Exception as e:
                sess.success = False
                sess.error = str(e)
                tb = traceback.format_exc()
                sess.emit("stderr", tb)
                sess.emit("error", str(e))
                sess.emit("done", "", success=False, traceback=tb)
            finally:
                sess.done = True
                # Wake any SSE waiters blocked on empty history tail
                with sess._cv:
                    sess._cv.notify_all()
                sys.stdout = old_stdout
                sys.stderr = old_stderr
                CodeExecutor._cleanup_blockly_packages(blockly_site)
                CodeExecutor._release_serial()

        t = threading.Thread(target=runner, name=f"exec-{session_id}", daemon=True)
        t.start()
        return {"success": True, "session_id": session_id}

    @classmethod
    def feed_input(cls, session_id: str, line: str) -> dict:
        sess = cls.get_session(session_id)
        if not sess:
            return {"success": False, "error": "Unknown session"}
        if sess.done:
            return {"success": False, "error": "Session already finished"}
        ok = sess.feed_input(line if line is not None else "")
        return {"success": ok}
