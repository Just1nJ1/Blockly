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

  function disconnectPort() {
    return fetch(getServerUrl() + '/cmd/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _connected = false;
      _currentPort = null;
      return data;
    });
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
    fetch(getServerUrl() + '/cmd/history?since=' + _lastMessageId)
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

    // Start polling immediately (to pick up connection status messages)
    startPolling();
  }

  // Expose for device detector to call
  window.commandTabConnect = connectToPort;
  window.commandTabDisconnect = disconnectPort;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }
})();