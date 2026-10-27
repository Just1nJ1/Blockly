"""Fake device session. create_session does not open hardware or a camera."""


def create_session(ctx):
    return DeviceSession(ctx)


class DeviceSession:
    def __init__(self, ctx):
        self.ctx = ctx
        self._closed = False
        self.opened = []

    def session_id(self):
        return self.ctx.session_id

    def open(self, port):
        self.ctx.check_aborted()
        if self._closed:
            raise RuntimeError('Test device session is closed.')
        if port is None or port == '':
            raise RuntimeError('Choose a port.')
        self.opened.append(str(port))
        return Device(str(port))

    def close(self):
        if self._closed:
            return
        self._closed = True
        self.opened.clear()


class Device:
    def __init__(self, port):
        self.port = port

    def __repr__(self):
        return 'device:%s' % self.port
