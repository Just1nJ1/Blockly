"""
Code execution module for the Blockly server.
Handles safe execution of Python code and captures stdout/stderr.
"""

import sys
import io
import threading
import traceback
from .serial_manager import SerialManager


class _AbortExecution(Exception):
    """Raised when execution is aborted via emergency stop."""
    pass


class CodeExecutor:
    """Handles safe execution of Python code."""

    _abort_event = threading.Event()

    @classmethod
    def abort(cls):
        """Signal the running execution to abort."""
        cls._abort_event.set()

    @staticmethod
    def _safe_globals() -> dict:
        """Return a sandboxed globals dictionary with basic safe builtins."""
        return {
            '__builtins__': {
                'print': print,
                'len': len,
                'range': range,
                'enumerate': enumerate,
                'zip': zip,
                'map': map,
                'filter': filter,
                'sum': sum,
                'min': min,
                'max': max,
                'abs': abs,
                'round': round,
                'pow': pow,
                'divmod': divmod,
                'int': int,
                'float': float,
                'str': str,
                'bool': bool,
                'list': list,
                'dict': dict,
                'tuple': tuple,
                'set': set,
                'type': type,
                'isinstance': isinstance,
                'hasattr': hasattr,
                'getattr': getattr,
                'setattr': setattr,
                'dir': dir,
                'chr': chr,
                'ord': ord,
                'hex': hex,
                'bin': bin,
                'oct': oct,
                'format': format,
                'sorted': sorted,
                'reversed': reversed,
                'any': any,
                'all': all,
                'vars': vars,
                'locals': locals,
                'globals': globals,
                'repr': repr,
                'ascii': ascii,
                'callable': callable,
                'classmethod': classmethod,
                'staticmethod': staticmethod,
                'property': property,
                'slice': slice,
                'complex': complex,
                'frozenset': frozenset,
                'bytearray': bytearray,
                'bytes': bytes,
                'memoryview': memoryview,
                'hash': hash,
                'help': help,
                'id': id,
                'input': input,
                'iter': iter,
                'next': next,
                'object': object,
                'super': super,
                '__import__': __import__,
                '__name__': '__main__',
                '__doc__': None,
            }
        }

    @staticmethod
    def execute(code: str) -> dict:
        """
        Execute Python code and return results.

        Returns a dict with:
        - success: bool
        - stdout: captured stdout
        - stderr: captured stderr
        - result: the result of the last expression (if any)
        - error: error message if execution failed
        - traceback: full error traceback if execution failed
        """
        # Create string buffers for stdout and stderr
        stdout_buffer = io.StringIO()
        stderr_buffer = io.StringIO()

        # Save original streams
        old_stdout = sys.stdout
        old_stderr = sys.stderr

        try:
            # Redirect stdout and stderr
            sys.stdout = stdout_buffer
            sys.stderr = stderr_buffer

            # Create a sandboxed globals dict with basic safe builtins
            safe_globals = CodeExecutor._safe_globals()

            # Patch serial.Serial so SDK reuses the shared connection
            mgr = SerialManager.get_instance()
            if mgr.connected:
                mgr.busy = True
                for conn in mgr.all_connected():
                    conn.add_history('sys', 'Blockly started')
                import serial as _serial_module
                _patched_serial = type(_serial_module)('_patched_serial')
                _patched_serial.__dict__.update(_serial_module.__dict__)
                _patched_serial.Serial = mgr.get_proxy_serial_class()
                safe_globals['__serial_proxy__'] = _patched_serial

            # Compile and execute the code
            try:
                # Inject proxy: replace "import serial" with our patched module
                if mgr.connected and '__serial_proxy__' in safe_globals:
                    import importlib
                    _orig_import = __import__
                    _proxy = safe_globals['__serial_proxy__']
                    def _patched_import(name, *args, **kwargs):
                        if name == 'serial':
                            return _proxy
                        return _orig_import(name, *args, **kwargs)
                    safe_globals['__builtins__']['__import__'] = _patched_import

                # Clear abort flag before starting
                CodeExecutor._abort_event.clear()

                # Set up a trace function that checks the abort flag on every line
                def _abort_trace(frame, event, arg):
                    if CodeExecutor._abort_event.is_set():
                        raise _AbortExecution('Execution aborted by emergency stop')
                    return _abort_trace

                compiled = compile(code, '<blockly>', 'exec')
                sys.settrace(_abort_trace)
                try:
                    exec(compiled, safe_globals)
                finally:
                    sys.settrace(None)

                # Get the result - try to find the last expression value
                result = None
                # Check if there's a last expression to evaluate
                lines = code.strip().split('\n')
                if lines:
                    last_line = lines[-1].strip()
                    # Skip common statements that don't yield a result
                    # Skip lines that are statements or function/method calls
                    # (re-eval'ing them would execute side effects twice)
                    is_skip = (
                        last_line.startswith(('def ', 'class ', 'if ', 'for ', 'while ',
                                             'import ', 'from ', '#', 'print(', 'try:',
                                             'except', 'finally', 'with ', 'return ',
                                             'pass', 'break', 'continue', 'raise ')) or
                        '=' in last_line.split('(')[0] or  # assignment like x = ...
                        last_line.endswith(')')             # any function/method call
                    )
                    if last_line and not is_skip:
                        try:
                            result = eval(last_line, safe_globals)
                        except Exception:
                            pass

                return {
                    'success': True,
                    'stdout': stdout_buffer.getvalue(),
                    'stderr': stderr_buffer.getvalue(),
                    'result': repr(result) if result is not None else None
                }
            except _AbortExecution:
                return {
                    'success': False,
                    'error': 'Execution aborted by emergency stop',
                    'stdout': stdout_buffer.getvalue(),
                    'stderr': stderr_buffer.getvalue()
                }
            except SyntaxError as e:
                return {
                    'success': False,
                    'error': f'Syntax Error: {e.msg} at line {e.lineno}',
                    'stdout': stdout_buffer.getvalue(),
                    'stderr': stderr_buffer.getvalue()
                }
            except Exception as e:
                error_msg = traceback.format_exc()
                return {
                    'success': False,
                    'error': str(e),
                    'traceback': error_msg,
                    'stdout': stdout_buffer.getvalue(),
                    'stderr': stderr_buffer.getvalue()
                }
        finally:
            # Restore original streams
            sys.stdout = old_stdout
            sys.stderr = old_stderr

            # Release busy flag and log stop
            try:
                mgr = SerialManager.get_instance()
                for conn in mgr.all_connected():
                    conn.add_history('sys', 'Blockly stopped')
                mgr.busy = False
            except Exception:
                pass
