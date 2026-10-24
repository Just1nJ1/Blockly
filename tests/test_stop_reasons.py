"""Normal Stop and Emergency Stop use different reasons on the running session."""

import os
import sys
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.executor import ABORT_EMERGENCY, ABORT_STOP, CodeExecutor


def _wait_done(session_id, timeout=3.0):
    sess = CodeExecutor.get_session(session_id)
    deadline = time.time() + timeout
    events = []
    index = 0
    while time.time() < deadline:
        batch, index = sess.wait_events(index, timeout=0.2)
        events.extend(batch)
        if sess.done and any(event.get("type") == "done" for event in events):
            return sess, events
    return sess, events


class StopReasonTests(unittest.TestCase):
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

    def _start_loop(self):
        started = CodeExecutor.start_interactive("import time\nwhile True:\n    time.sleep(0.05)\n")
        self.assertTrue(started["success"], started)
        time.sleep(0.05)
        return started["session_id"]

    def test_normal_stop_is_not_an_error(self):
        session_id = self._start_loop()
        CodeExecutor.abort(ABORT_STOP)
        sess, events = _wait_done(session_id)
        self.assertTrue(sess.done)
        self.assertEqual(sess.abort_reason, ABORT_STOP)
        self.assertFalse(any(event.get("type") == "error" for event in events))
        done = next(event for event in events if event.get("type") == "done")
        self.assertFalse(done["success"])
        self.assertEqual(done["reason"], ABORT_STOP)
        self.assertNotIn("emergency", str(events).lower())

    def test_emergency_stop_keeps_its_own_reason(self):
        session_id = self._start_loop()
        CodeExecutor.abort(ABORT_EMERGENCY)
        sess, events = _wait_done(session_id)
        self.assertTrue(sess.done)
        self.assertEqual(sess.abort_reason, ABORT_EMERGENCY)
        self.assertFalse(any(event.get("type") == "error" for event in events))
        done = next(event for event in events if event.get("type") == "done")
        self.assertEqual(done["reason"], ABORT_EMERGENCY)
        self.assertNotIn("Execution aborted by emergency stop", str(events))

    def test_python_exception_stays_an_error(self):
        started = CodeExecutor.start_interactive("1/0\n")
        self.assertTrue(started["success"], started)
        sess, events = _wait_done(started["session_id"])
        self.assertIsNone(sess.abort_reason)
        errors = [event for event in events if event.get("type") == "error"]
        self.assertTrue(any("division by zero" in event.get("data", "") for event in errors))
        done = next(event for event in events if event.get("type") == "done")
        self.assertNotIn("reason", done)

    def test_next_run_does_not_inherit_the_stop_reason(self):
        session_id = self._start_loop()
        CodeExecutor.abort(ABORT_STOP)
        stopped, _events = _wait_done(session_id)
        self.assertEqual(stopped.abort_reason, ABORT_STOP)

        started = CodeExecutor.start_interactive("print(1)\n")
        self.assertTrue(started["success"], started)
        sess, events = _wait_done(started["session_id"])
        self.assertIsNone(sess.abort_reason)
        self.assertTrue(sess.done)
        done = next(event for event in events if event.get("type") == "done")
        self.assertTrue(done["success"])
        self.assertNotEqual(sess.id, stopped.id)

    def test_stop_while_waiting_for_input_is_not_an_error(self):
        started = CodeExecutor.start_interactive("input('?')\n")
        self.assertTrue(started["success"], started)
        sess = CodeExecutor.get_session(started["session_id"])
        deadline = time.time() + 2
        while time.time() < deadline and not sess.waiting_for_input:
            time.sleep(0.02)
        self.assertTrue(sess.waiting_for_input)
        CodeExecutor.abort(ABORT_STOP)
        sess, events = _wait_done(started["session_id"])
        self.assertEqual(sess.abort_reason, ABORT_STOP)
        self.assertFalse(any(event.get("type") == "error" for event in events))
        done = next(event for event in events if event.get("type") == "done")
        self.assertEqual(done["reason"], ABORT_STOP)


if __name__ == "__main__":
    unittest.main()
