"""
Flask application and routes for the Blockly server.
"""

import os
import sys
import subprocess
import tempfile
import threading
import uuid

from flask import Flask, request, jsonify
from flask_cors import CORS
from .executor import CodeExecutor
from .inspector import FunctionInspector, InstanceInspector
from .debugger import StepDebugger
from .detector import scan_devices
from .serial_manager import SerialManager

# In-memory store for firmware flash jobs (desktop app, single user)
_flash_jobs = {}

app = Flask(__name__)
CORS(app, resources={
    r"/*": {
        "origins": "*",
        "methods": ["GET", "POST", "OPTIONS"],
        "allow_headers": ["Content-Type"]
    }
})


@app.route('/health', methods=['GET'])
def health_check():
    """Health check endpoint."""
    return jsonify({'status': 'ok', 'message': 'StudioX Server is running'})


@app.route('/check-serial-access', methods=['GET'])
def check_serial_access():
    """Check if the user has permission to access serial ports (Linux)."""
    import sys
    import os

    if sys.platform == 'win32':
        return jsonify({'success': True, 'access': True})

    # Check if user is in dialout/uucp group
    try:
        import grp
        username = os.getlogin()
        groups = [g.gr_name for g in grp.getgrall() if username in g.gr_mem]
        # Also check primary group
        primary_gid = os.getgid()
        try:
            primary_group = grp.getgrgid(primary_gid).gr_name
            groups.append(primary_group)
        except KeyError:
            pass

        has_dialout = 'dialout' in groups
        has_uucp = 'uucp' in groups

        if has_dialout or has_uucp:
            return jsonify({'success': True, 'access': True})

        # Check if any serial ports are actually accessible
        import serial.tools.list_ports
        ports = list(serial.tools.list_ports.comports())
        for p in ports:
            try:
                import serial
                s = serial.Serial(p.device, timeout=0.1)
                s.close()
                return jsonify({'success': True, 'access': True})
            except PermissionError:
                return jsonify({
                    'success': True,
                    'access': False,
                    'message': 'Serial port permission denied. Run this command and restart:\n\nsudo usermod -aG dialout $USER\n\nThen log out and log back in.',
                    'platform': sys.platform
                })
            except Exception:
                continue

        # No ports found — can't determine, assume OK
        return jsonify({'success': True, 'access': True})
    except Exception as e:
        return jsonify({'success': True, 'access': True})


@app.route('/functions', methods=['GET'])
def list_functions():
    """Return list of available built-in functions."""
    return jsonify({
        'success': True,
        'functions': FunctionInspector.list_available_functions()
    })


@app.route('/execute', methods=['POST'])
def execute_code():
    """Execute Python code."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        code = data.get('code', '')
        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        result = CodeExecutor.execute(code)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/execute/abort', methods=['POST'])
def execute_abort():
    """Abort any running code execution."""
    try:
        CodeExecutor.abort()
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/inspect', methods=['POST'])
def inspect_function():
    """Inspect a function signature."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        func_name = data.get('function', '')
        if not func_name:
            return jsonify({'success': False, 'error': 'No function name provided'}), 400

        result = FunctionInspector.inspect_function(func_name)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/import', methods=['POST'])
def import_module():
    """List functions in a module."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        module_name = data.get('module', '')
        if not module_name:
            return jsonify({'success': False, 'error': 'No module name provided'}), 400

        result = FunctionInspector.list_module_functions(module_name)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/inspect-instance', methods=['POST'])
def inspect_instance():
    """Inspect instance members (methods and fields)."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        code = data.get('code', '')
        instance_name = data.get('instance', '')

        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        if not instance_name:
            return jsonify({'success': False, 'error': 'No instance name provided'}), 400

        result = InstanceInspector.inspect_instance_members(code, instance_name)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/inspect-instance-method', methods=['POST'])
def inspect_instance_method():
    """Inspect a specific instance method."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        code = data.get('code', '')
        instance_name = data.get('instance', '')
        method_name = data.get('method', '')

        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        if not instance_name:
            return jsonify({'success': False, 'error': 'No instance name provided'}), 400

        if not method_name:
            return jsonify({'success': False, 'error': 'No method name provided'}), 400

        result = InstanceInspector.inspect_instance_method(code, instance_name, method_name)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/debug/start', methods=['POST'])
def debug_start():
    """Start a step-debug session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        code = data.get('code', '')
        if not code:
            return jsonify({'success': False, 'error': 'No code provided'}), 400

        result = StepDebugger.start(code)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/debug/step', methods=['POST'])
