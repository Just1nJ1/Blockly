"""Preview hub, execution cleanup, and camera-session ownership."""

import io
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import camera_client, preview_hub
from server.executor import CodeExecutor


def _wait_until(predicate, timeout=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return False


class PreviewHubTests(unittest.TestCase):
    def setUp(self):
        preview_hub.reset_for_execution()
        preview_hub._logged.clear()

    def test_opencv_load_is_not_program_output(self):
        stdout = io.StringIO()
        with mock.patch('sys.stdout', stdout):
            try:
                preview_hub._import_cv2()
            except Exception:
                pass
        self.assertNotIn('[preview]', stdout.getvalue())
        self.assertNotIn('OpenCV', stdout.getvalue())

    def test_reset_drops_previous_frames(self):
        with mock.patch.object(preview_hub, '_encode_one', lambda image: 'jpeg-%s' % image):
            preview_hub.submit('one', 1)
            self.assertTrue(_wait_until(lambda: preview_hub.snapshot()[1]))
            rev, frames, err = preview_hub.snapshot()
            self.assertEqual(frames[0]['image'], 'jpeg-one')
            self.assertEqual(err, '')
            preview_hub.reset_for_execution()
            rev2, frames2, err2 = preview_hub.snapshot()
            self.assertEqual(frames2, [])
            self.assertEqual(err2, '')
            self.assertGreater(rev2, rev)

    def test_inflight_encode_does_not_publish_after_reset(self):
        started = threading.Event()
        release = threading.Event()

        def encode(image):
            if image == 'old':
                started.set()
                self.assertTrue(release.wait(2))
                return 'OLD'
            return 'NEW-%s' % image

        try:
            with mock.patch.object(preview_hub, '_encode_one', encode):
                preview_hub.submit('old', 1)
                self.assertTrue(started.wait(2))
                preview_hub.reset_for_execution()
                preview_hub.submit('fresh', 1)
                release.set()
                self.assertTrue(_wait_until(
                    lambda: any(f['image'] == 'NEW-fresh' for f in preview_hub.snapshot()[1])
                ))
                images = [f['image'] for f in preview_hub.snapshot()[1]]
                self.assertNotIn('OLD', images)
                self.assertIn('NEW-fresh', images)
        finally:
            release.set()

    def test_failure_is_visible_with_existing_frames_and_logged_once(self):
        with mock.patch.object(preview_hub, '_encode_one', lambda image: 'jpeg'):
            preview_hub.submit('frame', 1)
            self.assertTrue(_wait_until(lambda: preview_hub.snapshot()[1]))
        with mock.patch('sys.stdout'):
            preview_hub.note_failure('OpenCV encode failed')
            preview_hub.note_failure('OpenCV encode failed')
        _rev, frames, err = preview_hub.snapshot()
        self.assertTrue(frames)
        self.assertEqual(err, 'OpenCV encode failed')
        self.assertEqual(sum(1 for line in preview_hub._logged if 'OpenCV encode failed' in line), 1)


class CameraOwnershipTests(unittest.TestCase):
    def setUp(self):
        with camera_client._program_lock:
            camera_client._by_session.clear()
        camera_client.unbind_capture_session()

    def tearDown(self):
        with camera_client._program_lock:
            camera_client._by_session.clear()
        camera_client.unbind_capture_session()

    def test_one_session_does_not_release_the_other(self):
        calls = []

        def fake(method, path, body=None, timeout=8):
            calls.append((method, path, body))
            return b'{"success": true}', 'application/json'

        with mock.patch.object(camera_client, '_call', fake):
            camera_client.bind_capture_session('exec-a')
            first = camera_client.ManagedCapture(0)
            camera_client.bind_capture_session('exec-b')
            second = camera_client.ManagedCapture(0)
            camera_client.release_program_captures('exec-a')
            self.assertFalse(first.isOpened())
            self.assertTrue(second.isOpened())
            disconnects = [body for method, path, body in calls if path == '/disconnect']
            self.assertEqual(len(disconnects), 1)
            self.assertEqual(disconnects[0]['client'], first.client)
            self.assertTrue(disconnects[0]['client'].startswith('program-exec-a-'))
            self.assertNotIn('window', disconnects[0]['client'])
            camera_client.release_program_captures('exec-a')
            self.assertEqual(len([c for c in calls if c[1] == '/disconnect']), 1)
            second.release()
            second.release()
            self.assertEqual(len([c for c in calls if c[1] == '/disconnect']), 2)
            self.assertFalse(second.isOpened())

    def test_failed_connect_keeps_no_owner(self):
        calls = []

        def fake(method, path, body=None, timeout=8):
            calls.append((method, path, body))
            if path == '/connect':
                return b'{"success": false, "error": "busy"}', 'application/json'
            return b'{"success": true}', 'application/json'

        with mock.patch.object(camera_client, '_call', fake):
            with mock.patch.object(camera_client, '_note_failure'):
                camera_client.bind_capture_session('exec-a')
                cap = camera_client.ManagedCapture(1)
        self.assertFalse(cap.isOpened())
        self.assertEqual(camera_client._by_session, {})
        self.assertTrue(any(path == '/disconnect' and body['client'] == cap.client
                            for _method, path, body in calls))


class ExecutorCleanupTests(unittest.TestCase):
    def tearDown(self):
        CodeExecutor.abort()
        _wait_until(self._idle, timeout=3)
        CodeExecutor._abort_event.clear()

    @staticmethod
    def _idle():
        with CodeExecutor._sessions_lock:
            return all(s.done for s in CodeExecutor._sessions.values())

    def test_new_start_waits_until_cleanup_finishes(self):
        entered = threading.Event()
        gate = threading.Event()
        original = CodeExecutor._release_cameras

        def slow(session_id=None):
            entered.set()
            CodeExecutor._abort_event.set()
            self.assertTrue(gate.wait(3))
            original(session_id)

        CodeExecutor._release_cameras = staticmethod(slow)
        try:
            first = CodeExecutor.start_interactive('print(1)\n')
            self.assertTrue(first['success'])
            self.assertTrue(entered.wait(2))
            second = CodeExecutor.start_interactive('print(2)\n')
            self.assertFalse(second['success'])
            self.assertIn('already running', second['error'])
            self.assertTrue(CodeExecutor._abort_event.is_set())
        finally:
            gate.set()
            CodeExecutor._release_cameras = original
        self.assertTrue(_wait_until(self._idle))
        third = CodeExecutor.start_interactive('print(3)\n')
        self.assertTrue(third['success'], third)
        self.assertFalse(CodeExecutor._abort_event.is_set())

    def test_overlapping_starts_allow_only_one(self):
        barrier = threading.Barrier(2)
        results = []

        def go():
            barrier.wait()
            results.append(CodeExecutor.start_interactive('import time\ntime.sleep(0.6)\n'))

        threads = [threading.Thread(target=go) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sum(1 for result in results if result.get('success')), 1)


if __name__ == '__main__':
    unittest.main()
