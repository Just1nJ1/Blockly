"""Preview hub and execution cleanup. OpenCV import is not redirected."""

import io
import os
import sys
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import preview_hub
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
        original = CodeExecutor.cleanup_runtime

        def slow(runtime=None):
            entered.set()
            CodeExecutor._abort_event.set()
            self.assertTrue(gate.wait(3))
            original(runtime)

        CodeExecutor.cleanup_runtime = staticmethod(slow)
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
            CodeExecutor.cleanup_runtime = original
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

    def test_import_cv2_is_not_sent_to_the_camera_extension(self):
        self.assertNotIn('server.camera_client', sys.modules)
        result = CodeExecutor.execute(
            "try:\n"
            "    import cv2\n"
            "    print(cv2.VideoCapture.__name__)\n"
            "except Exception as exc:\n"
            "    print('import-failed:' + type(exc).__name__)\n"
        )
        self.assertTrue(result['success'], result)
        text = result.get('stdout') or ''
        self.assertNotIn('ManagedCapture', text)
        self.assertTrue(
            'VideoCapture' in text or text.startswith('import-failed:'),
            text,
        )
        self.assertNotIn('server.camera_client', sys.modules)


if __name__ == '__main__':
    unittest.main()