def debug_step():
    """Advance one line in a debug session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        session_id = data.get('session_id', '')
        if not session_id:
            return jsonify({'success': False, 'error': 'No session_id provided'}), 400

        result = StepDebugger.step(session_id)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/debug/continue', methods=['POST'])
def debug_continue():
    """Continue running code without pausing."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        session_id = data.get('session_id', '')
        if not session_id:
            return jsonify({'success': False, 'error': 'No session_id provided'}), 400

        result = StepDebugger.continue_run(session_id)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/debug/stop', methods=['POST'])
def debug_stop():
    """Stop and clean up a debug session."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        session_id = data.get('session_id', '')
        if not session_id:
            return jsonify({'success': False, 'error': 'No session_id provided'}), 400

        result = StepDebugger.stop(session_id)
        return jsonify(result)

    except Exception as e:
        return jsonify({'success': False, 'error': f'Server error: {str(e)}'}), 500


@app.route('/cmd/connect', methods=['POST'])
def cmd_connect():
    """Connect to a serial port."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        port = data.get('port', '')
        model = data.get('model', None)
        baudrate = data.get('baudrate', 115200)

        if not port:
            return jsonify({'success': False, 'error': 'No port provided'}), 400

        mgr = SerialManager.get_instance()
        result = mgr.connect(port, model=model, baudrate=baudrate)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/disconnect', methods=['POST'])
def cmd_disconnect():
    """Disconnect from the serial port."""
    try:
        mgr = SerialManager.get_instance()
        result = mgr.disconnect()
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/send', methods=['POST'])
def cmd_send():
    """Send a raw command to the connected device."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        command = data.get('command', '')
        if not command:
            return jsonify({'success': False, 'error': 'No command provided'}), 400

        port = data.get('port', None)
        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected:
            return jsonify({'success': False, 'error': 'Not connected'})

        result = conn.send_raw(command, source='command')
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/query', methods=['POST'])
def cmd_query():
    """Send a command and return the first response line (blocks up to timeout)."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        command = data.get('command', '')
        if not command:
            return jsonify({'success': False, 'error': 'No command provided'}), 400

        port    = data.get('port', None)
        timeout = float(data.get('timeout', 1.5))

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected:
            return jsonify({'success': False, 'error': 'Not connected'})

        result = conn.send_and_wait(command, timeout=timeout)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/history', methods=['GET'])
def cmd_history():
    """Get message history since a given ID."""
    try:
        since = request.args.get('since', 0, type=int)
        mgr = SerialManager.get_instance()
        messages = mgr.get_history(since=since)
        return jsonify({'success': True, 'messages': messages})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/last-status', methods=['POST'])
