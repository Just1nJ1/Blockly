/**
 * Code Preview Module
 * Handles updating the Python code preview panel.
 */

var TEXT_COPY_PANELS = '#code-preview, #console-log, #debug-variables, #debug-callstack';

/** Element that owns a DOM node when it sits in the code panel or console. */
function textPanelFromNode(node) {
  if (!node) return null;
  var el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || typeof el.closest !== 'function') return null;
  return el.closest(TEXT_COPY_PANELS);
}

function _selectionInTextPanel() {
  if (typeof window === 'undefined' || !window.getSelection) return null;
  var selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  return textPanelFromNode(selection.anchorNode);
}

/**
 * Cmd/Ctrl+C and Cmd/Ctrl+A inside the code panel or console copy that text.
 * Block copy must not take the shortcut while a selection is there.
 */
function enableCodeTextCopy() {
  if (typeof document === 'undefined') return;
  document.addEventListener('keydown', function(e) {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
    var key = e.key;
    if (key !== 'c' && key !== 'C' && key !== 'a' && key !== 'A') return;
    var panel = _selectionInTextPanel();
    if (!panel) return;
    var selection = window.getSelection();
    if ((key === 'c' || key === 'C') && (!selection || selection.isCollapsed)) return;
    if (key === 'a' || key === 'A') {
      e.preventDefault();
      var range = document.createRange();
      range.selectNodeContents(panel);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    e.stopImmediatePropagation();
  }, true);

  var button = document.getElementById('copy-code-btn');
  if (button && !button._copyBound) {
    button._copyBound = true;
    button.addEventListener('click', copyGeneratedCode);
  }
}

function copyGeneratedCode() {
  var preview = document.getElementById('code-preview');
  var text = preview ? (preview.textContent || '') : '';
  var button = document.getElementById('copy-code-btn');
  if (!text) return;
  function done() {
    if (!button) return;
    var previous = button.textContent;
    button.textContent = 'Copied';
    setTimeout(function() { button.textContent = previous; }, 1200);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(function() {
      if (_fallbackCopy(text)) done();
    });
    return;
  }
  if (_fallbackCopy(text)) done();
}

function _fallbackCopy(text) {
  var area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.left = '-9999px';
  document.body.appendChild(area);
  area.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  area.remove();
  return ok;
}

/**
 * Update the code preview panel with the current workspace code.
 * This is called whenever blocks change in the workspace.
 */
function updateCodePreview() {
  var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
  try {
    var code = '';
    if (workspace && window.ExtensionPython && typeof window.ExtensionPython.generate === 'function') {
      code = window.ExtensionPython.generate(workspace, { target: 'portable', purpose: 'export' });
    } else if (workspace && window.Blockly && Blockly.Python) {
      code = Blockly.Python.workspaceToCode(workspace);
    }
    var previewElement = document.getElementById('code-preview');
    if (previewElement && previewElement.textContent !== code) {
      previewElement.textContent = code;
    }
  } catch (error) {
    console.error('Failed to generate code preview:', error);
  }
  if (typeof window.updateRobotTabs === 'function') window.updateRobotTabs();
  if (typeof window.scheduleRecordedMovesRefresh === 'function') {
    window.scheduleRecordedMovesRefresh(400);
  }
}

enableCodeTextCopy();

if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
  module.exports = { textPanelFromNode: textPanelFromNode };
}
