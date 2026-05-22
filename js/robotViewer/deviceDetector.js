// Device detector: polls the server for connected serial devices,
// updates the setup_robot block dropdowns, and auto-selects the model
// when the user picks a port.
// Exposes: window.detectedPorts, window.portModelMap

(function() {
  var POLL_INTERVAL = 3000;
  var pollTimer = null;

  // Loaded from /robots at init — maps model name → Blockly dropdown value
  var MODEL_VALUE_MAP = {};
  // Full robot definitions from robots.json (for manual port picker)
  var _robotDefs = [];

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
        var newManualSet = new Set();

        for (var i = 0; i < data.ports.length; i++) {
          var entry = data.ports[i];
          var port = entry.port;
          var model = entry.model;
          var label = port;

          if (entry.manual) newManualSet.add(port);

          // Skip ports that are still being detected
          if (model === 'Detecting...') {
            newPorts.push([port + ' (Detecting...)', '__detecting__' + port]);
            continue;
          }

          if (model) {
            label = port + ' (' + model + ')';
            var modelValue = MODEL_VALUE_MAP[model];
            if (modelValue) {
              newMap[port] = modelValue;
            }
          }

          newPorts.push([label, port]);
        }

        _manualPortSet = newManualSet;

        // Only update if something changed
        var changed = (JSON.stringify(newPorts) !== JSON.stringify(window.detectedPorts));
        window.detectedPorts = newPorts;
        window.portModelMap = newMap;

        lastDetectedPorts = data.ports.slice();

        if (changed) {
          console.log('[DeviceDetector] Ports updated:', newPorts, 'Model map:', newMap);
          // Reset last connected port so reconnect works after disconnect/reconnect
          _lastConnectedPort = null;
          updateCommandPortSelect(lastDetectedPorts);
          updateControlPortSelect(lastDetectedPorts);
          updateTeachingPortSelect(lastDetectedPorts);
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

    // If no detected ports, show "No Connection"
    if (!ports || ports.length === 0) {
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
        var model = ports[i].model;
        // Handle ports still being detected
        if (model === 'Detecting...') {
          opt.value = '';
          opt.textContent = ports[i].port + ' (Detecting...)';
          opt.disabled = true;
        } else {
          opt.value = ports[i].port;
          opt.textContent = ports[i].port + ' (' + model + ')';
          detectedValues.add(ports[i].port);
        }
        select.appendChild(opt);
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
      var hasRealPort = (ports && ports.length > 0);
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

  // Get variable name associated with a port from setup_robot blocks
  function getVarNameForPort(port) {
    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) return null;
    var blocks = ws.getBlocksByType('setup_robot', false);
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].getFieldValue('PORT') === port) {
        var field = blocks[i].getField('VARIABLE');
        if (field && field.getVariable()) {
          return field.getVariable().name;
        }
      }
    }
    return null;
  }

  // Update the control panel's port dropdown
  function updateControlPortSelect(ports) {
    var select = document.getElementById('ctrl-port-select');
    if (!select) return;

    var currentValue = select.value;
    select.innerHTML = '';

    if (!ports || ports.length === 0) {
      var noConn = document.createElement('option');
      noConn.value = '';
      noConn.textContent = 'No Connection';
      noConn.disabled = true;
      noConn.selected = true;
      select.appendChild(noConn);
      // Notify control panel that there's no connection
      // Pass the previous port so it can clear cached data
      if (typeof window.controlPanelOnDisconnected === 'function') {
        window.controlPanelOnDisconnected(currentValue || null);
      }
      return;
    }

    for (var i = 0; i < ports.length; i++) {
      var opt = document.createElement('option');
      var model = ports[i].model;
      // Handle ports still being detected
      if (model === 'Detecting...') {
        opt.value = '';
        opt.textContent = ports[i].port + ' (Detecting...)';
        opt.disabled = true;
      } else {
        opt.value = ports[i].port;
        var varName = getVarNameForPort(ports[i].port);
        var label = '';
        if (varName) label = varName + ' - ';
        label += ports[i].port + ' (' + model + ')';
        opt.textContent = label;
      }
      select.appendChild(opt);
    }

    // Restore previous selection
    var restored = false;
    for (var j = 0; j < select.options.length; j++) {
      if (select.options[j].value === currentValue) {
        select.selectedIndex = j;
        restored = true;
        break;
      }
    }
    if (!restored && ports.length > 0) {
      // Previous port is gone — notify control panel to clear its cache
      if (currentValue && typeof window.controlPanelOnDisconnected === 'function') {
        window.controlPanelOnDisconnected(currentValue);
      }
      select.selectedIndex = 0;
      // Trigger change so control panel picks up the new port
      select.dispatchEvent(new Event('change'));
    }
  }

  // Update the teaching panel's port dropdown
  function updateTeachingPortSelect(ports) {
    var select = document.getElementById('teach-port-select');
    if (!select) return;

    var currentValue = select.value;
    select.innerHTML = '';

    if (!ports || ports.length === 0) {
      var noConn = document.createElement('option');
      noConn.value = '';
      noConn.textContent = 'No Connection';
      noConn.disabled = true;
      noConn.selected = true;
      select.appendChild(noConn);
      if (typeof window.teachingPanelOnDisconnected === 'function') {
        window.teachingPanelOnDisconnected();
      }
      return;
    }

    for (var i = 0; i < ports.length; i++) {
      var opt = document.createElement('option');
      var model = ports[i].model;
      if (model === 'Detecting...') {
        opt.value = '';
        opt.textContent = ports[i].port + ' (Detecting...)';
        opt.disabled = true;
      } else {
        opt.value = ports[i].port;
        opt.textContent = ports[i].port + ' (' + model + ')';
      }
      select.appendChild(opt);
    }

    // Restore previous selection
    var restored = false;
    for (var j = 0; j < select.options.length; j++) {
      if (select.options[j].value === currentValue && currentValue !== '') {
        select.selectedIndex = j;
        restored = true;
        break;
      }
    }
    if (!restored && ports.length > 0) {
      // Select first real (non-detecting) port
      for (var p = 0; p < select.options.length; p++) {
        if (select.options[p].value && !select.options[p].disabled) {
          select.selectedIndex = p;
          break;
        }
      }
    }
    // Always fire change so teaching panel picks up the port
    if (select.value) {
      select.dispatchEvent(new Event('change'));
    }
  }

  // Port picker: combo box with a text input, a toggle arrow to expand/fold
  // the dropdown, and typing filters the list items.
  function showPortPrompt() {
    return new Promise(function(resolve) {
      var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
      var allPorts = [];
      var highlightIdx = -1;
      var isOpen = false;
      var loaded = false;

      var detectedSet = new Set();
      for (var d = 0; d < lastDetectedPorts.length; d++) {
        detectedSet.add(lastDetectedPorts[d].port);
      }

      function cleanup() { if (overlay.parentNode) document.body.removeChild(overlay); }
      function cancel() { cleanup(); resolve(null); }

      // After user picks a port, probe it for model detection
      function submit(val) {
        val = val && val.trim();
        if (!val) return;
        probeAndResolve(val);
      }

      // ── Probe port and resolve (or show model picker) ──
      function probeAndResolve(port) {
        // Disable the dialog and show probing state
        input.disabled = true;
        arrow.disabled = true;
        connectBtn.disabled = true;
        connectBtn.textContent = 'Probing...';
        closeDropdown();

        fetch(serverUrl + '/cmd/probe-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: port })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.model) {
            cleanup();
            resolve({ port: port, model: data.model });
          } else {
            showModelPicker(port);
          }
        })
        .catch(function() {
          showModelPicker(port);
        });
      }

      function showModelPicker(port) {
        // Replace dialog body with model selection buttons
        body.innerHTML = '';
        var msg = document.createElement('div');
        msg.className = 'port-picker-probe-msg';
        msg.textContent = 'Could not auto-detect model on ' + port + '. Select the robot type:';
        body.appendChild(msg);

        var btnGroup = document.createElement('div');
        btnGroup.className = 'port-picker-model-group';

        var models = _robotDefs.map(function(r) {
          return { label: r.label, value: r.name };
        });
        models.push({ label: 'None (raw serial)', value: null });

        models.forEach(function(m) {
          var btn = document.createElement('button');
          btn.className = 'port-picker-model-btn';
          btn.textContent = m.label;
          btn.addEventListener('click', function() {
            cleanup();
            resolve({ port: port, model: m.value });
          });
          btnGroup.appendChild(btn);
        });

        body.appendChild(btnGroup);

        // Update footer
        connectBtn.style.display = 'none';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = cancel;
      }

      // ── Overlay + dialog ──
      var overlay = document.createElement('div');
      overlay.className = 'port-picker-overlay';
      overlay.addEventListener('click', function(e) { if (e.target === overlay) cancel(); });

      var dialog = document.createElement('div');
      dialog.className = 'port-picker-dialog';

      // Header
      var header = document.createElement('div');
      header.className = 'port-picker-header';
      header.innerHTML = '<span>Manual Connection</span>';
      var closeBtn = document.createElement('button');
      closeBtn.className = 'port-picker-close';
      closeBtn.innerHTML = '&times;';
      closeBtn.onclick = cancel;
      header.appendChild(closeBtn);
      dialog.appendChild(header);

      // Body
      var body = document.createElement('div');
      body.className = 'port-picker-body';

      // Combo box wrapper
      var combo = document.createElement('div');
      combo.className = 'port-picker-combo';

      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'port-picker-input';
      input.placeholder = 'Select or type a port path...';
      combo.appendChild(input);

      var arrow = document.createElement('button');
      arrow.className = 'port-picker-arrow';
      arrow.innerHTML = '&#9662;';
      arrow.setAttribute('tabindex', '-1');
      combo.appendChild(arrow);

      body.appendChild(combo);

      var dropdown = document.createElement('div');
      dropdown.className = 'port-picker-dropdown';
      dropdown.style.display = 'none';
      body.appendChild(dropdown);

      dialog.appendChild(body);

      // Footer
      var footer = document.createElement('div');
      footer.className = 'port-picker-footer';
      var cancelBtn = document.createElement('button');
      cancelBtn.className = 'port-picker-cancel-btn';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.onclick = cancel;
      footer.appendChild(cancelBtn);
      var connectBtn = document.createElement('button');
      connectBtn.className = 'port-picker-connect-btn';
      connectBtn.textContent = 'Connect';
      connectBtn.onclick = function() { submit(input.value); };
      footer.appendChild(connectBtn);
      dialog.appendChild(footer);

      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      input.focus();

      // ── Open / close ──
      function openDropdown() {
        if (isOpen) return;
        isOpen = true;
        dropdown.style.display = '';
        arrow.classList.add('port-picker-arrow-open');
        renderDropdown();
      }

      function closeDropdown() {
        if (!isOpen) return;
        isOpen = false;
        dropdown.style.display = 'none';
        arrow.classList.remove('port-picker-arrow-open');
        highlightIdx = -1;
      }

      function toggleDropdown() {
        if (isOpen) closeDropdown(); else openDropdown();
      }

      arrow.addEventListener('mousedown', function(e) {
        e.preventDefault(); // keep focus on input
        toggleDropdown();
      });

      // ── Render filtered items ──
      function renderDropdown() {
        var filter = input.value.trim().toLowerCase();
        dropdown.innerHTML = '';
        highlightIdx = -1;

        if (!loaded) {
          dropdown.innerHTML = '<div class="port-picker-empty">Loading...</div>';
          return;
        }

        var matched = allPorts.filter(function(p) {
          if (!filter) return true;
          return p.device.toLowerCase().indexOf(filter) !== -1 ||
                 (p.description && p.description.toLowerCase().indexOf(filter) !== -1);
        });

        if (allPorts.length === 0) {
          dropdown.innerHTML = '<div class="port-picker-empty">No additional ports found.</div>';
          return;
        }

        if (matched.length === 0) {
          dropdown.innerHTML = '<div class="port-picker-empty">No matching ports.</div>';
          return;
        }

        for (var i = 0; i < matched.length; i++) {
          (function(port, idx) {
            var item = document.createElement('div');
            item.className = 'port-picker-item';
            item.addEventListener('mousedown', function(e) {
              e.preventDefault(); // prevent blur before click fires
            });
            item.addEventListener('click', function() {
              input.value = port.device;
              closeDropdown();
              submit(port.device);
            });
            item.addEventListener('mouseenter', function() {
              highlightIdx = idx;
              updateHighlight();
            });

            var nameSpan = document.createElement('span');
            nameSpan.className = 'port-picker-item-name';
            nameSpan.textContent = port.device;
            item.appendChild(nameSpan);

            if (port.description && port.description !== 'n/a') {
              var descSpan = document.createElement('span');
              descSpan.className = 'port-picker-item-desc';
              descSpan.textContent = port.description;
              item.appendChild(descSpan);
            }

            dropdown.appendChild(item);
          })(matched[i], i);
        }
      }

      function updateHighlight() {
        var items = dropdown.querySelectorAll('.port-picker-item');
        items.forEach(function(el, i) {
          el.classList.toggle('port-picker-item-active', i === highlightIdx);
        });
      }

      // ── Input events ──
      input.addEventListener('input', function() {
        openDropdown();
        renderDropdown();
      });

      input.addEventListener('focus', function() {
        if (loaded && allPorts.length > 0) openDropdown();
      });

      input.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!isOpen) { openDropdown(); return; }
          var items = dropdown.querySelectorAll('.port-picker-item');
          if (items.length > 0) {
            highlightIdx = (highlightIdx + 1) % items.length;
            updateHighlight();
            items[highlightIdx].scrollIntoView({ block: 'nearest' });
          }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!isOpen) { openDropdown(); return; }
          var items2 = dropdown.querySelectorAll('.port-picker-item');
          if (items2.length > 0) {
            highlightIdx = highlightIdx <= 0 ? items2.length - 1 : highlightIdx - 1;
            updateHighlight();
            items2[highlightIdx].scrollIntoView({ block: 'nearest' });
          }
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (isOpen && highlightIdx >= 0) {
            var items3 = dropdown.querySelectorAll('.port-picker-item');
            if (highlightIdx < items3.length) { items3[highlightIdx].click(); return; }
          }
          submit(input.value);
        } else if (e.key === 'Escape') {
          if (isOpen) { closeDropdown(); } else { cancel(); }
        }
      });

      // ── Fetch ports ──
      fetch(serverUrl + '/list-all-ports')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          loaded = true;
          if (data.success && data.ports) {
            allPorts = data.ports.filter(function(p) { return !detectedSet.has(p.device); });
          }
          if (isOpen) renderDropdown();
        })
        .catch(function() {
          loaded = true;
          allPorts = [];
          if (isOpen) renderDropdown();
        });
    });
  }

  // Track which ports are manual (populated from poll data)
  var _manualPortSet = new Set();

  // Show/hide the remove button based on current selection
  function updateRemoveButton() {
    var select = document.getElementById('command-port-select');
    var removeBtn = document.getElementById('command-port-remove');
    if (!select || !removeBtn) return;

    var val = select.value;
    removeBtn.classList.toggle('visible', val && _manualPortSet.has(val));
  }

  // Handle "Connect manually..." selection
  function setupManualConnect() {
    var select = document.getElementById('command-port-select');
    var removeBtn = document.getElementById('command-port-remove');
    var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
    if (!select) return;

    select.addEventListener('change', function() {
      if (select.value === '__manual__') {
        showPortPrompt().then(function(result) {
          if (!result) {
            revertSelection(select);
            updateRemoveButton();
            return;
          }

          var port = result.port;
          var model = result.model;

          // Register on the server so it's managed by the detector + SerialManager
          fetch(serverUrl + '/cmd/add-manual-port', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: port, model: model })
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (!data.success) {
              console.warn('[DeviceDetector] Failed to register manual port:', data.error);
            }
            // Trigger an immediate poll so the UI updates right away
            pollDevices();
            // Select and connect after the poll refreshes the dropdown
            setTimeout(function() {
              select.value = port;
              updateRemoveButton();
              connectToSelectedPort(port);
            }, 500);
            console.log('[DeviceDetector] Manually added port:', port, 'model:', model);
          })
          .catch(function(err) {
            console.error('[DeviceDetector] Error registering manual port:', err);
          });
        });
      } else {
        updateRemoveButton();
        if (select.value && select.value !== '') {
          connectToSelectedPort(select.value);
        }
      }
    });

    // Remove button: delete the currently selected manual port
    if (removeBtn) {
      removeBtn.addEventListener('click', function() {
        var val = select.value;
        if (!_manualPortSet.has(val)) return;

        // Disconnect first
        if (typeof window.commandTabDisconnect === 'function') {
          window.commandTabDisconnect();
        }

        // Remove on the server
        fetch(serverUrl + '/cmd/remove-manual-port', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: val })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (!data.success) {
            console.warn('[DeviceDetector] Failed to remove manual port:', data.error);
          }
          _manualPortSet.delete(val);
          // Trigger immediate poll to refresh UI
          pollDevices();
          setTimeout(function() {
            updateRemoveButton();
            if (select.value && select.value !== '' && select.value !== '__manual__') {
              connectToSelectedPort(select.value);
            }
          }, 500);
          console.log('[DeviceDetector] Removed manual port:', val);
        })
        .catch(function(err) {
          console.error('[DeviceDetector] Error removing manual port:', err);
        });
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
    var result = window.commandTabConnect(port, model);
    if (result && typeof result.then === 'function') {
      result.then(function(data) {
        if (!data || !data.success) {
          _lastConnectedPort = null;  // device not ready yet — retry next poll
        }
      }).catch(function() {
        _lastConnectedPort = null;
      });
    }
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

  // Refresh control panel dropdown labels (called when workspace blocks change)
  function refreshControlPortLabels() {
    if (lastDetectedPorts.length > 0) {
      updateControlPortSelect(lastDetectedPorts);
    }
  }
  window.refreshControlPortLabels = refreshControlPortLabels;

  // Allow other modules to force a reconnect on the next poll cycle
  // (e.g. after firmware flash disconnects and reconnects the port)
  window.resetDetectorPort = function(port) {
    if (!port || port === _lastConnectedPort) {
      _lastConnectedPort = null;
    }
  };

  // Load robot definitions from server, then start polling
  function loadRobotDefs(callback) {
    var serverUrl = (typeof getServerUrl === 'function') ? getServerUrl() : 'http://127.0.0.1:5080';
    fetch(serverUrl + '/robots')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.robots) {
          _robotDefs = data.robots;
          MODEL_VALUE_MAP = {};
          for (var i = 0; i < data.robots.length; i++) {
            MODEL_VALUE_MAP[data.robots[i].name] = data.robots[i].blocklyValue;
          }
        }
      })
      .catch(function() { /* use empty defaults */ })
      .then(callback);
  }

  function init() {
    loadRobotDefs(function() {
      pollDevices();
      pollTimer = setInterval(pollDevices, POLL_INTERVAL);
      setupAutoModelSwitch();
      setupManualConnect();
      console.log('[DeviceDetector] Started polling every', POLL_INTERVAL, 'ms');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // DOM already loaded (script at bottom of body)
    setTimeout(init, 100);
  }
})();