def cmd_last_status():
    """Return the cached status from auto-report ($40=1). No serial query."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected:
            return jsonify({'success': False, 'error': 'Not connected'})

        if not conn._last_status:
            return jsonify({'success': False, 'error': 'No status available yet'})

        result = {
            'success': True,
            'state': conn._last_status.get('state', ''),
            'model': conn.model,
            'angles': conn._last_status['angles'],
            'coordinates': conn._last_status['coordinates'],
            'pump': conn._last_status.get('pump', 0),
            'valve': conn._last_status.get('valve', 0),
            'mode': conn._last_status.get('mode', 0),
            'ts': conn._last_status_ts,
        }
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/get-status', methods=['POST'])
def cmd_get_status():
    """Query the robot's current status using the SDK's getStatus()."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)

        mgr = SerialManager.get_instance()

        # Find the connection for the requested port
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected:
            return jsonify({'success': False, 'error': 'Not connected'})

        if not conn.robot:
            return jsonify({'success': False, 'error': 'No SDK instance for this port'})

        silent = data.get('silent', False)

        # Query status directly via serial (more reliable than SDK's getStatus
        # which has tight timing). Flush, send ?, wait for <...> response.
        import time as _time
        import re as _re

        status = None
        max_retries = 5
        for attempt in range(max_retries):
            try:
                if silent:
                    conn._silent = True
                conn.rx_flush_input()
                conn._awaiting_query = True
                conn.raw_serial.write(b'?\r\n')
                # Wait for response via RX buffer
                line_bytes = conn.rx_readline(timeout=1.0)
                if silent:
                    conn._silent = False

                if not line_bytes:
                    _time.sleep(0.2)
                    continue

                line = line_bytes.decode('utf-8', errors='ignore').strip()
                if line.startswith('<') and line.endswith('>'):
                    pattern = r'<(\w+),Angle\(ABCDXYZ\):([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),Cartesian coordinate\(XYZ RxRyRz\):([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),([\d.-]+),Pump PWM:([\d.-]+),Valve PWM:([\d.-]+),Motion_MODE:([\d.-]+)>'
                    m = _re.match(pattern, line)
                    if m:
                        status = {
                            'state': m.group(1),
                            'angle_A': m.group(2), 'angle_B': m.group(3),
                            'angle_C': m.group(4), 'angle_D': m.group(5),
                            'angle_X': m.group(6), 'angle_Y': m.group(7),
                            'angle_Z': m.group(8),
                            'coordinate_X': m.group(9), 'coordinate_Y': m.group(10),
                            'coordinate_Z': m.group(11), 'coordinate_RX': m.group(12),
                            'coordinate_RY': m.group(13), 'coordinate_RZ': m.group(14),
                            'pump': m.group(15), 'valve': m.group(16),
                            'mode': m.group(17)
                        }
                        break
                _time.sleep(0.2)
            except Exception:
                if silent:
                    conn._silent = False
                _time.sleep(0.2)

        if silent:
            conn._silent = False

        if not status:
            return jsonify({'success': False, 'error': 'Failed to get status'})

        # status is a dict with keys like 'state', 'angle_A', 'coordinate_X', etc.
        result = {
            'success': True,
            'state': str(status.get('state', '')),
            'model': conn.model,
            'angles': {
                'A': float(status.get('angle_A', 0)),
                'B': float(status.get('angle_B', 0)),
                'C': float(status.get('angle_C', 0)),
                'D': float(status.get('angle_D', 0)),
                'X': float(status.get('angle_X', 0)),
                'Y': float(status.get('angle_Y', 0)),
                'Z': float(status.get('angle_Z', 0)),
            },
            'coordinates': {
                'X': float(status.get('coordinate_X', 0)),
                'Y': float(status.get('coordinate_Y', 0)),
                'Z': float(status.get('coordinate_Z', 0)),
                'Rx': float(status.get('coordinate_RX', 0)),
                'Ry': float(status.get('coordinate_RY', 0)),
                'Rz': float(status.get('coordinate_RZ', 0)),
            },
            'pump': float(status.get('pump', 0)),
            'valve': float(status.get('valve', 0)),
            'mode': float(status.get('mode', 0)),
        }
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/home', methods=['POST'])
def cmd_home():
    """Call homing() on the robot at the specified port."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        conn.robot.homing()
        conn.add_history('sys', 'Homing started')
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/zero', methods=['POST'])
def cmd_zero():
    """Call zero() on the robot at the specified port."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        conn.robot.zero()
        conn.add_history('sys', 'Move to zero position')
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/pump', methods=['POST'])
def cmd_pump():
    """Control the suction cup via SDK pump()."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)
        mode = int(data.get('mode', 0))

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        conn.robot.pump(mode)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/gripper', methods=['POST'])
def cmd_gripper():
    """Control the gripper via SDK gripper()."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)
        mode = int(data.get('mode', 0))

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        conn.robot.gripper(mode)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/stop-all', methods=['POST'])
def cmd_stop_all():
    """Emergency stop: call cancellation() on all connected robots."""
    try:
        mgr = SerialManager.get_instance()
        stopped = []
        errors = []
        for conn in mgr.all_connected():
            try:
                if conn.robot:
                    conn.robot.cancellation()
                    conn.add_history('sys', 'STOP — cancellation sent')
                    stopped.append(conn.port)
            except Exception as e:
                errors.append({'port': conn.port, 'error': str(e)})
        return jsonify({'success': True, 'stopped': stopped, 'errors': errors})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/jog', methods=['POST'])
