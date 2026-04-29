/**
 * Block Area Selection Module
 * Hold Cmd/Ctrl + drag to select multiple blocks in a rectangular area.
 * Partially overlapping blocks are also selected.
 *
 * Uses an invisible overlay div on top of the Blockly SVG to intercept
 * mouse events before Blockly's gesture system can capture them.
 */

(function() {
  var _selecting = false;
  var _startX = 0;
  var _startY = 0;
  var _rectEl = null;
  var _selectedBlocks = [];
  var _overlay = null;

  function initBlockSelection() {
    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) return;

    var blocklyDiv = document.getElementById('blocklyDiv');
    var svgEl = ws.getParentSvg();
    if (!blocklyDiv || !svgEl) return;

    // Create an invisible overlay that sits on top of blocklyDiv
    // It only becomes active (pointer-events: auto) when Cmd/Ctrl is held
    _overlay = document.createElement('div');
    _overlay.className = 'blockly-selection-overlay';
    blocklyDiv.style.position = 'relative';
    blocklyDiv.appendChild(_overlay);

    // Track Cmd/Ctrl key state to enable/disable the overlay for area selection
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && _overlay) {
        _overlay.style.pointerEvents = 'auto';
        _overlay.style.cursor = 'crosshair';
      }
    });
    document.addEventListener('keyup', function(e) {
      if (!e.metaKey && !e.ctrlKey && _overlay && !_selecting) {
        if (_dragOverlayActive) {
          // Keep overlay active for group drag, restore grab cursor
          _overlay.style.cursor = 'grab';
        } else {
          _overlay.style.pointerEvents = 'none';
        }
      }
    });

    // Mouse down on overlay: start area selection (only with Cmd/Ctrl)
    _overlay.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      if (!(e.metaKey || e.ctrlKey)) return;  // area selection requires modifier
      e.preventDefault();
      e.stopPropagation();

      _selecting = true;  // set BEFORE clearSelection so overlay stays active
      clearSelection();

      var point = svgToWorkspaceCoords(svgEl, e, ws);
      _startX = point.x;
      _startY = point.y;

      // Create selection rectangle in workspace canvas
      var canvas = ws.getCanvas();
      _rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      _rectEl.setAttribute('class', 'blockly-selection-rect');
      _rectEl.setAttribute('x', _startX);
      _rectEl.setAttribute('y', _startY);
      _rectEl.setAttribute('width', 0);
      _rectEl.setAttribute('height', 0);
      canvas.appendChild(_rectEl);
    });

    // Mouse move: update rectangle
    _overlay.addEventListener('mousemove', function(e) {
      if (!_selecting || !_rectEl) return;
      e.preventDefault();

      var point = svgToWorkspaceCoords(svgEl, e, ws);
      var x = Math.min(_startX, point.x);
      var y = Math.min(_startY, point.y);
      var w = Math.abs(point.x - _startX);
      var h = Math.abs(point.y - _startY);

      _rectEl.setAttribute('x', x);
      _rectEl.setAttribute('y', y);
      _rectEl.setAttribute('width', w);
      _rectEl.setAttribute('height', h);
    });

    // Mouse up: finish selection
    _overlay.addEventListener('mouseup', function(e) {
      if (!_selecting) return;
      e.preventDefault();

      var point = svgToWorkspaceCoords(svgEl, e, ws);
      var selRect = {
        left: Math.min(_startX, point.x),
        top: Math.min(_startY, point.y),
        right: Math.max(_startX, point.x),
        bottom: Math.max(_startY, point.y)
      };

      // Remove selection rectangle
      if (_rectEl && _rectEl.parentNode) {
        _rectEl.parentNode.removeChild(_rectEl);
      }
      _rectEl = null;
      _selecting = false;

      // Disable overlay
      _overlay.style.pointerEvents = 'none';

      // Skip tiny drags
      if ((selRect.right - selRect.left) < 5 && (selRect.bottom - selRect.top) < 5) {
        return;
      }

      // Find intersecting blocks (checks each block's own bounds)
      _selectedBlocks = [];
      findBlocksInRect(ws, selRect);

      console.log('[Selection] Selected', _selectedBlocks.length, 'blocks');

      // Enable drag overlay so group drag works
      _enableDragOverlay();
    });

    // Clear selection on any workspace click without modifier
    // (but not during/right after a group drag)
    var _dragJustFinished = false;
    ws.addChangeListener(function(event) {
      if (event.type === Blockly.Events.CLICK && _selectedBlocks.length > 0) {
        if (_dragJustFinished) {
          _dragJustFinished = false;
          return;
        }
        if (!_dragOverlayActive) {
          clearSelection();
        }
      }
    });

    // Delete selected blocks on Delete/Backspace, Copy/Paste
    document.addEventListener('keydown', function(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      if (_selectedBlocks.length > 0) {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          deleteSelectedBlocks(ws);
        } else if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
          e.preventDefault();
          copySelectedBlocks(ws);
        }
      }

      if ((e.metaKey || e.ctrlKey) && e.key === 'v' && _clipboard.length > 0) {
        e.preventDefault();
        pasteBlocks(ws);
      }

      // Cmd/Ctrl+Shift+Enter: run selected blocks
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'Enter') {
        e.preventDefault();
        runSelectedBlocks();
      }

      // Cmd/Ctrl+Z: undo (ensure it works even when overlay is active)
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        ws.undo(false);
      }

      // Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y: redo
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        ws.undo(true);
      }
    });

    // Group drag: use overlay to intercept mouse before Blockly.
    // On drag start: disconnect selected from non-selected, save internal connections.
    // During drag: move all blocks. On drop: reconnect internal connections.
    var _dragStartPos = null;
    var _dragBlocks = null;
    var _dragOrigPositions = null;
    var _dragSavedConnections = [];
    var _dragStarted = false;
    var _dragThreshold = 3;
    var _dragOverlayActive = false;

    // After selection, enable overlay so we intercept clicks on selected blocks
    function _enableDragOverlay() {
      if (_selectedBlocks.length > 0) {
        _overlay.style.pointerEvents = 'auto';
        _overlay.style.cursor = 'grab';
        _dragOverlayActive = true;
      }
    }

    function _disableDragOverlay() {
      _dragOverlayActive = false;
      if (!_selecting) {
        _overlay.style.pointerEvents = 'none';
        _overlay.style.cursor = 'crosshair';
      }
    }

    // Hook into selection completion
    var _origClearSelection = clearSelection;
    clearSelection = function() {
      _origClearSelection();
      _disableDragOverlay();
    };

    // Override the mouseup in area selection to enable drag overlay after selecting
    // (we'll call _enableDragOverlay from the area selection mouseup)

    // Overlay mousedown: check if on a selected block, start group drag
    _overlay.addEventListener('mousedown', function(e) {
      if (e.metaKey || e.ctrlKey) return;  // area selection mode
      if (_selectedBlocks.length < 2) return;
      if (e.button !== 0) return;
      if (!_dragOverlayActive) return;

      // Hit-test: temporarily hide overlay to find element below
      _overlay.style.pointerEvents = 'none';
      var elBelow = document.elementFromPoint(e.clientX, e.clientY);
      _overlay.style.pointerEvents = 'auto';

      // Walk up to find if it's a selected block
      var isOnSelected = false;
      var el = elBelow;
      while (el && el !== svgEl) {
        if (el.classList && el.classList.contains('blockly-selected-multi')) {
          isOnSelected = true;
          break;
        }
        el = el.parentNode;
      }

      if (!isOnSelected) {
        // Clicked empty space — deselect
        clearSelection();
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      _dragStartPos = { x: e.clientX, y: e.clientY };
      _dragStarted = false;
      _overlay.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', function(e) {
      if (!_dragStartPos) return;

      var dx = e.clientX - _dragStartPos.x;
      var dy = e.clientY - _dragStartPos.y;

      if (!_dragStarted) {
        if (Math.abs(dx) < _dragThreshold && Math.abs(dy) < _dragThreshold) return;
        _dragStarted = true;
        _prepareDrag(ws);
      }

      e.preventDefault();

      var scale = ws.getScale();
      var wsDx = dx / scale;
      var wsDy = dy / scale;

      Blockly.Events.disable();
      for (var i = 0; i < _dragBlocks.length; i++) {
        var b = _dragBlocks[i];
        if (b.isDisposed() || b.getParent()) continue;  // skip child blocks
        var orig = _dragOrigPositions[i];
        b.moveTo(new Blockly.utils.Coordinate(orig.x + wsDx, orig.y + wsDy));
      }
      Blockly.Events.enable();
    });

    document.addEventListener('mouseup', function() {
      if (!_dragStartPos) return;

      if (_dragStarted) {
        _finishDrag(ws);
        _dragJustFinished = true;
        // Reset after a tick so the next real click can clear selection
        setTimeout(function() { _dragJustFinished = false; }, 100);
      }

      _dragStartPos = null;
      _dragBlocks = null;
      _dragOrigPositions = null;
      _dragSavedConnections = [];
      _dragStarted = false;
      if (_dragOverlayActive) {
        _overlay.style.cursor = 'grab';
      }
    });

    function _prepareDrag(ws) {
      var selectedSet = new Set(_selectedBlocks.map(function(b) { return b.id; }));
      _dragSavedConnections = [];

      // Group all disconnect/move events together for undo
      Blockly.Events.setGroup(true);

      // First pass: disconnect all external connections (selected ↔ non-selected)
      for (var i = 0; i < _selectedBlocks.length; i++) {
        var block = _selectedBlocks[i];

        if (block.previousConnection && block.previousConnection.targetConnection) {
          var above = block.previousConnection.targetBlock();
          if (above && !selectedSet.has(above.id)) {
            block.previousConnection.disconnect();
          }
        }

        if (block.nextConnection && block.nextConnection.targetConnection) {
          var below = block.nextConnection.targetBlock();
          if (below && !selectedSet.has(below.id)) {
            block.nextConnection.disconnect();
          }
        }
      }

      // Second pass: save and disconnect internal connections
      for (var j = 0; j < _selectedBlocks.length; j++) {
        var b = _selectedBlocks[j];
        if (b.nextConnection && b.nextConnection.targetConnection) {
          var nextBlock = b.nextConnection.targetBlock();
          if (nextBlock && selectedSet.has(nextBlock.id)) {
            _dragSavedConnections.push({ fromId: b.id, toId: nextBlock.id });
            b.nextConnection.disconnect();
          }
        }
      }

      // Record positions
      _dragBlocks = _selectedBlocks.slice();
      _dragOrigPositions = [];
      for (var k = 0; k < _dragBlocks.length; k++) {
        _dragOrigPositions.push(_dragBlocks[k].getRelativeToSurfaceXY());
      }

      // Disable events for the continuous mousemove updates
      Blockly.Events.disable();
    }

    function _finishDrag(ws) {
      // Re-enable events so final positions and reconnections are recorded
      Blockly.Events.enable();

      // Fire move events for each top-level block's final position
      for (var j = 0; j < _dragBlocks.length; j++) {
        var block = _dragBlocks[j];
        if (block.isDisposed() || block.getParent()) continue;
        var newPos = block.getRelativeToSurfaceXY();
        var oldPos = _dragOrigPositions[j];
        if (newPos.x !== oldPos.x || newPos.y !== oldPos.y) {
          var moveEvent = new Blockly.Events.BlockMove(block);
          moveEvent.oldCoordinate = oldPos;
          moveEvent.newCoordinate = newPos;
          Blockly.Events.fire(moveEvent);
        }
      }

      // Reconnect internal connections (events fire for undo)
      for (var i = 0; i < _dragSavedConnections.length; i++) {
        var conn = _dragSavedConnections[i];
        var fromBlock = ws.getBlockById(conn.fromId);
        var toBlock = ws.getBlockById(conn.toId);
        if (fromBlock && toBlock && fromBlock.nextConnection && toBlock.previousConnection) {
          fromBlock.nextConnection.connect(toBlock.previousConnection);
        }
      }

      // End the event group (all disconnect + move + reconnect = one undo step)
      Blockly.Events.setGroup(false);
    }

    _trackNativeSelection();
    console.log('[Selection] Block area selection initialized');
  }

  function findBlocksInRect(ws, selRect) {
    // Check ALL blocks in the workspace (not just top blocks)
    var allBlocks = ws.getAllBlocks(false);
    for (var i = 0; i < allBlocks.length; i++) {
      var block = allBlocks[i];
      if (block.isInsertionMarker()) continue;

      var blockRect = getOwnBlockRect(block);
      if (!blockRect) continue;

      if (rectsIntersect(selRect, blockRect)) {
        if (_selectedBlocks.indexOf(block) === -1) {
          _selectedBlocks.push(block);
          highlightBlock(block, true);
        }
      }
    }
  }

  function getOwnBlockRect(block) {
    // Get only THIS block's visual bounds, not including children.
    // Use the block's .pathObject or first .blocklyPath element.
    var svgRoot = block.getSvgRoot();
    if (!svgRoot) return null;

    var pathEl = svgRoot.querySelector(':scope > .blocklyPath');
    if (!pathEl) return null;

    var bbox = pathEl.getBBox();
    var xy = block.getRelativeToSurfaceXY();

    return {
      left: xy.x + bbox.x,
      top: xy.y + bbox.y,
      right: xy.x + bbox.x + bbox.width,
      bottom: xy.y + bbox.y + bbox.height
    };
  }

  function rectsIntersect(a, b) {
    return !(a.right < b.left || a.left > b.right ||
             a.bottom < b.top || a.top > b.bottom);
  }

  function svgToWorkspaceCoords(svgEl, mouseEvent, ws) {
    var svgPoint = svgEl.createSVGPoint();
    svgPoint.x = mouseEvent.clientX;
    svgPoint.y = mouseEvent.clientY;

    // Transform screen coords to SVG coords
    var ctm = svgEl.getScreenCTM().inverse();
    var svgCoord = svgPoint.matrixTransform(ctm);

    // Account for workspace scroll and scale
    var metrics = ws.getMetrics();
    var scale = ws.getScale();

    return {
      x: (svgCoord.x - metrics.absoluteLeft) / scale + metrics.viewLeft,
      y: (svgCoord.y - metrics.absoluteTop) / scale + metrics.viewTop
    };
  }

  function highlightBlock(block, selected) {
    var svg = block.getSvgRoot();
    if (!svg) return;
    if (selected) {
      svg.classList.add('blockly-selected-multi');
    } else {
      svg.classList.remove('blockly-selected-multi');
    }
  }

  function clearSelection() {
    for (var i = 0; i < _selectedBlocks.length; i++) {
      highlightBlock(_selectedBlocks[i], false);
    }
    _selectedBlocks = [];
  }

  function deleteSelectedBlocks(ws) {
    // Collect block IDs first (disposing changes the list)
    var ids = _selectedBlocks.map(function(b) { return b.id; });
    clearSelection();

    Blockly.Events.setGroup(true);
    for (var i = 0; i < ids.length; i++) {
      var block = ws.getBlockById(ids[i]);
      if (block && !block.isDisposed()) {
        block.dispose(true, true);
      }
    }
    Blockly.Events.setGroup(false);
    console.log('[Selection] Deleted', ids.length, 'blocks');
  }

  // ── Clipboard ──

  var _clipboard = [];  // array of XML strings

  function copySelectedBlocks(ws) {
    _clipboard = [];
    for (var i = 0; i < _selectedBlocks.length; i++) {
      var block = _selectedBlocks[i];
      if (block.isDisposed()) continue;

      // Temporarily disconnect the next block so we only copy THIS block
      // (and its value inputs), not the entire stack below it.
      var nextBlock = block.getNextBlock();
      var nextConn = block.nextConnection;
      if (nextBlock && nextConn && nextConn.targetConnection) {
        nextConn.disconnect();
      }

      var xml = Blockly.Xml.blockToDom(block);
      _clipboard.push(Blockly.Xml.domToText(xml));

      // Reconnect
      if (nextBlock && nextConn && nextBlock.previousConnection) {
        nextConn.connect(nextBlock.previousConnection);
      }
    }
    console.log('[Selection] Copied', _clipboard.length, 'blocks to clipboard');
  }

  function pasteBlocks(ws) {
    if (_clipboard.length === 0) return;

    clearSelection();

    // Disable events entirely during paste to prevent any feedback loops
    Blockly.Events.disable();

    var pastedBlocks = [];
    var offset = 30;
    for (var i = 0; i < _clipboard.length; i++) {
      try {
        var xmlDom = Blockly.utils.xml.textToDom(_clipboard[i]);
        var block = Blockly.Xml.domToBlock(xmlDom, ws);
        pastedBlocks.push(block);
      } catch (e) {
        console.warn('[Selection] Failed to paste block:', e);
      }
    }

    // Connect blocks in order via next/previous connections
    for (var k = 1; k < pastedBlocks.length; k++) {
      var prev = pastedBlocks[k - 1];
      var curr = pastedBlocks[k];
      if (prev.nextConnection && curr.previousConnection) {
        prev.nextConnection.connect(curr.previousConnection);
      }
    }

    // Move the first block (the rest follow since they're connected)
    if (pastedBlocks.length > 0) {
      pastedBlocks[0].moveBy(offset, offset);
    }

    Blockly.Events.enable();

    // Highlight pasted blocks
    for (var j = 0; j < pastedBlocks.length; j++) {
      _selectedBlocks.push(pastedBlocks[j]);
      highlightBlock(pastedBlocks[j], true);
    }

    console.log('[Selection] Pasted', pastedBlocks.length, 'blocks');
  }

  function _isInOrIsFunction(block) {
    var current = block;
    while (current) {
      if (current.type === 'procedures_defnoreturn' || current.type === 'procedures_defreturn') {
        return true;
      }
      current = current.getSurroundParent();
    }
    return false;
  }

  // ── Run selected blocks ──

  // Track the last Blockly-selected block so we can use it even after
  // clicking a toolbar button deselects it.
  var _lastNativeSelected = null;

  function _trackNativeSelection() {
    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) return;
    ws.addChangeListener(function(event) {
      if (event.type === Blockly.Events.SELECTED) {
        if (event.newElementId) {
          _lastNativeSelected = ws.getBlockById(event.newElementId);
        }
        // Don't clear on deselect — keep the last one
      }
    });
  }

  function getBlocksToRun() {
    // Use area-selected blocks if any
    if (_selectedBlocks.length > 0) {
      return _selectedBlocks.slice();
    }
    // Try current Blockly selection
    var selected = null;
    try {
      if (typeof Blockly !== 'undefined') {
        selected = Blockly.getSelected ? Blockly.getSelected() :
                   (Blockly.common && Blockly.common.getSelected ? Blockly.common.getSelected() : null);
      }
    } catch (e) {}
    if (selected) return [selected];
    // Fall back to last known selection (survives toolbar button clicks)
    if (_lastNativeSelected && !_lastNativeSelected.isDisposed()) {
      return [_lastNativeSelected];
    }
    return [];
  }

  async function runSelectedBlocks() {
    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) return;

    var blocks = getBlocksToRun();
    if (blocks.length === 0) {
      appendOutput('No blocks selected to run.', 'error');
      return;
    }

    // Generate full workspace code first to get all imports and function defs
    var fullWsCode = Blockly.Python.workspaceToCode(ws);

    // Extract imports and function definitions from the full code
    var wsLines = fullWsCode.split('\n');
    var preambleLines = [];
    var inFuncDef = false;
    var funcDefIndent = 0;
    for (var li = 0; li < wsLines.length; li++) {
      var line = wsLines[li];
      var trimmed = line.trim();

      if (inFuncDef) {
        preambleLines.push(line);
        var lineIndent = line.search(/\S/);
        if (trimmed.length > 0 && lineIndent <= funcDefIndent) {
          inFuncDef = false;
        }
        continue;
      }

      if (trimmed.match(/^(import\s+|from\s+\S+\s+import\s+)/)) {
        preambleLines.push(line);
      } else if (trimmed.match(/^def\s+\w+\s*\(/)) {
        inFuncDef = true;
        funcDefIndent = line.search(/\S/);
        preambleLines.push(line);
      } else if (trimmed.startsWith('#')) {
        preambleLines.push(line);
      }
    }

    // Sort selected blocks by vertical position (top to bottom)
    // Connected blocks stay in their connection order
    var sortedBlocks = blocks.slice().sort(function(a, b) {
      var posA = a.getRelativeToSurfaceXY();
      var posB = b.getRelativeToSurfaceXY();
      return posA.y - posB.y;
    });

    // Deduplicate: if a block is connected below another selected block,
    // it will be reached via the connection — skip it in the sorted list
    var selectedSet = new Set(blocks.map(function(b) { return b.id; }));
    var processedIds = new Set();

    // Re-init for generating selected block code
    Blockly.Python.init(ws);

    var blockCodeParts = [];
    for (var i = 0; i < sortedBlocks.length; i++) {
      var block = sortedBlocks[i];
      if (block.isDisposed() || !block.isEnabled()) continue;
      if (processedIds.has(block.id)) continue;

      // Skip function definitions and anything inside them —
      // all function defs are always included in the preamble
      if (_isInOrIsFunction(block)) continue;

      // Walk the chain of connected selected blocks from this one
      var chainBlock = block;
      while (chainBlock) {
        if (processedIds.has(chainBlock.id)) break;
        if (!selectedSet.has(chainBlock.id)) break;
        processedIds.add(chainBlock.id);

        // Temporarily disconnect next to get only this block's code
        var nextBlock = chainBlock.getNextBlock();
        var nextConn = chainBlock.nextConnection;
        if (nextBlock && nextConn && nextConn.targetConnection) {
          nextConn.disconnect();
        }

        var code = Blockly.Python.blockToCode(chainBlock);
        if (Array.isArray(code)) {
          code = code[0] + '\n';
        }

        // Reconnect
        if (nextBlock && nextConn && nextBlock.previousConnection) {
          nextConn.connect(nextBlock.previousConnection);
        }

        if (code && code.trim()) {
          blockCodeParts.push(code);
        }

        // Follow the chain to the next connected selected block
        chainBlock = nextBlock && selectedSet.has(nextBlock.id) ? nextBlock : null;
      }
    }

    if (blockCodeParts.length === 0) {
      appendOutput('Selected blocks produce no code.', 'error');
      return;
    }

    // Combine: preamble (imports + function defs) + selected block code
    var fullCode = '';
    if (preambleLines.length > 0) {
      fullCode = preambleLines.join('\n') + '\n\n';
    }
    fullCode += blockCodeParts.join('');

    console.log('[Selection] Running selected code:\n' + fullCode);

    // Show in output panel
    var outputContent = document.getElementById('output-content');
    if (outputContent) outputContent.innerHTML = '';

    var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
    try {
      var response = await fetch(serverUrl + '/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: fullCode }),
        signal: AbortSignal.timeout(30000)
      });

      var result = await response.json();
      if (result.success) {
        if (result.stdout) appendOutput(result.stdout, 'stdout');
        if (result.result) appendOutput('Result: ' + result.result, 'result');
        if (result.stderr) appendOutput(result.stderr, 'stderr');
      } else {
        appendOutput('Error: ' + result.error, 'error');
        if (result.traceback) appendOutput(result.traceback, 'stderr');
      }
    } catch (error) {
      appendOutput('Connection Error: ' + error.message, 'error');
    }

    // Mark control panel as stale
    if (typeof window.controlPanelMarkStale === 'function') {
      window.controlPanelMarkStale();
    }
  }

  // Expose
  window.clearBlockSelection = clearSelection;
  window.initBlockSelection = initBlockSelection;
  window.runSelectedBlocks = runSelectedBlocks;
})();