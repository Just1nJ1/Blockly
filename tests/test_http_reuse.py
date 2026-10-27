"""Finite localhost responses reuse one TCP connection. Streams still close."""

import json
import os
import sys
import threading
import time
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from flask import Flask, Response, jsonify, request

from server.ext_process import _SubprocessInfo, _forward_request, _running
from server.extension_runtime import ExtensionRuntimeError, urllib_transport
from server.http_reuse import (
    ReusableWSGIServer,
    close_all,
    close_host,
    forward_http,
    request_bytes,
)


def _app():
    app = Flask('reuse-test')

    @app.route('/health')
    def health():
        return jsonify({'ok': True})

    @app.route('/frame')
    def frame():
        size = int(request.args.get('n', '8'))
        return Response(b'X' * size, mimetype='image/jpeg')

    @app.route('/echo', methods=['POST'])
    def echo():
        return jsonify(request.get_json(silent=True) or {})

    @app.route('/stream')
    def stream():
        def generate():
            # Larger than the proxy's 16 KB read, so the first chunk can be
            # delivered before the rest of the stream is produced.
            yield b'one' + (b'A' * 20000)
            time.sleep(0.3)
            yield b'two' + (b'B' * 20000)
        return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

    @app.route('/events')
    def events():
        def generate():
            yield b'data: 1\n\n' + (b'A' * 20000)
            time.sleep(0.2)
            yield b'data: 2\n\n' + (b'B' * 20000)
        return Response(generate(), mimetype='text/event-stream')

    return app


