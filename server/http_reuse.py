"""Localhost HTTP that can reuse a connection.

Werkzeug's development server sends ``Connection: close`` on every
response, and ``urllib.request`` does the same. A camera frame loop that
uses both opens a new TCP connection per request. Finite responses from
:func:`serve_app` stay open. Streaming responses (MJPEG, server-sent
events) are still chunked and closed, because the development server
cannot keep a connection after a body of unknown length.
"""

import http.client
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import unquote

_MAX_IDLE = 4
_IDLE_HEADER_TIMEOUT = 60
_STALE = (
    http.client.RemoteDisconnected,
    http.client.BadStatusLine,
    ConnectionResetError,
    BrokenPipeError,
    ConnectionAbortedError,
)
_HOP_BY_HOP = frozenset({
    'connection',
    'keep-alive',
    'proxy-connection',
    'transfer-encoding',
    'upgrade',
    'te',
    'trailer',
})

_pools_lock = threading.Lock()
_idle = {}  # (host, port) -> [HTTPConnection]


class Forwarded:
    """One proxied response. ``body`` is bytes, or an iterator when streaming."""

    def __init__(self, status, headers, body, stream):
        self.status = int(status)
        self.headers = headers
        self.body = body
        self.stream = bool(stream)


def _close_quietly(conn):
    try:
        conn.close()
    except Exception:
        return


def _socket_is_dead(conn):
    """True when the server has already closed this idle connection."""
    sock = getattr(conn, 'sock', None)
    if sock is None:
        return False
    timeout = sock.gettimeout()
    try:
        sock.settimeout(0)
        try:
            peeked = sock.recv(1, socket.MSG_PEEK)
        except BlockingIOError:
            return False
        except OSError:
            return True
        return peeked == b''
    finally:
        try:
            sock.settimeout(timeout)
        except OSError:
            return True


def _checkout(host, port, timeout):
    key = (host, int(port))
    with _pools_lock:
        pool = _idle.get(key)
        while pool:
            conn = pool.pop()
            if _socket_is_dead(conn):
                _close_quietly(conn)
                continue
            conn.timeout = timeout
            return conn
    return http.client.HTTPConnection(host, int(port), timeout=timeout)


def _checkin(conn):
    if conn is None or conn.sock is None:
        return
    key = (conn.host, conn.port)
    with _pools_lock:
        pool = _idle.setdefault(key, [])
        if len(pool) >= _MAX_IDLE:
            _close_quietly(conn)
            return
        pool.append(conn)


def _discard(conn):
    if conn is not None:
        _close_quietly(conn)


def close_host(host, port):
    """Drop idle connections to one extension process."""
    key = (host, int(port))
    with _pools_lock:
        conns = _idle.pop(key, [])
    for conn in conns:
        _close_quietly(conn)


def close_all():
    """Drop every idle connection. In-flight requests are not interrupted."""
    with _pools_lock:
        groups = list(_idle.values())
        _idle.clear()
    for conns in groups:
        for conn in conns:
            _close_quietly(conn)


def _clean_headers(headers):
    cleaned = {}
    for key, value in dict(headers or {}).items():
        if str(key).lower() in _HOP_BY_HOP or str(key).lower() == 'host':
            continue
        if str(key).lower() == 'content-length':
            continue
        cleaned[str(key)] = str(value)
    cleaned['Connection'] = 'keep-alive'
    return cleaned


def _response_headers(resp):
    headers = {}
    for key, value in resp.getheaders():
        if key.lower() in _HOP_BY_HOP:
            continue
        headers[key] = value
    return headers


def _should_stream(resp):
    ctype = (resp.headers.get('Content-Type') or '').lower()
    if ctype.startswith('multipart/') or ctype.startswith('text/event-stream'):
        return True
    return resp.headers.get('Content-Length') is None


def _open_response(host, port, method, path, body, headers, timeout):
    """Send one request. Retry a connection that died before the request was sent.

    A POST is not retried after it has been written. Retrying it could run
    the extension's connect or disconnect a second time.
    """
    if timeout is None:
        timeout = 30
    verb = str(method or 'GET').upper()
    target = path if str(path).startswith('/') else '/' + str(path)
    outbound = _clean_headers(headers)
    last = None
    for attempt in (1, 2):
        conn = _checkout(host, port, timeout)
        sent = False
        try:
            conn.timeout = timeout
            conn.request(verb, target, body=body if body else None, headers=outbound)
            sent = True
            resp = conn.getresponse()
            return conn, resp
        except _STALE as exc:
            _discard(conn)
            last = exc
            if sent and verb not in ('GET', 'HEAD'):
                raise
            if attempt == 2:
                raise
        except Exception:
            _discard(conn)
            raise
    if last is not None:
        raise last
    raise OSError('Extension request failed')


