/**
 * Export G-code from Blockly via a server-side dry-run.
 *
 * Requires exactly one setup_robot block. Records every G-code line the
 * wlkatapython library would send; time.sleep becomes G4 P{seconds}.
 *
 * Limitations (shown in the button tooltip):
 *  - Only G-code is recorded (not if-branch logic as structure, external libs, etc.)
 *  - Branches that depend on sensors / robot status may not take the real path
 */

var _GCODE_WARN =
  'Exports only G-code from a dry-run of this program. ' +
  'If/else branches, sensor conditions, and external libraries are not fully recorded — ' +
  'only the G-code actually emitted is saved. Delays (sleep) become G4 P{seconds}.';

var _gcodeExportBusy = false;

/**
 * Count setup_robot blocks on the current workspace.
 * @returns {number}
 */
function countSetupRobotBlocks() {
  var workspace = typeof getWorkspace === 'function' ? getWorkspace() : null;
  if (!workspace || typeof workspace.getBlocksByType !== 'function') return 0;
  try {
    return workspace.getBlocksByType('setup_robot', false).length;
  } catch (e) {
    return 0;
  }
}

/**
 * Enable/disable the G-code export button and set an accurate hover title.
 */
function updateGcodeExportButton() {
  var btn = document.getElementById('exportGcodeBtn');
  if (!btn) return;

  // While stepping, keep the slot but disable (step mode may also hide it via CSS)
  var inStep =
    (typeof window !== 'undefined' && window._debugActive === true) ||
    (document.getElementById('toolbar') &&
      document.getElementById('toolbar').classList.contains('step-mode'));

  if (_gcodeExportBusy) {
    btn.disabled = true;
    btn.title = 'Exporting G-code…';
    return;
  }

  if (inStep) {
    btn.disabled = true;
    btn.title = 'Unavailable while stepping.\n\n' + _GCODE_WARN;
    return;
  }

  var n = countSetupRobotBlocks();
  if (n === 0) {
    btn.disabled = true;
    btn.title =
      'Disabled: add exactly one Setup Robot block before exporting G-code.\n\n' +
      _GCODE_WARN;
    return;
  }
  if (n > 1) {
    btn.disabled = true;
    btn.title =
      'Disabled: G-code export supports only one robot (found ' +
      n +
      ' Setup Robot blocks).\n\n' +
      _GCODE_WARN;
    return;
  }

  btn.disabled = false;
  btn.title = 'Export G-code file\n\n' + _GCODE_WARN;
}

/**
 * Run dry-run export and download a .gcode file.
 */
async function exportGcode() {
  var btn = document.getElementById('exportGcodeBtn');
  var n = countSetupRobotBlocks();
  if (n !== 1) {
    updateGcodeExportButton();
    if (typeof appendOutput === 'function') {
      appendOutput(
        n === 0
          ? 'G-code export: add exactly one Setup Robot block.'
          : 'G-code export: only one Setup Robot block is supported (found ' + n + ').',
        'error'
      );
    }
    return;
  }

  var workspace = typeof getWorkspace === 'function' ? getWorkspace() : null;
  if (!workspace || typeof Blockly === 'undefined' || !Blockly.Python) {
    if (typeof appendOutput === 'function') {
      appendOutput('G-code export: workspace not ready.', 'error');
    }
    return;
  }

  var code;
  try {
    code = Blockly.Python.workspaceToCode(workspace);
  } catch (e) {
    if (typeof appendOutput === 'function') {
      appendOutput('G-code export: failed to generate Python — ' + e, 'error');
    }
    return;
  }

  if (!code || !String(code).trim()) {
    if (typeof appendOutput === 'function') {
      appendOutput('G-code export: no code to export.', 'error');
    }
    return;
  }

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : '';
  if (!serverUrl) {
    if (typeof appendOutput === 'function') {
      appendOutput('G-code export: server URL not configured.', 'error');
    }
    return;
  }

  _gcodeExportBusy = true;
  updateGcodeExportButton();
  if (btn && typeof setToolbarBtnLabel === 'function') {
    setToolbarBtnLabel(btn, '…');
  }

  try {
    if (typeof appendOutput === 'function') {
      appendOutput('Exporting G-code (dry-run)…', 'system');
    }

    var response = await fetch(serverUrl + '/export-gcode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, timeout: 10.0 }),
    });
    var result = await response.json();

    if (!result || result.success === false) {
      var err = (result && result.error) || 'Export failed';
      if (typeof appendOutput === 'function') {
        appendOutput('G-code export failed: ' + err, 'error');
        if (result && result.traceback) {
          appendOutput(result.traceback, 'stderr');
        }
      }
      return;
    }

    var lines = result.lines || [];
    if (result.error && lines.length) {
      if (typeof appendOutput === 'function') {
        appendOutput(
          'G-code export finished with warnings: ' + result.error +
            ' (' + lines.length + ' lines captured)',
          'result'
        );
      }
    }

    if (!lines.length) {
      if (typeof appendOutput === 'function') {
        appendOutput(
          'G-code export: no G-code was emitted. ' +
            'Use robot motion / accessory blocks (if/else and external libraries may produce nothing).',
          'result'
        );
      }
      return;
    }

    var header =
      '; StudioX G-code export\n' +
      '; Lines: ' + lines.length + '\n' +
      '; Note: only G-code from dry-run; branches/sensors/external libs may be incomplete\n';
    var body = result.gcode || lines.join('\n') + '\n';
    var text = header + body;

    var filename = 'program.gcode';
    try {
      var label = document.getElementById('workspace-name-label');
      if (label && label.textContent && label.textContent.trim()) {
        filename =
          label.textContent.trim().replace(/[^\w\-]+/g, '_') + '.gcode';
      }
    } catch (eName) { /* ignore */ }

    var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (typeof appendOutput === 'function') {
      appendOutput(
        'G-code exported: ' + lines.length + ' line(s) → ' + filename,
        'result'
      );
    }
  } catch (e) {
    if (typeof appendOutput === 'function') {
      appendOutput('G-code export error: ' + e, 'error');
    }
  } finally {
    _gcodeExportBusy = false;
    if (btn && typeof setToolbarBtnLabel === 'function') {
      setToolbarBtnLabel(btn, 'G-code');
    }
    updateGcodeExportButton();
  }
}

// Keep button state in sync with workspace edits
if (typeof window !== 'undefined') {
  window.exportGcode = exportGcode;
  window.updateGcodeExportButton = updateGcodeExportButton;
  window.countSetupRobotBlocks = countSetupRobotBlocks;
}