class ReuseTests(unittest.TestCase):
    def setUp(self):
        self.server = ReusableWSGIServer(('127.0.0.1', 0), _app())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]
        self._wait_until_up()

    def tearDown(self):
        close_all()
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        _running.pop('reuse-ext', None)

    def _wait_until_up(self):
        last = None
        for _ in range(50):
            try:
                status, _headers, body = request_bytes(
                    '127.0.0.1', self.port, 'GET', '/health', timeout=1,
                )
                if status == 200 and b'ok' in body:
                    return
            except Exception as exc:
                last = exc
                time.sleep(0.02)
        self.fail('server did not start: %s' % last)

    def test_hundreds_of_frame_reads_reuse_one_connection(self):
        before = self.server.accepted
        for n in (1, 10, 100, 1000, 7):
            for _ in range(60):
                status, headers, body = request_bytes(
                    '127.0.0.1', self.port, 'GET', '/frame?n=%d' % n, timeout=2,
                )
                self.assertEqual(status, 200)
                self.assertEqual(body, b'X' * n)
                self.assertEqual(headers.get('Content-Type'), 'image/jpeg')
        self.assertEqual(self.server.accepted, before)

    def test_post_json_roundtrip_reuses_the_connection(self):
        before = self.server.accepted
        for i in range(20):
            status, _headers, body = request_bytes(
                '127.0.0.1', self.port, 'POST', '/echo',
                json.dumps({'n': i}).encode(),
                {'Content-Type': 'application/json'},
                timeout=2,
            )
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body.decode())['n'], i)
        self.assertEqual(self.server.accepted, before)

    def test_eight_callers_do_not_open_a_connection_per_request(self):
        before = self.server.accepted
        errors = []

        def worker():
            try:
                for _ in range(15):
                    status, _headers, body = request_bytes(
                        '127.0.0.1', self.port, 'GET', '/frame?n=4', timeout=2,
                    )
                    if status != 200 or body != b'XXXX':
                        errors.append('bad response')
            except Exception as exc:
                errors.append(repr(exc))

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        self.assertLessEqual(self.server.accepted - before, 8)
        self.assertGreaterEqual(self.server.accepted - before, 1)

    def test_connection_close_is_not_reused(self):
        import http.client
        before = self.server.accepted
        for _ in range(12):
            conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=2)
            conn.request('GET', '/frame?n=3', headers={'Connection': 'close'})
            resp = conn.getresponse()
            self.assertEqual(resp.read(), b'XXX')
            conn.close()
        self.assertEqual(self.server.accepted - before, 12)

    def test_stream_arrives_before_it_finishes_and_health_still_answers(self):
        before = self.server.accepted
        result = forward_http(
            '127.0.0.1', self.port, 'GET', '/stream', timeout=2,
        )
        self.assertTrue(result.stream)
        started = time.monotonic()
        first = next(result.body)
        self.assertIn(b'one', first)
        self.assertLess(time.monotonic() - started, 0.2)
        status, _headers, body = request_bytes(
            '127.0.0.1', self.port, 'GET', '/health', timeout=2,
        )
        self.assertEqual(status, 200)
        self.assertIn(b'ok', body)
        rest = b''.join(result.body)
        self.assertIn(b'two', rest)
        self.assertGreaterEqual(time.monotonic() - started, 0.25)
        # The stream connection closes. The health check reuses or adds one.
        self.assertLessEqual(self.server.accepted - before, 3)

    def test_event_stream_is_not_buffered(self):
        result = forward_http(
            '127.0.0.1', self.port, 'GET', '/events', timeout=2,
        )
        self.assertTrue(result.stream)
        started = time.monotonic()
        first = next(result.body)
        self.assertIn(b'data: 1', first)
        self.assertLess(time.monotonic() - started, 0.15)
        result.body.close()

    def test_proxy_helper_streams_and_reuses_finite_responses(self):
        app = Flask('proxy-ctx')
        before = self.server.accepted
        with app.test_request_context('/ext/reuse-ext/frame?n=5'):
            response = _forward_request('reuse-ext', self.port, 'frame')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_data(), b'XXXXX')
        with app.test_request_context('/ext/reuse-ext/stream'):
            streamed = _forward_request('reuse-ext', self.port, 'stream')
        self.assertEqual(streamed.status_code, 200)
        iterator = iter(streamed.response)
        first = next(iterator)
        self.assertIn(b'one', first)
        streamed.close()
        for _ in range(25):
            with app.test_request_context('/ext/reuse-ext/frame?n=2'):
                response = _forward_request('reuse-ext', self.port, 'frame')
            self.assertEqual(response.get_data(), b'XX')
        self.assertLessEqual(self.server.accepted - before, 4)

    def test_close_host_drops_the_idle_socket(self):
        request_bytes('127.0.0.1', self.port, 'GET', '/health', timeout=1)
        before = self.server.accepted
        close_host('127.0.0.1', self.port)
        request_bytes('127.0.0.1', self.port, 'GET', '/health', timeout=1)
        self.assertEqual(self.server.accepted, before + 1)
        for _ in range(10):
            request_bytes('127.0.0.1', self.port, 'GET', '/health', timeout=1)
        self.assertEqual(self.server.accepted, before + 1)

    def test_runtime_transport_uses_the_registered_extension_once(self):
        class Alive:
            def poll(self):
                return None

        info = _SubprocessInfo('reuse-ext', self.port, Alive())
        info.healthy = True
        _running['reuse-ext'] = info
        before = self.server.accepted
        try:
            for _ in range(40):
                status, _headers, body = urllib_transport(
                    'reuse-ext', 'GET', '/frame?n=6', None, {}, 2,
                )
                self.assertEqual(status, 200)
                self.assertEqual(body, b'XXXXXX')
        finally:
            _running.pop('reuse-ext', None)
        self.assertEqual(self.server.accepted, before)

    def test_unregistered_extension_does_not_pretend_success(self):
        import socket
        probe = socket.socket()
        probe.bind(('127.0.0.1', 0))
        port = probe.getsockname()[1]
        probe.close()
        previous = os.environ.get('STUDIOX_PORT')
        os.environ['STUDIOX_PORT'] = str(port)
        try:
            with self.assertRaises(ExtensionRuntimeError):
                urllib_transport('not-registered', 'GET', '/health', None, {}, 1)
        finally:
            if previous is None:
                os.environ.pop('STUDIOX_PORT', None)
            else:
                os.environ['STUDIOX_PORT'] = previous

    def test_stop_during_a_stream_does_not_stick_the_finite_pool(self):
        # Five open/close cycles must not accumulate accepted sockets.
        before = self.server.accepted
        for _ in range(5):
            result = forward_http(
                '127.0.0.1', self.port, 'GET', '/stream', timeout=2,
            )
            next(result.body)
            result.body.close()
            status, _headers, body = request_bytes(
                '127.0.0.1', self.port, 'GET', '/health', timeout=1,
            )
            self.assertEqual(status, 200)
            self.assertIn(b'ok', body)
            close_host('127.0.0.1', self.port)
        self.assertLessEqual(self.server.accepted - before, 15)


if __name__ == '__main__':
    unittest.main()