def _finish(conn, resp):
    if resp.will_close:
        _discard(conn)
        return
    _checkin(conn)


def request_bytes(host, port, method, path, body=None, headers=None, timeout=None):
    """Finite request. Returns ``(status, headers, body)`` and may reuse the socket."""
    conn, resp = _open_response(host, port, method, path, body, headers, timeout)
    try:
        payload = resp.read()
    except Exception:
        _discard(conn)
        raise
    headers_out = _response_headers(resp)
    _finish(conn, resp)
    return resp.status, headers_out, payload


def forward_http(host, port, method, path, body=None, headers=None, timeout=None):
    """Proxy one extension response. Streams multipart and event streams."""
    conn, resp = _open_response(host, port, method, path, body, headers, timeout)
    headers_out = _response_headers(resp)
    if not _should_stream(resp):
        try:
            payload = resp.read()
        except Exception:
            _discard(conn)
            raise
        _finish(conn, resp)
        return Forwarded(resp.status, headers_out, payload, stream=False)

    def generate():
        try:
            while True:
                chunk = resp.read(16384)
                if not chunk:
                    break
                yield chunk
        finally:
            try:
                resp.close()
            except Exception:
                pass
            _discard(conn)

    return Forwarded(resp.status, headers_out, generate(), stream=True)


class ReusableWSGIServer(ThreadingHTTPServer):
    """Threaded HTTP/1.1 server. One accepted socket can serve many finite requests."""

    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 128

    def __init__(self, server_address, app):
        self.app = app
        self.accepted = 0
        self._accept_lock = threading.Lock()
        super().__init__(server_address, _ReusableHandler)

    def get_request(self):
        conn, addr = super().get_request()
        with self._accept_lock:
            self.accepted += 1
        return conn, addr


