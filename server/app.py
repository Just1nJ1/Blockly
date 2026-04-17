"""
Flask application and routes for the Blockly server.
"""

from flask import Flask, request, jsonify
from flask_cors import CORS
from .executor import CodeExecutor
from .inspector import FunctionInspector, InstanceInspector
from .debugger import StepDebugger
from .detector import scan_devices
from .serial_manager import SerialManager

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
    return jsonify({'status': 'ok', 'message': 'Blockly Python Server is running'})


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

        mgr = SerialManager.get_instance()
        result = mgr.send_raw(command, source='command')
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
    """Jog a single axis by a step amount using the SDK."""
    try:
        data = request.get_json()
        if not data:
            return jsonify({'success': False, 'error': 'No JSON data provided'}), 400

        port = data.get('port', None)
        mode = data.get('mode', 'joint')       # 'joint' or 'coord'
        axis = data.get('axis', '').upper()     # e.g. 'X', 'Y', 'Z', 'A', 'B', 'C'
        step = float(data.get('step', 0))

        if not axis:
            return jsonify({'success': False, 'error': 'Invalid axis'}), 400

        mgr = SerialManager.get_instance()
        conn = None
        if port and port in mgr._ports:
            conn = mgr._ports[port]
        elif mgr.active_connection:
            conn = mgr.active_connection

        if not conn or not conn.connected or not conn.robot:
            return jsonify({'success': False, 'error': 'Not connected'})

        absolute = data.get('absolute', False)

        # Build keyword args: only the target axis gets the value
        kwargs = {axis.lower(): step}

        if absolute:
            # Absolute move: position=0 (G90)
            if mode == 'coord':
                conn.robot.writeCoordinate(0, 0, **kwargs)
            else:
                conn.robot.writeAngle(0, **kwargs)
        else:
            # Incremental move: position=1 (G91)
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


@app.route('/detect-devices', methods=['GET'])
def detect_devices():
    """Scan serial ports and identify connected robotic arms."""
    try:
        result = scan_devices()
        return jsonify({'success': True, **result})
    except Exception as e:
        return jsonify({'success': False, 'error': f'Detection error: {str(e)}', 'ports': []})


@app.errorhandler(404)
def not_found(error):
    """Handle 404 errors."""
    return jsonify({'error': 'Not found'}), 404


@app.errorhandler(500)
def internal_error(error):
    """Handle 500 errors."""
    return jsonify({'error': 'Internal server error'}), 500


def create_app():
    """Factory function to create the Flask app."""
    return app
