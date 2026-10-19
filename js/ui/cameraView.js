/**
 * Camera pane shows frames sent by the preview block, one cell per slot.
 */
(function () {
  var started = false;
  var timer = null;
  var pollToken = 0;
  var lastRev = -1;

  function base() {
    var port = '5080';
    if (typeof getServerUrl === 'function') {
      var match = String(getServerUrl()).match(/:(\d+)/);
      if (match) port = match[1];
    }
    return 'http://127.0.0.1:' + port;
  }

  function render(frames) {
    var grid = document.getElementById('camera-preview-grid');
    var empty = document.getElementById('camera-empty');
    if (!grid) return;
    if (!frames || !frames.length) {
      grid.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }
    if (empty) empty.style.display = 'none';
    var seen = {};
    frames.forEach(function (frame) {
      var slot = String(frame.slot);
      seen[slot] = true;
      var cell = grid.querySelector('[data-slot="' + slot + '"]');
      if (!cell) {
        cell = document.createElement('div');
        cell.className = 'camera-slot';
        cell.dataset.slot = slot;
        cell.innerHTML = '<span></span><img alt="">';
        grid.appendChild(cell);
      }
      cell.querySelector('span').textContent = 'Slot ' + slot;
      var img = cell.querySelector('img');
      var src = 'data:image/jpeg;base64,' + frame.image;
      if (img.getAttribute('data-src') !== src) {
        img.setAttribute('data-src', src);
        img.src = src;
      }
    });
    var cells = grid.querySelectorAll('.camera-slot');
    for (var i = 0; i < cells.length; i++) {
      if (!seen[cells[i].dataset.slot]) cells[i].remove();
    }
  }

  function setEmpty(text) {
    var empty = document.getElementById('camera-empty');
    if (!empty) return;
    if (text) empty.textContent = text;
    empty.style.display = '';
  }

  function poll() {
    if (!started) return;
    var token = ++pollToken;
    fetch(base() + '/preview-frames')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!started || token !== pollToken || !data || !data.success) return;
        if (data.rev === lastRev) return;
        lastRev = data.rev;
        if (!data.frames || !data.frames.length) {
          setEmpty('Waiting for the first frame…');
          return;
        }
        render(data.frames || []);
      })
      .catch(function () {
        if (started) setEmpty('Camera preview is still starting…');
      });
  }

  function start() {
    started = true;
    poll();
    if (!timer) timer = setInterval(poll, 50);
  }

  function arm() {
    setEmpty('Waiting for the first frame…');
    start();
  }

  function stop() {
    started = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  window.CameraView = { start: start, stop: stop, arm: arm };
})();
