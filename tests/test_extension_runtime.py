"""Runtime adapters load per execution and clean up before the session is done.

The camera proxy stays in place. These tests use the fake test-device extension.
"""

import json
import os
import sys
import tempfile
import textwrap
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.app import _extension_ids_from_request, app
from server.debugger import StepDebugger
from server.executor import ABORT_STOP, CodeExecutor, _AbortExecution
from server.extension_registry import clear, discover, set_enabled
from server.extension_runtime import (
    ExtensionContext,
    ExtensionHttpError,
    ExtensionResponse,
    ExtensionRuntimeError,
    ExtensionRuntimeManager,
    clear_module_cache,
    runtime_module_name,
    unavailable_extensions,
)

FIXTURE = os.path.join(os.path.dirname(__file__), 'extension_contract')

GOOD_ADAPTER = textwrap.dedent('''
    EVENTS = []

    def create_session(ctx):
        EVENTS.append('init')
        ctx.add_cleanup(lambda: EVENTS.append('cleanup'))
        return Session()

    class Session:
        def close(self):
            if getattr(self, '_closed', False):
                return
            self._closed = True
            EVENTS.append('close')
''')

BAD_ADAPTER = textwrap.dedent('''
    def create_session(ctx):
        raise RuntimeError('boom')
''')

ORDER_ADAPTER = textwrap.dedent('''
    EVENTS = []

    def create_session(ctx):
        return Session(ctx)

    class Session:
        def __init__(self, ctx):
            self.ctx = ctx
        def close(self):
            from server.executor import CodeExecutor
            sess = CodeExecutor.get_session(self.ctx.session_id)
            EVENTS.append(False if sess is None else bool(sess.done))
''')

RAISE_ON_CLOSE = textwrap.dedent('''
    EVENTS = []

    def create_session(ctx):
        return Session()

    class Session:
        def close(self):
            EVENTS.append('close')
            raise RuntimeError('close broke')
''')


def _write_extension(root, name, source, depends=None, runtime_rel='runtime/adapter.py'):
    folder = os.path.join(root, name, 'runtime')
    os.makedirs(folder, exist_ok=True)
    manifest = {
        'manifestVersion': 2,
        'extensionApiVersion': 1,
        'name': name,
        'version': '1.0.0',
        'contributes': {'runtime': {'python': runtime_rel}},
    }
    if depends:
        manifest['depends'] = depends
    with open(os.path.join(root, name, 'extension.json'), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle)
    if source is not None:
        with open(os.path.join(root, name, runtime_rel), 'w', encoding='utf-8') as handle:
            handle.write(source)


