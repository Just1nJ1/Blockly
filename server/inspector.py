"""
Introspection module for the Blockly server.
Handles inspection of functions, modules, and instances.

Module imports resolve against:
  1. The server process environment (wlkatapython, flask, …)
  2. The reserved Blockly venv site-packages (user packages e.g. opencv-python)

so toolbox ``import`` / function-call inspect matches Run/Debug.
"""

import inspect
import builtins
import importlib
import re
from .executor import CodeExecutor
from .serial_manager import SerialManager


def _param_entry(name, *, has_default=False, default=None,
                 is_varargs=False, is_varkwargs=False,
                 is_keyword_only=False, is_positional_only=False,
                 kind='POSITIONAL_OR_KEYWORD', annotation=None):
    return {
        'name': name,
        'kind': kind,
        'has_default': bool(has_default),
        'default': default,
        'annotation': annotation,
        'is_varargs': bool(is_varargs),
        'is_varkwargs': bool(is_varkwargs),
        'is_keyword_only': bool(is_keyword_only),
        'is_positional_only': bool(is_positional_only),
    }


def _parse_opencv_style_doc_params(docstring):
    """
    Parse first-line signatures used by OpenCV / many C extensions, e.g.::

        cvtColor(src, code[, dst[, dstCn[, hint]]]) -> dst
        GaussianBlur(src, ksize, sigmaX[, dst[, sigmaY[, borderType]]]) -> dst

    Bracket groups mark optional parameters (has_default=True).
    Returns a list of param dicts, or None if the line cannot be parsed.
    """
    if not docstring:
        return None
    first = docstring.strip().splitlines()[0].strip()
    # OpenCV sometimes prefixes with ".   "
    first = re.sub(r'^[\.\s]+', '', first)
    if '->' in first:
        first = first.split('->', 1)[0].strip()

    # Require name(...)
    m = re.search(r'\((.*)\)\s*$', first)
    if not m:
        return None
    body = m.group(1).strip()
    if not body:
        return []

    # Tokenize identifiers and brackets (ignore other punctuation)
    tokens = re.findall(r'\[|\]|[A-Za-z_]\w*', body)
    if not tokens:
        return None

    params = []
    optional_depth = 0
    for tok in tokens:
        if tok == '[':
            optional_depth += 1
            continue
        if tok == ']':
            optional_depth = max(0, optional_depth - 1)
            continue
        # Skip self/cls for methods if ever present
        if tok in ('self', 'cls'):
            continue
        params.append(_param_entry(
            tok,
            has_default=(optional_depth > 0),
            kind='POSITIONAL_OR_KEYWORD',
        ))

    return params if params else None


def _params_from_text_signature(text_sig):
    """Parse PEP 362 ``__text_signature__`` if present (e.g. ``($module, /, src, code)``)."""
    if not text_sig or not isinstance(text_sig, str):
        return None
    # strip leading $self / $module patterns
    s = text_sig.strip()
    if s.startswith('(') and s.endswith(')'):
        s = s[1:-1]
    parts = [p.strip() for p in s.split(',')]
    params = []
    for p in parts:
        if not p or p == '/' or p == '*':
            continue
        if p.startswith('$'):  # $self, $module
            continue
        name = p.split('=')[0].strip()
        if not re.match(r'^[A-Za-z_]\w*$', name):
            continue
        has_def = '=' in p
        params.append(_param_entry(name, has_default=has_def))
    return params or None


