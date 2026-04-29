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
  var _portFirmwareVersions = {};  // port -> { extender: str|null, robot: str|null }
  function isDeveloperMode() {
    return !!window.developerMode;
  }

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
      // Robot will auto-report status when movement finishes ($40=1)
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
      // Robot will auto-report status when movement finishes ($40=1)
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
    refreshStatus(false);
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

  function getBlockColorForPort(port) {
    var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!workspace) return '#E67E22';
    var setupBlocks = workspace.getBlocksByType('setup_robot', false);
    for (var i = 0; i < setupBlocks.length; i++) {
      if (setupBlocks[i].getFieldValue('PORT') === port) {
        return setupBlocks[i].getColour() || '#E67E22';
      }
    }
    return '#E67E22';
  }

  function updatePortSelectColor(port) {
    var select = document.getElementById('ctrl-port-select');
    if (!select) return;
    if (!port) {
      select.style.background = '';
      select.style.color = '';
      select.style.borderColor = '';
      select.classList.remove('port-connected');
      return;
    }
    var color = getBlockColorForPort(port);
    select.style.background = color;
    select.style.color = '#fff';
    select.style.borderColor = color;
    select.classList.add('port-connected');
  }

  function updateSettingsButtonState() {
    var btn = document.getElementById('ctrl-settings-btn');
    if (btn) btn.disabled = !_currentPort;
  }

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

      updatePortSelectColor(port);
      updateSettingsButtonState();
      buildAxisRows();
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

    // Sync the dropdown selection and color
    if (select) {
      for (var i = 0; i < select.options.length; i++) {
        if (select.options[i].value === port) {
          select.selectedIndex = i;
          break;
        }
      }
    }
    updatePortSelectColor(port);
    updateSettingsButtonState();

    buildAxisRows();
    _lastStatusTs = 0;  // reset so we pick up cached status immediately
    refreshStatus(true);  // force query on first connect (no cached status yet)
    startStatusPolling();

    // Fetch firmware version once on connect (cached until disconnect)
    if (!_portFirmwareVersions[port]) {
      fetch(getServerUrl() + '/cmd/firmware-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: port })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success) {
          _portFirmwareVersions[port] = { extender: data.extender || null, robot: data.robot || null };
          checkFirmwareUpdates(port);
        }
      })
      .catch(function() {});
    }
  }

  // ── Firmware update check ──

  var _pendingUpdates = {};  // port -> { extender: {current,latest,url}|null, robot: ... }

  function checkFirmwareUpdates(port) {
    var versions = _portFirmwareVersions[port];
    if (!versions) return;

    fetch(getServerUrl() + '/cmd/check-firmware-update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extender: versions.extender, robot: versions.robot, model: _currentModel })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success || !data.updates) return;
      var updates = data.updates;

      // Filter out ignored versions
      if (updates.extender && typeof isFirmwareVersionIgnored === 'function') {
        if (isFirmwareVersionIgnored('EXBOX', updates.extender.current)) {
          updates.extender = null;
        }
      }
      if (updates.robot && typeof isFirmwareVersionIgnored === 'function') {
        var deviceType = _currentModel || 'Mirobot';
        if (isFirmwareVersionIgnored(deviceType, updates.robot.current)) {
          updates.robot = null;
        }
      }

      if (!updates.extender && !updates.robot) return;

      _pendingUpdates[port] = updates;
      showFirmwareUpdateNotification(port, updates);
    })
    .catch(function() {});
  }

  function showFirmwareUpdateNotification(port, updates) {
    // Build notification text
    var parts = [];
    if (updates.extender) {
      parts.push('Extender Box: ' + updates.extender.current + ' \u2192 ' + updates.extender.latest);
    }
    if (updates.robot) {
      parts.push('Robot Arm: ' + updates.robot.current + ' \u2192 ' + updates.robot.latest);
    }

    // Show a toast-style notification bar at the top of the control panel
    var panel = document.querySelector('.ctrl-panel');
    if (!panel) return;

    // Remove any existing notification
    var existing = panel.querySelector('.ctrl-fw-update-bar');
    if (existing) existing.remove();

    var bar = document.createElement('div');
    bar.className = 'ctrl-fw-update-bar';
    bar.innerHTML =
      '<span class="ctrl-fw-update-text">Firmware update available: ' + parts.join(', ') + '</span>' +
      '<button class="ctrl-fw-update-btn" id="ctrl-fw-update-accept">Update</button>' +
      '<button class="ctrl-fw-update-ignore" id="ctrl-fw-update-ignore">Ignore</button>' +
      '<button class="ctrl-fw-update-dismiss" id="ctrl-fw-update-dismiss">&times;</button>';

    panel.insertBefore(bar, panel.firstChild);

    document.getElementById('ctrl-fw-update-dismiss').addEventListener('click', function() {
      bar.remove();
    });

    document.getElementById('ctrl-fw-update-accept').addEventListener('click', function() {
      bar.remove();
      openRobotSettings();
    });

    document.getElementById('ctrl-fw-update-ignore').addEventListener('click', function() {
      // Ignore all versions shown in this notification
      if (updates.extender && typeof ignoreFirmwareVersion === 'function') {
        ignoreFirmwareVersion('EXBOX', updates.extender.current);
      }
      if (updates.robot && typeof ignoreFirmwareVersion === 'function') {
        var deviceType = _currentModel || 'Mirobot';
        ignoreFirmwareVersion(deviceType, updates.robot.current);
      }
      bar.remove();
    });
  }

  function startRemoteFlash(port, type, url) {
    // Start the download+flash via server (called from firmware modal)
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    var uploadBtn = document.getElementById('ctrl-fw-upload');
    var out = document.getElementById('ctrl-fw-output');
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading...';
    uploadBtn.disabled = true;
    out.textContent = 'Downloading firmware from GitHub...\n';
    _flashLastLine = 0;

    // Collect field values for flash settings
    var cfg = _FLASH_CONFIGS[type];
    var grid = document.getElementById('ctrl-fw-settings-grid');
    var flashParams = { port: port, url: url, type: type };
    for (var i = 0; i < cfg.fields.length; i++) {
      var f = cfg.fields[i];
      var el = grid.querySelector('[data-key="' + f.key + '"]');
      flashParams[f.key] = el ? el.value : f.value;
    }

    fetch(getServerUrl() + '/cmd/download-firmware', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(flashParams)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) {
        appendFwOutput('Error: ' + (data.error || 'Unknown error'));
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Download & Flash';
        uploadBtn.disabled = false;
        return;
      }
      pollFlashProgress(data.job_id, downloadBtn);
    })
    .catch(function(e) {
      appendFwOutput('Error: ' + e.message);
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download & Flash';
      uploadBtn.disabled = false;
    });
  }

  // ── Status polling ──
  // Uses /cmd/last-status which reads cached auto-reported status ($40=1).
  // No serial traffic — the robot pushes status after each movement.

  var STATUS_POLL_INTERVAL = 300;
  var _pollTimer = null;
  var _refreshing = false;
  var _lastStatusTs = 0;  // track timestamp to avoid redundant UI updates

  function refreshStatus(forceQuery) {
    if (!_currentPort || _refreshing) return;
    _refreshing = true;

    // forceQuery: send explicit ? (used on first connect when no cached status exists)
    var endpoint = forceQuery ? '/cmd/get-status' : '/cmd/last-status';
    var body = { port: _currentPort };
    if (forceQuery) body.silent = true;

    fetch(getServerUrl() + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _refreshing = false;
      if (!data.success) return;

      // Skip UI update if timestamp hasn't changed (no new status)
      if (!forceQuery && data.ts && data.ts === _lastStatusTs) return;
      if (data.ts) _lastStatusTs = data.ts;

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
        refreshStatus(false);
      }
    }, STATUS_POLL_INTERVAL);
  }

  function stopStatusPolling() {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  function markStale() {
    // After a command, the robot will auto-report when movement finishes.
    // Nothing to do — the poll loop picks it up from the cache.
  }

  function checkAndRefresh() {
    if (isControlPanelVisible()) {
      refreshStatus(false);
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

  // ── Settings Modal ──

  var _settingsModal = null;
  var _settingsInitialState = null;

  function getVarForPort(port) {
    var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!workspace) return null;
    var setupBlocks = workspace.getBlocksByType('setup_robot', false);
    for (var i = 0; i < setupBlocks.length; i++) {
      if (setupBlocks[i].getFieldValue('PORT') === port) {
        var field = setupBlocks[i].getField('VARIABLE');
        if (field && field.getVariable()) return field.getVariable().name;
      }
    }
    return null;
  }

  function buildSettingsModal() {
    var overlay = document.createElement('div');
    overlay.id = 'ctrl-settings-modal';
    overlay.className = 'ctrl-modal-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'ctrl-modal-dialog';
    dialog.innerHTML =
      '<div class="ctrl-modal-header">' +
        '<span class="ctrl-modal-title">Robot Settings</span>' +
        '<button class="ctrl-modal-close" id="ctrl-settings-close">&times;</button>' +
      '</div>' +
      '<div class="ctrl-modal-body">' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Firmware</div>' +
          '<div class="ctrl-settings-grid ctrl-fw-ver-grid">' +
            '<span class="ctrl-settings-label">Extender Box</span>' +
            '<span class="ctrl-fw-ver-val" id="ctrl-settings-ext-ver">—</span>' +
            '<span class="ctrl-settings-label">Robotic Arm</span>' +
            '<span class="ctrl-fw-ver-val" id="ctrl-settings-robot-ver">—</span>' +
          '</div>' +
          '<div class="ctrl-fw-btn-row">' +
            '<button class="ctrl-action-btn ctrl-btn-fw-upload" id="ctrl-settings-fw-btn" disabled>&#8679; Extender Box</button>' +
            '<button class="ctrl-action-btn ctrl-btn-fw-upload" id="ctrl-settings-arm-fw-btn" disabled>&#8679; Robot Arm</button>' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Appearance</div>' +
          '<div class="ctrl-settings-grid">' +
            '<label class="ctrl-settings-label">Robot Color</label>' +
            '<input type="color" id="ctrl-settings-color" class="ctrl-settings-color-input">' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">WiFi</div>' +
          '<div class="ctrl-settings-grid">' +
            '<label class="ctrl-settings-label">SSID</label>' +
            '<input type="text" id="ctrl-settings-wifi-ssid" class="ctrl-settings-input" placeholder="WiFi network name">' +
            '<label class="ctrl-settings-label">Password</label>' +
            '<input type="text" id="ctrl-settings-wifi-pass" class="ctrl-settings-input" placeholder="WiFi password">' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Bluetooth</div>' +
          '<div class="ctrl-settings-grid">' +
            '<label class="ctrl-settings-label">Device Name</label>' +
            '<input type="text" id="ctrl-settings-bt-name" class="ctrl-settings-input" placeholder="Bluetooth device name">' +
            '<label class="ctrl-settings-label">PIN</label>' +
            '<input type="text" id="ctrl-settings-bt-pin" class="ctrl-settings-input ctrl-settings-pin" placeholder="4-digit PIN" maxlength="4">' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Calibration</div>' +
          '<button class="ctrl-action-btn ctrl-btn-calibrate" id="ctrl-settings-cal-btn">Save Current Position as Calibration Position</button>' +
        '</div>' +
      '</div>' +
      '<div class="ctrl-modal-footer">' +
        '<button class="ctrl-modal-btn ctrl-modal-btn-cancel" id="ctrl-settings-cancel">Cancel</button>' +
        '<button class="ctrl-modal-btn ctrl-modal-btn-save" id="ctrl-settings-save">Save</button>' +
      '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) attemptCloseSettings();
    });
    document.getElementById('ctrl-settings-close').addEventListener('click', attemptCloseSettings);
    document.getElementById('ctrl-settings-cancel').addEventListener('click', attemptCloseSettings);
    document.getElementById('ctrl-settings-save').addEventListener('click', saveRobotSettings);
    document.getElementById('ctrl-settings-fw-btn').addEventListener('click', function() {
      _settingsModal.style.display = 'none';
      openFirmwareModal('extender');
    });
    document.getElementById('ctrl-settings-arm-fw-btn').addEventListener('click', function() {
      _settingsModal.style.display = 'none';
      openFirmwareModal('robot');
    });

    // PIN: digits only
    document.getElementById('ctrl-settings-bt-pin').addEventListener('input', function() {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 4);
    });

    _settingsModal = overlay;
  }

  function getSettingsState() {
    return {
      color:    document.getElementById('ctrl-settings-color').value,
      wifiSsid: document.getElementById('ctrl-settings-wifi-ssid').value,
      wifiPass: document.getElementById('ctrl-settings-wifi-pass').value,
      btName:   document.getElementById('ctrl-settings-bt-name').value,
      btPin:    document.getElementById('ctrl-settings-bt-pin').value
    };
  }

  function settingsHaveChanged() {
    if (!_settingsInitialState) return false;
    var s = getSettingsState();
    return s.color    !== _settingsInitialState.color    ||
           s.wifiSsid !== _settingsInitialState.wifiSsid ||
           s.wifiPass !== _settingsInitialState.wifiPass ||
           s.btName   !== _settingsInitialState.btName   ||
           s.btPin    !== _settingsInitialState.btPin;
  }

  function updateFirmwareButtons() {
    var versions = _portFirmwareVersions[_currentPort] || {};
    var exBtn  = document.getElementById('ctrl-settings-fw-btn');
    var armBtn = document.getElementById('ctrl-settings-arm-fw-btn');
    if (!exBtn || !armBtn) return;

    // Normal rules:
    // - ExBox button enabled if extender firmware detected
    // - Robot arm button enabled if robot firmware detected AND extender NOT detected
    var exAvail  = !!versions.extender;
    var armAvail = !!versions.robot && !versions.extender;

    if (isDeveloperMode()) {
      // Developer mode: both always enabled
      exBtn.disabled  = false;
      armBtn.disabled = false;

      // Mark forced buttons red with FORCE prefix
      if (exAvail) {
        exBtn.textContent = '\u21E7 Extender Box';
        exBtn.classList.remove('ctrl-btn-fw-force');
      } else {
        exBtn.textContent = '\u21E7 FORCE Extender Box';
        exBtn.classList.add('ctrl-btn-fw-force');
      }
      if (armAvail) {
        armBtn.textContent = '\u21E7 Robot Arm';
        armBtn.classList.remove('ctrl-btn-fw-force');
      } else {
        armBtn.textContent = '\u21E7 FORCE Robot Arm';
        armBtn.classList.add('ctrl-btn-fw-force');
      }
    } else {
      // Normal mode
      exBtn.disabled  = !exAvail;
      armBtn.disabled = !armAvail;
      exBtn.textContent  = '\u21E7 Extender Box';
      armBtn.textContent = '\u21E7 Robot Arm';
      exBtn.classList.remove('ctrl-btn-fw-force');
      armBtn.classList.remove('ctrl-btn-fw-force');
    }
  }

  function openRobotSettings() {
    if (!_settingsModal) buildSettingsModal();

    // Pre-fill color from current port
    var color = getBlockColorForPort(_currentPort);
    document.getElementById('ctrl-settings-color').value = color;

    // Populate firmware version display and button states
    var versions = _portFirmwareVersions[_currentPort] || {};
    document.getElementById('ctrl-settings-ext-ver').textContent   = versions.extender || '—';
    document.getElementById('ctrl-settings-robot-ver').textContent = versions.robot    || '—';

    updateFirmwareButtons();

    _settingsModal.style.display = 'flex';

    if (_currentPort) {
      loadRobotSettings();
    } else {
      // No port — reset fields and capture initial state immediately
      _settingsFields.forEach(function(f) {
        var el = document.getElementById(f.id);
        if (el) { el.value = ''; el.placeholder = f.placeholder; el.disabled = false; }
      });
      _settingsInitialState = getSettingsState();
    }
  }

  function attemptCloseSettings() {
    if (settingsHaveChanged()) {
      if (!confirm('You have unsaved changes. Close without saving?')) return;
    }
    _settingsModal.style.display = 'none';
  }

  function queryRobotSetting(command) {
    return fetch(getServerUrl() + '/cmd/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, command: command })
    })
    .then(function(r) { return r.json(); })
    .catch(function() { return { success: false, response: '' }; });
  }

  function parseSettingResponse(response) {
    if (!response) return '';
    var eq = response.indexOf('=');
    return eq !== -1 ? response.slice(eq + 1).trim() : response.trim();
  }

  var _settingsFields = [
    { id: 'ctrl-settings-wifi-ssid', cmd: 'O162?', placeholder: 'WiFi network name', exboxOnly: true },
    { id: 'ctrl-settings-wifi-pass', cmd: 'O163?', placeholder: 'WiFi password', exboxOnly: true },
    { id: 'ctrl-settings-bt-name',   cmd: 'O150?', placeholder: 'Bluetooth device name', exboxOnly: true },
    { id: 'ctrl-settings-bt-pin',    cmd: 'O151?', placeholder: '4-digit PIN', exboxOnly: true, disabledPlaceholder: 'N/A' }
  ];

  function loadRobotSettings() {
    var versions = _portFirmwareVersions[_currentPort] || {};
    var hasExbox = !!versions.extender;

    // Show loading state on applicable fields, disable exbox-only fields if no exbox
    _settingsFields.forEach(function(f) {
      var el = document.getElementById(f.id);
      if (!el) return;
      if (f.exboxOnly && !hasExbox) {
        el.value = '';
        el.placeholder = f.disabledPlaceholder || 'Requires Extender Box';
        el.disabled = true;
        return;
      }
      el.value = '';
      el.placeholder = 'Loading...';
      el.disabled = true;
    });

    // Query sequentially so responses don't interleave on the serial line
    // Skip exbox-only fields if no extender box
    var chain = Promise.resolve();
    _settingsFields.forEach(function(f) {
      if (f.exboxOnly && !hasExbox) return;
      chain = chain.then(function() {
        return queryRobotSetting(f.cmd).then(function(r) {
          var el = document.getElementById(f.id);
          if (!el) return;
          el.value = r.success ? parseSettingResponse(r.response) : '';
          el.placeholder = f.placeholder;
          el.disabled = false;
        });
      });
    });

    chain.then(function() {
      _settingsInitialState = getSettingsState();
    });
  }

  function sendRobotCommand(command) {
    return fetch(getServerUrl() + '/cmd/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, command: command })
    })
    .then(function(r) { return r.json(); })
    .catch(function() {});
  }

  function saveRobotSettings() {
    var color    = document.getElementById('ctrl-settings-color').value;
    var wifiSsid = document.getElementById('ctrl-settings-wifi-ssid').value.trim();
    var wifiPass = document.getElementById('ctrl-settings-wifi-pass').value.trim();
    var btName   = document.getElementById('ctrl-settings-bt-name').value.trim();
    var btPin    = document.getElementById('ctrl-settings-bt-pin').value.trim();

    // Apply color to robot blocks and port select
    if (_currentPort) {
      var varName = getVarForPort(_currentPort);
      if (varName && typeof window.setRobotColorForVar === 'function') {
        window.setRobotColorForVar(varName, color);
      }
      updatePortSelectColor(_currentPort);
    }

    // Send O-codes for each non-empty field (only if extender box present)
    var versions = _portFirmwareVersions[_currentPort] || {};
    var hasExbox = !!versions.extender;
    if (hasExbox) {
      if (wifiSsid) sendRobotCommand('O162=' + wifiSsid);
      if (wifiPass) sendRobotCommand('O163=' + wifiPass);
      if (btName)   sendRobotCommand('O150=' + btName);
      if (btPin)    sendRobotCommand('O151=' + btPin);
    }

    _settingsInitialState = getSettingsState();
    _settingsModal.style.display = 'none';
  }

  function setupSettingsButton() {
    var btn = document.getElementById('ctrl-settings-btn');
    if (!btn) return;
    btn.addEventListener('click', openRobotSettings);
  }

  // ── Firmware Upload Modal ──

  var _firmwareModal  = null;
  var _flashType      = 'extender';  // 'extender' | 'robot'
  var _flashPollTimer = null;
  var _flashLastLine  = 0;
  var _selectedFirmwarePath = null;  // Path from native file dialog (Electron only)

  var _FLASH_CONFIGS = {
    extender: {
      title:    'Upload Extender Box Firmware',
      accept:   '.bin',
      btnLabel: 'Choose .bin file',
      alert:    'Please choose a .bin firmware file first.',
      endpoint: '/cmd/flash-firmware',
      fields: [
        { key: 'baud', label: 'Baud Rate', value: '460800', options: ['115200', '230400', '460800', '921600'] },
        { key: 'flash_mode', label: 'SPI Mode', value: 'qio', options: ['qio', 'qout', 'dio', 'dout'] },
        { key: 'flash_freq', label: 'SPI Speed', value: '80m', options: ['80m', '40m', '26m', '20m'] },
        { key: 'flash_size', label: 'Flash Size', value: '4MB', options: ['2MB', '4MB', '8MB', '16MB'] },
        { key: 'address', label: 'Start Address', value: '0x0', type: 'text' }
      ]
    },
    robot: {
      title:    'Upload Robot Arm Firmware',
      accept:   '.hex',
      btnLabel: 'Choose .hex file',
      alert:    'Please choose a .hex firmware file first.',
      endpoint: '/cmd/flash-arm-firmware',
      fields: [
        { key: 'device', label: 'Device', value: 'atmega2560', options: ['atmega2560', 'atmega328p', 'atmega1280'] },
        { key: 'baud', label: 'Baud Rate', value: '115200', options: ['57600', '115200', '230400'] },
        { key: 'programmer', label: 'Programmer', value: 'wiring', options: ['wiring', 'arduino', 'stk500v2'] }
      ]
    }
  };

  function buildFirmwareModal() {
    var overlay = document.createElement('div');
    overlay.id = 'ctrl-firmware-modal';
    overlay.className = 'ctrl-modal-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'ctrl-modal-dialog ctrl-fw-dialog';
    dialog.innerHTML =
      '<div class="ctrl-modal-header">' +
        '<span class="ctrl-modal-title">Upload Firmware</span>' +
        '<button class="ctrl-modal-close" id="ctrl-fw-close">&times;</button>' +
      '</div>' +
      '<div class="ctrl-modal-body">' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Flash Settings</div>' +
          '<div class="ctrl-settings-grid ctrl-fw-settings-grid" id="ctrl-fw-settings-grid">' +
            '<span class="ctrl-settings-label">COM Port</span>' +
            '<span class="ctrl-fw-value ctrl-fw-value-muted" id="ctrl-fw-port">Not set</span>' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title ctrl-fw-section-toggle" id="ctrl-fw-github-toggle">' +
            '<span class="ctrl-fw-toggle-arrow">&#9662;</span> Download from GitHub' +
          '</div>' +
          '<div class="ctrl-fw-github-section" id="ctrl-fw-github-section">' +
            '<div class="ctrl-fw-version-row">' +
              '<span class="ctrl-settings-label">Version</span>' +
              '<select class="ctrl-fw-version-select" id="ctrl-fw-version-select">' +
                '<option value="">Loading...</option>' +
              '</select>' +
            '</div>' +
            '<button class="ctrl-action-btn ctrl-btn-download-flash" id="ctrl-fw-download-btn">Download &amp; Flash</button>' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title ctrl-fw-section-toggle" id="ctrl-fw-local-toggle">' +
            '<span class="ctrl-fw-toggle-arrow">&#9656;</span> Upload Local File' +
          '</div>' +
          '<div class="ctrl-fw-local-section" id="ctrl-fw-local-section" style="display:none;">' +
            '<div class="ctrl-fw-file-row">' +
              '<button class="ctrl-action-btn ctrl-btn-choose-file" id="ctrl-fw-choose">Choose file</button>' +
              '<span class="ctrl-fw-filename" id="ctrl-fw-filename">No file selected</span>' +
              '<input type="file" id="ctrl-fw-file-input" accept=".bin" style="display:none">' +
            '</div>' +
            '<button class="ctrl-action-btn ctrl-btn-local-flash" id="ctrl-fw-upload">Flash Local File</button>' +
          '</div>' +
        '</div>' +
        '<div class="ctrl-settings-section">' +
          '<div class="ctrl-settings-section-title">Output</div>' +
          '<pre class="ctrl-fw-output" id="ctrl-fw-output">Ready.\n</pre>' +
        '</div>' +
      '</div>' +
      '<div class="ctrl-modal-footer">' +
        '<button class="ctrl-modal-btn ctrl-modal-btn-cancel" id="ctrl-fw-cancel">Close</button>' +
      '</div>';

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    // Wire up events
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeFirmwareModal();
    });
    document.getElementById('ctrl-fw-close').addEventListener('click', closeFirmwareModal);
    document.getElementById('ctrl-fw-cancel').addEventListener('click', closeFirmwareModal);
    document.getElementById('ctrl-fw-upload').addEventListener('click', startFlash);
    document.getElementById('ctrl-fw-download-btn').addEventListener('click', startGitHubFlash);

    document.getElementById('ctrl-fw-choose').addEventListener('click', function() {
      // Use Electron's native dialog to select firmware file
      // Falls back to HTML file input if not in Electron
      if (typeof require !== 'undefined') {
        try {
          var ipcRenderer = require('electron').ipcRenderer;
          ipcRenderer.invoke('dialog:selectFirmware', _flashType).then(function(result) {
            if (result) {
              _selectedFirmwarePath = result.path;
              document.getElementById('ctrl-fw-filename').textContent = result.name;
            }
          });
          return;
        } catch (e) {
          // Fall through to HTML file input
        }
      }
      document.getElementById('ctrl-fw-file-input').click();
    });
    document.getElementById('ctrl-fw-file-input').addEventListener('change', function() {
      var name = this.files.length ? this.files[0].name : 'No file selected';
      document.getElementById('ctrl-fw-filename').textContent = name;
      _selectedFirmwarePath = null; // Using file input, not path
    });

    // Toggle sections
    document.getElementById('ctrl-fw-github-toggle').addEventListener('click', function() {
      var section = document.getElementById('ctrl-fw-github-section');
      var arrow = this.querySelector('.ctrl-fw-toggle-arrow');
      var isOpen = section.style.display !== 'none';
      section.style.display = isOpen ? 'none' : '';
      arrow.innerHTML = isOpen ? '&#9656;' : '&#9662;';
    });
    document.getElementById('ctrl-fw-local-toggle').addEventListener('click', function() {
      var section = document.getElementById('ctrl-fw-local-section');
      var arrow = this.querySelector('.ctrl-fw-toggle-arrow');
      var isOpen = section.style.display !== 'none';
      section.style.display = isOpen ? 'none' : '';
      arrow.innerHTML = isOpen ? '&#9656;' : '&#9662;';
    });

    _firmwareModal = overlay;
  }

  function startGitHubFlash() {
    var select = document.getElementById('ctrl-fw-version-select');
    var selectedOpt = select.options[select.selectedIndex];
    if (!selectedOpt || !selectedOpt.dataset.url) {
      alert('Please select a firmware version first.');
      return;
    }
    var url = selectedOpt.dataset.url;
    startRemoteFlash(_currentPort, _flashType, url);
  }

  function loadFirmwareVersions() {
    var select = document.getElementById('ctrl-fw-version-select');
    select.innerHTML = '<option value="">Loading...</option>';

    fetch(getServerUrl() + '/cmd/list-firmware-versions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: _flashType, model: _currentModel })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      select.innerHTML = '';
      if (!data.success || !data.versions || data.versions.length === 0) {
        select.innerHTML = '<option value="">No versions available</option>';
        return;
      }
      var currentVer = null;
      var versions = _portFirmwareVersions[_currentPort] || {};
      if (_flashType === 'extender') {
        currentVer = versions.extender;
      } else {
        currentVer = versions.robot;
      }
      for (var i = 0; i < data.versions.length; i++) {
        var v = data.versions[i];
        var opt = document.createElement('option');
        opt.value = v.version;
        opt.dataset.url = v.url;
        var label = 'v' + v.version;
        if (i === 0) label += ' (Latest)';
        if (currentVer && v.version === currentVer) label += ' (Current)';
        opt.textContent = label;
        select.appendChild(opt);
      }
    })
    .catch(function() {
      select.innerHTML = '<option value="">Failed to load versions</option>';
    });
  }

  function openFirmwareModal(type) {
    if (!_firmwareModal) buildFirmwareModal();
    _flashType = (type === 'robot') ? 'robot' : 'extender';
    var cfg = _FLASH_CONFIGS[_flashType];

    // Reconfigure title
    _firmwareModal.querySelector('.ctrl-modal-title').textContent = cfg.title;

    // Reconfigure file picker
    document.getElementById('ctrl-fw-file-input').accept = cfg.accept;
    document.getElementById('ctrl-fw-choose').textContent = cfg.btnLabel;

    // Rebuild settings grid (COM Port row + config-specific fields)
    var grid = document.getElementById('ctrl-fw-settings-grid');
    var portVal   = _currentPort || 'Not set';
    var portClass = _currentPort ? 'ctrl-fw-value' : 'ctrl-fw-value ctrl-fw-value-muted';
    var devMode = isDeveloperMode();
    var html = '<span class="ctrl-settings-label">COM Port</span>' +
               '<span class="' + portClass + '" id="ctrl-fw-port">' + portVal + '</span>';

    for (var i = 0; i < cfg.fields.length; i++) {
      var f = cfg.fields[i];
      html += '<span class="ctrl-settings-label">' + f.label + '</span>';
      if (devMode) {
        if (f.options) {
          html += '<select class="ctrl-fw-field-select" data-key="' + f.key + '">';
          for (var j = 0; j < f.options.length; j++) {
            var sel = f.options[j] === f.value ? ' selected' : '';
            html += '<option value="' + f.options[j] + '"' + sel + '>' + f.options[j] + '</option>';
          }
          html += '</select>';
        } else {
          html += '<input type="text" class="ctrl-fw-field-input" data-key="' + f.key + '" value="' + f.value + '">';
        }
      } else {
        var displayVal = f.value;
        if (f.key === 'flash_freq') displayVal = f.value.replace('m', ' MHz');
        if (f.key === 'flash_size') displayVal = f.value.replace('MB', ' Mbit');
        html += '<span class="ctrl-fw-value">' + displayVal + '</span>';
      }
    }
    grid.innerHTML = html;

    // Reset state
    _selectedFirmwarePath = null;
    document.getElementById('ctrl-fw-file-input').value = '';
    document.getElementById('ctrl-fw-filename').textContent = 'No file selected';
    document.getElementById('ctrl-fw-output').textContent = 'Ready.\n';
    var uploadBtn = document.getElementById('ctrl-fw-upload');
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Flash Local File';
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    downloadBtn.disabled = false;
    downloadBtn.textContent = 'Download & Flash';

    // Reset section visibility (GitHub open, local closed)
    document.getElementById('ctrl-fw-github-section').style.display = '';
    document.getElementById('ctrl-fw-local-section').style.display = 'none';
    document.getElementById('ctrl-fw-github-toggle').querySelector('.ctrl-fw-toggle-arrow').innerHTML = '&#9662;';
    document.getElementById('ctrl-fw-local-toggle').querySelector('.ctrl-fw-toggle-arrow').innerHTML = '&#9656;';

    // Load available versions from GitHub
    loadFirmwareVersions();

    _firmwareModal.style.display = 'flex';
  }

  function closeFirmwareModal() {
    if (_flashPollTimer) { clearInterval(_flashPollTimer); _flashPollTimer = null; }
    if (_firmwareModal) _firmwareModal.style.display = 'none';
  }

  function appendFwOutput(text) {
    var out = document.getElementById('ctrl-fw-output');
    if (!out) return;
    out.textContent += text + '\n';
    out.scrollTop = out.scrollHeight;
  }

  function startFlash() {
    var cfg = _FLASH_CONFIGS[_flashType];
    var fileInput = document.getElementById('ctrl-fw-file-input');

    // Check if we have a file selected (either via native dialog or file input)
    var hasNativePath = !!_selectedFirmwarePath;
    var hasFileInput = fileInput.files && fileInput.files.length > 0;

    if (!hasNativePath && !hasFileInput) {
      alert(cfg.alert);
      return;
    }

    var uploadBtn = document.getElementById('ctrl-fw-upload');
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Flashing...';
    downloadBtn.disabled = true;

    var out = document.getElementById('ctrl-fw-output');
    out.textContent = 'Starting flash...\n';
    _flashLastLine = 0;

    // Collect field values (from editable inputs in dev mode, or defaults)
    var grid = document.getElementById('ctrl-fw-settings-grid');
    var fieldValues = {};
    for (var i = 0; i < cfg.fields.length; i++) {
      var f = cfg.fields[i];
      var el = grid.querySelector('[data-key="' + f.key + '"]');
      fieldValues[f.key] = el ? el.value : f.value;
    }

    // If we have a native path, use JSON endpoint; otherwise use FormData
    if (hasNativePath) {
      var payload = {
        file_path: _selectedFirmwarePath,
        port: _currentPort || ''
      };
      for (var key in fieldValues) {
        payload[key] = fieldValues[key];
      }
      fetch(getServerUrl() + cfg.endpoint + '-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      .then(function(r) { return r.json(); })
      .then(handleFlashResponse)
      .catch(handleFlashError);
      return;
    }

    // Use FormData for file upload
    var formData = new FormData();
    formData.append('file', fileInput.files[0]);
    formData.append('port', _currentPort || '');
    for (var key2 in fieldValues) {
      formData.append(key2, fieldValues[key2]);
    }

    fetch(getServerUrl() + cfg.endpoint, {
      method: 'POST',
      body: formData
    })
    .then(function(r) { return r.json(); })
    .then(handleFlashResponse)
    .catch(handleFlashError);
  }

  function handleFlashResponse(data) {
    var uploadBtn = document.getElementById('ctrl-fw-upload');
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    if (!data.success) {
      appendFwOutput('Error: ' + (data.error || 'Unknown error'));
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Flash Local File';
      downloadBtn.disabled = false;
      return;
    }
    pollFlashProgress(data.job_id, uploadBtn);
  }

  function handleFlashError(e) {
    var uploadBtn = document.getElementById('ctrl-fw-upload');
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    appendFwOutput('Error: ' + e.message);
    uploadBtn.disabled = false;
    uploadBtn.textContent = 'Flash Local File';
    downloadBtn.disabled = false;
  }

  function pollFlashProgress(jobId, activeBtn) {
    var downloadBtn = document.getElementById('ctrl-fw-download-btn');
    var uploadBtn = document.getElementById('ctrl-fw-upload');

    function resetButtons() {
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download & Flash';
      uploadBtn.disabled = false;
      uploadBtn.textContent = 'Flash Local File';
    }

    if (_flashPollTimer) clearInterval(_flashPollTimer);
    _flashPollTimer = setInterval(function() {
      fetch(getServerUrl() + '/cmd/flash-progress/' + jobId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) {
          clearInterval(_flashPollTimer);
          _flashPollTimer = null;
          resetButtons();
          return;
        }
        // Append only new lines since last poll
        for (var i = _flashLastLine; i < data.lines.length; i++) {
          appendFwOutput(data.lines[i]);
        }
        _flashLastLine = data.lines.length;

        if (data.done) {
          clearInterval(_flashPollTimer);
          _flashPollTimer = null;
          resetButtons();
          appendFwOutput(data.flash_success
            ? '\n[OK] Firmware uploaded successfully.'
            : '\n[FAILED] Flash failed. Check the output above.');
          if (data.flash_success) {
            // Clear cached version so onConnected re-fetches after reboot
            delete _portFirmwareVersions[_currentPort];
            var extEl = document.getElementById('ctrl-settings-ext-ver');
            var armEl = document.getElementById('ctrl-settings-arm-ver');
            if (extEl) extEl.textContent = '...';
            if (armEl) armEl.textContent = '...';
            if (typeof window.resetDetectorPort === 'function') {
              window.resetDetectorPort(_currentPort);
            }
          }
        }
      })
      .catch(function() {
        clearInterval(_flashPollTimer);
        _flashPollTimer = null;
        resetButtons();
      });
    }, 300);
  }

  function setupFirmwareButton() {
    var btn = document.getElementById('ctrl-firmware-btn');
    if (!btn) return;
    btn.addEventListener('click', openFirmwareModal);
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
    setupSettingsButton();
    updateSettingsButtonState();
    setupActionButtons();
    setupCaptureButton();
    setupEffectorSelect();
    buildAxisRows();
  }

  // Called when all ports disconnect or the current port is removed
  function onDisconnected(port) {
    // Clear cached firmware version so it re-checks on next connect
    if (port) {
      delete _portFirmwareVersions[port];
      delete _pendingUpdates[port];
    }

    _currentPort = null;
    _currentModel = null;
    updatePortSelectColor(null);
    updateSettingsButtonState();
    stopStatusPolling();

    // Close robot settings modal if open
    if (_settingsModal && _settingsModal.style.display !== 'none') {
      _settingsModal.style.display = 'none';
    }

    // Close firmware modal if open
    if (_firmwareModal && _firmwareModal.style.display !== 'none') {
      closeFirmwareModal();
    }

    // Remove any firmware update notification
    var panel = document.querySelector('.ctrl-panel');
    if (panel) {
      var bar = panel.querySelector('.ctrl-fw-update-bar');
      if (bar) bar.remove();
    }
  }

  // Expose for external use
  window.controlPanelRefresh = refreshStatus;
  window.controlPanelOnConnected = onConnected;
  window.controlPanelOnDisconnected = onDisconnected;
  window.controlPanelMarkStale = markStale;
  window.controlPanelCheckAndRefresh = checkAndRefresh;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 100);
  }
})();