class ExtensionRuntimeTests(unittest.TestCase):
    def tearDown(self):
        CodeExecutor.abort(ABORT_STOP)
        deadline = time.time() + 3
        while time.time() < deadline:
            with CodeExecutor._sessions_lock:
                if all(sess.done for sess in CodeExecutor._sessions.values()):
                    break
            time.sleep(0.02)
        with CodeExecutor._sessions_lock:
            CodeExecutor._clear_abort()
        StepDebugger._sessions.clear()
        clear()
        clear_module_cache()

    def test_response_keeps_bytes_until_json_is_asked_for(self):
        response = ExtensionResponse(200, {'Content-Type': 'image/jpeg'}, b'\\xff\\xd8')
        self.assertIsInstance(response.body, bytes)
        self.assertEqual(response.status, 200)
        parsed = ExtensionResponse(200, {}, b'{"ports":[{"id":"A"}]}')
        self.assertEqual(parsed.json()['ports'][0]['id'], 'A')
        self.assertIsInstance(parsed.body, bytes)

    def test_request_rejects_foreign_paths_and_keeps_abort(self):
        calls = []

        def transport(extension_id, method, relative, body, headers, timeout):
            calls.append((extension_id, method, relative, body, dict(headers)))
            return 200, {'Content-Type': 'application/json'}, b'{"ok": true}'

        ctx = ExtensionContext('test-device', 'sess-1', None, transport)
        response = ctx.request('get', '/ports?refresh=1')
        self.assertEqual(response.json()['ok'], True)
        self.assertEqual(calls[0][0], 'test-device')
        self.assertEqual(calls[0][1], 'GET')
        self.assertEqual(calls[0][2], '/ports?refresh=1')

        ctx.request('POST', '/open', json={'id': 'A'})
        self.assertEqual(calls[1][3], b'{"id": "A"}')
        self.assertEqual(calls[1][4].get('Content-Type'), 'application/json')

        for path in ('../secret', '//evil', 'http://evil/x', '/../x', '/a/../../b', ''):
            with self.assertRaises(ExtensionRuntimeError):
                ctx.request('GET', path)
        self.assertEqual(len(calls), 2)

        def fail(_extension_id, _method, _relative, _body, _headers, _timeout):
            return 404, {'Content-Type': 'application/json'}, b'{"error": "missing"}'

        ctx = ExtensionContext('test-device', 'sess-1', None, fail)
        with self.assertRaises(ExtensionHttpError) as caught:
            ctx.request('GET', '/frame?id=0')
        self.assertEqual(caught.exception.response.status, 404)
        self.assertIsInstance(caught.exception.response.body, bytes)
        self.assertIn('missing', str(caught.exception))

        def aborting(*_args):
            raise _AbortExecution('stop')

        ctx = ExtensionContext('test-device', 'sess-1', aborting, transport)
        with self.assertRaises(_AbortExecution):
            ctx.request('GET', '/ports')
        cleanup = ctx.request('POST', '/disconnect', json={'id': 1}, ignore_abort=True)
        self.assertEqual(cleanup.json()['ok'], True)
        self.assertEqual(calls[-1][1], 'POST')
        self.assertEqual(calls[-1][2], '/disconnect')

        def abort_inside(*_args):
            raise _AbortExecution('emergency')

        ctx = ExtensionContext('test-device', 'sess-1', None, abort_inside)
        with self.assertRaises(_AbortExecution) as caught_abort:
            ctx.request('GET', '/ports')
        self.assertEqual(caught_abort.exception.reason, 'emergency')

    def test_fixture_session_closes_once_and_is_not_cached(self):
        discover([FIXTURE])
        calls = []

        def transport(*_args):
            calls.append(1)
            raise AssertionError('test-device open must not need HTTP')

        first = ExtensionRuntimeManager.create_for_session(
            'run-1', ['test-device', 'test-device'], lambda: None, transport=transport,
        )
        second = ExtensionRuntimeManager.create_for_session(
            'run-2', ['test-device'], lambda: None, transport=transport,
        )
        self.assertIsNot(first.namespaces()['test-device'], second.namespaces()['test-device'])
        self.assertEqual(first.namespaces()['test-device'].session_id(), 'run-1')
        self.assertEqual(repr(first.namespaces()['test-device'].open('A')), 'device:A')
        with self.assertRaises(RuntimeError):
            first.namespaces()['test-device'].open('')
        with self.assertRaises(TypeError):
            first.namespaces()['extra'] = object()
        adapter = first.namespaces()['test-device']
        first.close_all()
        first.close_all()
        self.assertTrue(adapter._closed)
        self.assertEqual(calls, [])
        second.close_all()

    def test_init_failure_closes_previous_and_names_the_extension(self):
        with tempfile.TemporaryDirectory() as root:
            _write_extension(root, 'alpha', GOOD_ADAPTER)
            _write_extension(root, 'beta', BAD_ADAPTER)
            discover([root])
            with self.assertRaises(ExtensionRuntimeError) as caught:
                ExtensionRuntimeManager.create_for_session(
                    'run-1', ['alpha', 'beta'], lambda: None, transport=lambda *_a: None,
                )
        self.assertIn('beta', str(caught.exception))
        self.assertIn('boom', str(caught.exception))
        import sys as _sys
        events = _sys.modules[runtime_module_name('alpha')].EVENTS
        self.assertEqual(events, ['init', 'close', 'cleanup'])

    def test_cleanup_error_does_not_skip_the_other_adapter(self):
        with tempfile.TemporaryDirectory() as root:
            _write_extension(root, 'beta', RAISE_ON_CLOSE)
            _write_extension(root, 'alpha', GOOD_ADAPTER)
            discover([root])
            runtime = ExtensionRuntimeManager.create_for_session(
                'run-1', ['beta', 'alpha'], lambda: None, transport=lambda *_a: None,
            )
            runtime.close_all()
            runtime.close_all()
        import sys as _sys
        self.assertEqual(_sys.modules[runtime_module_name('beta')].EVENTS, ['close'])
        self.assertEqual(
            _sys.modules[runtime_module_name('alpha')].EVENTS,
            ['init', 'close', 'cleanup'],
        )
        self.assertEqual(len(runtime.cleanup_errors), 1)

    def test_disabled_missing_dependency_and_escaped_runtime_fail_before_user_code(self):
        discover([FIXTURE])
        set_enabled('test-device', False)
        with self.assertRaises(ExtensionRuntimeError) as disabled:
            ExtensionRuntimeManager.create_for_session('run-1', ['test-device'], None)
        self.assertIn('disabled', str(disabled.exception))

        with tempfile.TemporaryDirectory() as root:
            _write_extension(root, 'needs-other', GOOD_ADAPTER, depends=['not-there'])
            _write_extension(root, 'hole', None, runtime_rel='runtime/missing.py')
            discover([root])
            with self.assertRaises(ExtensionRuntimeError) as missing_dep:
                ExtensionRuntimeManager.create_for_session('run-1', ['needs-other'], None)
            self.assertIn('not-there', str(missing_dep.exception))
            with self.assertRaises(ExtensionRuntimeError) as missing_file:
                ExtensionRuntimeManager.create_for_session('run-1', ['hole'], None)
            self.assertIn('missing', str(missing_file.exception))
            record = __import__('server.extension_registry', fromlist=['get']).get('hole')
            record['runtime_python'] = '../secret.py'
            with self.assertRaises(ExtensionRuntimeError) as escaped:
                ExtensionRuntimeManager.create_for_session('run-2', ['hole'], None)
            self.assertIn('outside', str(escaped.exception))

        with self.assertRaises(ExtensionRuntimeError) as unknown:
            ExtensionRuntimeManager.create_for_session('run-1', ['not-installed'], None)
        self.assertIn('Missing extension: not-installed', str(unknown.exception))

    def test_batch_run_cleans_up_before_done_and_rejects_a_missing_extension(self):
        discover([FIXTURE])
        result = CodeExecutor.execute(
            "print(__studiox_extensions['test-device'].open('A'))\n"
            "print(__studiox_extensions['test-device'].session_id())\n",
            extension_ids=['test-device'],
        )
        self.assertTrue(result['success'], result)
        self.assertIn('device:A', result['stdout'])

        again = CodeExecutor.execute(
            "print(__studiox_extensions['test-device'].session_id())\n",
            extension_ids=['test-device'],
        )
        self.assertTrue(again['success'], again)
        self.assertNotEqual(result['stdout'].strip().splitlines()[-1], again['stdout'].strip())

        skipped = CodeExecutor.execute("print('ran')\n", extension_ids=['not-installed'])
        self.assertFalse(skipped['success'])
        self.assertIn('not-installed', skipped['error'])
        self.assertNotIn('ran', skipped.get('stdout') or '')

        plain = CodeExecutor.execute("print(1)\n")
        self.assertTrue(plain['success'], plain)
        self.assertIn('1', plain['stdout'])

    def test_stop_closes_the_adapter_before_the_session_is_done(self):
        with tempfile.TemporaryDirectory() as root:
            _write_extension(root, 'ordercheck', ORDER_ADAPTER)
            discover([root])
            started = CodeExecutor.start_interactive(
                'import time\nwhile True:\n    time.sleep(0.05)\n',
                extension_ids=['ordercheck'],
            )
            self.assertTrue(started['success'], started)
            deadline = time.time() + 2
            while time.time() < deadline and runtime_module_name('ordercheck') not in sys.modules:
                time.sleep(0.02)
            self.assertIn(runtime_module_name('ordercheck'), sys.modules)
            CodeExecutor.abort(ABORT_STOP)
            sess, events = _wait_done(started['session_id'])
        self.assertTrue(sess.done)
        self.assertEqual(sess.abort_reason, ABORT_STOP)
        self.assertTrue(any(event.get('type') == 'done' for event in events))
        import sys as _sys
        self.assertEqual(_sys.modules[runtime_module_name('ordercheck')].EVENTS, [False])

    def test_a_second_run_is_refused_while_the_first_is_stopping(self):
        discover([FIXTURE])
        started = CodeExecutor.start_interactive(
            'import time\nwhile True:\n    time.sleep(0.05)\n',
            extension_ids=['test-device'],
        )
        self.assertTrue(started['success'], started)
        busy = CodeExecutor.execute("print('no')\n", extension_ids=['test-device'])
        self.assertFalse(busy['success'])
        self.assertIn('already running', busy['error'])
        CodeExecutor.abort(ABORT_STOP)
        _wait_done(started['session_id'])

    def test_debug_uses_the_same_adapter_metadata(self):
        discover([FIXTURE])
        missing = StepDebugger.start("print('ran')\n", extension_ids=['not-installed'])
        self.assertFalse(missing['success'])
        self.assertIn('not-installed', missing['error'])

        started = StepDebugger.start(
            "print(__studiox_extensions['test-device'].open('B'))\n",
            extension_ids=['test-device'],
        )
        self.assertTrue(started['success'], started)
        finished = StepDebugger.continue_run(started['session_id'])
        self.assertTrue(finished.get('finished'))
        self.assertIn('device:B', finished.get('stdout') or '')

    def test_other_modes_do_not_pretend_the_runtime_is_loaded(self):
        with self.assertRaises(RuntimeError) as caught:
            unavailable_extensions('simulation')['test-device']
        self.assertIn('simulation', str(caught.exception))
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        for relative in ('server/move_simulator.py', 'server/gcode_export.py', 'server/inspector.py'):
            with open(os.path.join(root, relative), encoding='utf-8') as handle:
                self.assertIn('__studiox_extensions', handle.read())
        with open(os.path.join(root, 'server/extension_runtime.py'), encoding='utf-8') as handle:
            runtime = handle.read()
        self.assertNotIn("== 'camera'", runtime)
        self.assertNotIn('== "camera"', runtime)
        server_dir = os.path.join(root, 'server')
        for name in os.listdir(server_dir):
            if not name.endswith('.py'):
                continue
            with open(os.path.join(server_dir, name), encoding='utf-8') as handle:
                source = handle.read()
            self.assertNotIn('camera_client', source, name)
            self.assertNotIn('ManagedCapture', source, name)
            self.assertNotIn('_prepare_cv_proxy', source, name)
            self.assertNotIn('patch_cv2_module', source, name)

    def test_request_ids_are_optional_and_rechecked(self):
        self.assertEqual(_extension_ids_from_request({}), [])
        self.assertEqual(_extension_ids_from_request({'extension_ids': None}), [])
        self.assertEqual(
            _extension_ids_from_request({'extension_ids': ['test-device', 'test-device']}),
            ['test-device'],
        )
        with self.assertRaises(ValueError):
            _extension_ids_from_request({'extension_ids': 'test-device'})
        client = app.test_client()
        response = client.post('/execute', json={'code': 'print(1)\n', 'extension_ids': 'nope'})
        self.assertEqual(response.status_code, 400)


def _wait_done(session_id, timeout=3.0):
    sess = CodeExecutor.get_session(session_id)
    deadline = time.time() + timeout
    events = []
    index = 0
    while time.time() < deadline:
        batch, index = sess.wait_events(index, timeout=0.2)
        events.extend(batch)
        if sess.done and any(event.get('type') == 'done' for event in events):
            return sess, events
    return sess, events


if __name__ == '__main__':
    unittest.main()