def _extract_parameters(func, docstring):
    """
    Build parameter list for Blockly function_call blocks.

    Order:
      1. inspect.signature (pure Python)
      2. __text_signature__ (some CPython builtins)
      3. OpenCV-style first-line docstring
      4. Fallback: single *args so the block is still usable
    """
    # 1) Real signature
    try:
        sig = inspect.signature(func)
        parameters = []
        has_varargs = False
        has_varkwargs = False
        for param_name, param in sig.parameters.items():
            if param_name in ('self', 'cls'):
                continue
            is_varargs = param.kind == inspect.Parameter.VAR_POSITIONAL
            is_varkwargs = param.kind == inspect.Parameter.VAR_KEYWORD
            if is_varargs:
                has_varargs = True
            if is_varkwargs:
                has_varkwargs = True
            has_default = param.default is not inspect.Parameter.empty
            default = None
            if has_default:
                try:
                    default = repr(param.default)
                except Exception:
                    default = str(param.default)
            annotation = None
            if param.annotation is not inspect.Parameter.empty:
                try:
                    annotation = str(param.annotation)
                except Exception:
                    annotation = None
            parameters.append(_param_entry(
                param_name,
                has_default=has_default,
                default=default,
                is_varargs=is_varargs,
                is_varkwargs=is_varkwargs,
                is_keyword_only=(param.kind == inspect.Parameter.KEYWORD_ONLY),
                is_positional_only=(param.kind == inspect.Parameter.POSITIONAL_ONLY),
                kind=str(param.kind.name),
                annotation=annotation,
            ))
        if parameters:
            return parameters, has_varargs, has_varkwargs
    except (ValueError, TypeError):
        pass

    # 2) text signature
    text_sig = getattr(func, '__text_signature__', None)
    parsed = _params_from_text_signature(text_sig)
    if parsed:
        return parsed, False, False

    # 3) Docstring (OpenCV et al.)
    raw_doc = docstring if docstring and docstring != 'No documentation available.' else None
    if not raw_doc:
        raw_doc = getattr(func, '__doc__', None) or ''
    parsed = _parse_opencv_style_doc_params(raw_doc)
    if parsed:
        return parsed, False, False

    # 4) Usable fallback
    return (
        [_param_entry('args', is_varargs=True, kind='VAR_POSITIONAL')],
        True,
        False,
    )


