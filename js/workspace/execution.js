/**
 * Code Execution Module
 * Real-time interactive console: streams stdout/stderr and supports input().
 */

/** Active interactive session id (null when idle). */
var _execSessionId = null;
/** EventSource for SSE stream */
var _execEventSource = null;
/** True while a program is running interactively */
var _execRunning = false;
/** True after Stop until the server finishes cleanup and sends done */
var _execStopping = false;
/** True when Python is blocked on input() */
var _execAwaitingInput = false;

/** Update only the label under a toolbar icon button (preserve SVG). */
function setToolbarBtnLabel(btn, label) {
  if (!btn) return;
  var el = btn.querySelector('.toolbar-btn-label');
  if (el) el.textContent = label;
  else btn.textContent = label;
}

/**
 * Ensure the console has a scroll log + input line.
 * Migrates the plain #output-content div if needed.
 */
function ensureConsoleUi() {
  var content = document.getElementById('output-content');
  if (!content) return null;

  if (content.querySelector('.console-log')) {
    return {
      root: content,
      log: content.querySelector('.console-log'),
      input: content.querySelector('#console-input'),
      inputRow: content.querySelector('.console-input-row'),
      prompt: content.querySelector('.console-prompt')
    };
  }

  content.classList.add('console-root');
  content.innerHTML =
    '<div class="console-log" id="console-log"></div>' +
    '<div class="console-input-row" id="console-input-row">' +
    '  <span class="console-prompt" id="console-prompt">&gt;</span>' +
    '  <input type="text" id="console-input" class="console-input" ' +
    '    autocomplete="off" spellcheck="false" ' +
    '    placeholder="Program input (when prompted)…" disabled />' +
    '</div>';

  var input = content.querySelector('#console-input');
  if (input && !input._consoleBound) {
    input._consoleBound = true;
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitConsoleInput();
      }
    });
  }

  return {
    root: content,
    log: content.querySelector('.console-log'),
    input: content.querySelector('#console-input'),
    inputRow: content.querySelector('.console-input-row'),
    prompt: content.querySelector('.console-prompt')
  };
}

function clearConsole() {
  var ui = ensureConsoleUi();
  if (ui && ui.log) ui.log.innerHTML = '';
  setConsoleInputEnabled(false);
}

function setConsoleInputEnabled(enabled, placeholder) {
  var ui = ensureConsoleUi();
  if (!ui || !ui.input) return;
  ui.input.disabled = !enabled;
  if (placeholder != null) ui.input.placeholder = placeholder;
  if (enabled) {
    ui.inputRow && ui.inputRow.classList.add('active');
    try { ui.input.focus(); } catch (e) { /* ignore */ }
  } else {
    ui.inputRow && ui.inputRow.classList.remove('active');
    ui.input.value = '';
    ui.input.placeholder = 'Program input (when prompted)…';
  }
}

/**
 * Append text to the console log.
 * @param {string} text
 * @param {string} type - stdout | stderr | result | error | stdin | system
 * @param {boolean} [raw] - if true, keep exact whitespace (streaming chunks)
 */