class _ReusableHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'StudioXHTTP/1.0'

    def setup(self):
        super().setup()
        try:
            self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass

    def handle(self):
        self.close_connection = True
        try:
            self.handle_one_request()
            while not self.close_connection:
                self.handle_one_request()
        except (ConnectionError, TimeoutError, socket.timeout):
            return

    def handle_one_request(self):
        try:
            self.connection.settimeout(_IDLE_HEADER_TIMEOUT)
            self.raw_requestline = self.rfile.readline(65537)
            if len(self.raw_requestline) > 65536:
                self.requestline = ''
                self.request_version = ''
                self.command = ''
                self.send_error(414)
                self.close_connection = True
                return
            if not self.raw_requestline:
                self.close_connection = True
                return
            if not self.parse_request():
                return
            # The application may block for as long as the route allows.
            # The idle timeout applies only while waiting for the next request.
            self.connection.settimeout(None)
            self._dispatch()
        except (ConnectionError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception:
            self.close_connection = True
            try:
                sys.__stderr__.write('[http] request failed\n')
            except Exception:
                pass

    def _dispatch(self):
        body = _read_request_body(self)
        started = {}
        pending = []
        headers_sent = {'on': False}
        result = None

        def start_response(status, response_headers, exc_info=None):
            if 'status' in started:
                if exc_info:
                    try:
                        raise exc_info[1].with_traceback(exc_info[2])
                    finally:
                        exc_info = None
                raise AssertionError('headers already sent')
            started['status'] = status
            started['headers'] = list(response_headers or [])

            def write(data):
                if not data:
                    return
                if isinstance(data, str):
                    data = data.encode('utf-8')
                if headers_sent['on']:
                    _write_chunk(self, data)
                    return
                pending.append(data)

            return write

        try:
            result = self.server.app(self._environ(body), start_response)
            if 'status' not in started:
                self.close_connection = True
                self._send_text(500, b'Internal Server Error')
                return
            code, message = _split_status(started['status'])
            header_map = {str(key).lower(): value for key, value in started['headers']}
            finite = code in (204, 304) or 'content-length' in header_map
            if finite:
                chunks = list(pending)
                for chunk in result:
                    if chunk:
                        if isinstance(chunk, str):
                            chunk = chunk.encode('utf-8')
                        chunks.append(chunk)
                payload = b''.join(chunks)
                keep = not self.close_connection
                self._send_bytes(code, message, started['headers'], payload, keep=keep)
                return
            self.close_connection = True
            self._start_chunked(code, message, started['headers'])
            headers_sent['on'] = True
            for chunk in pending:
                _write_chunk(self, chunk)
            for chunk in result:
                if not chunk:
                    continue
                if isinstance(chunk, str):
                    chunk = chunk.encode('utf-8')
                _write_chunk(self, chunk)
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
        except (ConnectionError, TimeoutError, socket.timeout):
            self.close_connection = True
        except Exception:
            self.close_connection = True
            if not headers_sent['on']:
                self._send_text(500, b'Internal Server Error')
        finally:
            closer = getattr(result, 'close', None)
            if callable(closer):
                try:
                    closer()
                except Exception:
                    pass

    def _environ(self, body):
        path = self.path
        if '?' in path:
            path, query = path.split('?', 1)
        else:
            query = ''
        env = {
            'REQUEST_METHOD': self.command,
            'SCRIPT_NAME': '',
            'PATH_INFO': unquote(path, 'iso-8859-1'),
            'QUERY_STRING': query,
            'SERVER_NAME': self.server.server_name,
            'SERVER_PORT': str(self.server.server_port),
            'SERVER_PROTOCOL': self.request_version,
            'SERVER_SOFTWARE': self.server_version,
            'REMOTE_ADDR': self.client_address[0],
            'GATEWAY_INTERFACE': 'CGI/1.1',
            'wsgi.version': (1, 0),
            'wsgi.url_scheme': 'http',
            'wsgi.input': BytesIO(body),
            'wsgi.errors': sys.stderr,
            'wsgi.multithread': True,
            'wsgi.multiprocess': False,
            'wsgi.run_once': False,
            'CONTENT_TYPE': '',
            'CONTENT_LENGTH': str(len(body)) if body else '',
        }
        for key, value in self.headers.items():
            name = key.replace('-', '_').upper()
            if name in ('CONTENT_TYPE', 'CONTENT_LENGTH'):
                env[name] = value.strip()
                continue
            http_name = 'HTTP_' + name
            if http_name in env:
                env[http_name] = env[http_name] + ',' + value.strip()
            else:
                env[http_name] = value.strip()
        # The body was already decoded. Flask must not parse it again.
        env.pop('HTTP_TRANSFER_ENCODING', None)
        if body and not env.get('CONTENT_LENGTH'):
            env['CONTENT_LENGTH'] = str(len(body))
        return env

    def _start_chunked(self, code, message, app_headers):
        self.send_response(code, message)
        for key, value in app_headers:
            if str(key).lower() in _HOP_BY_HOP or str(key).lower() == 'content-length':
                continue
            self.send_header(key, value)
        self.send_header('Transfer-Encoding', 'chunked')
        self.send_header('Connection', 'close')
        self.end_headers()

    def _send_bytes(self, code, message, app_headers, payload, keep):
        self.send_response(code, message)
        for key, value in app_headers:
            if str(key).lower() in _HOP_BY_HOP or str(key).lower() == 'content-length':
                continue
            self.send_header(key, value)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Connection', 'keep-alive' if keep else 'close')
        self.end_headers()
        if self.command != 'HEAD' and payload:
            self.wfile.write(payload)
        self.wfile.flush()

    def _send_text(self, code, payload):
        try:
            self.send_response(code, 'Error')
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        except Exception:
            return

    def log_message(self, fmt, *args):
        return


def _split_status(status):
    text = str(status or '500 Internal Server Error')
    code_text, _, message = text.partition(' ')
    try:
        code = int(code_text)
    except ValueError:
        code = 500
    return code, message or 'OK'


def _write_chunk(handler, data):
    handler.wfile.write(b'%X\r\n' % len(data))
    handler.wfile.write(data)
    handler.wfile.write(b'\r\n')
    handler.wfile.flush()


def _read_request_body(handler):
    if handler.command in ('GET', 'HEAD'):
        return b''
    encoding = (handler.headers.get('Transfer-Encoding') or '').lower()
    if 'chunked' in encoding:
        return _read_chunked(handler.rfile)
    length = handler.headers.get('Content-Length')
    if not length:
        return b''
    try:
        size = int(length)
    except ValueError:
        return b''
    if size <= 0:
        return b''
    return handler.rfile.read(size)


def _read_chunked(stream):
    chunks = []
    while True:
        line = stream.readline(65537)
        if not line:
            break
        size_text = line.split(b';', 1)[0].strip()
        try:
            size = int(size_text, 16)
        except ValueError:
            break
        if size == 0:
            while True:
                extra = stream.readline(65537)
                if extra in (b'\r\n', b'\n', b''):
                    break
            break
        chunks.append(stream.read(size))
        stream.read(2)
    return b''.join(chunks)


def serve_app(app, host, port):
    """Serve ``app`` until the process is interrupted."""
    server = ReusableWSGIServer((host, int(port)), app)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