class FunctionInspector:
    """Handles introspection of Python functions for Blockly blocks."""

    # Available built-in functions that users can call
    AVAILABLE_BUILTINS = [
        'abs', 'all', 'any', 'ascii', 'bin', 'bool', 'chr', 'complex',
        'dict', 'dir', 'divmod', 'enumerate', 'filter', 'float', 'format',
        'frozenset', 'hash', 'hex', 'id', 'input', 'int', 'isinstance',
        'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'oct', 'ord',
        'pow', 'print', 'range', 'repr', 'reversed', 'round', 'set',
        'slice', 'sorted', 'str', 'sum', 'tuple', 'type', 'zip',
    ]

    @staticmethod
    def inspect_function(func_name: str) -> dict:
        """
        Inspect a function and return its signature information.
        """
        try:
            # Check if it's a module.function pattern
            if '.' in func_name:
                parts = func_name.rsplit('.', 1)
                module_path = parts[0]
                function_name = parts[1]
                try:
                    module = CodeExecutor._import_module_resolved(module_path)
                    func = getattr(module, function_name)
                except (ImportError, AttributeError):
                    return {
                        'success': False,
                        'error': f'Function "{function_name}" not found in module "{module_path}"'
                    }
            else:
                # Try to get the function from builtins
                if func_name not in FunctionInspector.AVAILABLE_BUILTINS:
                    # Also check if it's a valid builtin not in our restricted list
                    if not hasattr(builtins, func_name):
                        return {
                            'success': False,
                            'error': f'Function "{func_name}" not found in available builtins'
                        }

                func = getattr(builtins, func_name)

            if not callable(func):
                return {
                    'success': False,
                    'error': f'"{func_name}" is not callable'
                }

            # Get docstring
            docstring = inspect.getdoc(func) or 'No documentation available.'

            parameters, has_varargs, has_varkwargs = _extract_parameters(func, docstring)

            return {
                'success': True,
                'name': func_name,
                'docstring': docstring,
                'parameters': parameters,
                'has_varargs': has_varargs,
                'has_varkwargs': has_varkwargs
            }

        except Exception as e:
            return {
                'success': False,
                'error': f'Error inspecting function: {str(e)}'
            }

    @staticmethod
    def list_available_functions() -> list:
        """Return a list of available function names."""
        return FunctionInspector.AVAILABLE_BUILTINS

    @staticmethod
    def _is_module_constant(name: str, obj) -> bool:
        """True for public module-level constants (not callables / submodules).

        Includes ints/floats/bools/strs (OpenCV flags like COLOR_BGR2GRAY) and
        small numeric tuples. Skips callables, modules, and huge objects.
        """
        import types
        if not name or name.startswith('_'):
            return False
        if callable(obj):
            return False
        if isinstance(obj, types.ModuleType):
            return False
        # Classic ALL_CAPS flags (COLOR_BGR2GRAY, RETR_EXTERNAL, …)
        if re.match(r'^[A-Z][A-Z0-9_]*$', name):
            # Avoid dumping class objects / large structs under CAPS names
            if isinstance(obj, type):
                return False
            return True
        if isinstance(obj, (int, float, bool, str)) or obj is None:
            return True
        if isinstance(obj, tuple) and len(obj) <= 16:
            try:
                return all(isinstance(x, (int, float, bool)) for x in obj)
            except Exception:
                return False
        # numpy scalar types (some OpenCV builds expose these)
        try:
            import numpy as np
            if isinstance(obj, (np.integer, np.floating, np.bool_)):
                return True
        except Exception:
            pass
        return False

    @staticmethod
    def list_module_functions(module_path: str) -> dict:
        """List public callables and constants in a module.

        Resolves the module from the server env first, then the Blockly
        venv (same as Run/Debug ``import`` resolution).

        Returns:
          functions: ``["cv2.cvtColor", ...]``
          constants: ``["cv2.COLOR_BGR2GRAY", ...]``  (non-callable values)
        """
        try:
            module = CodeExecutor._import_module_resolved(module_path)
            functions = []
            constants = []
            for name, obj in inspect.getmembers(module):
                if name.startswith('_'):
                    continue
                full = f"{module_path}.{name}"
                if callable(obj):
                    functions.append(full)
                elif FunctionInspector._is_module_constant(name, obj):
                    constants.append(full)

            return {
                'success': True,
                'module': module_path,
                'functions': sorted(functions),
                'constants': sorted(constants),
            }
        except ImportError as e:
            return {
                'success': False,
                'error': f'Module "{module_path}" not found: {str(e)}'
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'Error listing functions for "{module_path}": {str(e)}'
            }


