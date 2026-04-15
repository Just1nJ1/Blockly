// Device detector: polls the server for connected serial devices,
// updates the setup_robot block dropdowns, and auto-selects the model
// when the user picks a port.
// Exposes: window.detectedPorts, window.portModelMap

(function() {
  var POLL_INTERVAL = 3000;
  var pollTimer = null;

  // Maps model names returned by the server to the block's MODEL dropdown values.
  // Add new models here as they become available.
  var MODEL_VALUE_MAP = {
    'Mirobot': 'Mirobot_UART',
    'MT4': 'MT4_UART'
  };

  // Shared state: populated by polling, read by the block's dropdown generator
  // detectedPorts: array of display labels for the dropdown, e.g. ['COM3 (Mirobot)', 'COM5']
  // portModelMap:  { portValue -> modelValue }, e.g. { 'COM3': 'Mirobot_UART' }
  // portList:      raw array of { port, description, model } from server
  window.detectedPorts = [];
  window.portModelMap = {};

  function pollDevices() {
    var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';

    fetch(serverUrl + '/detect-devices')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (!data.success || !data.ports) return;

        var newPorts = [];
        var newMap = {};

        for (var i = 0; i < data.ports.length; i++) {
          var entry = data.ports[i];
          var port = entry.port;
          var model = entry.model;
          var label = port;

          if (model) {
            label = port + ' (' + model + ')';
            var modelValue = MODEL_VALUE_MAP[model];
            if (modelValue) {
              newMap[port] = modelValue;
            }
          }

          newPorts.push([label, port]);
        }

        // Only update if something changed
        var changed = (JSON.stringify(newPorts) !== JSON.stringify(window.detectedPorts));
        window.detectedPorts = newPorts;
        window.portModelMap = newMap;

        lastDetectedPorts = data.ports;

        if (changed) {
          console.log('[DeviceDetector] Ports updated:', newPorts, 'Model map:', newMap);
          updateCommandPortSelect(data.ports);
        }
      })
      .catch(function(err) {
        // Server not available — keep existing data
      });
  }

  // Auto-select the correct MODEL when the user changes the PORT dropdown
  function setupAutoModelSwitch() {
    var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!workspace) {
      // Workspace not ready yet, retry shortly
      setTimeout(setupAutoModelSwitch, 500);
      return;
    }

    workspace.addChangeListener(function(event) {
      if (event.type !== Blockly.Events.BLOCK_CHANGE) return;
      if (event.name !== 'PORT') return;

      var block = workspace.getBlockById(event.blockId);
      if (!block || block.type !== 'setup_robot') return;

      var selectedPort = event.newValue;
      var modelValue = window.portModelMap[selectedPort];

      if (modelValue) {
        var currentModel = block.getFieldValue('MODEL');
        if (currentModel !== modelValue) {
          block.setFieldValue(modelValue, 'MODEL');
          console.log('[DeviceDetector] Auto-switched model to', modelValue, 'for port', selectedPort);
        }
      }
    });
  }

  // Manually added ports (survive poll updates)
  var manualPorts = [];  // array of port strings, e.g. ['COM7']

  // Update the command tab's port dropdown with detected robot ports
  function updateCommandPortSelect(ports) {
    var select = document.getElementById('command-port-select');
    if (!select) return;

    // Remember current selection
    var currentValue = select.value;

    // Clear existing options
    select.innerHTML = '';

    // Collect detected port values for dedup
    var detectedValues = new Set();

    // If no detected ports AND no manual ports, show "No Connection"
    if ((!ports || ports.length === 0) && manualPorts.length === 0) {
      var noConn = document.createElement('option');
      noConn.value = '';
      noConn.textContent = 'No Connection';
      noConn.disabled = true;
      noConn.selected = true;
      select.appendChild(noConn);
    }

    // Add detected robot ports
    if (ports) {
      for (var i = 0; i < ports.length; i++) {
        var opt = document.createElement('option');
        opt.value = ports[i].port;
        opt.textContent = ports[i].port + ' (' + ports[i].model + ')';
        select.appendChild(opt);
        detectedValues.add(ports[i].port);
      }
    }

    // Add manually configured ports (skip if already in detected list)
    for (var k = 0; k < manualPorts.length; k++) {
      if (!detectedValues.has(manualPorts[k])) {
        var mOpt = document.createElement('option');
        mOpt.value = manualPorts[k];
        mOpt.textContent = manualPorts[k] + ' (manual)';
        select.appendChild(mOpt);
      }
    }

    // Always add "Connect manually..." at the end
    var manualOpt = document.createElement('option');
    manualOpt.value = '__manual__';
    manualOpt.textContent = 'Connect manually...';
    select.appendChild(manualOpt);

    // Restore previous selection if still available
    var restored = false;
    for (var j = 0; j < select.options.length; j++) {
      if (select.options[j].value === currentValue && currentValue !== '' && currentValue !== '__manual__') {
        select.selectedIndex = j;
        restored = true;
        break;
      }
    }

    // If previous selection gone, select first real port and auto-connect
    if (!restored) {
      var hasRealPort = (ports && ports.length > 0) || manualPorts.length > 0;
      if (hasRealPort) {
        select.selectedIndex = 0;
        // Auto-connect since programmatic selection doesn't fire 'change'
        var autoPort = select.value;
        if (autoPort && autoPort !== '' && autoPort !== '__manual__') {
          connectToSelectedPort(autoPort);
        }
      }
    }

    updateRemoveButton();
  }

  // Show a custom modal prompt (Electron doesn't support window.prompt)
  function showPortPrompt() {
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:30000;';

      var dialog = document.createElement('div');
      dialog.style.cssText = 'background:#2d2d2d;border-radius:8px;padding:24px;min-width:340px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

      var title = document.createElement('div');
      title.textContent = 'Manual Connection';
      title.style.cssText = 'font-size:16px;font-weight:600;color:#e0e0e0;margin-bottom:12px;';
      dialog.appendChild(title);

      var input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'e.g. COM7, /dev/ttyUSB0';
      input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px 12px;background:#3c3c3c;border:1px solid #555;border-radius:4px;color:#d4d4d4;font-size:14px;outline:none;margin-bottom:16px;';
      dialog.appendChild(input);

      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'padding:6px 16px;background:#555;color:#ddd;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
      cancelBtn.onclick = function() { document.body.removeChild(overlay); resolve(null); };
      btnRow.appendChild(cancelBtn);

      var okBtn = document.createElement('button');
      okBtn.textContent = 'Connect';
      okBtn.style.cssText = 'padding:6px 16px;background:#2196F3;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px;';
      okBtn.onclick = function() { document.body.removeChild(overlay); resolve(input.value); };
      btnRow.appendChild(okBtn);

      dialog.appendChild(btnRow);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);

      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') okBtn.click();
        if (e.key === 'Escape') cancelBtn.click();
      });
      input.focus();
    });
  }

  // Show/hide the remove button based on current selection
  function updateRemoveButton() {
    var select = document.getElementById('command-port-select');
    var removeBtn = document.getElementById('command-port-remove');
    if (!select || !removeBtn) return;

    var val = select.value;
    var isManual = val && manualPorts.indexOf(val) !== -1;
    removeBtn.classList.toggle('visible', isManual);
  }

  // Handle "Connect manually..." selection
  function setupManualConnect() {
    var select = document.getElementById('command-port-select');
    var removeBtn = document.getElementById('command-port-remove');
    if (!select) return;

    select.addEventListener('change', function() {
      if (select.value === '__manual__') {
        showPortPrompt().then(function(port) {
          if (!port || !port.trim()) {
            revertSelection(select);
            updateRemoveButton();
            return;
          }

          port = port.trim();

          if (manualPorts.indexOf(port) === -1) {
            manualPorts.push(port);
          }

          updateCommandPortSelect(lastDetectedPorts);
          select.value = port;
          updateRemoveButton();
          connectToSelectedPort(port);
          console.log('[DeviceDetector] Manually added port:', port);
        });
      } else {
        updateRemoveButton();
        // Connect to the selected port
        if (select.value && select.value !== '') {
          connectToSelectedPort(select.value);
        }
      }
    });

    // Remove button: delete the currently selected manual port
    if (removeBtn) {
      removeBtn.addEventListener('click', function() {
        var val = select.value;
        var idx = manualPorts.indexOf(val);
        if (idx === -1) return;

        // Disconnect first
        if (typeof window.commandTabDisconnect === 'function') {
          window.commandTabDisconnect();
        }

        manualPorts.splice(idx, 1);
        updateCommandPortSelect(lastDetectedPorts);
        updateRemoveButton();

        // Auto-connect to first remaining port if available
        if (select.value && select.value !== '' && select.value !== '__manual__') {
          connectToSelectedPort(select.value);
        }

        console.log('[DeviceDetector] Removed manual port:', val);
      });
    }
  }

  var _lastConnectedPort = null;

  function connectToSelectedPort(port) {
    if (typeof window.commandTabConnect !== 'function') return;
    // Skip if already connected to this port
    if (port === _lastConnectedPort) return;

    // Find the model for this port from detected ports
    var model = null;
    for (var i = 0; i < lastDetectedPorts.length; i++) {
      if (lastDetectedPorts[i].port === port) {
        model = lastDetectedPorts[i].model;
        break;
      }
    }

    _lastConnectedPort = port;
    window.commandTabConnect(port, model);
  }

  function revertSelection(select) {
    // Try to select the first non-disabled, non-manual option
    for (var i = 0; i < select.options.length; i++) {
      if (!select.options[i].disabled && select.options[i].value !== '__manual__') {
        select.selectedIndex = i;
        return;
      }
    }
    // Fallback: select first option (probably "No Connection")
    select.selectedIndex = 0;
  }

  // Keep a reference to the last detected ports for rebuilding after manual add
  var lastDetectedPorts = [];

  // Start polling and set up auto-switch after DOM is ready
  function init() {
    pollDevices();
    pollTimer = setInterval(pollDevices, POLL_INTERVAL);
    setupAutoModelSwitch();
    setupManualConnect();
    console.log('[DeviceDetector] Started polling every', POLL_INTERVAL, 'ms');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded (script at bottom of body)
    setTimeout(init, 100);
  }
})();