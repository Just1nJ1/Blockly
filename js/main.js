/**
 * Main Entry Point for Blockly Application
 *
 * Flow:
 *   1. App starts on the Command tab (no workspace needed)
 *   2. When user clicks the Blockly sidebar tab:
 *      a. If no workspace selected yet, show the workspace dialog
 *      b. Initialize Blockly (once), load blocks
 *   3. Switching back to Command tab preserves Blockly state
 */

var _blocklyInitialized = false;

document.addEventListener('DOMContentLoaded', () => {
  // Init blocks & generators first (no workspace needed)
  initCustomBlocks();
  initPythonGenerator();
  setupCustomPrompts();

  // Set up sidebar tab switching
  initSidebar();

  // Check serial port access on Linux/Chromebook
  checkSerialAccess();

  // Ctrl+S / Cmd+S to save (only when blockly is active)
  document.addEventListener('keydown', function(e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (_blocklyInitialized) saveWorkspaceBlocks();
    }
  });
});

/**
 * Check if serial ports are accessible. Shows a warning on Linux/Chromebook
 * if the user doesn't have permission.
 */
async function checkSerialAccess() {
  var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
  try {
    var resp = await fetch(serverUrl + '/check-serial-access');
    var data = await resp.json();
    if (data.success && data.access === false) {
      // Show warning banner in the command output
      var output = document.getElementById('command-output');
      if (output) {
        var warning = document.createElement('div');
        warning.style.cssText = 'background:#FFF3E0;color:#E65100;padding:12px 16px;margin:8px;border-radius:6px;font-size:13px;line-height:1.5;border:1px solid #FFB74D;';
        warning.innerHTML = '<strong>Serial Port Access Denied</strong><br>' +
          data.message.replace(/\n/g, '<br>');
        output.appendChild(warning);
      }
    }
  } catch (e) {
    // Server not ready yet — will check on next poll
  }
}

/**
 * Called when the user switches to the Blockly tab.
 * Ensures workspace is selected and Blockly is initialized.
 */
async function ensureBlocklyReady() {
  // If no workspace selected, ask the user to pick one
  if (!getCurrentWorkspacePath()) {
    var wsPath = await showWorkspaceDialog();
    setCurrentWorkspace(wsPath);
  }

  // Initialize Blockly once
  if (!_blocklyInitialized) {
    initBlockly();
    loadWorkspaceBlocks();
    initSavedFunctions();
    _blocklyInitialized = true;
  }

  // Blockly needs a resize after becoming visible
  if (typeof getWorkspace === 'function' && typeof Blockly !== 'undefined') {
    setTimeout(function() {
      Blockly.svgResize(getWorkspace());
      // Apply theme overrides to Blockly's inline styles
      if (typeof applyBlocklyThemeOverrides === 'function') {
        applyBlocklyThemeOverrides();
      }
    }, 50);
  }
}

/**
 * Initialize the Blockly workspace with toolbox and event listeners.
 */