class InstanceInspector:
    """Handles introspection of instance members."""

    @staticmethod
    def _build_safe_globals(code: str) -> dict:
        """Build safe globals dict by executing code and extracting imports.
        Uses the SerialManager's proxy so serial.Serial() reuses
        the shared connection instead of opening a new one.

        Blockly venv site-packages are on ``sys.path`` for the duration so
        imports like ``cv2`` resolve the same way as Run/Debug.
        """
        import_lines = []
        for line in code.split('\n'):
            if line.strip().startswith(('import ', 'from ')):
                import_lines.append(line)

        safe_globals = CodeExecutor._safe_globals()

        # Patch serial.Serial to use the proxy if a managed port is connected
        mgr = SerialManager.get_instance()
        if mgr.connected:
            import serial as _serial_module
            _patched_serial = type(_serial_module)('_patched_serial')
            _patched_serial.__dict__.update(_serial_module.__dict__)
            _patched_serial.Serial = mgr.get_proxy_serial_class()

            _orig_import = __import__
            _proxy = _patched_serial
            def _patched_import(name, *args, **kwargs):
                if name == 'serial':
                    return _proxy
                return _orig_import(name, *args, **kwargs)
            safe_globals['__builtins__']['__import__'] = _patched_import

        # Match runtime package resolution (server env + blockly env)
        site = CodeExecutor._prepare_blockly_packages()
        try:
            for imp in import_lines:
                try:
                    exec(imp, safe_globals)
                except Exception:
                    pass

            try:
                exec(compile(code, '<blockly>', 'exec'), safe_globals)
            except Exception:
                # Ignore execution errors; we just need whatever variables did get defined
                pass
        finally:
            CodeExecutor._cleanup_blockly_packages(site)

        return safe_globals

    @staticmethod
    def inspect_instance_members(code: str, instance_name: str) -> dict:
        """Inspect instance members (methods and fields)."""
        try:
            safe_globals = InstanceInspector._build_safe_globals(code)

            if instance_name not in safe_globals:
                return {
                    'success': False,
                    'error': f'Instance "{instance_name}" not found. Make sure the code defining it is valid.'
                }

            instance = safe_globals[instance_name]
            methods = []
            fields = []

            for name, attr in inspect.getmembers(instance):
                if name.startswith('_'):
                    continue

                if callable(attr):
                    methods.append(name)
                else:
                    fields.append(name)

            return {
                'success': True,
                'instance': instance_name,
                'class_name': type(instance).__name__,
                'methods': sorted(methods),
                'fields': sorted(fields)
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'Error inspecting instance: {str(e)}'
            }

    @staticmethod
    def inspect_instance_method(code: str, instance_name: str, method_name: str) -> dict:
        """Inspect a specific instance method."""
        try:
            safe_globals = InstanceInspector._build_safe_globals(code)

            if instance_name not in safe_globals:
                return {
                    'success': False,
                    'error': f'Instance "{instance_name}" not found. Make sure the code defining it is valid.'
                }

            instance = safe_globals[instance_name]
            if not hasattr(instance, method_name):
                return {
                    'success': False,
                    'error': f'Method "{method_name}" not found on instance "{instance_name}"'
                }

            method = getattr(instance, method_name)
            if not callable(method):
                return {
                    'success': False,
                    'error': f'"{method_name}" is not callable on "{instance_name}"'
                }

            docstring = inspect.getdoc(method) or 'No documentation available.'
            try:
                sig = inspect.signature(method)
            except (ValueError, TypeError):
                return {
                    'success': True,
                    'name': method_name,
                    'docstring': docstring,
                    'parameters': [],
                    'has_varargs': False,
                    'has_varkwargs': False
                }

            parameters = []
            has_varargs = False
            has_varkwargs = False

            for param_name, param in sig.parameters.items():
                if param_name == 'self':
                    continue

                param_info = {
                    'name': param_name,
                    'kind': str(param.kind.name),
                }

                if param.kind == inspect.Parameter.VAR_POSITIONAL:
                    param_info['kind'] = 'VAR_POSITIONAL'
                    param_info['is_varargs'] = True
                    has_varargs = True
                elif param.kind == inspect.Parameter.VAR_KEYWORD:
                    param_info['kind'] = 'VAR_KEYWORD'
                    param_info['is_varkwargs'] = True
                    has_varkwargs = True
                elif param.kind == inspect.Parameter.KEYWORD_ONLY:
                    param_info['kind'] = 'KEYWORD_ONLY'
                    param_info['is_keyword_only'] = True
                elif param.kind == inspect.Parameter.POSITIONAL_ONLY:
                    param_info['kind'] = 'POSITIONAL_ONLY'
                    param_info['is_positional_only'] = True
                else:
                    param_info['kind'] = 'POSITIONAL_OR_KEYWORD'

                if param.default is not inspect.Parameter.empty:
                    param_info['has_default'] = True
                    try:
                        param_info['default'] = repr(param.default)
                    except Exception:
                        param_info['default'] = str(param.default)
                else:
                    param_info['has_default'] = False
                    param_info['default'] = None

                if param.annotation is not inspect.Parameter.empty:
                    try:
                        param_info['annotation'] = str(param.annotation)
                    except Exception:
                        param_info['annotation'] = None
                else:
                    param_info['annotation'] = None

                parameters.append(param_info)

            return {
                'success': True,
                'name': method_name,
                'docstring': docstring,
                'parameters': parameters,
                'has_varargs': has_varargs,
                'has_varkwargs': has_varkwargs
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'Error inspecting method: {str(e)}'
            }