function appendOutput(text, type, raw) {
  var ui = ensureConsoleUi();
  if (!ui || !ui.log) return;
  if (text == null || text === '') return;

  var line = document.createElement('span');
  line.className = 'output-line output-' + (type || 'stdout');
  // Streaming chunks often lack a trailing newline; use pre-wrap on parent
  line.textContent = String(text);
  if (raw) line.classList.add('output-chunk');
  ui.log.appendChild(line);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function setRunButtonRunning(running) {
  var busy = !!running || _execStopping;
  var runBtn = document.getElementById('runBtn');
  if (runBtn) {
    runBtn.disabled = busy;
    setToolbarBtnLabel(runBtn, busy ? '…' : 'Run');
    runBtn.title = _execStopping ? 'Stopping…' : (running ? 'Running…' : 'Run');
  }
  var stopBtn = document.getElementById('stopProgramBtn');
  if (stopBtn) stopBtn.disabled = !running || _execStopping;
}

function closeExecStream() {
  if (_execEventSource) {
    try { _execEventSource.close(); } catch (e) { /* ignore */ }
    _execEventSource = null;
  }
}

function finishExecution(ok) {
  _execRunning = false;
  _execStopping = false;
  _execAwaitingInput = false;
  _execSessionId = null;
  closeExecStream();
  setConsoleInputEnabled(false);
  setRunButtonRunning(false);

  if (typeof window.controlPanelMarkStale === 'function') {
    window.controlPanelMarkStale();
  }
}

/**
 * Handle one SSE event from the interactive executor.
 */
function handleExecEvent(evt) {
  if (!evt || !evt.type) return;

  switch (evt.type) {
    case 'stdout':
      appendOutput(evt.data || '', 'stdout', true);
      break;
    case 'stderr':
      appendOutput(evt.data || '', 'stderr', true);
      break;
    case 'stdin_request':
      _execAwaitingInput = true;
      // Prompt is also emitted as stdout; if it was empty, still enable input
      setConsoleInputEnabled(true, 'Type input and press Enter…');
      break;
    case 'stdin_echo':
      appendOutput(evt.data || '', 'stdin', true);
      break;
    case 'result':
      appendOutput('Result: ' + (evt.data || ''), 'result');
      break;
    case 'error':
      appendOutput('Error: ' + (evt.data || 'Unknown error'), 'error');
      break;
    case 'done':
      if (evt.success) {
        appendOutput('\n— finished —\n', 'system', true);
      } else if (evt.reason === 'stop') {
        appendOutput('\n— Program stopped —\n', 'system', true);
      } else if (evt.reason === 'emergency') {
        // stopAllRobots already showed the emergency notification.
      } else {
        appendOutput('\n— stopped —\n', 'system', true);
      }
      finishExecution(!!evt.success);
      break;
    default:
      break;
  }
}

/**
 * Submit the console input line to the running session (Python input()).
 */
async function submitConsoleInput() {
  var ui = ensureConsoleUi();
  if (!ui || !ui.input || !_execSessionId || !_execRunning) return;

  var line = ui.input.value;
  ui.input.value = '';
  setConsoleInputEnabled(false);
  _execAwaitingInput = false;

  var serverUrl = (typeof getServerUrl === 'function')
    ? getServerUrl()
    : 'http://127.0.0.1:5080';

  try {
    var resp = await fetch(serverUrl + '/execute/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _execSessionId, line: line })
    });
    var result = await resp.json();
    if (!result.success) {
      appendOutput('Input error: ' + (result.error || 'failed'), 'error');
    }
  } catch (err) {
    appendOutput('Input connection error: ' + err.message, 'error');
  }
}

/**
 * Execute the current workspace code with a live interactive console.
 */
async function runCode() {
  var serverUrl = (typeof getServerUrl === 'function')
    ? getServerUrl()
    : 'http://127.0.0.1:5080';

  if (_execRunning || _execStopping) {
    appendOutput('A program is already running. Stop it first.', 'error');
    return;
  }

  ensureConsoleUi();
  clearConsole();
  setRunButtonRunning(true);
  _execRunning = true;

  try {
    try {
      var healthCheck = await fetch(serverUrl + '/health', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      if (!healthCheck.ok) throw new Error('Server health check failed');
    } catch (healthError) {
      appendOutput('Python server is not running. Please restart the application.', 'error');
      finishExecution(false);
      return;
    }

    var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    var pythonCode = workspace ? Blockly.Python.workspaceToCode(workspace) : '';

    if (!pythonCode.trim()) {
      appendOutput('No code to execute. Add some blocks first!', 'error');
      finishExecution(false);
      return;
    }

    // Start interactive session
    var startResp = await fetch(serverUrl + '/execute/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pythonCode })
    });
    var startResult = await startResp.json();
    if (!startResult.success || !startResult.session_id) {
      appendOutput('Error: ' + (startResult.error || 'Could not start'), 'error');
      finishExecution(false);
      return;
    }

    _execSessionId = startResult.session_id;
    // Arm only after the server has reset the preview hub for this run.
    if (pythonCode.indexOf('__studiox_preview') !== -1 &&
        window.CameraView && typeof window.CameraView.arm === 'function') {
      window.CameraView.arm();
    }
    appendOutput('— running —\n', 'system', true);

    // Stream events (SSE)
    closeExecStream();
    var es = new EventSource(serverUrl + '/execute/events/' + _execSessionId);
    _execEventSource = es;

    es.onmessage = function(msg) {
      try {
        var evt = JSON.parse(msg.data);
        handleExecEvent(evt);
      } catch (e) {
        console.warn('[Exec] Bad SSE payload', msg.data, e);
      }
    };
    es.onerror = function() {
      // EventSource retries by default; if session is done, close cleanly
      if (!_execRunning) {
        closeExecStream();
        return;
      }
      // If the stream dies mid-run, surface a message once
      if (es.readyState === EventSource.CLOSED) {
        appendOutput('\nConnection to execution stream lost.\n', 'error', true);
        finishExecution(false);
      }
    };
  } catch (error) {
    appendOutput('Connection Error: ' + error.message, 'error');
    appendOutput('Make sure the Python server is running.', 'stderr');
    finishExecution(false);
  }
}