def cmd_jog():
    """Jog the robot. Supports single-axis step or multi-axis absolute move."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        port = data.get('port', None)
        mode = data.get('mode', 'joint')       # 'joint' or 'coord'

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        values = data.get('values', None)       # multi-axis: {x, y, z, a, b, c}

        if values:
            # Multi-axis absolute move (used by teaching panel)
            motion = int(data.get('motion', 0))  # 0=Fast, 1=Linear, 2=Joint
            kwargs = {}
            for key in ('x', 'y', 'z', 'a', 'b', 'c'):
                if key in values and values[key] is not None:
                    kwargs[key] = float(values[key])
            if mode == 'coord':
                conn.robot.writeCoordinate(motion, 0, **kwargs)
            else:
                conn.robot.writeAngle(0, **kwargs)
        else:
            # Single-axis jog (used by control panel +/- buttons)
            axis = data.get('axis', '').upper()
            step = float(data.get('step', 0))
            if not axis:
                return jsonify({'success': False, 'error': 'Invalid axis'}), 400

            absolute = data.get('absolute', False)
            kwargs = {axis.lower(): step}

            if absolute:
                if mode == 'coord':
                    conn.robot.writeCoordinate(0, 0, **kwargs)
                else:
                    conn.robot.writeAngle(0, **kwargs)
            else:
                if mode == 'coord':
                    conn.robot.writeCoordinate(0, 1, **kwargs)
                else:
                    conn.robot.writeAngle(1, **kwargs)

        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/status', methods=['GET'])
def cmd_status():
    """Get current connection status."""
    try:
        mgr = SerialManager.get_instance()
        return jsonify({'success': True, **mgr.status()})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/probe-port', methods=['POST'])
def cmd_probe_port():
    """Probe a serial port to detect the robot model (sends $V).
    Returns the model name or null if detection fails."""
    try:
        data = request.get_json() or {}
        port = data.get('port', '')
        if not port:
            return jsonify({'success': False, 'error': 'No port provided'}), 400

        from .detector import detect_model
        model = detect_model(port)
        return jsonify({'success': True, 'model': model})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'model': None})


@app.route('/list-all-ports', methods=['GET'])
def list_all_ports():
    """List ALL serial ports on the system (no filtering).
    Used by the manual port picker to show available ports."""
    try:
        import serial.tools.list_ports
        all_ports = list(serial.tools.list_ports.comports())
        result = []
        for p in all_ports:
            result.append({
                'device': p.device,
                'description': p.description or '',
                'hwid': p.hwid or '',
            })
        result.sort(key=lambda r: r['device'])
        return jsonify({'success': True, 'ports': result})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e), 'ports': []})


@app.route('/detect-devices', methods=['GET'])
def detect_devices():
    """Scan serial ports and identify connected robotic arms."""
    try:
        result = scan_devices()
        return jsonify({'success': True, **result})
    except Exception as e:
        return jsonify({'success': False, 'error': f'Detection error: {str(e)}', 'ports': []})


@app.route('/cmd/firmware-version', methods=['POST'])
def cmd_firmware_version():
    """Fetch and cache firmware version for the connected robot."""
    try:
        data = request.get_json() or {}
        port = data.get('port', None)

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected:
            return jsonify({'success': False, 'error': 'Not connected'})

        result = conn.fetch_firmware_version()
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


def _find_esptool_cfg():
    """Return path to bundled esptool.cfg, falling back to resources/ in dev."""
    _parent = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
    for candidate in [
        os.path.join(_parent, 'esptool.cfg'),
        os.path.join(_parent, 'resources', 'esptool.cfg'),
    ]:
        if os.path.isfile(candidate):
            return candidate
    return ''


def _find_avrdude():
    """Locate avrdude binary and config, preferring bundled resources."""
    import glob, shutil, platform
    _parent = os.path.normpath(os.path.join(os.path.dirname(__file__), '..'))
    _avrdude_root = os.path.join(_parent, 'avrdude')
    if not os.path.isdir(_avrdude_root):
        _avrdude_root = os.path.join(_parent, 'resources', 'avrdude')
    machine = platform.machine().lower()
    if sys.platform == 'darwin':
        _subdir = 'avrdude_macOS_64bit'
        _exe_rel = os.path.join('bin', 'avrdude')
        _cfg_rel = os.path.join('etc', 'avrdude.conf')
    elif sys.platform == 'win32':
        _subdir = 'avrdude-v8.1-windows-arm64' if 'arm' in machine else 'avrdude-v8.1-windows-x64'
        _exe_rel = 'avrdude.exe'
        _cfg_rel = 'avrdude.conf'
    else:
        _subdir = 'avrdude_Linux_ARM64' if ('aarch' in machine or machine == 'arm64') else 'avrdude_Linux_64bit'
        _exe_rel = os.path.join('bin', 'avrdude')
        _cfg_rel = os.path.join('etc', 'avrdude.conf')
    bundled_exe = os.path.join(_avrdude_root, _subdir, _exe_rel)
    bundled_conf = os.path.join(_avrdude_root, _subdir, _cfg_rel)
    candidates = [bundled_exe]
    from_path = shutil.which('avrdude')
    if from_path:
        candidates.append(from_path)
    candidates.append('/Applications/Arduino.app/Contents/Java/hardware/tools/avr/bin/avrdude')
    candidates += glob.glob(os.path.expanduser('~/Library/Arduino15/packages/arduino/tools/avrdude/*/bin/avrdude'))
    candidates += ['/usr/local/bin/avrdude', '/opt/homebrew/bin/avrdude']
    for base in [r'C:\Program Files (x86)\Arduino', r'C:\Program Files\Arduino']:
        candidates.append(os.path.join(base, r'hardware\tools\avr\bin\avrdude.exe'))
    for path in candidates:
        if not os.path.isfile(path):
            continue
        if path == bundled_exe and os.path.isfile(bundled_conf):
            return path, bundled_conf
        for rel in [os.path.join('..', 'etc', 'avrdude.conf'), 'avrdude.conf']:
            c = os.path.normpath(os.path.join(os.path.dirname(path), rel))
            if os.path.isfile(c):
                return path, c
        return path, None
    return None, None


@app.route('/cmd/flash-firmware', methods=['POST'])
def cmd_flash_firmware():
    """Flash ESP32 extender box firmware using esptool."""
    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No firmware file provided'}), 400
    fw_file = request.files['file']
    port = request.form.get('port', '').strip()
    baud = request.form.get('baud', '460800').strip()
    flash_mode = request.form.get('flash_mode', 'qio').strip()
    flash_freq = request.form.get('flash_freq', '80m').strip()
    flash_size = request.form.get('flash_size', '4MB').strip()
    address = request.form.get('address', '0x0').strip()

    mgr = SerialManager.get_instance()
    if port:
        mgr.lock_for_flash(port)

    import time as _time
    _time.sleep(1.0)  # let OS fully release the port before esptool opens it

    fd, tmp_path = tempfile.mkstemp(suffix='.bin')
    os.close(fd)
    fw_file.save(tmp_path)

    job_id = uuid.uuid4().hex[:8]
    _flash_jobs[job_id] = {'lines': [], 'done': False, 'success': None}

    def run_flash():
        try:
            cmd = [sys.executable, '-m', 'esptool']
            if port:
                cmd += ['--port', port]
            cmd += ['--chip', 'esp32', '--baud', baud,
                    '--before', 'default-reset', '--after', 'hard-reset',
                    'write_flash', '--flash-mode', flash_mode, '--flash-freq', flash_freq,
                    '--flash-size', flash_size, address, tmp_path]
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            cfg_path = _find_esptool_cfg()
            if cfg_path:
                env['ESPTOOL_CFGFILE'] = cfg_path
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, env=env)
            for line in proc.stdout:
                _flash_jobs[job_id]['lines'].append(line.rstrip())
            proc.wait()
            _flash_jobs[job_id]['success'] = (proc.returncode == 0)
        except Exception as e:
            _flash_jobs[job_id]['lines'].append(f'Error: {e}')
            _flash_jobs[job_id]['success'] = False
        finally:
            _flash_jobs[job_id]['done'] = True
            if port:
                SerialManager.get_instance().unlock_port(port)
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    threading.Thread(target=run_flash, daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/cmd/flash-firmware-path', methods=['POST'])
def cmd_flash_firmware_path():
    """Flash ESP32 extender box firmware from a local file path."""
    data = request.get_json() or {}
    file_path = data.get('file_path', '').strip()
    port = data.get('port', '').strip()
    baud = data.get('baud', '460800').strip()
    flash_mode = data.get('flash_mode', 'qio').strip()
    flash_freq = data.get('flash_freq', '80m').strip()
    flash_size = data.get('flash_size', '4MB').strip()
    address = data.get('address', '0x0').strip()

    if not file_path or not os.path.isfile(file_path):
        return jsonify({'success': False, 'error': 'Invalid firmware file path'})

    mgr = SerialManager.get_instance()
    if port:
        mgr.lock_for_flash(port)

    import time as _time
    _time.sleep(1.0)

    job_id = uuid.uuid4().hex[:8]
    _flash_jobs[job_id] = {'lines': [], 'done': False, 'success': None}

    def run_flash():
        try:
            cmd = [sys.executable, '-m', 'esptool']
            if port:
                cmd += ['--port', port]
            cmd += ['--chip', 'esp32', '--baud', baud,
                    '--before', 'default-reset', '--after', 'hard-reset',
                    'write_flash', '--flash-mode', flash_mode, '--flash-freq', flash_freq,
                    '--flash-size', flash_size, address, file_path]
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            cfg_path = _find_esptool_cfg()
            if cfg_path:
                env['ESPTOOL_CFGFILE'] = cfg_path
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, env=env)
            for line in proc.stdout:
                _flash_jobs[job_id]['lines'].append(line.rstrip())
            proc.wait()
            _flash_jobs[job_id]['success'] = (proc.returncode == 0)
        except Exception as e:
            _flash_jobs[job_id]['lines'].append(f'Error: {e}')
            _flash_jobs[job_id]['success'] = False
        finally:
            _flash_jobs[job_id]['done'] = True
            if port:
                SerialManager.get_instance().unlock_port(port)

    threading.Thread(target=run_flash, daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/cmd/flash-arm-firmware', methods=['POST'])
def cmd_flash_arm_firmware():
    """Flash ATMEGA2560 robot arm firmware using avrdude."""
    avrdude, avrdude_conf = _find_avrdude()
    if not avrdude:
        return jsonify({'success': False, 'error': 'avrdude not found. Please install the Arduino IDE.'})

    if 'file' not in request.files:
        return jsonify({'success': False, 'error': 'No firmware file provided'}), 400
    fw_file = request.files['file']
    port = request.form.get('port', '').strip()
    device = request.form.get('device', 'atmega2560').strip()
    baud = request.form.get('baud', '115200').strip()
    programmer = request.form.get('programmer', 'wiring').strip()

    mgr = SerialManager.get_instance()
    if port:
        mgr.lock_for_flash(port)

    import time as _time
    _time.sleep(1.0)  # let OS fully release the port before avrdude opens it

    fd, tmp_path = tempfile.mkstemp(suffix='.hex')
    os.close(fd)
    fw_file.save(tmp_path)

    job_id = uuid.uuid4().hex[:8]
    _flash_jobs[job_id] = {'lines': [], 'done': False, 'success': None}

    def run_flash():
        try:
            cmd = [avrdude, '-p', device, '-c', programmer,
                   '-b', baud, '-D',
                   '-U', f'flash:w:{tmp_path}:i']
            if port:
                cmd += ['-P', port]
            if avrdude_conf:
                cmd += ['-C', avrdude_conf]
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, env=env)
            for line in proc.stdout:
                _flash_jobs[job_id]['lines'].append(line.rstrip())
            proc.wait()
            _flash_jobs[job_id]['success'] = (proc.returncode == 0)
        except Exception as e:
            _flash_jobs[job_id]['lines'].append(f'Error: {e}')
            _flash_jobs[job_id]['success'] = False
        finally:
            _flash_jobs[job_id]['done'] = True
            if port:
                SerialManager.get_instance().unlock_port(port)
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    threading.Thread(target=run_flash, daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/cmd/flash-arm-firmware-path', methods=['POST'])
def cmd_flash_arm_firmware_path():
    """Flash ATMEGA2560 robot arm firmware from a local file path."""
    avrdude, avrdude_conf = _find_avrdude()
    if not avrdude:
        return jsonify({'success': False, 'error': 'avrdude not found. Please install the Arduino IDE.'})

    data = request.get_json() or {}
    file_path = data.get('file_path', '').strip()
    port = data.get('port', '').strip()
    device = data.get('device', 'atmega2560').strip()
    baud = data.get('baud', '115200').strip()
    programmer = data.get('programmer', 'wiring').strip()

    if not file_path or not os.path.isfile(file_path):
        return jsonify({'success': False, 'error': 'Invalid firmware file path'})

    mgr = SerialManager.get_instance()
    if port:
        mgr.lock_for_flash(port)

    import time as _time
    _time.sleep(1.0)

    job_id = uuid.uuid4().hex[:8]
    _flash_jobs[job_id] = {'lines': [], 'done': False, 'success': None}

    def run_flash():
        try:
            cmd = [avrdude, '-p', device, '-c', programmer,
                   '-b', baud, '-D',
                   '-U', f'flash:w:{file_path}:i']
            if port:
                cmd += ['-P', port]
            if avrdude_conf:
                cmd += ['-C', avrdude_conf]
            env = os.environ.copy()
            env['PYTHONUNBUFFERED'] = '1'
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    text=True, bufsize=1, env=env)
            for line in proc.stdout:
                _flash_jobs[job_id]['lines'].append(line.rstrip())
            proc.wait()
            _flash_jobs[job_id]['success'] = (proc.returncode == 0)
        except Exception as e:
            _flash_jobs[job_id]['lines'].append(f'Error: {e}')
            _flash_jobs[job_id]['success'] = False
        finally:
            _flash_jobs[job_id]['done'] = True
            if port:
                SerialManager.get_instance().unlock_port(port)

    threading.Thread(target=run_flash, daemon=True).start()
    return jsonify({'success': True, 'job_id': job_id})


@app.route('/cmd/flash-progress/<job_id>', methods=['GET'])
def cmd_flash_progress(job_id):
    """Poll progress of a firmware flash job."""
    job = _flash_jobs.get(job_id)
    if not job:
        return jsonify({'success': False, 'error': 'Unknown job'}), 404
    return jsonify({
        'success': True,
        'lines': list(job['lines']),
        'done': job['done'],
        'flash_success': job['success'],
    })


_FIRMWARE_REPO = 'wlkata/Firmware'
_firmware_cache = {'ts': 0, 'data': None}  # cache GitHub response for 10 min
_FIRMWARE_CACHE_TTL = 600
_FIRMWARE_MAX_PAGES = 3  # scan up to 3 pages of releases (30 per page)


def _fetch_all_releases():
    """Fetch recent releases from GitHub (cached). Returns list of releases."""
    import time as _time
    import urllib.request
    import json as _json

    now = _time.time()
    if _firmware_cache['data'] and (now - _firmware_cache['ts']) < _FIRMWARE_CACHE_TTL:
        return _firmware_cache['data']

    all_releases = []
    for page in range(1, _FIRMWARE_MAX_PAGES + 1):
        url = (f'https://api.github.com/repos/{_FIRMWARE_REPO}/releases'
               f'?per_page=30&page={page}')
        req = urllib.request.Request(url, headers={
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'WLKATA-StudioX'
        })
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                page_data = _json.loads(resp.read().decode())
            if not page_data:
                break
            all_releases.extend(page_data)
        except Exception:
            break

    _firmware_cache['data'] = all_releases
    _firmware_cache['ts'] = now
    return all_releases


@app.route('/cmd/check-firmware-update', methods=['POST'])
def cmd_check_firmware_update():
    """Check GitHub releases for newer firmware.

    Expects JSON: { extender: "20230710" | null, robot: "20230710" | null,
                    model: "Mirobot" | "MT4" | "E4" | null }
    Scans all recent releases to find the newest asset matching each type,
    since different releases may contain firmware for different models.
    Returns: { success, updates: { extender: {current, latest, url} | null,
                                    robot: {current, latest, url} | null } }
    """
    import re
    try:
        data = request.get_json() or {}
        current_ext = data.get('extender')
        current_robot = data.get('robot')
        model = data.get('model', '')  # e.g. 'Mirobot', 'MT4', 'E4'

        try:
            releases = _fetch_all_releases()
        except Exception:
            return jsonify({'success': True, 'updates': {'extender': None, 'robot': None}})

        if not releases:
            return jsonify({'success': True, 'updates': {'extender': None, 'robot': None}})

        updates = {'extender': None, 'robot': None}
        date_re = re.compile(r'v?(\d{8})')  # matches 20260422 or v20260422

        # Model name matching for robot arm .hex files
        # E4 uses MT4 firmware, so look for MT4 assets when model is E4
        robot_prefix = model.upper() if model else ''
        if robot_prefix == 'E4':
            robot_prefix = 'MT4'

        # Scan all releases, all assets — keep the newest match for each type
        for release in releases:
            for asset in release.get('assets', []):
                name = asset.get('name', '')
                name_upper = name.upper()
                download_url = asset.get('browser_download_url', '')
                m = date_re.search(name)
                if not m:
                    continue
                asset_date = m.group(1)

                # Extender box: any .bin with EXBOX in the name
                if 'EXBOX' in name_upper and name.lower().endswith('.bin'):
                    if current_ext and asset_date > current_ext:
                        if not updates['extender'] or asset_date > updates['extender']['latest']:
                            updates['extender'] = {
                                'current': current_ext,
                                'latest': asset_date,
                                'filename': name,
                                'url': download_url
                            }

                # Robot arm: .hex file matching the connected model
                elif name.lower().endswith('.hex') and robot_prefix:
                    if robot_prefix in name_upper:
                        if current_robot and asset_date > current_robot:
                            if not updates['robot'] or asset_date > updates['robot']['latest']:
                                updates['robot'] = {
                                    'current': current_robot,
                                    'latest': asset_date,
                                    'filename': name,
                                    'url': download_url
                                }

        return jsonify({'success': True, 'updates': updates})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/list-firmware-versions', methods=['POST'])
def cmd_list_firmware_versions():
    """List all available firmware versions from GitHub releases.

    Expects JSON: { type: 'extender'|'robot', model: 'Mirobot'|'MT4'|'E4' }
    Returns: { success, versions: [ {version, filename, url, release_date}, ... ] }
    Versions are sorted newest first.
    """
    import re
    try:
        data = request.get_json() or {}
        fw_type = data.get('type', 'extender')
        model = data.get('model', '')

        try:
            releases = _fetch_all_releases()
        except Exception:
            return jsonify({'success': True, 'versions': []})

        if not releases:
            return jsonify({'success': True, 'versions': []})

        date_re = re.compile(r'v?(\d{8})')
        versions = []
        seen = set()

        # Model prefix for robot arm
        robot_prefix = model.upper() if model else ''
        if robot_prefix == 'E4':
            robot_prefix = 'MT4'

        for release in releases:
            release_date = release.get('published_at', '')[:10]  # YYYY-MM-DD
            for asset in release.get('assets', []):
                name = asset.get('name', '')
                name_upper = name.upper()
                download_url = asset.get('browser_download_url', '')
                m = date_re.search(name)
                if not m:
                    continue
                asset_version = m.group(1)

                # Skip duplicates
                if asset_version in seen:
                    continue

                if fw_type == 'extender':
                    if 'EXBOX' in name_upper and name.lower().endswith('.bin'):
                        seen.add(asset_version)
                        versions.append({
                            'version': asset_version,
                            'filename': name,
                            'url': download_url,
                            'release_date': release_date
                        })
                else:
                    if name.lower().endswith('.hex') and robot_prefix and robot_prefix in name_upper:
                        seen.add(asset_version)
                        versions.append({
                            'version': asset_version,
                            'filename': name,
                            'url': download_url,
                            'release_date': release_date
                        })

        # Sort newest first
        versions.sort(key=lambda v: v['version'], reverse=True)
        return jsonify({'success': True, 'versions': versions})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.route('/cmd/download-firmware', methods=['POST'])
def cmd_download_firmware():
    """Download a firmware asset from GitHub and flash it.

    Expects JSON: { port, url, type: 'extender'|'robot' }
    Returns: { success, job_id } — same polling as manual flash.
    """
    try:
        import urllib.request

        data = request.get_json() or {}
        port = data.get('port', '').strip()
        fw_url = data.get('url', '').strip()
        fw_type = data.get('type', 'extender')

        # Extender flash params
        baud = data.get('baud', '460800')
        flash_mode = data.get('flash_mode', 'qio')
        flash_freq = data.get('flash_freq', '80m')
        flash_size = data.get('flash_size', '4MB')
        address = data.get('address', '0x0')

        # Robot arm flash params
        device = data.get('device', 'atmega2560')
        arm_baud = data.get('baud', '115200')
        programmer = data.get('programmer', 'wiring')

        if not fw_url:
            return jsonify({'success': False, 'error': 'No firmware URL provided'})

        suffix = '.bin' if fw_type == 'extender' else '.hex'
        fd, tmp_path = tempfile.mkstemp(suffix=suffix)
        os.close(fd)

        job_id = uuid.uuid4().hex[:8]
        _flash_jobs[job_id] = {'lines': [], 'done': False, 'success': None}

        def run():
            try:
                _flash_jobs[job_id]['lines'].append('Downloading firmware...')
                req = urllib.request.Request(fw_url, headers={'User-Agent': 'WLKATA-StudioX'})
                with urllib.request.urlopen(req, timeout=120) as resp:
                    with open(tmp_path, 'wb') as f:
                        f.write(resp.read())
                _flash_jobs[job_id]['lines'].append('Download complete. Starting flash...')

                mgr = SerialManager.get_instance()
                if port:
                    mgr.lock_for_flash(port)

                import time as _time
                _time.sleep(1.0)

                if fw_type == 'extender':
                    cmd = [sys.executable, '-m', 'esptool']
                    if port:
                        cmd += ['--port', port]
                    cmd += ['--chip', 'esp32', '--baud', baud,
                            '--before', 'default-reset', '--after', 'hard-reset',
                            'write_flash', '--flash-mode', flash_mode, '--flash-freq', flash_freq,
                            '--flash-size', flash_size, address, tmp_path]
                    env = os.environ.copy()
                    env['PYTHONUNBUFFERED'] = '1'
                    cfg_path = _find_esptool_cfg()
                    if cfg_path:
                        env['ESPTOOL_CFGFILE'] = cfg_path
                else:
                    avrdude, avrdude_conf = _find_avrdude()
                    if not avrdude:
                        _flash_jobs[job_id]['lines'].append('Error: avrdude not found.')
                        _flash_jobs[job_id]['success'] = False
                        return
                    cmd = [avrdude, '-p', device, '-c', programmer,
                           '-b', arm_baud, '-D',
                           '-U', f'flash:w:{tmp_path}:i']
                    if port:
                        cmd += ['-P', port]
                    if avrdude_conf:
                        cmd += ['-C', avrdude_conf]
                    env = os.environ.copy()
                    env['PYTHONUNBUFFERED'] = '1'

                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, bufsize=1, env=env)
                for line in proc.stdout:
                    _flash_jobs[job_id]['lines'].append(line.rstrip())
                proc.wait()
                _flash_jobs[job_id]['success'] = (proc.returncode == 0)
            except Exception as e:
                _flash_jobs[job_id]['lines'].append(f'Error: {e}')
                _flash_jobs[job_id]['success'] = False
            finally:
                _flash_jobs[job_id]['done'] = True
                if port:
                    SerialManager.get_instance().unlock_port(port)
                try:
                    os.unlink(tmp_path)
                except Exception:
                    pass

        threading.Thread(target=run, daemon=True).start()
        return jsonify({'success': True, 'job_id': job_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)})


@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors."""
    return jsonify({'error': 'Internal server error'}), 500


def create_app(extensions_dirs=None):
    """Factory function to create the Flask app."""
    if extensions_dirs:
        from .extensions import load_extensions
        for ext_dir in extensions_dirs:
            load_extensions(app, ext_dir)
    return app
