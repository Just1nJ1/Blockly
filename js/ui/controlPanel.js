/**
 * Control Panel Module
 * Handles joint/coordinate mode switching, dynamic axis rows,
 * and status polling from the robot.
 */

(function() {
  // Model definitions: which axes each model supports
  // statusKey: key in the getStatus response dict (for reading values)
  // sdkParam: parameter name for writeAngle/writeCoordinate (for jogging)
  var MODELS = {
    'Mirobot': {
      joints: [
        { label: 'Joint 1', statusKey: 'X', sdkParam: 'x' },
        { label: 'Joint 2', statusKey: 'Y', sdkParam: 'y' },
        { label: 'Joint 3', statusKey: 'Z', sdkParam: 'z' },
        { label: 'Joint 4', statusKey: 'A', sdkParam: 'a' },
        { label: 'Joint 5', statusKey: 'B', sdkParam: 'b' },
        { label: 'Joint 6', statusKey: 'C', sdkParam: 'c' }
      ],
      coords: [
        { label: 'X', statusKey: 'X', sdkParam: 'x' },
        { label: 'Y', statusKey: 'Y', sdkParam: 'y' },
        { label: 'Z', statusKey: 'Z', sdkParam: 'z' },
        { label: 'A', statusKey: 'Rx', sdkParam: 'a' },
        { label: 'B', statusKey: 'Ry', sdkParam: 'b' },
        { label: 'C', statusKey: 'Rz', sdkParam: 'c' }
      ]
    },
    'MT4': {
      joints: [
        { label: 'Joint 1', statusKey: 'X', sdkParam: 'x' },
        { label: 'Joint 2', statusKey: 'Y', sdkParam: 'y' },
        { label: 'Joint 3', statusKey: 'Z', sdkParam: 'z' },
        { label: 'Joint 4', statusKey: 'A', sdkParam: 'a' }
      ],
      coords: [
        { label: 'X', statusKey: 'X', sdkParam: 'x' },
        { label: 'Y', statusKey: 'Y', sdkParam: 'y' },
        { label: 'Z', statusKey: 'Z', sdkParam: 'z' },
        { label: 'A', statusKey: 'Rx', sdkParam: 'a' }
      ]
    }
  };
  // E4 uses the same layout as MT4
  MODELS['E4'] = MODELS['MT4'];

  // Default to Mirobot if model unknown
  var DEFAULT_MODEL = 'Mirobot';

  var _currentMode = 'joint';  // 'joint' or 'coord'
  var _currentPort = null;
  var _currentModel = null;
  var _stepSize = 10;

  function getServerUrl() {
    return (typeof window.getServerUrl === 'function')
      ? window.getServerUrl() : 'http://127.0.0.1:5080';
  }

  function getModelConfig(model) {
    return MODELS[model] || MODELS[DEFAULT_MODEL];
  }

  function getAxes() {
    var config = getModelConfig(_currentModel);
    return (_currentMode === 'joint') ? config.joints : config.coords;
  }

  // ── Build axis rows ──

  function buildAxisRows() {
    var container = document.getElementById('ctrl-axis-rows');
    if (!container) return;

    container.innerHTML = '';
    var axes = getAxes();

    for (var i = 0; i < axes.length; i++) {
      (function(axis) {
        var row = document.createElement('div');
        row.className = 'ctrl-joint-row';
        row.dataset.statusKey = axis.statusKey;
        row.dataset.sdkParam = axis.sdkParam;

        var label = document.createElement('span');
        label.className = 'ctrl-joint-label';
        label.textContent = axis.label;

        var minusBtn = document.createElement('button');
        minusBtn.className = 'ctrl-btn ctrl-btn-minus';
        minusBtn.textContent = '\u2212';
        minusBtn.addEventListener('click', function() { jog(axis.sdkParam, -_stepSize); });

        var valueInput = document.createElement('input');
        valueInput.type = 'text';
        valueInput.className = 'ctrl-joint-value';
        valueInput.value = '0.00';
        valueInput.addEventListener('keydown', function(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            var val = parseFloat(valueInput.value);
            if (isNaN(val)) return;
            moveToAbsolute(axis.sdkParam, val);
            valueInput.blur();
          }
        });

        var plusBtn = document.createElement('button');
        plusBtn.className = 'ctrl-btn ctrl-btn-plus';
        plusBtn.textContent = '+';
        plusBtn.addEventListener('click', function() { jog(axis.sdkParam, _stepSize); });

        row.appendChild(label);
        row.appendChild(minusBtn);
        row.appendChild(valueInput);
        row.appendChild(plusBtn);
        container.appendChild(row);
      })(axes[i]);
    }
  }

  // ── Step size ──

  function setupStepControls() {
    var presets = document.querySelectorAll('.ctrl-step-preset');
    var stepInput = document.querySelector('.ctrl-step-input');

    presets.forEach(function(btn) {
      btn.addEventListener('click', function() {
        _stepSize = parseFloat(btn.dataset.step);
        presets.forEach(function(b) { b.classList.remove('active'); });
        btn.classList.add('active');
        if (stepInput) stepInput.value = _stepSize;
      });
    });

    if (stepInput) {
      stepInput.addEventListener('change', function() {
        var val = parseFloat(stepInput.value);
        if (!isNaN(val) && val > 0) {
          _stepSize = val;
          // Deselect presets since it's a custom value
          presets.forEach(function(b) {
            b.classList.toggle('active', parseFloat(b.dataset.step) === _stepSize);
          });
        }
      });
    }
  }

  // ── Jog ──

  function jog(sdkParam, step) {
    if (!_currentPort) return;

    // Notify debugger BEFORE jogging (captures before-jog position on first click)
    var notifyPromise = Promise.resolve();
    if (typeof window.debugNotifyJog === 'function') {
      notifyPromise = window.debugNotifyJog() || Promise.resolve();
    }

    notifyPromise.then(function() {
      return fetch(getServerUrl() + '/cmd/jog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: _currentPort,
          mode: _currentMode,
          axis: sdkParam,
          step: step
        })
      });
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        setTimeout(function() { refreshStatus(true); }, 500);
      }
    })
    .catch(function() {});
  }

  // ── Move to absolute position ──

  function moveToAbsolute(sdkParam, value) {
    if (!_currentPort) return;

    fetch(getServerUrl() + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: _currentPort,
        mode: _currentMode,
        axis: sdkParam,
        step: value,
        absolute: true
      })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        setTimeout(function() { refreshStatus(true); }, 500);
      }
    })
    .catch(function() {});
  }

  // ── Mode toggle ──

  function setMode(mode) {
    _currentMode = mode;
    var track = document.getElementById('ctrl-mode-switch');
    var labels = document.querySelectorAll('.ctrl-mode-label');

    if (mode === 'coord') {
      track.classList.add('toggled');
    } else {
      track.classList.remove('toggled');
    }

    labels.forEach(function(lbl) {
      lbl.classList.toggle('ctrl-mode-active', lbl.dataset.mode === mode);
    });

    buildAxisRows();
    refreshStatus(true);
  }

  function setupModeToggle() {
    var track = document.getElementById('ctrl-mode-switch');
    var labels = document.querySelectorAll('.ctrl-mode-label');

    if (track) {
      track.addEventListener('click', function() {
        setMode(_currentMode === 'joint' ? 'coord' : 'joint');
      });
    }

    labels.forEach(function(lbl) {
      lbl.addEventListener('click', function() {
        setMode(lbl.dataset.mode);
      });
    });
  }

  // ── Port selection ──

  function setupPortSelect() {
    var select = document.getElementById('ctrl-port-select');
    if (!select) return;

    select.addEventListener('change', function() {
      var port = select.value;
      if (!port) return;

      _currentPort = port;

      // Extract model from the selected option text, e.g. "COM3 (Mirobot)"
      _currentModel = null;
      var opt = select.options[select.selectedIndex];
      if (opt && opt.textContent) {
        if (opt.textContent.indexOf('Mirobot') !== -1) _currentModel = 'Mirobot';
        else if (opt.textContent.indexOf('MT4') !== -1) _currentModel = 'MT4';
        else if (opt.textContent.indexOf('E4') !== -1) _currentModel = 'E4';
      }
      _currentModel = _currentModel || DEFAULT_MODEL;

      buildAxisRows();
      // Don't refresh here — wait for onConnected to be called
    });
  }

  // Called externally after a connection is successfully established
  function onConnected(port, model) {
    var select = document.getElementById('ctrl-port-select');

    // Update current port/model
    _currentPort = port;
    if (model) {
      if (model.indexOf('Mirobot') !== -1) _currentModel = 'Mirobot';
      else if (model.indexOf('MT4') !== -1) _currentModel = 'MT4';
      else if (model.indexOf('E4') !== -1) _currentModel = 'E4';
      else _currentModel = DEFAULT_MODEL;
    }

    // Sync the dropdown selection
    if (select) {
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === port) {
          select.selectedIndex = i;
          break;
        }
      }
    }

    buildAxisRows();
    refreshStatus(false);  // initial query is non-silent (shows in command tab)
    startStatusPolling();
  }

  // ── Status polling ──

  var STATUS_POLL_INTERVAL = 200;
  var _pollTimer = null;
  var _refreshing = false;

  function refreshStatus(silent) {
    if (!_currentPort || _refreshing) return;
    _refreshing = true;

    fetch(getServerUrl() + '/cmd/get-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, silent: !!silent })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _refreshing = false;
      if (!data.success) return;

      if (data.model && data.model !== _currentModel) {
        _currentModel = data.model;
        buildAxisRows();
      }

      updateValues(data);
    })
    .catch(function() {
      _refreshing = false;
    });
  }

  function isControlPanelVisible() {
    var panel = document.getElementById('panel-content-control-panel');
    var blocklyView = document.getElementById('blockly-view');
    return panel && panel.classList.contains('active') &&
           blocklyView && blocklyView.classList.contains('active');
  }

  function startStatusPolling() {
    stopStatusPolling();
    _pollTimer = setInterval(function() {
      if (isControlPanelVisible()) {
        refreshStatus(true);  // silent poll — no history logging
      }
    }, STATUS_POLL_INTERVAL);
  }

  function stopStatusPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // For external callers (command send, blockly run, etc.)
  function markStale() {
    if (isControlPanelVisible()) {
      refreshStatus(true);
    }
  }

  function checkAndRefresh() {
    if (isControlPanelVisible()) {
      refreshStatus(true);
    }
  }

  function updateValues(data) {
    var container = document.getElementById('ctrl-axis-rows');
    if (!container) return;

    var rows = container.querySelectorAll('.ctrl-joint-row');
    var source = (_currentMode === 'joint') ? data.angles : data.coordinates;
    if (!source) return;

    rows.forEach(function(row) {
      var key = row.dataset.statusKey;
      if (key && source[key] !== undefined) {
        var input = row.querySelector('.ctrl-joint-value');
        if (input) {
          input.value = parseFloat(source[key]).toFixed(2);
        }
      }
    });
  }

  // ── Home / Zero ──

  function setupActionButtons() {
    var homeBtn = document.getElementById('ctrl-home-btn');
    var zeroBtn = document.getElementById('ctrl-zero-btn');

    if (homeBtn) {
      homeBtn.addEventListener('click', function() {
        if (!_currentPort) return;
        fetch(getServerUrl() + '/cmd/home', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: _currentPort })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) markStale();
        })
        .catch(function() {});
      });
    }

    if (zeroBtn) {
      zeroBtn.addEventListener('click', function() {
        if (!_currentPort) return;
        fetch(getServerUrl() + '/cmd/zero', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: _currentPort })
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) markStale();
        })
        .catch(function() {});
      });
    }
  }

  // ── Capture Position ──

  function setupCaptureButton() {
    var btn = document.getElementById('ctrl-capture-btn');
    if (!btn) return;

    btn.addEventListener('click', function() {
      var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
      if (!workspace) return;

      // Read current values from the axis rows
      var container = document.getElementById('ctrl-axis-rows');
      if (!container) return;

      var rows = container.querySelectorAll('.ctrl-joint-row');
      var values = {};
      rows.forEach(function(row) {
        var key = row.dataset.sdkParam;
        var input = row.querySelector('.ctrl-joint-value');
        if (key && input) {
          values[key] = parseFloat(input.value) || 0;
        }
      });

      // Find the variable name for the selected port from setup_robot blocks
      var varName = null;
      var setupBlocks = workspace.getBlocksByType('setup_robot', false);
      for (var s = 0; s < setupBlocks.length; s++) {
        var portVal = setupBlocks[s].getFieldValue('PORT');
        if (portVal === _currentPort) {
          var varField = setupBlocks[s].getField('VARIABLE');
          if (varField && varField.getVariable()) {
            varName = varField.getVariable().name;
          }
          break;
        }
      }

      // Determine block type based on mode
      var blockType = (_currentMode === 'coord') ? 'write_coordinate' : 'write_angle';

      // Create the block
      var block = workspace.newBlock(blockType);

      // Set the variable to match the port's robot variable
      if (varName && block.getField('VARIABLE')) {
        block.setFieldValue(varName, 'VARIABLE');
      }

      // Set mode to Absolute
      if (block.getField('POSITION')) {
        block.setFieldValue('0', 'POSITION');
      }

      // Initialize and render first so value inputs exist
      block.initSvg();
      block.render();

      // Wait for variable validator to trigger axis rebuild, then attach numbers
      setTimeout(function() {
        var axisKeys = ['x', 'y', 'z', 'a', 'b', 'c'];
        var inputNames = ['X', 'Y', 'Z', 'A', 'B', 'C'];
        for (var i = 0; i < axisKeys.length; i++) {
          var axisInput = block.getInput('AXIS_' + inputNames[i]);
          if (!axisInput) continue;
          var val = values[axisKeys[i]];
          if (val === undefined) val = 0;

          var numBlock = workspace.newBlock('math_number');
          numBlock.setFieldValue(String(val), 'NUM');
          numBlock.initSvg();
          numBlock.render();
          axisInput.connection.connect(numBlock.outputConnection);
        }
        block.render();
      }, 100);

      // Place it in a visible spot on the workspace
      var metrics = workspace.getMetrics();
      var viewLeft = metrics.viewLeft || 0;
      var viewTop = metrics.viewTop || 0;
      block.moveBy(viewLeft + 50, viewTop + 50);
    });
  }

  // ── End effector ──

  // Each effector type: list of { label, endpoint, mode }
  var EFFECTORS = {
    none: [],
    suction: [
      { label: 'SUCTION', endpoint: '/cmd/pump', mode: 1 },
      { label: 'BLOW',    endpoint: '/cmd/pump', mode: 2 },
      { label: 'OFF',     endpoint: '/cmd/pump', mode: 0 }
    ],
    gripper: [
      { label: 'OPEN',  endpoint: '/cmd/gripper', mode: 1 },
      { label: 'CLOSE', endpoint: '/cmd/gripper', mode: 2 },
      { label: 'OFF',   endpoint: '/cmd/gripper', mode: 0 }
    ],
    soft: [
      { label: 'OPEN',  endpoint: '/cmd/pump', mode: 1 },
      { label: 'CLOSE', endpoint: '/cmd/pump', mode: 2 },
      { label: 'OFF',   endpoint: '/cmd/pump', mode: 0 }
    ]
  };

  function setupEffectorSelect() {
    var select = document.getElementById('ctrl-effector-select');
    if (!select) return;

    select.addEventListener('change', function() {
      buildEffectorButtons(select.value);
    });

    buildEffectorButtons(select.value);
  }

  function buildEffectorButtons(type) {
    var container = document.getElementById('ctrl-effector-buttons');
    if (!container) return;

    container.innerHTML = '';
    var buttons = EFFECTORS[type] || [];

    for (var i = 0; i < buttons.length; i++) {
      (function(btnDef) {
        var btn = document.createElement('button');
        btn.className = 'ctrl-btn ctrl-eff-btn';
        btn.textContent = btnDef.label;
        btn.addEventListener('click', function() {
          sendEffectorCommand(btnDef.endpoint, btnDef.mode);
        });
        container.appendChild(btn);
      })(buttons[i]);
    }
  }

  function sendEffectorCommand(endpoint, mode) {
    if (!_currentPort) return;

    fetch(getServerUrl() + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, mode: mode })
    })
    .then(function(r) { return r.json(); })
    .catch(function() {});
  }

  // ── Initialization ──

  function init() {
    setupModeToggle();
    setupPortSelect();
    setupStepControls();
    setupActionButtons();
    setupCaptureButton();
    setupEffectorSelect();
    buildAxisRows();
  }

  // Expose for external use
  window.controlPanelRefresh = refreshStatus;
  window.controlPanelOnConnected = onConnected;
  window.controlPanelMarkStale = markStale;
  window.controlPanelCheckAndRefresh = checkAndRefresh;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }
})();