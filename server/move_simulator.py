"""
Dry-run robot move recorder.

Executes user Blockly/Python code with mock wlkatapython robots and a fake
serial port so that writeCoordinate / writeAngle / homing / zero are recorded
instead of being sent to hardware. Loops and branches run for real, so a
`for i in range(3)` produces three move records.

Used by the 3D animation viewer to build accurate move sequences.
"""

from __future__ import annotations

import io
import sys
import time
import types
import traceback
from typing import Any, Dict, List, Optional


# Safety limits so infinite loops cannot hang the server
_DEFAULT_TIMEOUT_S = 3.0
_MAX_TRACE_LINES = 200_000
_MAX_MOVES_TOTAL = 2_000


class _SimLimitExceeded(Exception):
    """Raised when simulation hits a safety limit."""


class RecordingRobot:
    """Drop-in stand-in for wlkatapython.*_UART that only records moves.

    Appends events to a shared timeline used by ``build_move_schedule`` so
    world animation can honor real waitIdle semantics (per-robot queues).
    """

    # Class-level counters shared across all instances in one simulation
    total_moves = 0
    all_instances: List["RecordingRobot"] = []
    # Global event order: {"type":"move"|"waitIdle", "instance_id": int, ...}
    timeline: List[dict] = []

    def __init__(self) -> None:
        self.moves: List[dict] = []
        RecordingRobot.all_instances.append(self)

    # ── lifecycle / no-ops ──────────────────────────────────────

    def init(self, p=None, adr=-1):
        return None

    def waitIdle(self, count=3):
        """Record a program-level wait for *this* robot (not a pose keyframe).

        Real firmware: blocks the Python program until this robot's motion queue
        is empty. Other robots keep running. If this robot is already idle the
        call returns immediately (no-op for scheduling).
        """
        RecordingRobot.timeline.append({
            "type": "waitIdle",
            "instance_id": id(self),
            "count": count,
        })
        return None

    def speed(self, num=0):
        return None

    def sendMsg(self, message=""):
        return None

    def pump(self, num=0):
        return None

    def gripper(self, num=0):
        return None

    def cancellation(self):
        return None

    # Swallow any other SDK methods so unknown calls don't crash the sim
    def __getattr__(self, name: str):
        if name.startswith("_"):
            raise AttributeError(name)

        def _noop(*args, **kwargs):
            return None

        return _noop

    # ── recording helpers ───────────────────────────────────────

    def _axis_val(self, v) -> float:
        if v is None:
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    def _record(self, move: dict) -> None:
        RecordingRobot.total_moves += 1
        if RecordingRobot.total_moves > _MAX_MOVES_TOTAL:
            raise _SimLimitExceeded(
                f"Simulation exceeded max moves ({_MAX_MOVES_TOTAL})"
            )
        self.moves.append(move)
        RecordingRobot.timeline.append({
            "type": "move",
            "instance_id": id(self),
            "move_index": len(self.moves) - 1,
            "move": move,
        })

    # ── motion APIs (match wlkatapython signatures) ─────────────

    def writeCoordinate(
        self,
        motion=0,
        position=0,
        x=None,
        y=None,
        z=None,
        a=None,
        b=None,
        c=None,
    ):
        self._record({
            "type": "writeCoordinate",
            "incremental": int(position) == 1,
            "motion": int(motion) if motion is not None else 0,
            "Axis1": self._axis_val(x),
            "Axis2": self._axis_val(y),
            "Axis3": self._axis_val(z),
            "Axis4": self._axis_val(a),
            "Axis5": self._axis_val(b),
            "Axis6": self._axis_val(c),
        })

    def writeAngle(
        self,
        position=0,
        x=None,
        y=None,
        z=None,
        a=None,
        b=None,
        c=None,
    ):
        self._record({
            "type": "writeAngle",
            "incremental": int(position) == 1,
            "Axis1": self._axis_val(x),
            "Axis2": self._axis_val(y),
            "Axis3": self._axis_val(z),
            "Axis4": self._axis_val(a),
            "Axis5": self._axis_val(b),
            "Axis6": self._axis_val(c),
        })

    def homing(self, mode=8):
        self._record({
            "type": "homing",
            "Axis1": 0.0,
            "Axis2": 0.0,
            "Axis3": 0.0,
            "Axis4": 0.0,
            "Axis5": 0.0,
            "Axis6": 0.0,
            "incremental": False,
        })

    def zero(self):
        # Treat as absolute joint zeros for animation purposes
        self._record({
            "type": "writeAngle",
            "incremental": False,
            "Axis1": 0.0,
            "Axis2": 0.0,
            "Axis3": 0.0,
            "Axis4": 0.0,
            "Axis5": 0.0,
            "Axis6": 0.0,
        })