function initBlockly() {
  const toolbox = getToolboxConfig();

  // Inject Blockly
  const workspace = Blockly.inject('blocklyDiv', {
    toolbox: toolbox,
    grid: {
      spacing: 20,
      length: 3,
      colour: '#ccc',
      snap: true,
    },
    trashcan: true,
    zoom: {
      controls: true,
      wheel: true,
      startScale: 1.0,
      maxScale: 3,
      minScale: 0.3,
      scaleSpeed: 1.2,
    },
  });

  // Store workspace reference
  setWorkspace(workspace);

  // Initialize block area selection (Cmd/Ctrl + drag)
  if (typeof initBlockSelection === 'function') {
    initBlockSelection();
  }

  // Store initial toolbox structure
  workspace.initialToolbox = JSON.parse(JSON.stringify(toolbox));

  // Update code preview on block change
  workspace.addChangeListener(updateCodePreview);

  // Refresh control panel port labels and block colors when setup_robot blocks change
  workspace.addChangeListener(function(event) {
    if (event.type === Blockly.Events.BLOCK_CREATE ||
        event.type === Blockly.Events.BLOCK_DELETE ||
        event.type === Blockly.Events.BLOCK_CHANGE) {
      if (typeof refreshControlPortLabels === 'function') {
        refreshControlPortLabels();
      }
      if (typeof updateRobotBlockColors === 'function') {
        updateRobotBlockColors();
      }
    }
  });

  // ── Dynamic *args / **kwargs slot management ──
  // On any connect or disconnect, immediately cleanup trailing empties and
  // ensure each dynamic param has exactly one trailing empty slot.
  workspace.addChangeListener((event) => {
    if (event.type !== Blockly.Events.BLOCK_MOVE) return;

    // Handle connect
    if (event.newParentId) {
      const parent = workspace.getBlockById(event.newParentId);
      if (parent && parent.functionInfo_) {
        updateDynamicSlots(parent);
      }
    }

    // Handle disconnect
    if (event.oldParentId) {
      const parent = workspace.getBlockById(event.oldParentId);
      if (parent && !parent.isDisposed() && parent.functionInfo_) {
        updateDynamicSlots(parent);
      }
    }
  });

  // Listen for block creation and changes to trigger library loading
  workspace.addChangeListener((event) => {
    // Sync toolbox for import blocks
    if (event.type === Blockly.Events.BLOCK_CREATE ||
        event.type === Blockly.Events.BLOCK_DELETE ||
        (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'MODULE_NAME')) {
      syncToolboxWithImports();
    }

    // Update function info for call blocks
    if (event.type === Blockly.Events.BLOCK_CREATE) {
      const block = workspace.getBlockById(event.blockId);
      if (block && (block.type === 'function_call' || block.type === 'library_function_call')) {
        const funcName = block.getFieldValue('FUNC_NAME');
        if (funcName && funcName !== '...') {
          block.updateFunctionInfo(funcName);
        }
      } else if (block && block.type === 'instance_function_call') {
        updateInstanceMethodsForBlock(block);
      }
    } else if (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'FUNC_NAME') {
      const block = workspace.getBlockById(event.blockId);
      if (block && (block.type === 'function_call' || block.type === 'library_function_call')) {
        block.updateFunctionInfo(event.newValue);
      }
    } else if (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'INSTANCE') {
      const block = workspace.getBlockById(event.blockId);
      if (block && block.type === 'instance_function_call') {
        updateInstanceMethodsForBlock(block);
      }
    } else if (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'METHOD') {
      const block = workspace.getBlockById(event.blockId);
      if (block && block.type === 'instance_function_call') {
        const methodName = block.getFieldValue('METHOD');
        if (methodName && methodName !== '...') {
          block.updateFunctionInfo(methodName);
        }
      }
    } else if (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'INSTANCE_NAME') {
      // local_instance_call: when user changes the local-var dropdown, fetch methods
      const block = workspace.getBlockById(event.blockId);
      if (block && block.type === 'local_instance_call' && block.updateMethodList) {
        block.updateMethodList();
      }
    } else if (event.type === Blockly.Events.BLOCK_CHANGE && event.name === 'METHOD_NAME') {
      // local_instance_call: when user picks a method, fetch its signature
      const block = workspace.getBlockById(event.blockId);
      if (block && block.type === 'local_instance_call') {
        const methodName = block.getFieldValue('METHOD_NAME');
        if (methodName && methodName !== '...' && block.updateFunctionInfo) {
          block.updateFunctionInfo(methodName);
        }
      }
    }

    // Also trigger method list fetch when a local_instance_call block is created
    if (event.type === Blockly.Events.BLOCK_CREATE) {
      const block = workspace.getBlockById(event.blockId);
      if (block && block.type === 'local_instance_call' && block.updateMethodList) {
        setTimeout(() => block.updateMethodList(), 100);
      }
    }
  });
}
