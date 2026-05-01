/**
 * Teaching Panel Module
 * Provides robot jogging controls and a position list table.
 * Capture positions and replay them sequentially.
 */

(function() {
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
  MODELS['E4'] = MODELS['MT4'];

  var _currentMode = 'joint';
  var _currentPort = null;
  var _currentModel = null;
  var _stepSize = 10;
  var _actionList = [];
  var _selectedIdx = -1;
  var _playing = false;
  var _stopRequested = false;
  var _statusTimer = null;

  var AXIS_KEYS = ['x', 'y', 'z', 'a', 'b', 'c'];

  function getServerUrl() {
    return (typeof window.getServerUrl === 'function')
      ? window.getServerUrl() : 'http://127.0.0.1:5080';
  }

  function getModelConfig(model) {
    return MODELS[model] || MODELS['Mirobot'];
  }

  function getAxes() {
    return (_currentMode === 'joint')
      ? getModelConfig(_currentModel).joints
      : getModelConfig(_currentModel).coords;
  }

  function getModelForPort(port) {
    if (!port || !window.detectedPorts) return 'Mirobot';
    var map = window.detectedPorts;
    if (map[port]) {
      var val = map[port];
      if (typeof val === 'string') {
        if (val.indexOf('MT4') !== -1) return 'MT4';
        if (val.indexOf('E4') !== -1) return 'E4';
      }
    }
    return 'Mirobot';
  }

  function isMT4Model(model) {
    return model === 'MT4' || model === 'E4';
  }

  // ── Axis Rows ──

  function buildAxisRows() {
    var container = document.getElementById('teach-axis-rows');
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

  // ── Jog / Move ──

  function jog(sdkParam, step) {
    console.log('[TeachingPanel] Jog', sdkParam, step, 'port:', _currentPort);
    if (!_currentPort) return;
    fetch(getServerUrl() + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, mode: _currentMode, axis: sdkParam, step: step })
    }).catch(function() {});
  }

  function moveToAbsolute(sdkParam, value) {
    if (!_currentPort) return;
    fetch(getServerUrl() + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort, mode: _currentMode, axis: sdkParam, step: value, absolute: true })
    }).catch(function() {});
  }

  // ── Status Polling ──

  function refreshStatus() {
    if (!_currentPort) return;
    fetch(getServerUrl() + '/cmd/last-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: _currentPort })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) return;
      var container = document.getElementById('teach-axis-rows');
      if (!container) return;
      var rows = container.querySelectorAll('.ctrl-joint-row');
      var source = (_currentMode === 'joint') ? data.angles : data.coordinates;
      if (!source) return;
      rows.forEach(function(row) {
        var key = row.dataset.statusKey;
        var input = row.querySelector('.ctrl-joint-value');
        if (key && input && source[key] !== undefined && document.activeElement !== input) {
          input.value = parseFloat(source[key]).toFixed(2);
        }
      });
    })
    .catch(function() {});
  }

  function startStatusPolling() {
    stopStatusPolling();
    refreshStatus();
    _statusTimer = setInterval(refreshStatus, 500);
  }

  function stopStatusPolling() {
    if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  }

  // ── Mode Toggle ──

  function setMode(mode) {
    _currentMode = mode;
    var track = document.getElementById('teach-mode-switch');
    var labels = document.querySelectorAll('.teach-mode-label');

    if (mode === 'coord') {
      track.classList.add('toggled');
    } else {
      track.classList.remove('toggled');
    }
    labels.forEach(function(lbl) {
      lbl.classList.toggle('ctrl-mode-active', lbl.dataset.mode === mode);
    });
    buildAxisRows();
    refreshStatus();
  }

  // ── Port Select ──

  function setupPortSelect() {
    var select = document.getElementById('teach-port-select');
    if (!select) return;
    select.addEventListener('change', function() {
      var port = select.value;
      if (!port) return;
      _currentPort = port;
      _currentModel = null;
      var opt = select.options[select.selectedIndex];
      if (opt && opt.textContent) {
        if (opt.textContent.indexOf('Mirobot') !== -1) _currentModel = 'Mirobot';
        else if (opt.textContent.indexOf('MT4') !== -1) _currentModel = 'MT4';
        else if (opt.textContent.indexOf('E4') !== -1) _currentModel = 'E4';
      }
      if (!_currentModel) _currentModel = 'Mirobot';
      console.log('[TeachingPanel] Port selected:', _currentPort, 'Model:', _currentModel);
      buildAxisRows();
      startStatusPolling();
    });
  }

  // ── Step Size ──

  function setupStepControls() {
    var presets = document.querySelectorAll('.teach-step-preset');
    var stepInput = document.querySelector('.teach-step-input');

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
          presets.forEach(function(b) {
            b.classList.toggle('active', parseFloat(b.dataset.step) === _stepSize);
          });
        }
      });
    }
  }

  // ── Action Buttons (Home / Zero) ──

  function setupActionButtons() {
    var homeBtn = document.getElementById('teach-home-btn');
    var zeroBtn = document.getElementById('teach-zero-btn');
    if (homeBtn) {
      homeBtn.addEventListener('click', function() {
        console.log('[TeachingPanel] Home clicked, port:', _currentPort);
        if (!_currentPort) return;
        fetch(getServerUrl() + '/cmd/home', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: _currentPort })
        }).catch(function() {});
      });
    }
    if (zeroBtn) {
      zeroBtn.addEventListener('click', function() {
        if (!_currentPort) return;
        fetch(getServerUrl() + '/cmd/zero', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ port: _currentPort })
        }).catch(function() {});
      });
    }
  }

  // ── End Effector ──

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
    var select = document.getElementById('teach-effector-select');
    if (!select) return;
    select.addEventListener('change', function() { buildEffectorButtons(select.value); });
    buildEffectorButtons(select.value);
  }

  function buildEffectorButtons(type) {
    var container = document.getElementById('teach-effector-buttons');
    if (!container) return;
    container.innerHTML = '';
    var buttons = EFFECTORS[type] || [];
    for (var i = 0; i < buttons.length; i++) {
      (function(def) {
        var col = document.createElement('div');
        col.className = 'teach-eff-col';

        var btn = document.createElement('button');
        btn.className = 'ctrl-eff-btn';
        btn.textContent = def.label;
        btn.addEventListener('click', function() {
          if (!_currentPort) return;
          fetch(getServerUrl() + def.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ port: _currentPort, mode: def.mode })
          }).catch(function() {});
        });

        var addBtn = document.createElement('button');
        addBtn.className = 'teach-eff-add-btn';
        addBtn.textContent = '+ Add';
        addBtn.title = 'Add ' + def.label + ' action to list';
        addBtn.addEventListener('click', function() {
          if (!_currentPort) return;
          _actionList.push({
            port: _currentPort,
            model: _currentModel || 'Mirobot',
            type: 'effector',
            effectorType: def.endpoint === '/cmd/gripper' ? 'gripper' : 'pump',
            effectorMode: def.mode,
            effectorLabel: def.label
          });
          _selectedIdx = _actionList.length - 1;
          renderTable();
          var wrap = document.querySelector('.teach-table-wrap');
          if (wrap) wrap.scrollTop = wrap.scrollHeight;
        });

        col.appendChild(btn);
        col.appendChild(addBtn);
        container.appendChild(col);
      })(buttons[i]);
    }
  }

  // ── Selection helpers ──

  function selectRow(idx) {
    if (_selectedIdx === idx) return;
    _selectedIdx = idx;
    // Update row classes
    var rows = document.querySelectorAll('#teach-table-body tr');
    rows.forEach(function(r, i) {
      r.classList.toggle('teach-row-selected', i === idx);
      r.classList.remove('teach-row-editing');
    });
    updateToolbarButtons();
  }

  function updateToolbarButtons() {
    var hasSelection = _selectedIdx >= 0 && _selectedIdx < _actionList.length;
    var runStepBtn = document.getElementById('teach-run-step-btn');
    var upBtn = document.getElementById('teach-move-up-btn');
    var downBtn = document.getElementById('teach-move-down-btn');
    var delBtn = document.getElementById('teach-delete-btn');

    if (runStepBtn) runStepBtn.disabled = !hasSelection;
    if (upBtn) upBtn.disabled = !hasSelection || _selectedIdx === 0;
    if (downBtn) downBtn.disabled = !hasSelection || _selectedIdx >= _actionList.length - 1;
    if (delBtn) delBtn.disabled = !hasSelection;
  }

  // ── Action List Table ──

  function renderTable() {
    var tbody = document.getElementById('teach-table-body');
    var emptyMsg = document.getElementById('teach-empty-msg');
    if (!tbody) return;

    tbody.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = _actionList.length === 0 ? '' : 'none';

    // Clamp selection
    if (_selectedIdx >= _actionList.length) _selectedIdx = _actionList.length - 1;

    for (var i = 0; i < _actionList.length; i++) {
      (function(idx) {
        var action = _actionList[idx];
        var tr = document.createElement('tr');
        tr.id = 'teach-row-' + idx;

        if (idx === _selectedIdx) tr.classList.add('teach-row-selected');

        // Click to select row
        tr.addEventListener('click', function(e) {
          if (e.target.closest('.teach-row-btn')) return;
          selectRow(idx);
        });

        // # column
        var tdNum = document.createElement('td');
        tdNum.textContent = idx + 1;
        tr.appendChild(tdNum);

        if (action.type === 'delay') {
          // Delay row: spans all columns after #
          var tdDelayLabel = document.createElement('td');
          tdDelayLabel.colSpan = 9;
          tdDelayLabel.style.textAlign = 'left';
          tdDelayLabel.style.paddingLeft = '10px';
          var delaySpan = document.createElement('span');
          delaySpan.textContent = 'Delay ';
          delaySpan.style.fontWeight = '500';
          var delayInput = document.createElement('input');
          delayInput.type = 'number';
          delayInput.className = 'teach-cell-input';
          delayInput.style.width = '60px';
          delayInput.style.display = 'inline-block';
          delayInput.style.pointerEvents = 'auto';
          delayInput.min = '0.1';
          delayInput.step = '0.1';
          delayInput.value = action.delaySeconds;
          delayInput.addEventListener('change', function() {
            _actionList[idx].delaySeconds = parseFloat(delayInput.value) || 1;
          });
          var secSpan = document.createElement('span');
          secSpan.textContent = ' seconds';
          tdDelayLabel.appendChild(delaySpan);
          tdDelayLabel.appendChild(delayInput);
          tdDelayLabel.appendChild(secSpan);
          tr.appendChild(tdDelayLabel);
        } else if (action.type === 'effector') {
          // Effector action row: port + label spanning remaining columns
          var tdPort = document.createElement('td');
          tdPort.textContent = action.port;
          if (action.model) tdPort.textContent += ' (' + action.model + ')';
          tr.appendChild(tdPort);

          var tdLabel = document.createElement('td');
          tdLabel.colSpan = 8;
          tdLabel.style.fontWeight = '500';
          tdLabel.style.textAlign = 'left';
          tdLabel.style.paddingLeft = '10px';
          tdLabel.textContent = action.effectorLabel;
          tr.appendChild(tdLabel);
        } else {
          // Move action row
          // Port column
          var tdPort2 = document.createElement('td');
          tdPort2.textContent = action.port;
          if (action.model) tdPort2.textContent += ' (' + action.model + ')';
          tr.appendChild(tdPort2);

          // Mode column
          var tdMode = document.createElement('td');
          var modeSelect = document.createElement('select');
          modeSelect.className = 'teach-cell-select';
          var modes = [['Coordinate', 'coord'], ['Joint', 'joint']];
          for (var m = 0; m < modes.length; m++) {
            var mo = document.createElement('option');
            mo.value = modes[m][1];
            mo.textContent = modes[m][0];
            if (action.mode === modes[m][1]) mo.selected = true;
            modeSelect.appendChild(mo);
          }
          modeSelect.addEventListener('change', function() {
            _actionList[idx].mode = modeSelect.value;
            var motionSel = tr.querySelector('.teach-motion-select');
            if (motionSel) motionSel.disabled = (modeSelect.value === 'joint');
          });
          tdMode.appendChild(modeSelect);
          tr.appendChild(tdMode);

          // Motion column
          var tdMotion = document.createElement('td');
          var motionSelect = document.createElement('select');
          motionSelect.className = 'teach-cell-select teach-motion-select';
          var motions = [['Fast (G00)', '0'], ['Linear (G01)', '1'], ['Joint (G05)', '2']];
          for (var n = 0; n < motions.length; n++) {
            var mt = document.createElement('option');
            mt.value = motions[n][1];
            mt.textContent = motions[n][0];
            if (action.motionMode === motions[n][1]) mt.selected = true;
            motionSelect.appendChild(mt);
          }
          motionSelect.disabled = (action.mode === 'joint');
          motionSelect.addEventListener('change', function() {
            _actionList[idx].motionMode = motionSelect.value;
          });
          tdMotion.appendChild(motionSelect);
          tr.appendChild(tdMotion);

          // Axis value columns (X Y Z A B C)
          for (var k = 0; k < AXIS_KEYS.length; k++) {
            (function(key) {
              var td = document.createElement('td');
              var inp = document.createElement('input');
              inp.type = 'number';
              inp.className = 'teach-cell-input';
              inp.step = '0.01';
              inp.value = (action.values[key] !== undefined) ? action.values[key].toFixed(2) : '';
              if (isMT4Model(action.model) && (key === 'b' || key === 'c')) {
                inp.disabled = true;
                inp.value = '';
              }
              inp.addEventListener('change', function() {
                _actionList[idx].values[key] = parseFloat(inp.value) || 0;
              });
              td.appendChild(inp);
              tr.appendChild(td);
            })(AXIS_KEYS[k]);
          }
        }

        // Actions column (delete only)
        var tdActions = document.createElement('td');
        tdActions.className = 'teach-actions-cell';

        var delBtn = document.createElement('button');
        delBtn.className = 'teach-row-btn teach-row-btn-del';
        delBtn.title = 'Delete';
        delBtn.textContent = '\u2715';
        delBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          deleteRow(idx);
        });

        tdActions.appendChild(delBtn);
        tr.appendChild(tdActions);

        tbody.appendChild(tr);
      })(i);
    }

    updateToolbarButtons();
  }

  function moveRow(idx, direction) {
    var newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= _actionList.length) return;
    var temp = _actionList[idx];
    _actionList[idx] = _actionList[newIdx];
    _actionList[newIdx] = temp;
    _selectedIdx = newIdx;
    renderTable();
  }

  function deleteRow(idx) {
    _actionList.splice(idx, 1);
    if (_selectedIdx >= _actionList.length) _selectedIdx = _actionList.length - 1;
    renderTable();
  }

  // ── Capture Position ──

  function setupCaptureButton() {
    var btn = document.getElementById('teach-capture-btn');
    if (!btn) return;

    btn.addEventListener('click', function() {
      if (!_currentPort) return;

      var container = document.getElementById('teach-axis-rows');
      if (!container) return;

      var rows = container.querySelectorAll('.ctrl-joint-row');
      var values = {};
      rows.forEach(function(row) {
        var key = row.dataset.sdkParam;
        var input = row.querySelector('.ctrl-joint-value');
        if (key && input) values[key] = parseFloat(input.value) || 0;
      });

      // Fill missing keys with 0
      for (var i = 0; i < AXIS_KEYS.length; i++) {
        if (values[AXIS_KEYS[i]] === undefined) values[AXIS_KEYS[i]] = 0;
      }

      _actionList.push({
        port: _currentPort,
        model: _currentModel || 'Mirobot',
        mode: _currentMode,
        motionMode: '0',
        values: values
      });

      _selectedIdx = _actionList.length - 1;
      renderTable();

      // Scroll to bottom
      var wrap = document.querySelector('.teach-table-wrap');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    });
  }

  // ── Play ──

  function executeAction(action) {
    if (action.type === 'delay') {
      var ms = (action.delaySeconds || 1) * 1000;
      return new Promise(function(resolve) {
        setTimeout(function() {
          resolve({ json: function() { return Promise.resolve({ success: true }); } });
        }, ms);
      });
    }
    if (action.type === 'effector') {
      var endpoint = action.effectorType === 'gripper' ? '/cmd/gripper' : '/cmd/pump';
      return fetch(getServerUrl() + endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: action.port, mode: action.effectorMode })
      });
    }
    return fetch(getServerUrl() + '/cmd/jog', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        port: action.port,
        mode: action.mode,
        motion: action.motionMode,
        values: action.values
      })
    });
  }

  function playSingle(idx) {
    var action = _actionList[idx];
    if (!action) return;
    highlightRow(idx);

    executeAction(action)
    .then(function(r) { return r.json(); })
    .then(function() { clearHighlight(idx); })
    .catch(function() { clearHighlight(idx); });
  }

  function playAll() {
    if (_playing || _actionList.length === 0) return;
    _playing = true;
    _stopRequested = false;

    var playBtn = document.getElementById('teach-play-btn');
    var stopBtn = document.getElementById('teach-stop-btn');
    if (playBtn) playBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;

    function runStep(idx) {
      if (_stopRequested || idx >= _actionList.length) {
        _playing = false;
        if (playBtn) playBtn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        clearAllHighlights();
        return;
      }

      var action = _actionList[idx];
      highlightRow(idx);

      executeAction(action)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) {
          clearHighlight(idx);
          runStep(idx + 1);
          return;
        }
        // Effector/delay actions don't need to wait for idle
        if (action.type === 'effector' || action.type === 'delay') {
          clearHighlight(idx);
          runStep(idx + 1);
          return;
        }
        // Wait for idle before next step
        waitIdle(action.port, function() {
          clearHighlight(idx);
          runStep(idx + 1);
        });
      })
      .catch(function() {
        clearHighlight(idx);
        runStep(idx + 1);
      });
    }

    runStep(0);
  }

  function waitIdle(port, callback) {
    var checkInterval = setInterval(function() {
      if (_stopRequested) {
        clearInterval(checkInterval);
        callback();
        return;
      }
      fetch(getServerUrl() + '/cmd/last-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: port })
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!data.success) { clearInterval(checkInterval); callback(); return; }
        var state = data.state || '';
        if (state.toLowerCase().indexOf('idle') !== -1 || state.toLowerCase().indexOf('alarm') !== -1) {
          clearInterval(checkInterval);
          callback();
        }
      })
      .catch(function() { clearInterval(checkInterval); callback(); });
    }, 300);
  }

  function stopPlayback() {
    _stopRequested = true;
  }

  function highlightRow(idx) {
    var row = document.getElementById('teach-row-' + idx);
    if (row) row.classList.add('teach-row-active');
  }

  function clearHighlight(idx) {
    var row = document.getElementById('teach-row-' + idx);
    if (row) row.classList.remove('teach-row-active');
  }

  function clearAllHighlights() {
    var rows = document.querySelectorAll('.teach-row-active');
    rows.forEach(function(r) { r.classList.remove('teach-row-active'); });
  }

  // ── Export / Import ──

  function exportList() {
    if (_actionList.length === 0) return;
    var json = JSON.stringify(_actionList, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'teaching-positions.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function importList() {
    var fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.json';
    fileInput.addEventListener('change', function() {
      if (!fileInput.files.length) return;
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var data = JSON.parse(e.target.result);
          if (!Array.isArray(data)) { alert('Invalid file format'); return; }

          // Collect unique port+model pairs from the imported data (skip delay actions)
          var portMap = {};
          for (var i = 0; i < data.length; i++) {
            var item = data[i];
            if (item.type === 'delay' || !item.port) continue;
            var key = item.port;
            if (!portMap[key]) {
              portMap[key] = item.model || 'Mirobot';
            }
          }

          var portKeys = Object.keys(portMap);
          if (portKeys.length === 0) {
            // No port-dependent actions (e.g. all delays), just import
            _actionList = data;
            _selectedIdx = -1;
            renderTable();
            return;
          }

          // Show port mapping dialog
          showPortMappingDialog(portKeys, portMap, function(mapping) {
            // Apply mapping to all actions
            for (var j = 0; j < data.length; j++) {
              if (data[j].type === 'delay' || !data[j].port) continue;
              var mapped = mapping[data[j].port];
              if (mapped) {
                data[j].port = mapped.port;
                data[j].model = mapped.model;
              }
            }
            _actionList = data;
            _selectedIdx = -1;
            renderTable();
          });
        } catch (err) {
          alert('Invalid file format');
        }
      };
      reader.readAsText(fileInput.files[0]);
    });
    fileInput.click();
  }

  function getAvailablePorts() {
    var select = document.getElementById('teach-port-select');
    if (!select) return [];
    var ports = [];
    for (var i = 0; i < select.options.length; i++) {
      var opt = select.options[i];
      if (opt.disabled || !opt.value) continue;
      var model = 'Mirobot';
      if (opt.textContent.indexOf('MT4') !== -1) model = 'MT4';
      else if (opt.textContent.indexOf('E4') !== -1) model = 'E4';
      ports.push({ port: opt.value, label: opt.textContent, model: model });
    }
    return ports;
  }

  function showPortMappingDialog(portKeys, portModelMap, onConfirm) {
    var availPorts = getAvailablePorts();
    var bypassChecked = false;

    function cleanup() { if (overlay.parentNode) document.body.removeChild(overlay); }

    var overlay = document.createElement('div');
    overlay.className = 'port-picker-overlay';
    overlay.addEventListener('click', function(e) { if (e.target === overlay) cleanup(); });

    var dialog = document.createElement('div');
    dialog.className = 'port-picker-dialog';
    dialog.style.width = '480px';

    // Header
    var header = document.createElement('div');
    header.className = 'port-picker-header';
    header.innerHTML = '<span>Map Ports</span>';
    var closeBtn = document.createElement('button');
    closeBtn.className = 'port-picker-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.onclick = cleanup;
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    // Body
    var body = document.createElement('div');
    body.className = 'port-picker-body';
    body.style.maxHeight = '400px';
    body.style.overflowY = 'auto';

    var desc = document.createElement('div');
    desc.style.cssText = 'font-size:13px;color:var(--text-secondary);margin-bottom:12px;';
    desc.textContent = 'The imported file references the following ports. Select which connected port to use for each:';
    body.appendChild(desc);

    var selects = {};

    for (var k = 0; k < portKeys.length; k++) {
      (function(origPort) {
        var expectedModel = portModelMap[origPort];

        var row = document.createElement('div');
        row.style.cssText = 'margin-bottom:10px;';

        var label = document.createElement('div');
        label.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:4px;color:var(--text-primary);';
        label.textContent = origPort + ' (' + expectedModel + ')';
        row.appendChild(label);

        var sel = document.createElement('select');
        sel.style.cssText = 'width:100%;padding:6px 8px;font-size:13px;border:1px solid var(--border-primary);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);';
        sel.dataset.expectedModel = expectedModel;

        function populateSelect() {
          var curVal = sel.value;
          sel.innerHTML = '';
          var hasMatch = false;
          for (var p = 0; p < availPorts.length; p++) {
            var ap = availPorts[p];
            var modelMatch = (ap.model === expectedModel);
            if (!bypassChecked && !modelMatch) continue;
            var opt = document.createElement('option');
            opt.value = ap.port;
            opt.textContent = ap.label;
            if (!modelMatch) opt.textContent += ' [different model]';
            sel.appendChild(opt);
            hasMatch = true;
          }
          if (!hasMatch) {
            var none = document.createElement('option');
            none.value = '';
            none.textContent = 'No matching port available';
            none.disabled = true;
            sel.appendChild(none);
          }
          // Restore selection
          if (curVal) {
            for (var r = 0; r < sel.options.length; r++) {
              if (sel.options[r].value === curVal) { sel.selectedIndex = r; break; }
            }
          }
        }

        populateSelect();
        selects[origPort] = { select: sel, populate: populateSelect };
        row.appendChild(sel);
        body.appendChild(row);
      })(portKeys[k]);
    }

    // Bypass checkbox
    var cbRow = document.createElement('div');
    cbRow.style.cssText = 'margin-top:8px;display:flex;align-items:center;gap:6px;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'teach-import-bypass';
    var cbLabel = document.createElement('label');
    cbLabel.htmlFor = 'teach-import-bypass';
    cbLabel.style.cssText = 'font-size:12px;color:var(--text-secondary);cursor:pointer;';
    cbLabel.textContent = 'Show all ports (ignore model restriction)';
    cb.addEventListener('change', function() {
      bypassChecked = cb.checked;
      for (var key in selects) {
        selects[key].populate();
      }
    });
    cbRow.appendChild(cb);
    cbRow.appendChild(cbLabel);
    body.appendChild(cbRow);

    dialog.appendChild(body);

    // Footer
    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--border-faint);';

    var cancelBtn = document.createElement('button');
    cancelBtn.className = 'port-picker-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'padding:6px 16px;border:1px solid var(--border-primary);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);cursor:pointer;font-size:13px;';
    cancelBtn.onclick = cleanup;
    footer.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Import';
    confirmBtn.style.cssText = 'padding:6px 16px;border:1px solid #388E3C;border-radius:4px;background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;font-weight:500;';
    confirmBtn.addEventListener('click', function() {
      var mapping = {};
      for (var key in selects) {
        var s = selects[key].select;
        if (s.value) {
          var selectedModel = 'Mirobot';
          var txt = s.options[s.selectedIndex].textContent;
          if (txt.indexOf('MT4') !== -1) selectedModel = 'MT4';
          else if (txt.indexOf('E4') !== -1) selectedModel = 'E4';
          mapping[key] = { port: s.value, model: selectedModel };
        }
      }
      cleanup();
      onConfirm(mapping);
    });
    footer.appendChild(confirmBtn);

    dialog.appendChild(footer);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // ── Export to Blockly ──

  var MODEL_TO_BLOCK_VALUE = {
    'Mirobot': 'Mirobot_UART',
    'MT4': 'MT4_UART',
    'E4': 'MT4_UART'
  };

  function getUniqueVarName(ws, base) {
    var existing = new Set();
    var allVars = ws.getAllVariables();
    for (var i = 0; i < allVars.length; i++) {
      existing.add(allVars[i].name);
    }
    var n = 0;
    while (existing.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  function exportToBlockly() {
    if (_actionList.length === 0) return;

    var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
    if (!ws) {
      alert('Please select a workspace in the Blockly tab before exporting.');
      return;
    }

    // Group actions by port, preserving order
    var portOrder = [];
    var portActions = {};
    for (var i = 0; i < _actionList.length; i++) {
      var action = _actionList[i];
      if (action.type === 'delay') continue;
      var port = action.port;
      if (!portActions[port]) {
        portActions[port] = { model: action.model || 'Mirobot' };
        portOrder.push(port);
      }
    }

    // Create a variable + setup_robot block per port
    var portVarNames = {};
    var portVarIds = {};
    for (var p = 0; p < portOrder.length; p++) {
      var port = portOrder[p];
      var varName = getUniqueVarName(ws, 'temp_name');
      portVarNames[port] = varName;
      var varModel = ws.createVariable(varName);
      portVarIds[port] = varModel.getId();
    }

    // Build chain of blocks
    var allBlocks = [];

    // First: setup_robot blocks
    for (var s = 0; s < portOrder.length; s++) {
      allBlocks.push({
        blockType: 'setup_robot',
        port: portOrder[s],
        model: portActions[portOrder[s]].model,
        varName: portVarNames[portOrder[s]]
      });
    }

    // Then: action blocks in order
    for (var a = 0; a < _actionList.length; a++) {
      allBlocks.push(_actionList[a]);
    }

    // Create blocks on workspace
    var prevBlock = null;
    var startX = 20;
    var startY = 20;

    // Find an empty area on the workspace
    var existingBlocks = ws.getTopBlocks(false);
    if (existingBlocks.length > 0) {
      var maxY = 0;
      for (var eb = 0; eb < existingBlocks.length; eb++) {
        var xy = existingBlocks[eb].getRelativeToSurfaceXY();
        var h = existingBlocks[eb].getHeightWidth().height;
        if (xy.y + h > maxY) maxY = xy.y + h;
      }
      startY = maxY + 40;
    }

    for (var b = 0; b < allBlocks.length; b++) {
      var item = allBlocks[b];
      var block = null;

      if (item.blockType === 'setup_robot') {
        block = ws.newBlock('setup_robot');
        block.setFieldValue(portVarIds[item.port], 'VARIABLE');
        block.setFieldValue(MODEL_TO_BLOCK_VALUE[item.model] || 'Mirobot_UART', 'MODEL');
        block.setFieldValue(item.port, 'PORT');
        block.initSvg();
        block.render();
      } else if (item.type === 'delay') {
        block = ws.newBlock('robot_delay');
        block.initSvg();
        block.render();
        // Set delay value via a math_number shadow block
        var numBlock = ws.newBlock('math_number');
        numBlock.setFieldValue(String(item.delaySeconds || 1), 'NUM');
        numBlock.initSvg();
        numBlock.render();
        var timeInput = block.getInput('TIME');
        if (timeInput && timeInput.connection) {
          timeInput.connection.connect(numBlock.outputConnection);
        }
      } else if (item.type === 'effector') {
        var varName = portVarNames[item.port] || 'robot';
        if (item.effectorType === 'gripper') {
          block = ws.newBlock('robot_gripper');
        } else {
          block = ws.newBlock('robot_pump');
        }
        block.setFieldValue(varName, 'VARIABLE');
        block.setFieldValue(String(item.effectorMode), 'MODE');
        block.initSvg();
        block.render();
      } else {
        // Move action (coord or joint)
        var varName2 = portVarNames[item.port] || 'robot';
        var axisKeys = ['X', 'Y', 'Z', 'A', 'B', 'C'];
        var numAxes = isMT4Model(item.model) ? 4 : 6;

        if (item.mode === 'coord') {
          block = ws.newBlock('write_coordinate');
          block.setFieldValue(varName2, 'VARIABLE');
          block.setFieldValue(item.motionMode || '0', 'MOTION');
          block.setFieldValue('0', 'POSITION');
        } else {
          block = ws.newBlock('write_angle');
          block.setFieldValue(varName2, 'VARIABLE');
          block.setFieldValue('0', 'POSITION');
        }
        block.initSvg();
        block.render();

        // Set axis values
        for (var ax = 0; ax < numAxes; ax++) {
          var key = axisKeys[ax];
          var val = (item.values && item.values[key.toLowerCase()] !== undefined)
            ? item.values[key.toLowerCase()] : 0;
          var axisInput = block.getInput('AXIS_' + key);
          if (axisInput && axisInput.connection) {
            var numBlk = ws.newBlock('math_number');
            numBlk.setFieldValue(String(val), 'NUM');
            numBlk.initSvg();
            numBlk.render();
            axisInput.connection.connect(numBlk.outputConnection);
          }
        }
      }

      if (block) {
        if (prevBlock) {
          prevBlock.nextConnection.connect(block.previousConnection);
        } else {
          block.moveBy(startX, startY);
        }
        prevBlock = block;
      }
    }

    // Switch to blockly tab
    var blocklyTab = document.querySelector('.sidebar-tab[data-tab="blockly"]');
    if (blocklyTab) blocklyTab.click();
  }

  // ── Toolbar ──

  function setupToolbar() {
    var playBtn = document.getElementById('teach-play-btn');
    var runStepBtn = document.getElementById('teach-run-step-btn');
    var stopBtn = document.getElementById('teach-stop-btn');
    var upBtn = document.getElementById('teach-move-up-btn');
    var downBtn = document.getElementById('teach-move-down-btn');
    var delBtn = document.getElementById('teach-delete-btn');
    var clearBtn = document.getElementById('teach-clear-btn');
    var exportBtn = document.getElementById('teach-export-btn');
    var importBtn = document.getElementById('teach-import-btn');

    if (playBtn) playBtn.addEventListener('click', playAll);
    if (runStepBtn) runStepBtn.addEventListener('click', function() {
      if (_selectedIdx >= 0 && _selectedIdx < _actionList.length) {
        playSingle(_selectedIdx);
      }
    });
    if (stopBtn) stopBtn.addEventListener('click', stopPlayback);
    if (upBtn) upBtn.addEventListener('click', function() {
      if (_selectedIdx > 0) moveRow(_selectedIdx, -1);
    });
    if (downBtn) downBtn.addEventListener('click', function() {
      if (_selectedIdx >= 0 && _selectedIdx < _actionList.length - 1) moveRow(_selectedIdx, 1);
    });
    if (delBtn) delBtn.addEventListener('click', function() {
      if (_selectedIdx >= 0 && _selectedIdx < _actionList.length) deleteRow(_selectedIdx);
    });
    var addDelayBtn = document.getElementById('teach-add-delay-btn');
    if (addDelayBtn) addDelayBtn.addEventListener('click', function() {
      _actionList.push({
        type: 'delay',
        delaySeconds: 1
      });
      _selectedIdx = _actionList.length - 1;
      renderTable();
      var wrap = document.querySelector('.teach-table-wrap');
      if (wrap) wrap.scrollTop = wrap.scrollHeight;
    });
    if (clearBtn) clearBtn.addEventListener('click', function() {
      if (_actionList.length === 0) return;
      _actionList = [];
      _selectedIdx = -1;
      renderTable();
    });
    if (exportBtn) exportBtn.addEventListener('click', exportList);
    if (importBtn) importBtn.addEventListener('click', importList);

    var toBlocklyBtn = document.getElementById('teach-to-blockly-btn');
    if (toBlocklyBtn) toBlocklyBtn.addEventListener('click', exportToBlockly);
  }

  // ── Init ──

  function init() {
    console.log('[TeachingPanel] Initializing...');
    setupPortSelect();
    setupStepControls();
    setupActionButtons();
    setupCaptureButton();
    setupEffectorSelect();
    setupToolbar();
    buildAxisRows();
    renderTable();

    // Mode toggle
    var track = document.getElementById('teach-mode-switch');
    var labels = document.querySelectorAll('.teach-mode-label');
    if (track) {
      track.addEventListener('click', function() {
        setMode(_currentMode === 'joint' ? 'coord' : 'joint');
      });
    }
    labels.forEach(function(lbl) {
      lbl.addEventListener('click', function() { setMode(lbl.dataset.mode); });
    });
  }

  // Run init when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for device detector
  window.teachingPanelOnConnected = function(port, model) {
    if (!_currentPort) {
      _currentPort = port;
      _currentModel = model;
      buildAxisRows();
      startStatusPolling();
    }
  };

  window.teachingPanelOnDisconnected = function() {
    _currentPort = null;
    _currentModel = null;
    stopStatusPolling();
  };
})();