"""Core loads the Camera extension's runtime without a Camera-specific branch.

Hardware is not opened. The legacy cv2 proxy is still installed; removing it
is a later phase that waits on a real camera and a packaged build.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.extension_registry import clear, discover
from server.extension_runtime import (
    ExtensionRuntimeError,
    ExtensionRuntimeManager,
    clear_module_cache,
)
from server.executor import _AbortExecution

BLOCKLY = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _camera_root():
    candidates = [
        os.path.join(BLOCKLY, 'extensions', 'camera'),
        os.path.join(os.path.dirname(BLOCKLY), 'WLKATA-StudioX-camera'),
    ]
    for path in candidates:
        if os.path.isfile(os.path.join(path, 'runtime', 'adapter.py')):
            return os.path.realpath(path)
    return ''


class CameraAdapterLoadTests(unittest.TestCase):
    def setUp(self):
        self.root = _camera_root()
        if not self.root:
            self.skipTest('Camera extension checkout is not available')

    def tearDown(self):
        clear()
        clear_module_cache()

    def test_manager_opens_a_holder_only_through_the_extension(self):
        calls = []

        def transport(extension_id, method, relative, body, headers, timeout):
            calls.append((extension_id, method, relative, body))
            if method == 'POST' and relative == '/connect':
                return 200, {'Content-Type': 'application/json'}, b'{"success": true}'
            if method == 'GET' and relative.startswith('/frame'):
                return 404, {'Content-Type': 'application/json'}, b'{"error": "No camera frame"}'
            if method == 'POST' and relative == '/disconnect':
                return 200, {'Content-Type': 'application/json'}, b'{"success": true}'
            raise AssertionError((method, relative))

        with tempfile.TemporaryDirectory() as parent:
            os.symlink(self.root, os.path.join(parent, 'camera'))
            found = discover([parent])
            self.assertIn('camera', [item['id'] for item in found['accepted']])
            runtime = ExtensionRuntimeManager.create_for_session(
                'run-camera', ['camera'], lambda: None, transport=transport,
            )
            try:
                adapter = runtime.namespaces()['camera']
                with self.assertRaises(RuntimeError):
                    adapter.open_camera('')
                self.assertEqual(calls, [])
                cap = adapter.open_camera(0)
                self.assertEqual(calls[0][0], 'camera')
                self.assertEqual(calls[0][1], 'POST')
                self.assertEqual(calls[0][2], '/connect')
                payload = json.loads(calls[0][3].decode('utf-8'))
                self.assertEqual(payload['id'], 0)
                self.assertTrue(payload['client'].startswith('program-run-camera-'))
                self.assertTrue(cap.isOpened())
            finally:
                runtime.close_all()
            self.assertTrue(any(call[2] == '/disconnect' for call in calls))

            state = {'abort': False}

            def abort():
                if state['abort']:
                    raise _AbortExecution('stop')

            before = len(calls)
            runtime = ExtensionRuntimeManager.create_for_session(
                'run-stop', ['camera'], abort, transport=transport,
            )
            state['abort'] = True
            try:
                with self.assertRaises(_AbortExecution):
                    runtime.namespaces()['camera'].open_camera(1)
            finally:
                runtime.close_all()
            self.assertEqual(len(calls), before)

    def test_a_missing_camera_extension_does_not_open_hardware(self):
        clear()
        with self.assertRaises(ExtensionRuntimeError) as caught:
            ExtensionRuntimeManager.create_for_session('run-1', ['camera'], None)
        self.assertIn('Missing extension: camera', str(caught.exception))
        with open(os.path.join(BLOCKLY, 'server', 'executor.py'), encoding='utf-8') as handle:
            executor = handle.read()
        self.assertNotIn('camera_client', executor)
        self.assertNotIn('_prepare_cv_proxy', executor)
        self.assertNotIn("extension == 'camera'", executor)


if __name__ == '__main__':
    unittest.main()
