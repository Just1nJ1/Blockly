/**
 * Camera pane shows frames sent by the preview block, one cell per slot.
 * Polling is one request at a time. A generation id drops responses from
 * an older arm/stop, not from the previous request in the same cycle.
 */
(function () {
  var polling = false;
  var generation = 0;
  var pollTimer = null;
  var requestInFlight = false;
  var lastRev = -1;

  function base() {
    var port = '5080';
    if (typeof getServerUrl === 'function') {
      var match = String(getServerUrl()).match(/:(\d+)/);
      if (match) port = match[1];
    }
    return 'http://127.0.0.1:' + port;
  }

  function clearGrid() {
    var grid = document.getElementById('camera-preview-grid');
    if (grid) grid.innerHTML = '';
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

  function cancelTimer() {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedule(gen, delay) {
    if (!polling || gen !== generation) return;
    cancelTimer();
    pollTimer = setTimeout(function () {
      pollTimer = null;
      poll(gen);
    }, delay);
  }

  function applyPayload(gen, data) {
    if (!polling || gen !== generation) return;
    if (!data || !data.success) {
      setEmpty((data && data.error) || 'Preview request failed');
      return;
    }
    var revChanged = data.rev !== lastRev;
    if (revChanged) lastRev = data.rev;
    if (data.error) {
      if (revChanged) {
        if (data.frames && data.frames.length) render(data.frames);
        else clearGrid();
      }
      // render() hides the message. Put it back so an old JPEG cannot cover a failure.
      setEmpty(data.error);
      return;
    }
    if (!revChanged) return;
    if (!data.frames || !data.frames.length) {
      clearGrid();
      setEmpty('Waiting for the first frame…');
      return;
    }
    render(data.frames);
  }

  function poll(gen) {
    if (!polling || gen !== generation || requestInFlight) return;
    requestInFlight = true;
    fetch(base() + '/preview-frames', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Preview request failed (' + response.status + ')');
        }
        return response.json();
      })
      .then(function (data) {
        requestInFlight = false;
        if (gen !== generation) {
          if (polling) poll(generation);
          return;
        }
        applyPayload(gen, data);
        schedule(gen, 100);
      })
      .catch(function (err) {
        requestInFlight = false;
        if (gen !== generation) {
          if (polling) poll(generation);
          return;
        }
        if (polling) {
          setEmpty((err && err.message) || 'Camera preview is still starting…');
        }
        schedule(gen, 100);
      });
  }

  function start() {
    if (polling) return;
    polling = true;
    generation += 1;
    poll(generation);
  }

  function arm() {
    clearGrid();
    lastRev = -1;
    setEmpty('Waiting for the first frame…');
    cancelTimer();
    generation += 1;
    polling = true;
    if (!requestInFlight) poll(generation);
  }

  function stop() {
    polling = false;
    generation += 1;
    cancelTimer();
  }

  window.CameraView = { start: start, stop: stop, arm: arm };
})();