class _FakeSerial:
    """Minimal serial.Serial stand-in — never opens a real port."""

    def __init__(self, *args, **kwargs):
        self.port = args[0] if args else kwargs.get("port")
        self.baudrate = args[1] if len(args) > 1 else kwargs.get("baudrate", 115200)
        self.is_open = True
        self.timeout = kwargs.get("timeout", None)

    def open(self):
        self.is_open = True

    def close(self):
        self.is_open = False

    def write(self, data):
        try:
            return len(data)
        except TypeError:
            return 0

    def read(self, size=1):
        return b""

    def readline(self):
        return b""

    def read_until(self, *a, **k):
        return b""

    def flush(self):
        return None

    def reset_input_buffer(self):
        return None

    def reset_output_buffer(self):
        return None

    def inWaiting(self):
        return 0

    @property
    def in_waiting(self):
        return 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def _build_mock_wlkatapython() -> types.ModuleType:
    from .robots import get_sdk_class_names

    mod = types.ModuleType("wlkatapython")
    # Inject every SDK class name from robots.json so dry-run works for new models
    for class_name in get_sdk_class_names():
        setattr(mod, class_name, RecordingRobot)
    # Non-catalog SDK symbols still used by some generated / library code
    for extra in ("WLKATA_UART", "MS4220_UART", "Mirobot_Serial_GUI"):
        if not hasattr(mod, extra):
            setattr(mod, extra, RecordingRobot)
    mod.robots = []
    mod.warnings = __import__("warnings")
    return mod


def build_move_schedule(
    timeline: List[dict],
    id_to_name: Dict[int, str],
) -> List[dict]:
    """Schedule moves with real waitIdle semantics (unit time slots).

    Real firmware: motion commands are non-blocking (queued on the robot);
    only waitIdle(R) blocks the program until R finishes its queue.
    waitIdle on an already-idle robot returns immediately and does not
    stall other robots.

    Model
    -----
    - code_time advances only on waitIdle(R) → max(code_time, free_at[R])
    - each move on R starts at max(free_at[R], code_time) and lasts 1 unit
    - free_at[R] is when R's queue will be empty

    Example: A.1, A.2, waitIdle(B), A.3, B.1
      → A: [0,1], [1,2], [2,3];  B: [0,1]  (B starts with A; wait B is no-op)

    Example: A.1,B.1,C.1,B.2,A.2, wait A,B,C, then C.2,A.3,…
      → first batch free_at A=B=2, C=1; waits set code_time=2;
      → later moves start at t≥2 together.
    """
    code_time = 0
    free_at: Dict[str, int] = {}
    schedule: List[dict] = []

    for ev in timeline:
        et = ev.get("type")
        iid = ev.get("instance_id")
        name = id_to_name.get(iid) or f"__inst_{iid}"

        if et == "move":
            move = ev.get("move")
            if move is None:
                continue
            start = max(free_at.get(name, 0), code_time)
            end = start + 1
            free_at[name] = end
            schedule.append({
                "var": name,
                "start": start,
                "end": end,
                "move": move,
            })
        elif et == "waitIdle":
            # Block program time until this robot is idle (no-op if already free)
            code_time = max(code_time, free_at.get(name, 0))

    return schedule


def build_animation_segments(
    timeline: List[dict],
    id_to_name: Dict[int, str],
) -> List[Dict[str, List[dict]]]:
    """Legacy helper: group schedule slots into coarse lists per time-span.

    Prefer ``build_move_schedule`` + client concurrent playback. Kept so older
    clients that only read ``segments`` still get a reasonable split when
    waitIdles actually advance code_time for everyone who was waited on.
    """
    schedule = build_move_schedule(timeline, id_to_name)
    if not schedule:
        return []

    # Build per-var ordered moves (same as flat moves list order of issue)
    by_var: Dict[str, List[dict]] = {}
    for item in schedule:
        by_var.setdefault(item["var"], []).append(item["move"])

    # Single segment if no wait actually delayed anyone's later moves
    max_end = max(item["end"] for item in schedule)
    # Detect if any move starts after 0 with a gap caused by wait — still return
    # one segment of full lists for backward compat; client uses schedule.
    return [by_var]


def _build_mock_serial() -> types.ModuleType:
    # Start from a shallow shell so `import serial` works in user code
    mod = types.ModuleType("serial")
    mod.Serial = _FakeSerial
    # Common constants referenced by some serial-using code
    mod.EIGHTBITS = 8
    mod.PARITY_NONE = "N"
    mod.STOPBITS_ONE = 1
    return mod


def _build_mock_time() -> types.ModuleType:
    real = __import__("time")
    mod = types.ModuleType("time")
    for attr in dir(real):
        if attr.startswith("__"):
            continue
        try:
            setattr(mod, attr, getattr(real, attr))
        except Exception:
            pass
    # Never block during simulation
    mod.sleep = lambda *a, **k: None
    return mod


