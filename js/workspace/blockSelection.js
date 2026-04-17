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

    // Track Cmd/Ctrl key state to enable/disable the overlay
    document.addEventListener('keydown', function(e) {
      if ((e.metaKey || e.ctrlKey) && _overlay) {
        _overlay.style.pointerEvents = 'auto';
      }
    });
    document.addEventListener('keyup', function(e) {
      if (!e.metaKey && !e.ctrlKey && _overlay && !_selecting) {
        _overlay.style.pointerEvents = 'none';
      }
    });

    // Mouse down on overlay: start selection
    _overlay.addEventListener('mousedown', function(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

      clearSelection();

      var point = svgToWorkspaceCoords(svgEl, e, ws);
      _startX = point.x;
      _startY = point.y;
      _selecting = true;

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
    });

    // Clear selection on any workspace click without modifier
    ws.addChangeListener(function(event) {
      if (event.type === Blockly.Events.CLICK && _selectedBlocks.length > 0) {
        clearSelection();
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
    });

    // Group drag: show overlay when blocks are selected so we can
    // intercept drag on selected blocks before Blockly does.
    var _dragStartPos = null;
    var _dragRoots = null;
    var _dragOrigPositions = null;

    svgEl.addEventListener('mousedown', function(e) {
      if (e.metaKey || e.ctrlKey) return;  // selection mode
      if (_selectedBlocks.length < 2) return;
      if (e.button !== 0) return;

      // Check if the click is on a selected block
      var target = e.target;
      while (target && target !== svgEl) {
        if (target.classList && target.classList.contains('blockly-selected-multi')) {
          // Starting a group drag
          e.preventDefault();
          e.stopPropagation();

          _dragStartPos = { x: e.clientX, y: e.clientY };

          // Collect unique roots of selected blocks
          var rootMap = {};
          for (var i = 0; i < _selectedBlocks.length; i++) {
            var root = _selectedBlocks[i].getRootBlock();
            if (!rootMap[root.id]) {
              rootMap[root.id] = root;
            }
          }
          _dragRoots = [];
          _dragOrigPositions = [];
          for (var id in rootMap) {
            _dragRoots.push(rootMap[id]);
            _dragOrigPositions.push(rootMap[id].getRelativeToSurfaceXY());
          }
          return;
        }
        target = target.parentNode;
      }
    }, true);

    document.addEventListener('mousemove', function(e) {
      if (!_dragStartPos || !_dragRoots) return;
      e.preventDefault();

      var scale = ws.getScale();
      var dx = (e.clientX - _dragStartPos.x) / scale;
      var dy = (e.clientY - _dragStartPos.y) / scale;

      Blockly.Events.disable();
      for (var i = 0; i < _dragRoots.length; i++) {
        var orig = _dragOrigPositions[i];
        _dragRoots[i].moveTo(new Blockly.utils.Coordinate(orig.x + dx, orig.y + dy));
      }
      Blockly.Events.enable();
    });

    document.addEventListener('mouseup', function(e) {
      if (!_dragStartPos) return;
      _dragStartPos = null;
      _dragRoots = null;
      _dragOrigPositions = null;
    });

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

  // ── Run selected blocks ──

  function getBlocksToRun() {
    // Use area-selected blocks if any, otherwise Blockly's single selected block
    if (_selectedBlocks.length > 0) {
      return _selectedBlocks.slice();
    }
    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) return [];
    var selected = Blockly.getSelected ? Blockly.getSelected() : Blockly.common.getSelected();
    if (selected) return [selected];
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

    // Generate code: first get full workspace code to populate definitions_
    // (imports, function defs), then extract code for selected blocks only.
    Blockly.Python.init(ws);

    var blockCodeParts = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      if (block.isDisposed() || !block.isEnabled()) continue;

      var code = Blockly.Python.blockToCode(block);
      if (Array.isArray(code)) {
        // Expression block — wrap in statement
        code = code[0] + '\n';
      }
      if (code && code.trim()) {
        blockCodeParts.push(code);
      }
    }

    if (blockCodeParts.length === 0) {
      appendOutput('Selected blocks produce no code.', 'error');
      return;
    }

    // Collect definitions (imports, function defs) that were registered
    var defs = Blockly.Python.definitions_;
    var defLines = [];
    if (defs) {
      for (var key in defs) {
        defLines.push(defs[key]);
      }
    }

    var fullCode = '';
    if (defLines.length > 0) {
      fullCode = defLines.join('\n') + '\n\n';
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