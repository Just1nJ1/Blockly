/**
 * Code Preview Module
 * Handles updating the Python code preview panel.
 */

/**
 * Update the code preview panel with the current workspace code.
 * This is called whenever blocks change in the workspace.
 */
function updateCodePreview() {
  try {
    var code = Blockly.Python.workspaceToCode(getWorkspace ? getWorkspace() : null);
    code = String(code || '').split('\n').filter(function (line) {
      return line.indexOf('__studiox_preview') === -1;
    }).join('\n');
    const previewElement = document.getElementById('code-preview');
    if (previewElement) {
      previewElement.textContent = code;
    }
  } catch (error) {
    console.error('Failed to generate code preview:', error);
  }
}
