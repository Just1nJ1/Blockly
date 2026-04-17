/**
 * Debug Execution Module
 * Handles step-by-step debugging of Python code via the server's
 * /debug/start, /debug/step, /debug/continue, /debug/stop endpoints.
 */

// ── Debug session state ──────────────────────────────────────────
var _debugSessionId = null;
var _debugLineToBlock = {};  // line number -> block id
var _debugActive = false;
var _debugHighlightedBlock = null;  // currently highlighted block id

// ── Position tracking for live block updates ─────────────────────
// When the user jogs during debug, we capture the position at first jog click
// ("before jog"), then on the next step we capture again ("after jog") and
// update the previous move block's values with the difference.
var _debugLastMoveBlockId = null;    // block id of the last writeAngle/writeCoordinate
var _debugBeforeJogPosition = null;  // captured on first jog click after a move block
var _debugJoggedSinceStep = false;   // true if user jogged between steps

/**
 * Start a debug session.
 */
async function debugStart() {
  var workspace = getWorkspace ? getWorkspace() : null;
  var serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';
  if (!workspace) return;

  // Generate code + line-to-block map in one pass
  var generated = generateCodeWithMap(workspace);
  var pythonCode = generated.code;
  _debugLineToBlock = generated.lineToBlock;

  if (!pythonCode.trim()) {
    appendOutput('No code to debug. Add some blocks first!', 'error');
    return;
  }

  console.log('[Debug] Line-to-block map:', _debugLineToBlock);

  // Clear previous output
  var outputContent = document.getElementById('output-content');
  if (outputContent) outputContent.innerHTML = '';

  // Show debug UI
  _setDebugMode(true);

  try {
    var response = await fetch(serverUrl + '/debug/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pythonCode }),
      signal: AbortSignal.timeout(15000)
    });

    var result = await response.json();
    if (result.success) {
      _debugSessionId = result.session_id;
      _debugActive = true;
      _applyDebugState(result);
    } else {
      appendOutput('Debug error: ' + (result.error || 'Unknown error'), 'error');
      _setDebugMode(false);
    }
  } catch (error) {
    appendOutput('Debug connection error: ' + error.message, 'error');
    _setDebugMode(false);
  }
}

/**
 * Step one line forward.
 */
async function debugStep() {
  if (!_debugSessionId || !_debugActive) return;
  var serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';

  // Disable step button during request to prevent double-clicks
  var stepBtn = document.getElementById('stepBtn');
  if (stepBtn) stepBtn.disabled = true;

  try {
    // ── Before stepping: update previous move block if user jogged ──
    console.log('[Debug] Step check: jogged:', _debugJoggedSinceStep,
      'lastMoveBlock:', _debugLastMoveBlockId,
      'beforeJogPos:', !!_debugBeforeJogPosition);
    if (_debugJoggedSinceStep && _debugLastMoveBlockId) {
      // If before-jog position wasn't captured (fetch failed), try now
      if (!_debugBeforeJogPosition) {
        console.log('[Debug] Before-jog position missing, attempting late capture');
        try {
          var statusResp = await fetch(serverUrl + '/cmd/get-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ silent: true })
          });
          var statusData = await statusResp.json();
          if (statusData.success) {
            // Use current position as before-jog (best we can do)
            _debugBeforeJogPosition = {
              angles: statusData.angles,
              coordinates: statusData.coordinates
            };
            console.log('[Debug] Late-captured before-jog position');
          }
        } catch (e) {
          console.warn('[Debug] Late capture failed:', e);
        }
      }

      if (_debugBeforeJogPosition) {
        try {
          await _updateMoveBlockFromJog();
        } catch (updateErr) {
          console.warn('[Debug] Failed to update move block from jog:', updateErr);
        }
      }
    }
    _debugJoggedSinceStep = false;

    var response = await fetch(serverUrl + '/debug/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _debugSessionId }),
      signal: AbortSignal.timeout(35000)
    });

    var result = await response.json();
    if (result.success) {
      // The currently highlighted block is the one that just executed
      // (it was highlighted from the previous step, and now the server
      // has advanced past it). Save it before _applyDebugState changes it.
      var executedBlockId = _debugHighlightedBlock;

      _applyDebugState(result);

      // Track if the executed block was a move block.
      _trackMoveBlock(executedBlockId);

      // Auto-select the robot in the control panel based on the executed block
      _selectControlPanelForBlock(executedBlockId);

      if (result.finished) {
        _endDebugSession('Execution finished.');
      }
    } else {
      appendOutput('Step error: ' + (result.error || 'Unknown error'), 'error');
      _endDebugSession();
    }
  } catch (error) {
    appendOutput('Step error: ' + error.message, 'error');
    _endDebugSession();
  } finally {
    if (stepBtn) stepBtn.disabled = false;
  }
}

