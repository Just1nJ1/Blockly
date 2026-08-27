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

// ── Teach-after-step (live block updates from Control panel) ─────
// After a writeAngle/writeCoordinate *executes*, that block is the teach
// target (orange outline) until the *next* step runs. Control panel jog /
// absolute edits update its axis values. Stepping again clears teach so
// only the most recently executed move block is ever editable — never a
// move two steps above.
var _debugLastMoveBlockId = null;    // teach target: last executed move block
var _debugBeforeJogPosition = null;  // pose after move settled (baseline for deltas)
var _debugJoggedSinceStep = false;   // true if user jogged/edited since that move
var _debugTeachApplyTimer = null;    // debounce status-driven teach apply
var _debugTeachBaselineBlockValues = null; // axis values at teach-start (for incremental)

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
    // ── Before stepping: flush any pending teach edits onto the move block ──
    console.log('[Debug] Step check: jogged:', _debugJoggedSinceStep,
      'lastMoveBlock:', _debugLastMoveBlockId,
      'beforeJogPos:', !!_debugBeforeJogPosition);
    if (_debugJoggedSinceStep && _debugLastMoveBlockId) {
      try {
        await _updateMoveBlockFromJog({ keepTracking: true, force: true });
      } catch (updateErr) {
        console.warn('[Debug] Failed to update move block from jog:', updateErr);
      }
    }
    // Teach target is cleared/replaced after the step in _trackMoveBlock

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
      // Do not centerOnBlock / scroll the workspace — keep the user's view stable
      // while stepping through code.
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
 *
 * Layout contract while stepping:
 * - Next / Cont / Stop (debug) replace the Run / Step / Sel slots so
 *   Clear / Export / Import stay in the same horizontal positions.
 * - Clear / Export / Import remain visible but disabled.
 * - Emergency stop (#stopAllBtn) stays visible and enabled.
 */
function _setDebugMode(active) {
  var toolbar = document.getElementById('toolbar');
  var debugBtns = document.querySelectorAll('.debug-btn');
  var debugPanel = document.getElementById('debug-panel');
  var runBtn = document.getElementById('runBtn');
  var debugBtn = document.getElementById('debugBtn');
  var blocklyDiv = document.getElementById('blocklyDiv');
  var clearBtn = document.getElementById('clearBtn');
  var exportBtn = document.getElementById('exportBtn');
  var importBtn = document.getElementById('importBtn');
  var stopAllBtn = document.getElementById('stopAllBtn');

  if (toolbar) {
    toolbar.classList.toggle('step-mode', !!active);
  }

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

  // Playback controls are swapped out via CSS (.step-mode); keep disabled too
  if (runBtn) runBtn.disabled = active;
  if (debugBtn) debugBtn.disabled = active;
  var runSelectedBtn = document.getElementById('runSelectedBtn');
  if (runSelectedBtn) runSelectedBtn.disabled = active;

  // Keep file-ops in place; disable while stepping so the program cannot change mid-debug
  if (clearBtn) clearBtn.disabled = active;
  if (exportBtn) exportBtn.disabled = active;
  if (importBtn) importBtn.disabled = active;

  // G-code export: leave visible next to Sel slot, but disabled during step
  if (typeof updateGcodeExportButton === 'function') {
    updateGcodeExportButton();
  } else {
    var gcodeBtn = document.getElementById('exportGcodeBtn');
    if (gcodeBtn) gcodeBtn.disabled = true;
  }

  // Emergency stop must remain available during step mode
  if (stopAllBtn) {
    stopAllBtn.disabled = false;
    stopAllBtn.style.display = '';
    stopAllBtn.hidden = false;
  }
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
  _clearTeachTarget(/* skipWorkspaceClear */ true);
  if (_debugTeachApplyTimer) {
    clearTimeout(_debugTeachApplyTimer);
    _debugTeachApplyTimer = null;
  }

  // Clear block highlight
  var workspace = getWorkspace ? getWorkspace() : null;
  if (workspace) {
    _clearDebugActive(workspace);
    _clearDebugTeach(workspace);
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
 * Teach highlight: last executed move block stays visible while the PC
 * (debug-active) may already be on the next statement.
 */
function _applyDebugTeach(workspace, blockId) {
  _clearDebugTeach(workspace);
  if (!blockId) return;
  var block = workspace.getBlockById(blockId);
  if (!block) return;
  var svg = block.getSvgRoot();
  if (svg) svg.classList.add('debug-teach');
  var inputs = block.inputList || [];
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    if (input.connection && input.type !== 3) {
      var child = input.connection.targetBlock();
      if (child) _markTeachTree(child);
    }
  }
}

function _markTeachTree(block) {
  if (!block) return;
  var svg = block.getSvgRoot();
  if (svg) svg.classList.add('debug-teach');
  var inputs = block.inputList || [];
  for (var i = 0; i < inputs.length; i++) {
    var input = inputs[i];
    if (input.connection && input.type !== 3) {
      var child = input.connection.targetBlock();
      if (child) _markTeachTree(child);
    }
  }
}

function _clearDebugTeach(workspace) {
  if (!workspace) return;
  var svgEl = workspace.getParentSvg();
  if (!svgEl) return;
  var els = svgEl.querySelectorAll('.debug-teach');
  for (var i = 0; i < els.length; i++) {
    els[i].classList.remove('debug-teach');
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
 * Clear the teach target (state + orange outline).
 * @param {boolean} [skipSvg] if true, only clear state vars (caller clears SVG)
 */
function _clearTeachTarget(skipSvg) {
  _debugLastMoveBlockId = null;
  _debugBeforeJogPosition = null;
  _debugJoggedSinceStep = false;
  _debugTeachBaselineBlockValues = null;
  if (_debugTeachApplyTimer) {
    clearTimeout(_debugTeachApplyTimer);
    _debugTeachApplyTimer = null;
  }
  if (!skipSvg) {
    var workspace = getWorkspace ? getWorkspace() : null;
    if (workspace) _clearDebugTeach(workspace);
  }
}

/**
 * After a step executes:
 *  - move block → that block becomes the sole teach target
 *  - any other block → clear teach (cannot edit a move two steps above)
 */
function _trackMoveBlock(executedBlockId) {
  var workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace || !executedBlockId) return;

  var block = workspace.getBlockById(executedBlockId);
  if (!block) return;

  if (block.type === 'write_coordinate' || block.type === 'write_angle') {
    _debugLastMoveBlockId = executedBlockId;
    _debugBeforeJogPosition = null;
    _debugJoggedSinceStep = false;
    _debugTeachBaselineBlockValues = _snapshotAxisValues(block);
    _applyDebugTeach(workspace, executedBlockId);
    console.log('[Debug] Teaching move block:', executedBlockId, block.type);
    // Capture pose after motion settles as the baseline for jog deltas
    _captureTeachBaselineSoon();
  } else {
    // Stepped past the previous move — it is no longer editable
    console.log('[Debug] Non-move executed; clearing teach target');
    _clearTeachTarget();
  }
}

/** Snapshot numeric axis values on a move block (for incremental teach). */
function _snapshotAxisValues(block) {
  var axisKeys = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var snap = {};
  for (var i = 0; i < axisKeys.length; i++) {
    if (!block.getInput('AXIS_' + axisKeys[i])) continue;
    snap[axisKeys[i]] = _getAxisBlockValue(block, axisKeys[i]);
  }
  return snap;
}

/**
 * Capture robot pose shortly after a move block executed (settling delay).
 * Used as "before jog" baseline for teach deltas.
 */
function _captureTeachBaselineSoon() {
  if (!_debugLastMoveBlockId) return;
  var blockId = _debugLastMoveBlockId;
  // Prefer last-status (no serial traffic) then fall back to get-status
  setTimeout(function() {
    _fetchRobotPose().then(function(pose) {
      if (!pose) return;
      if (!_debugActive || _debugLastMoveBlockId !== blockId) return;
      if (_debugBeforeJogPosition) return; // already set by first jog or prior capture
      _debugBeforeJogPosition = pose;
      console.log('[Debug] Teach baseline (after move):', _debugBeforeJogPosition);
    });
  }, 500);
}

/**
 * Fetch current robot pose. Prefers /cmd/last-status (cached auto-report),
 * falls back to /cmd/get-status (? query).
 */
async function _fetchRobotPose() {
  var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
  // Port from control panel when available
  var port = null;
  var sel = document.getElementById('ctrl-port-select');
  if (sel && sel.value) port = sel.value;

  async function tryEndpoint(path, extra) {
    var body = Object.assign({}, extra || {});
    if (port) body.port = port;
    var resp = await fetch(serverUrl + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    var data = await resp.json();
    if (!data || !data.success) return null;
    if (!data.angles && !data.coordinates) return null;
    return {
      angles: data.angles || {},
      coordinates: data.coordinates || {}
    };
  }

  try {
    var pose = await tryEndpoint('/cmd/last-status', {});
    if (pose) return pose;
  } catch (e) { /* fall through */ }

  try {
    return await tryEndpoint('/cmd/get-status', { silent: true });
  } catch (e2) {
    return null;
  }
}

function _poseDiffers(a, b, eps) {
  if (!a || !b) return true;
  eps = eps == null ? 0.01 : eps;
  function check(srcA, srcB, keys) {
    srcA = srcA || {};
    srcB = srcB || {};
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var va = parseFloat(srcA[k]);
      var vb = parseFloat(srcB[k]);
      if (isNaN(va)) va = 0;
      if (isNaN(vb)) vb = 0;
      if (Math.abs(va - vb) >= eps) return true;
    }
    return false;
  }
  if (check(a.angles, b.angles, ['X', 'Y', 'Z', 'A', 'B', 'C'])) return true;
  if (check(a.coordinates, b.coordinates, ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'])) return true;
  return false;
}

/**
 * Called by control panel when a fresh robot status arrives (after jog settles).
 * Applies teach using the reported pose — more reliable than a fixed debounce
 * that can fire before motion finishes.
 */
function debugOnRobotStatus(status) {
  if (!_debugActive || !_debugLastMoveBlockId || !_debugJoggedSinceStep) return;
  if (!status || (!status.angles && !status.coordinates)) return;

  var pose = {
    angles: status.angles || {},
    coordinates: status.coordinates || {}
  };

  // Ignore status that hasn't moved since baseline (motion not finished yet)
  if (_debugBeforeJogPosition && !_poseDiffers(_debugBeforeJogPosition, pose)) {
    return;
  }

  // Debounce multi-axis jogs: apply once after status quiets
  if (_debugTeachApplyTimer) clearTimeout(_debugTeachApplyTimer);
  _debugTeachApplyTimer = setTimeout(function() {
    _debugTeachApplyTimer = null;
    if (!_debugActive || !_debugJoggedSinceStep || !_debugLastMoveBlockId) return;
    _updateMoveBlockFromJog({ keepTracking: true, pose: pose }).catch(function(e) {
      console.warn('[Debug] Status-driven teach apply failed:', e);
    });
  }, 200);
}

/**
 * Write current (or provided) robot pose onto the teach move block.
 * Absolute mode: set axes to robot pose.
 * Incremental mode: add (pose - baseline) to the values at teach-start.
 *
 * keepTracking: leave teach target active for more jogs.
 * force: apply even if pose matches baseline (final flush before Step).
 * pose: optional pre-fetched pose (from control panel status).
 */
async function _updateMoveBlockFromJog(opts) {
  opts = opts || {};
  var keepTracking = !!opts.keepTracking;
  var force = !!opts.force;

  var workspace = getWorkspace ? getWorkspace() : null;
  if (!workspace || !_debugLastMoveBlockId) {
    console.log('[Debug] _updateMoveBlockFromJog: no teach target');
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
    console.log('[Debug] _updateMoveBlockFromJog: not a move block:', block.type);
    return;
  }

  // Ensure baseline pose
  if (!_debugBeforeJogPosition) {
    _debugBeforeJogPosition = await _fetchRobotPose();
  }
  if (!_debugBeforeJogPosition) {
    console.log('[Debug] _updateMoveBlockFromJog: no baseline pose');
    return;
  }

  var afterJogPos = opts.pose || null;
  if (!afterJogPos) {
    afterJogPos = await _fetchRobotPose();
  }
  if (!afterJogPos) {
    console.log('[Debug] _updateMoveBlockFromJog: failed to read after pose');
    return;
  }

  // Skip no-op applies (early status / motion not finished) unless forced
  if (!force && !_poseDiffers(_debugBeforeJogPosition, afterJogPos)) {
    console.log('[Debug] _updateMoveBlockFromJog: pose unchanged, skip');
    return;
  }

  var positionMode = block.getFieldValue('POSITION');
  var isIncremental = (positionMode === '1');
  console.log('[Debug] Teach apply', _debugLastMoveBlockId, block.type,
    isIncremental ? 'incremental' : 'absolute');

  var axisKeys = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var updatedCount = 0;

  // Group field changes for a single undo step
  try { Blockly.Events.setGroup(true); } catch (eG) { /* ignore */ }

  if (isCoord) {
    var coordStatusKeys = ['X', 'Y', 'Z', 'Rx', 'Ry', 'Rz'];
    var beforeCoord = _debugBeforeJogPosition.coordinates || {};
    var afterCoord = afterJogPos.coordinates || {};

    for (var i = 0; i < axisKeys.length; i++) {
      if (!block.getInput('AXIS_' + axisKeys[i])) continue;
      var sk = coordStatusKeys[i];
      if (!sk) continue;

      var beforeVal = parseFloat(beforeCoord[sk]); if (isNaN(beforeVal)) beforeVal = 0;
      var afterVal = parseFloat(afterCoord[sk]); if (isNaN(afterVal)) afterVal = 0;
      var diff = afterVal - beforeVal;
      if (Math.abs(diff) < 0.01) continue;

      // Absolute: robot pose. Incremental: add this jog delta to block value.
      var newVal = isIncremental
        ? (_getAxisBlockValue(block, axisKeys[i]) + diff)
        : afterVal;

      console.log('[Debug] Coord', axisKeys[i], beforeVal, '->', afterVal,
        'diff', diff, 'newVal', newVal);
      if (_setAxisBlockValue(block, axisKeys[i], Math.round(newVal * 100) / 100)) {
        updatedCount++;
      }
    }
  } else {
    var beforeAngles = _debugBeforeJogPosition.angles || {};
    var afterAngles = afterJogPos.angles || {};

    for (var j = 0; j < axisKeys.length; j++) {
      if (!block.getInput('AXIS_' + axisKeys[j])) continue;

      var beforeValA = parseFloat(beforeAngles[axisKeys[j]]); if (isNaN(beforeValA)) beforeValA = 0;
      var afterValA = parseFloat(afterAngles[axisKeys[j]]); if (isNaN(afterValA)) afterValA = 0;
      var diffA = afterValA - beforeValA;
      if (Math.abs(diffA) < 0.01) continue;

      var newValA = isIncremental
        ? (_getAxisBlockValue(block, axisKeys[j]) + diffA)
        : afterValA;

      console.log('[Debug] Angle', axisKeys[j], beforeValA, '->', afterValA,
        'diff', diffA, 'newVal', newValA);
      if (_setAxisBlockValue(block, axisKeys[j], Math.round(newValA * 100) / 100)) {
        updatedCount++;
      }
    }
  }

  try { Blockly.Events.setGroup(false); } catch (eG2) { /* ignore */ }

  console.log('[Debug] Updated move block', _debugLastMoveBlockId,
    'axes updated:', updatedCount);

  if (keepTracking) {
    if (updatedCount > 0) {
      // Next jogs measure from this new pose; block values already include them
      _debugBeforeJogPosition = afterJogPos;
      _debugTeachBaselineBlockValues = _snapshotAxisValues(block);
      _debugJoggedSinceStep = false;
    }
    // If updatedCount === 0, keep _debugJoggedSinceStep so a later status can retry
    _applyDebugTeach(workspace, _debugLastMoveBlockId);
  } else {
    _clearTeachTarget();
  }
}

/**
 * Get the numeric value from a move block's axis input.
 * Reads from the connected math_number (or shadow) if present.
 */
function _getAxisBlockValue(block, axisKey) {
  var input = block.getInput('AXIS_' + axisKey);
  if (!input || !input.connection) return 0;
  var target = input.connection.targetBlock();
  if (!target) return 0;
  if (target.type === 'math_number') {
    var n = parseFloat(target.getFieldValue('NUM'));
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

/**
 * Set the numeric value on a move block's axis input.
 * Shadows are updated via setNumberShadow (Blockly 9+ state) so the value
 * actually sticks; real math_number blocks use setFieldValue.
 * Skips non-number expressions. Returns true if a value was written.
 */
function _setAxisBlockValue(block, axisKey, value) {
  var input = block.getInput('AXIS_' + axisKey);
  if (!input || !input.connection) return false;

  var num = (typeof value === 'number') ? value : parseFloat(value);
  if (isNaN(num)) num = 0;
  // Keep two decimal places without trailing noise
  num = Math.round(num * 100) / 100;
  var numStr = String(num);

  var target = input.connection.targetBlock();

  // Empty input or shadow number → write via shadow state (reliable in Blockly 9+)
  if (!target || (target.type === 'math_number' && target.isShadow && target.isShadow())) {
    if (typeof setNumberShadow === 'function') {
      setNumberShadow(input.connection, num);
      try {
        if (typeof block.render === 'function') block.render(false);
      } catch (eR0) { /* ignore */ }
      return true;
    }
  }

  if (target && target.type === 'math_number') {
    var field = target.getField('NUM');
    if (field && typeof field.setValue === 'function') {
      field.setValue(numStr);
    } else {
      target.setFieldValue(numStr, 'NUM');
    }
    try {
      if (typeof target.render === 'function') target.render(false);
      if (typeof block.render === 'function') block.render(false);
    } catch (eR) { /* ignore */ }
    return true;
  }

  if (!target) {
    var ws = block.workspace;
    var numBlock = ws.newBlock('math_number');
    numBlock.setFieldValue(numStr, 'NUM');
    numBlock.initSvg();
    numBlock.render();
    input.connection.connect(numBlock.outputConnection);
    return true;
  }

  // Connected expression (variable, math op, etc.) — don't overwrite
  console.log('[Debug] Skip axis', axisKey, '— non-number input:', target.type);
  return false;
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
 * Called by the control panel BEFORE a jog / absolute move is sent.
 * Captures baseline pose (once) and marks that a teach update is pending.
 * Actual block write happens when status arrives (debugOnRobotStatus) or
 * as a fallback debounce / next Step flush.
 */
async function debugNotifyJog() {
  console.log('[Debug] debugNotifyJog called. active:', _debugActive,
    'lastMoveBlock:', _debugLastMoveBlockId,
    'jogged:', _debugJoggedSinceStep,
    'beforeJogPos:', !!_debugBeforeJogPosition);

  if (!_debugActive || !_debugLastMoveBlockId) return;

  // Ensure baseline pose before this jog (after-move settle, or first capture)
  if (!_debugBeforeJogPosition) {
    // Brief settle so post-move auto-status is available
    await new Promise(function(r) { setTimeout(r, 150); });
    var pose = await _fetchRobotPose();
    if (pose) {
      _debugBeforeJogPosition = pose;
      console.log('[Debug] Captured before-jog position:', _debugBeforeJogPosition);
    } else {
      console.warn('[Debug] Failed to capture before-jog position');
    }
  }

  if (!_debugTeachBaselineBlockValues) {
    var workspace = getWorkspace ? getWorkspace() : null;
    var block = workspace && _debugLastMoveBlockId
      ? workspace.getBlockById(_debugLastMoveBlockId) : null;
    if (block) _debugTeachBaselineBlockValues = _snapshotAxisValues(block);
  }

  _debugJoggedSinceStep = true;

  // Fallback: if status-driven apply never fires (no poll / dry-run), try later
  if (_debugTeachApplyTimer) clearTimeout(_debugTeachApplyTimer);
  _debugTeachApplyTimer = setTimeout(function() {
    _debugTeachApplyTimer = null;
    if (!_debugActive || !_debugJoggedSinceStep || !_debugLastMoveBlockId) return;
    _updateMoveBlockFromJog({ keepTracking: true }).catch(function(e) {
      console.warn('[Debug] Fallback teach apply failed:', e);
    });
  }, 900);
}

// Expose globally for control panel to call
window.debugNotifyJog = debugNotifyJog;
window.debugOnRobotStatus = debugOnRobotStatus;

function _escapeHtml(str) {
  var div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}


