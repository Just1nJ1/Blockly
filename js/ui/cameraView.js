/**
 * In-app Camera pane. Uses the camera extension backend.
 * The preview is one MJPEG stream, not a new JPEG request every frame.
 */
(function () {
  var started = false;
  var activeId = null;

  function base() {
    var port = '5080';
    if (typeof getServerUrl === 'function') {
      var url = getServerUrl();
      var m = String(url).match(/:(\d+)/);
      if (m) port = m[1];
    }
    return 'http://127.0.0.1:' + port + '/ext/camera';
  }

  function els() {
    return {
      select: document.getElementById('camera-select'),
      status: document.getElementById('camera-status'),
      frame: document.getElementById('camera-stream'),
      empty: document.getElementById('camera-empty')
    };
  }

  function setStatus(text) {
    var status = els().status;
    if (status) status.textContent = text;
  }

  function showFrame(on) {
    var ui = els();
    if (ui.frame) ui.frame.style.display = on ? 'block' : 'none';
    if (ui.empty) ui.empty.style.display = on ? 'none' : 'block';
  }

  function ensureStream() {
    var frame = els().frame;
    if (!frame || activeId === null || activeId === undefined) {
      if (frame) frame.removeAttribute('src');
      showFrame(false);
      return;
    }
    var stream = base() + '/stream';
    if (frame.getAttribute('data-stream') !== stream) {
      frame.setAttribute('data-stream', stream);
      frame.src = stream;
    }
    showFrame(true);
  }

  function refreshList() {
    var select = els().select;
    if (!select) return;
    fetch(base() + '/cameras').then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.success) return;
      var previous = select.value;
      select.innerHTML = '';
      (data.cameras || []).forEach(function (cam) {
        var opt = document.createElement('option');
        opt.value = String(cam.id);
        opt.textContent = cam.name + (cam.connected ? ' (connected)' : '');
        select.appendChild(opt);
      });
      activeId = data.active;
      if (activeId !== null && activeId !== undefined) {
        select.value = String(activeId);
        setStatus(select.options[select.selectedIndex]
          ? select.options[select.selectedIndex].textContent
          : 'Camera ' + activeId);
      } else if (previous) {
        select.value = previous;
        setStatus('No camera connected');
      } else {
        setStatus(select.options.length ? 'No camera connected' : 'No cameras found');
      }
      ensureStream();
    }).catch(function () {
      setStatus('Camera extension is not running');
      showFrame(false);
    });
  }

  function bind() {
    var connect = document.getElementById('camera-connect');
    var disconnect = document.getElementById('camera-disconnect');
    var select = document.getElementById('camera-select');
    if (connect && !connect.dataset.bound) {
      connect.dataset.bound = '1';
      connect.addEventListener('click', function () {
        fetch(base() + '/connect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(select.value) })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data && !data.success) setStatus(data.error || 'Connect failed');
          refreshList();
        }).catch(function () { setStatus('Connect failed'); });
      });
    }
    if (disconnect && !disconnect.dataset.bound) {
      disconnect.dataset.bound = '1';
      disconnect.addEventListener('click', function () {
        fetch(base() + '/disconnect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: Number(select.value) })
        }).then(function () { refreshList(); });
      });
    }
  }

  function start() {
    bind();
    started = true;
    if (typeof ensureExtensionPermissions === 'function') {
      ensureExtensionPermissions('camera').then(function () { refreshList(); });
    } else {
      refreshList();
    }
    if (!start._timer) {
      start._timer = setInterval(function () {
        if (started) refreshList();
      }, 2000);
    }
  }

  function stop() {
    started = false;
    var frame = els().frame;
    if (frame) {
      frame.removeAttribute('src');
      frame.removeAttribute('data-stream');
    }
    showFrame(false);
  }

  window.CameraView = { start: start, stop: stop };
})();