/**
 * Continue running without pausing.
 */
async function debugContinue() {
  if (!_debugSessionId || !_debugActive) return;
  var serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';

  _setDebugButtonsEnabled(false);
  appendOutput('Continuing execution...', 'stdout');

  try {
    var response = await fetch(serverUrl + '/debug/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _debugSessionId }),
      signal: AbortSignal.timeout(35000)
    });

    var result = await response.json();
    if (result.success) {
      // Show any remaining output
      if (result.stdout) appendOutput(result.stdout, 'stdout');
      if (result.stderr) appendOutput(result.stderr, 'stderr');
      if (result.error) appendOutput('Error: ' + result.error, 'error');
    }
    _endDebugSession('Execution completed.');
  } catch (error) {
    appendOutput('Continue error: ' + error.message, 'error');
    _endDebugSession();
  }
}

/**
 * Stop the debug session.
 */
async function debugStop() {
  if (!_debugSessionId) {
    _setDebugMode(false);
    return;
  }
  var serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';

  try {
    await fetch(serverUrl + '/debug/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: _debugSessionId }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    // Ignore errors on stop
  }
  _endDebugSession('Debug session stopped.');
}

// ── Internal helpers ─────────────────────────────────────────────

/**
 * Apply the debug state from a server response to the UI.
 */
function _applyDebugState(state) {
  var workspace = getWorkspace ? getWorkspace() : null;

  // Highlight the current block
  if (workspace && state.line) {
    // Clear previous highlight
    _clearDebugActive(workspace);

    var blockId = _debugLineToBlock[state.line];
    if (blockId) {
      _debugHighlightedBlock = blockId;
      _applyDebugActive(workspace, blockId);
      workspace.centerOnBlock(blockId);
    }
  }

  // Update line info
  var lineInfo = document.getElementById('debug-line-info');
  if (lineInfo) {
    lineInfo.textContent = state.line ? 'Line ' + state.line : '';
  }

  // Update variables panel
  var varsEl = document.getElementById('debug-variables');
  if (varsEl) {
    varsEl.innerHTML = '';
    var variables = state.variables || {};
    var names = Object.keys(variables).sort();
    if (names.length === 0) {
      varsEl.innerHTML = '<div style="color:#999;padding:4px;">No variables yet</div>';
    } else {
      for (var i = 0; i < names.length; i++) {
        var name = names[i];
        var info = variables[name];
        var row = document.createElement('div');
        row.className = 'debug-var-row';
        row.innerHTML =
          '<span class="debug-var-name">' + _escapeHtml(name) + '</span>' +
          '<span class="debug-var-value">' + _escapeHtml(info.value) + '</span>' +
          '<span class="debug-var-type">' + _escapeHtml(info.type) + '</span>';
        varsEl.appendChild(row);
      }
    }
  }

  // Update call stack
  var stackEl = document.getElementById('debug-callstack');
  if (stackEl) {
    stackEl.innerHTML = '';
    var stack = state.call_stack || [];
    if (stack.length > 0) {
      for (var s = 0; s < stack.length; s++) {
        var frame = stack[s];
        var frameEl = document.createElement('div');
        frameEl.className = 'callstack-frame' + (s === 0 ? ' current' : '');
        var funcName = frame.function === '<module>' ? '<module>' : frame.function + '()';
        frameEl.textContent = (s === 0 ? '\u25B6 ' : '  ') + 'line ' + frame.line + ' in ' + funcName;
        stackEl.appendChild(frameEl);
      }
    }
  }

  // Append any new stdout
  if (state.stdout) {
    appendOutput(state.stdout, 'stdout');
  }

  // Show errors
  if (state.error) {
    appendOutput('Error: ' + state.error, 'error');
    if (state.traceback) {
      appendOutput(state.traceback, 'stderr');
    }
  }
}

/**
 * Show/hide debug mode UI elements.
 */
function _setDebugMode(active) {
  var debugBtns = document.querySelectorAll('.debug-btn');
  var debugPanel = document.getElementById('debug-panel');
  var runBtn = document.getElementById('runBtn');
  var debugBtn = document.getElementById('debugBtn');
  var blocklyDiv = document.getElementById('blocklyDiv');

  for (var i = 0; i < debugBtns.length; i++) {
    if (active) {
      debugBtns[i].classList.add('visible');
    } else {
      debugBtns[i].classList.remove('visible');
    }
  }

  if (debugPanel) {
    if (active) {
      debugPanel.classList.add('active');
    } else {
      debugPanel.classList.remove('active');
    }
  }

  // Gray out workspace and disable editing during debug
  if (blocklyDiv) {
    if (active) {
      blocklyDiv.classList.add('debug-mode');
      // Block keyboard events (delete, backspace, etc.) on workspace
      blocklyDiv.addEventListener('keydown', _blockKeysDuringDebug, true);
    } else {
      blocklyDiv.classList.remove('debug-mode');
      blocklyDiv.removeEventListener('keydown', _blockKeysDuringDebug, true);
    }
  }

  // Disable Run/Debug buttons during debug, enable when done
  if (runBtn) runBtn.disabled = active;
  if (debugBtn) debugBtn.disabled = active;
}

/**
 * Enable/disable the step/continue/stop buttons.
 */
function _setDebugButtonsEnabled(enabled) {
  var ids = ['stepBtn', 'continueBtn', 'stopDebugBtn'];
  for (var i = 0; i < ids.length; i++) {
    var btn = document.getElementById(ids[i]);
    if (btn) btn.disabled = !enabled;
  }
}

/**
 * End the debug session and clean up.
 */
function _endDebugSession(message) {
  _debugSessionId = null;
  _debugActive = false;
  _debugLineToBlock = {};
  _debugLastMoveBlockId = null;
  _debugBeforeJogPosition = null;
  _debugJoggedSinceStep = false;

  // Clear block highlight
  var workspace = getWorkspace ? getWorkspace() : null;
  if (workspace) {
    _clearDebugActive(workspace);
  }
  _debugHighlightedBlock = null;

  // Re-enable debug buttons before hiding them
  _setDebugButtonsEnabled(true);
  _setDebugMode(false);

  if (message) {
    appendOutput(message, 'result');
  }

  // Mark control panel as stale after debug session ends
  if (typeof window.controlPanelMarkStale === 'function') {
    window.controlPanelMarkStale();
  }
}

/**
 * Add 'debug-active' class to a block's SVG and all its direct value-input blocks.
 * This highlights only the statement block and its attached value inputs,
 * NOT the next-connection blocks stacked below it.
 */
function _applyDebugActive(workspace, blockId) {
  var block = workspace.getBlockById(blockId);
  if (!block) return;

  var svg = block.getSvgRoot();
  if (svg) svg.classList.add('debug-active');

  // Also mark each value-input child block (and their nested value inputs recursively)
  var inputs = block.inputList || [];
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    // Only value and dummy inputs, skip statement inputs (which are nested stacks)
    if (input.connection && input.type !== 3) {
      var childBlock = input.connection.targetBlock();
      if (childBlock) {
        _markBlockTree(childBlock);
      }
    }
  }
}