/**
 * Stop the running program, like Teaching's Stop. Does not emergency-stop robots.
 */
function _executionStreamClosed() {
  if (!_execEventSource) return true;
  var closed = (typeof EventSource !== 'undefined') ? EventSource.CLOSED : 2;
  return _execEventSource.readyState === closed;
}

async function stopRunningProgram() {
  if (_execStopping) return;
  if (!_execRunning) return;
  var serverUrl = (typeof getServerUrl === 'function')
    ? getServerUrl()
    : 'http://127.0.0.1:5080';
  _execStopping = true;
  setRunButtonRunning(true);
  try {
    var resp = await fetch(serverUrl + '/execute/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'stop' }),
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) throw new Error('Stop failed (' + resp.status + ')');
  } catch (e) {
    appendOutput('Stop failed: ' + (e && e.message ? e.message : e), 'error');
    if (_execRunning) {
      _execStopping = false;
      setRunButtonRunning(true);
    }
    return;
  }
  // The program may have finished and closed the stream while abort was in flight.
  if (!_execRunning) return;
  if (_executionStreamClosed()) {
    appendOutput('\nConnection to execution stream lost.\n', 'error', true);
    finishExecution(false);
  }
}

/**
 * Emergency stop: cancel all robot movements, stop debug session,
 * and abort any running Blockly code.
 */
async function stopAllRobots() {
  var serverUrl = (typeof getServerUrl === 'function')
    ? getServerUrl()
    : 'http://127.0.0.1:5080';
  var tracked = _execRunning || _execStopping;
  if (tracked && !_execStopping) {
    _execStopping = true;
    setRunButtonRunning(true);
  }

  // Robot cancel is immediate. Run stays disabled until Python cleanup finishes.
  try {
    await fetch(serverUrl + '/cmd/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000)
    });
  } catch (e) { /* ignore */ }

  if (typeof window.debugStop === 'function') {
    try { window.debugStop(); } catch (e2) { /* ignore */ }
  }

  var abortError = null;
  try {
    var resp = await fetch(serverUrl + '/execute/abort', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'emergency' }),
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) abortError = 'Stop failed (' + resp.status + ')';
  } catch (e3) {
    abortError = e3 && e3.message ? e3.message : String(e3);
  }

  if (!tracked) {
    appendOutput('EMERGENCY STOP — all operations cancelled.', 'error');
    return;
  }

  appendOutput('EMERGENCY STOP — all operations cancelled.', 'error');
  if (abortError) {
    appendOutput('Stop failed: ' + abortError, 'error');
  }
  if (!_execRunning) return;
  if (abortError) {
    _execStopping = false;
    setRunButtonRunning(true);
    return;
  }
  if (_executionStreamClosed()) {
    appendOutput('\nConnection to execution stream lost.\n', 'error', true);
    finishExecution(false);
  }
}

// Init console chrome when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { ensureConsoleUi(); });
} else {
  ensureConsoleUi();
}
