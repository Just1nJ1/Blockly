/**
 * Command Tab Module
 * Handles sending commands, polling message history, and rendering output.
 * Tracks per-port history so switching ports shows the correct log.
 */

(function() {
  var POLL_INTERVAL = 500;
  var _lastMessageId = 0;
  var _pollTimer = null;
  var _connected = false;
  var _currentPort = null;

  function getServerUrl() {
    return (typeof window.getServerUrl === 'function')
      ? window.getServerUrl() : 'http://127.0.0.1:5080';
  }

  // ── Connect / Disconnect ──

  function connectToPort(port, model) {
    var switchingPort = (_currentPort !== null && _currentPort !== port);

    return fetch(getServerUrl() + '/cmd/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: port, model: model || null })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _connected = data.success;
      if (data.success) {
        _currentPort = port;
        // Clear display and reset ID to reload this port's full history
        clearOutput();
        _lastMessageId = 0;
        startPolling();

        // Notify control panel that connection is ready
        if (typeof window.controlPanelOnConnected === 'function') {
          window.controlPanelOnConnected(port, model);
        }
      }
      return data;
    });
  }

  function disconnectPort(port) {
    var body = {};
    if (port) body.port = port;
    return fetch(getServerUrl() + '/cmd/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _connected = false;
      if (!port || port === _currentPort) {
        _currentPort = null;
      }
      return data;
    });
  }

  /**
   * Hard refresh: force disconnect + reconnect the same port.
   * Use after a quick power-cycle when the path is still listed but
   * the old serial session is dead (no responses forever).
   */
  function refreshPortConnection(port, model) {
    var select = document.getElementById('command-port-select');
    port = port || (select && select.value) || _currentPort;
    if (!port || port === '__manual__' || port.indexOf('__detecting__') === 0) {
      appendSystemMessage('Select a connected port to refresh');
      return Promise.resolve({ success: false, error: 'No port selected' });
    }

    if (!model && window.portModelMap && window.portModelMap[port]) {
      // Blockly dropdown values like Mirobot_UART → short model name
      var raw = window.portModelMap[port];
      if (typeof raw === 'string') {
        model = raw.replace(/_UART$/i, '').replace(/_USB$/i, '');
        // Map display labels if needed
        if (model === 'Haro380' || model === 'Harobot') model = 'MT4';
      }
    }
    // Fallback: parse from option label "port (Mirobot)"
    if (!model && select) {
      var opt = select.options[select.selectedIndex];
      var m = opt && opt.textContent && opt.textContent.match(/\(([^)]+)\)\s*$/);
      if (m && m[1] && m[1].indexOf('WiFi') !== 0 && m[1] !== 'Detecting...') {
        model = m[1].replace(/^WiFi,\s*/, '');
      }
    }

    var btn = document.getElementById('command-port-refresh');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    appendSystemMessage('Hard refresh: disconnecting ' + port + '…');

    return fetch(getServerUrl() + '/cmd/reconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: port, model: model || null })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻';
      }
      if (data.success) {
        _connected = true;
        _currentPort = port;
        clearOutput();
        _lastMessageId = 0;
        startPolling();
        appendSystemMessage('Reconnected to ' + port +
          (data.model ? ' (' + data.model + ')' : ''));
        // Reset control-panel FW cache / rebind UI for this port
        if (typeof window.controlPanelOnDisconnected === 'function') {
          window.controlPanelOnDisconnected(port);
        }
        if (typeof window.controlPanelOnConnected === 'function') {
          window.controlPanelOnConnected(port, data.model || model);
        }
      } else {
        _connected = false;
        appendSystemMessage('Refresh failed: ' + (data.error || 'unknown error'));
      }
      return data;
    })
    .catch(function(err) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻';
      }
      appendSystemMessage('Refresh error: ' + (err && err.message ? err.message : err));
      return { success: false, error: String(err) };
    });
  }

  function updateRefreshButton() {
    var select = document.getElementById('command-port-select');
    var btn = document.getElementById('command-port-refresh');
    if (!select || !btn) return;
    var val = select.value;
    var show = !!(val && val !== '' && val !== '__manual__' &&
      String(val).indexOf('__detecting__') !== 0);
    btn.classList.toggle('visible', show);
  }

  // ── Send command ──

  function sendCommand(command) {
    if (!command.trim()) return;

    return fetch(getServerUrl() + '/cmd/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: command })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      // Mark control panel as stale after sending a command
      if (typeof window.controlPanelMarkStale === 'function') {
        window.controlPanelMarkStale();
      }
      return data;
    })
    .catch(function(err) {
      appendSystemMessage('Send failed: ' + err.message);
    });
  }

  // ── Poll history ──

  function pollHistory() {
    var url = getServerUrl() + '/cmd/history?since=' + _lastMessageId;
    if (window.developerMode) url += '&include_status=true';
    fetch(url)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success || !data.messages) return;
        for (var i = 0; i < data.messages.length; i++) {
          var msg = data.messages[i];
          appendMessage(msg);
          if (msg.id >= _lastMessageId) {
            _lastMessageId = msg.id + 1;
          }
        }
      })
      .catch(function() {});
  }

  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(pollHistory, POLL_INTERVAL);
    pollHistory();
  }

  function stopPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  function clearOutput() {
    var output = document.getElementById('command-output');
    if (output) output.innerHTML = '';
  }

  // ── Render messages ──

  function appendMessage(msg) {
    var output = document.getElementById('command-output');
    if (!output) return;

    var el = document.createElement('div');
    var isBlockly = msg.source === 'blockly';
    var isBlocklySys = msg.dir === 'sys' &&
      (msg.text.indexOf('Blockly started') === 0 || msg.text === 'Blockly stopped');

    if (msg.dir === 'tx') {
      el.className = 'cmd-msg ' + (isBlockly ? 'cmd-msg-tx-blockly' : 'cmd-msg-tx');
      var prefix = isBlockly ? '[blockly] > ' : '> ';
      el.textContent = prefix + msg.text;
    } else if (msg.dir === 'rx') {
      el.className = 'cmd-msg cmd-msg-rx';
      el.textContent = msg.text;
    } else if (msg.dir === 'auto-status') {
      el.className = 'cmd-msg cmd-msg-rx cmd-msg-auto-status';
      el.textContent = msg.text;
    } else if (msg.dir === 'sys') {
      el.className = 'cmd-msg ' + (isBlocklySys ? 'cmd-msg-sys-blockly' : 'cmd-msg-sys');
      el.textContent = '--- ' + msg.text + ' ---';
    }

    output.appendChild(el);
    output.scrollTop = output.scrollHeight;
  }

  function appendSystemMessage(text) {
    var output = document.getElementById('command-output');
    if (!output) return;
    var el = document.createElement('div');
    el.className = 'cmd-msg cmd-msg-sys';
    el.textContent = '--- ' + text + ' ---';
    output.appendChild(el);
    output.scrollTop = output.scrollHeight;
  }

  // ── Setup input handling ──

  function init() {
    var input = document.getElementById('command-input');
    if (!input) return;

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        var cmd = input.value;
        if (cmd.trim()) {
          sendCommand(cmd);
          input.value = '';
        }
      }
    });

    // Clear screen button — clears display only, history stays on server
    var clearBtn = document.getElementById('command-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', function() {
        clearOutput();
      });
    }

    // Hard refresh (disconnect + reconnect same port)
    var refreshBtn = document.getElementById('command-port-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function() {
        refreshPortConnection();
      });
    }
    var portSelect = document.getElementById('command-port-select');
    if (portSelect) {
      portSelect.addEventListener('change', updateRefreshButton);
    }
    updateRefreshButton();

    // Start polling immediately (to pick up connection status messages)
    startPolling();
  }

  // Expose for device detector to call
  window.commandTabConnect = connectToPort;
  window.commandTabDisconnect = disconnectPort;
  window.commandTabRefresh = refreshPortConnection;
  window.commandTabUpdateRefreshButton = updateRefreshButton;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }
})();