/**
 * Recursively mark a block and all its value-input children with 'debug-active'.
 * This walks into nested value blocks (e.g. math_number inside math_arithmetic).
 */
function _markBlockTree(block) {
  if (!block) return;
  var svg = block.getSvgRoot();
  if (svg) svg.classList.add('debug-active');

  var inputs = block.inputList || [];
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    if (input.connection && input.type !== 3) {
      var child = input.connection.targetBlock();
      if (child) _markBlockTree(child);
    }
  }
}

/**
 * Remove 'debug-active' class from all blocks in the workspace.
 */
function _clearDebugActive(workspace) {
  var svgEl = workspace.getParentSvg();
  if (!svgEl) return;
  var actives = svgEl.querySelectorAll('.debug-active');
  for (var i = 0; i < actives.length; i++) {
    actives[i].classList.remove('debug-active');
  }
}

/**
 * Block keyboard events on the workspace during debug mode.
 */
function _blockKeysDuringDebug(e) {
  e.stopPropagation();
  e.preventDefault();
}

/**
 * Escape HTML entities for safe display.
 */
// ── Position tracking for live block updates ─────────────────────

/**
 * After a step executes, check if the executed line was a writeAngle/writeCoordinate
 * block. If so, capture the robot's current position for later comparison.
 */