def _safe_builtins() -> dict:
    """Same idea as CodeExecutor — enough for Blockly-generated code."""
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


class MoveSimulator:
    """Execute code in a sandboxed dry-run and collect recorded robot moves."""

    @staticmethod
    def simulate(
        code: str,
        timeout_s: float = _DEFAULT_TIMEOUT_S,
    ) -> dict:
        """
        Returns:
          {
            success: bool,
            moves: { varName: [move, ...], ... },
            stdout: str,
            stderr: str,
            error?: str,
            timed_out?: bool,
            truncated?: bool,
          }
        """
        # Reset class state for this run
        RecordingRobot.total_moves = 0
        RecordingRobot.all_instances = []
        RecordingRobot.timeline = []

        mock_wlkata = _build_mock_wlkatapython()
        mock_serial = _build_mock_serial()
        mock_time = _build_mock_time()

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()
        old_stdout, old_stderr = sys.stdout, sys.stderr

        builtins_dict = _safe_builtins()
        orig_import = __import__

        def _patched_import(name, globals=None, locals=None, fromlist=(), level=0):
            if name == "wlkatapython" or name.startswith("wlkatapython."):
                return mock_wlkata
            if name == "serial" or name.startswith("serial."):
                return mock_serial
            if name == "time":
                return mock_time
            # Allow ordinary stdlib imports used by Blockly code
            return orig_import(name, globals, locals, fromlist, level)

        builtins_dict["__import__"] = _patched_import

        safe_globals: Dict[str, Any] = {
            "__builtins__": builtins_dict,
            "wlkatapython": mock_wlkata,
            "serial": mock_serial,
            "time": mock_time,
        }

        start = time.monotonic()
        line_count = 0
        timed_out = False
        truncated = False
        error: Optional[str] = None
        tb: Optional[str] = None

        def _trace(frame, event, arg):
            nonlocal line_count, timed_out, truncated
            if event != "line":
                return _trace
            line_count += 1
            if line_count > _MAX_TRACE_LINES:
                truncated = True
                raise _SimLimitExceeded(
                    f"Simulation exceeded max lines ({_MAX_TRACE_LINES}); "
                    "possible infinite loop"
                )
            if (time.monotonic() - start) > timeout_s:
                timed_out = True
                raise _SimLimitExceeded(
                    f"Simulation timed out after {timeout_s:.1f}s"
                )
            return _trace

        try:
            sys.stdout = stdout_buf
            sys.stderr = stderr_buf
            compiled = compile(code, "<simulate-moves>", "exec")
            sys.settrace(_trace)
            try:
                exec(compiled, safe_globals)
            finally:
                sys.settrace(None)
        except _SimLimitExceeded as e:
            error = str(e)
            # Partial results are still useful (moves recorded so far)
        except Exception as e:
            error = str(e)
            tb = traceback.format_exc()
        finally:
            sys.stdout = old_stdout
            sys.stderr = old_stderr
            sys.settrace(None)

        # Map global names -> RecordingRobot instances
        moves_by_var: Dict[str, List[dict]] = {}
        id_to_name: Dict[int, str] = {}
        seen_ids = set()
        for name, val in safe_globals.items():
            if name.startswith("__"):
                continue
            if isinstance(val, RecordingRobot):
                moves_by_var[name] = list(val.moves)
                id_to_name[id(val)] = name
                seen_ids.add(id(val))

        # Instances that never got a lasting global name (still return under
        # synthetic keys so nothing is silently dropped)
        orphan_idx = 0
        for inst in RecordingRobot.all_instances:
            if id(inst) in seen_ids:
                continue
            if not inst.moves and not any(
                e.get("instance_id") == id(inst) and e.get("type") == "waitIdle"
                for e in RecordingRobot.timeline
            ):
                continue
            key = f"__orphan_{orphan_idx}"
            orphan_idx += 1
            moves_by_var[key] = list(inst.moves)
            id_to_name[id(inst)] = key

        # Concurrent schedule with true waitIdle semantics (unit time slots)
        schedule = build_move_schedule(RecordingRobot.timeline, id_to_name)
        segments = build_animation_segments(RecordingRobot.timeline, id_to_name)
        if not segments and moves_by_var:
            segments = [{k: list(v) for k, v in moves_by_var.items() if v}]

        # Annotate timeline with resolved var names for the client
        named_timeline = []
        for ev in RecordingRobot.timeline:
            e = dict(ev)
            e["var"] = id_to_name.get(ev.get("instance_id"), e.get("var"))
            named_timeline.append(e)

        success = error is None
        # Partial success when we hit a limit but still recorded moves
        if error and any(moves_by_var.values()):
            success = True

        result = {
            "success": success,
            "moves": moves_by_var,
            "schedule": schedule,
            "segments": segments,
            "timeline": named_timeline,
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
