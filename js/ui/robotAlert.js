/**
 * Firmware error toasts (e.g. E118 out of workspace).
 * Dedupes rapid repeats from history + last-status polling.
 */
(function() {
  var QUIET_MS = 1500;
  var SHOW_MS = 4200;
  var _quietUntil = {};
  var _seenAlertTs = {};
  var _hideTimer = null;

  function parseFirmwareError(text) {
    if (!text) return null;
    var m = String(text).trim().match(/^Error,(E\d+)\s*,\s*(.+)$/i);
    if (!m) return null;
    return { code: m[1].toUpperCase(), message: m[2].trim(), text: String(text).trim() };
  }

  function isWorkspaceError(alert) {
    if (!alert) return false;
    var code = String(alert.code || '').toUpperCase();
    var msg = String(alert.message || alert.text || '').toLowerCase();
    return code === 'E118' || msg.indexOf('outside the workspace') !== -1;
  }

  function quietKey(port, code) {
    return String(port || '') + '|' + String(code || 'E118');
  }

  function ensureHost() {
    var host = document.getElementById('robot-alert-host');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'robot-alert-host';
    host.className = 'robot-alert-host';
    document.body.appendChild(host);
    return host;
  }

  function hideAlert() {
    var host = document.getElementById('robot-alert-host');
    if (!host) return;
    var el = host.querySelector('.robot-alert');
    if (!el) return;
    el.classList.remove('robot-alert-visible');
    setTimeout(function() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 200);
  }

  function showWorkspaceAlert(alert, port) {
    if (!document.body) return;
    var host = ensureHost();
    host.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'robot-alert';
    el.setAttribute('role', 'alert');

    var title = document.createElement('div');
    title.className = 'robot-alert-title';
    title.textContent = 'Out of workspace';
    el.appendChild(title);

    var detail = String((alert && alert.message) || '').trim();
    if (detail && detail.toLowerCase() !== 'out of workspace') {
      var sub = document.createElement('div');
      sub.className = 'robot-alert-detail';
      sub.textContent = port ? (detail + '  ·  ' + port) : detail;
      el.appendChild(sub);
    } else if (port) {
      var subPort = document.createElement('div');
      subPort.className = 'robot-alert-detail';
      subPort.textContent = port;
      el.appendChild(subPort);
    }

    el.addEventListener('click', function() {
      if (_hideTimer) clearTimeout(_hideTimer);
      hideAlert();
    });
    host.appendChild(el);
    void el.offsetWidth;
    el.classList.add('robot-alert-visible');
    if (_hideTimer) clearTimeout(_hideTimer);
    _hideTimer = setTimeout(hideAlert, SHOW_MS);
  }

  function considerRobotAlert(port, alert) {
    if (!alert || !isWorkspaceError(alert)) return;
    if (alert.ts && _seenAlertTs[port] === alert.ts) return;
    var key = quietKey(port, alert.code || 'E118');
    var now = Date.now();
    if (_quietUntil[key] && now < _quietUntil[key]) {
      if (alert.ts) _seenAlertTs[port] = alert.ts;
      return;
    }
    if (alert.ts) _seenAlertTs[port] = alert.ts;
    _quietUntil[key] = now + QUIET_MS;
    showWorkspaceAlert(alert, port);
  }

  function considerRobotErrorLine(port, text) {
    var parsed = parseFirmwareError(text);
    if (!parsed) {
      if (String(text || '').toLowerCase().indexOf('outside the workspace') !== -1) {
        parsed = { code: 'E118', message: String(text).trim(), text: String(text).trim() };
      } else {
        return;
      }
    }
    considerRobotAlert(port, parsed);
  }

  window.considerRobotAlert = considerRobotAlert;
  window.considerRobotErrorLine = considerRobotErrorLine;
})();