function _trackMoveBlock(executedBlockId) {
  var workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace || !executedBlockId) {
    _debugLastMoveBlockId = null;
    return;
  }

  var block = workspace.getBlockById(executedBlockId);
  if (!block) return;

  if (block.type === 'write_coordinate' || block.type === 'write_angle') {
    _debugLastMoveBlockId = executedBlockId;
    _debugBeforeJogPosition = null;  // will be captured on first jog
    _debugJoggedSinceStep = false;
    console.log('[Debug] Tracking move block:', executedBlockId, block.type);
  } else {
    _debugLastMoveBlockId = null;
    _debugBeforeJogPosition = null;
  }
}

/**
 * Called before the next step executes. If the user jogged the robot since
 * the last move block, capture the current position and update the block's values.
 */
async function _updateMoveBlockFromJog() {
  var workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace || !_debugBeforeJogPosition) {
    console.log('[Debug] _updateMoveBlockFromJog: no workspace or no beforeJogPosition');
    return;
  }

  var block = workspace.getBlockById(_debugLastMoveBlockId);
  if (!block) {
    console.log('[Debug] _updateMoveBlockFromJog: block not found:', _debugLastMoveBlockId);
    return;
  }

  var isCoord = (block.type === 'write_coordinate');
  var isAngle = (block.type === 'write_angle');
  if (!isCoord && !isAngle) {
    console.log('[Debug] _updateMoveBlockFromJog: block is not a move block:', block.type);
    return;
  }

  console.log('[Debug] _updateMoveBlockFromJog: updating block', _debugLastMoveBlockId, block.type);

  // Get the block's position mode (0=absolute, 1=incremental)
  var positionMode = block.getFieldValue('POSITION');
  var isIncremental = (positionMode === '1');

  // Capture current position from robot (after user finished jogging)
  var serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';
  var afterJogPos;
  try {
    var resp = await fetch(serverUrl + '/cmd/get-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ silent: true })
    });
    var data = await resp.json();
    if (!data.success) return;
    afterJogPos = {
      angles: data.angles,
      coordinates: data.coordinates
    };
  } catch (e) {
    return;
  }

  console.log('[Debug] Before-jog position:', _debugBeforeJogPosition);
  console.log('[Debug] After-jog position:', afterJogPos);
  console.log('[Debug] Mode:', isIncremental ? 'incremental' : 'absolute');

  var axisKeys = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var updatedCount = 0;

  if (isCoord) {
    var coordStatusKeys = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
    var beforeCoord = _debugBeforeJogPosition.coordinates;
    var afterCoord = afterJogPos.coordinates;

    for (var i = 0; i < axisKeys.length; i++) {
      var input = block.getInput('AXIS_' + axisKeys[i]);
      if (!input) continue;
      var sk = coordStatusKeys[i];
      if (!sk) continue;

      var beforeVal = beforeCoord[sk] || 0;
      var afterVal = afterCoord[sk] || 0;
      var diff = afterVal - beforeVal;

      if (Math.abs(diff) < 0.01) continue;  // no significant change

      var newVal;
      if (isIncremental) {
        newVal = _getAxisBlockValue(block, axisKeys[i]) + diff;
      } else {
        newVal = afterVal;
      }
      console.log('[Debug] Coord axis', axisKeys[i], ':', beforeVal, '->', afterVal, 'diff:', diff, 'newVal:', newVal);
      _setAxisBlockValue(block, axisKeys[i], Math.round(newVal * 100) / 100);
      updatedCount++;
    }
  } else {
    var beforeAngles = _debugBeforeJogPosition.angles;
    var afterAngles = afterJogPos.angles;

    for (var j = 0; j < axisKeys.length; j++) {
      var inputA = block.getInput('AXIS_' + axisKeys[j]);
      if (!inputA) continue;

      var beforeValA = beforeAngles[axisKeys[j]] || 0;
      var afterValA = afterAngles[axisKeys[j]] || 0;
      var diffA = afterValA - beforeValA;

      if (Math.abs(diffA) < 0.01) continue;

      var newValA;
      if (isIncremental) {
        newValA = _getAxisBlockValue(block, axisKeys[j]) + diffA;
      } else {
        newValA = afterValA;
      }
      console.log('[Debug] Angle axis', axisKeys[j], ':', beforeValA, '->', afterValA, 'diff:', diffA, 'newVal:', newValA);
      _setAxisBlockValue(block, axisKeys[j], Math.round(newValA * 100) / 100);
      updatedCount++;
    }
  }

  console.log('[Debug] Updated move block', _debugLastMoveBlockId, 'axes updated:', updatedCount);

  // Clear tracking
  _debugLastMoveBlockId = null;
  _debugBeforeJogPosition = null;
}

/**
 * Get the numeric value from a move block's axis input.
 * Reads from the connected math_number block if present.
 */
function _getAxisBlockValue(block, axisKey) {
  var input = block.getInput('AXIS_' + axisKey);
  if (!input || !input.connection) return 0;
  var target = input.connection.targetBlock();
  if (!target) return 0;
  if (target.type === 'math_number') {
    return parseFloat(target.getFieldValue('NUM')) || 0;
  }
  return 0;
}

/**
 * Set the numeric value on a move block's axis input.
 * If a math_number is connected, updates its NUM field.
 * If nothing is connected, creates a new math_number block.
 */
function _setAxisBlockValue(block, axisKey, value) {
  var input = block.getInput('AXIS_' + axisKey);
  if (!input || !input.connection) return;

  var target = input.connection.targetBlock();
  if (target && target.type === 'math_number') {
    target.setFieldValue(String(value), 'NUM');
  } else if (!target) {
    // Create a new math_number block
    var ws = block.workspace;
    var numBlock = ws.newBlock('math_number');
    numBlock.setFieldValue(String(value), 'NUM');
    numBlock.initSvg();
    numBlock.render();
    input.connection.connect(numBlock.outputConnection);
  }
}

/**
 * Auto-select the control panel port based on the robot variable
 * used by the executed block.
 */
function _selectControlPanelForBlock(blockId) {
  var workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace || !blockId) return;

  var block = workspace.getBlockById(blockId);
  if (!block) return;

  // Get the variable name from the block's VARIABLE field
  var varField = block.getField('VARIABLE');
  if (!varField) return;

  var varName = null;
  if (typeof varField.getVariable === 'function' && varField.getVariable()) {
    varName = varField.getVariable().name;
  } else {
    varName = block.getFieldValue('VARIABLE');
  }
  if (!varName) return;

  // Find the port for this variable from setup_robot blocks
  var setupBlocks = workspace.getBlocksByType('setup_robot', false);
  var port = null;
  for (var i = 0; i < setupBlocks.length; i++) {
    var sf = setupBlocks[i].getField('VARIABLE');
    if (sf && sf.getVariable() && sf.getVariable().name === varName) {
      port = setupBlocks[i].getFieldValue('PORT');
      break;
    }
  }
  if (!port) return;

  // Switch the control panel to this port
  var select = document.getElementById('ctrl-port-select');
  if (!select) return;

  // Only switch if different from current selection
  if (select.value === port) return;

  for (var j = 0; j < select.options.length; j++) {
    if (select.options[j].value === port) {
      select.selectedIndex = j;
      select.dispatchEvent(new Event('change'));
      break;
    }
  }
}

/**
 * Called by the control panel BEFORE a jog command is sent.
 * On the first jog after a move block, captures the robot's current position
 * (which is the position the move block moved to, after the robot has settled).
 */
async function debugNotifyJog() {
  console.log('[Debug] debugNotifyJog called. active:', _debugActive,
    'lastMoveBlock:', _debugLastMoveBlockId,
    'jogged:', _debugJoggedSinceStep,
    'beforeJogPos:', !!_debugBeforeJogPosition);

  if (!_debugActive || !_debugLastMoveBlockId) return;

  // Already jogged and captured — nothing to do
  if (_debugJoggedSinceStep && _debugBeforeJogPosition) return;

  // Capture position on first jog (or retry if previous capture failed)
  if (!_debugBeforeJogPosition) {
    var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
    // Small delay to let the robot settle from the previous move command
    await new Promise(function(r) { setTimeout(r, 300); });
    try {
      var resp = await fetch(serverUrl + '/cmd/get-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ silent: true })
      });
      var data = await resp.json();
      if (data.success) {
        _debugBeforeJogPosition = {
          angles: data.angles,
          coordinates: data.coordinates
        };
        _debugJoggedSinceStep = true;
        console.log('[Debug] Captured before-jog position:', _debugBeforeJogPosition);
      } else {
        console.warn('[Debug] Failed to capture before-jog position:', data.error);
      }
    } catch (e) {
      console.warn('[Debug] Error capturing before-jog position:', e);
    }
  } else {
    _debugJoggedSinceStep = true;
  }
}

// Expose globally for control panel to call
window.debugNotifyJog = debugNotifyJog;

function _escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


