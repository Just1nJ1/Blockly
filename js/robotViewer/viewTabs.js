// View & panel tab switching, 3D viewer creation, and initialization.
// Uses the Three.js-based RobotViewer from wlkata_arm_virtual-reality.
// Depends on: codeAnalysis.js, animation.js, worldViewer.js, worldAnimation.js
// Exposes: window.updateRobotTabs, window._robotViewer

(function() {
  var workspaceArea = document.getElementById('workspace-area');
  var modelArea = document.getElementById('model-area');
  var viewerCanvas = document.getElementById('viewer-canvas');
  var worldCanvas = document.getElementById('world-canvas');

  var currentRobotVars = [];
  var currentVariableName = null;  // active individual variable (null when in world/workspace)
  var currentMode = 'workspace';   // 'workspace' | 'individual' | 'world'
  var lastMovesSignatures = {};
  var viewerInstance = null;        // single shared RobotViewer for individual tabs
  var modelLoaded = false;
  var initializedVars = {};

  // World tab state
  var worldProgressEl = null;
  var worldProgressCreated = false;

  // Will be populated once RobotAnimation is available
  var RA = null;

  function ensureRA() {
    if (!RA && window.RobotAnimation) {
      RA = window.RobotAnimation;
    }
    return RA;
  }

  // ── Viewer control panel (bound to HTML elements) ─────────────

  var playBtn = document.getElementById('anim-play-btn');
  var pauseBtn = document.getElementById('anim-pause-btn');
  var stopBtn = document.getElementById('anim-stop-btn');
  var loopToggleBtn = document.getElementById('loop-toggle-btn');

  // ── Playback button handlers ──

  function startIndividualPlayback() {
    if (!currentVariableName || !RA) return;
    var st = RA.getVariableState(currentVariableName);
    if (st.pausedState && !st.animationDone) {
      // Resume from where we paused (mid-move or between moves)
      RA.resumeVarAnimation(currentVariableName);
    } else {
      // Fresh start (either first play or replay after done)
      st.moveIndex = 0;
      st.pausedState = null;
      st.animationDone = false;
      if (window._robotViewer) window._robotViewer.setJoints([0, 0, 0, 0, 0, 0]);
      st.savedJoints = [0, 0, 0, 0, 0, 0];
      RA.startVarAnimation(currentVariableName, null);
    }
    updatePlaybackButtons();
  }

  if (playBtn) {
    playBtn.addEventListener('click', function() {
      if (currentMode === 'world') {
        var WA = window.WorldAnimation;
        if (!WA) return;
        // Ensure dry-run is fresh so loops are unrolled before world play
        var startWorld = function() {
          if (WA.isPaused()) {
            WA.resume();
          } else {
            WA.start();
          }
          updatePlaybackButtons();
        };
        if (typeof window.refreshRecordedMoves === 'function') {
          window.refreshRecordedMoves().then(startWorld).catch(startWorld);
        } else {
          startWorld();
        }
      } else if (currentMode === 'individual') {
        ensureRA();
        if (!currentVariableName || !RA) return;
        // Prefer unrolled dry-run moves (handles while/for loops)
        if (typeof window.refreshRecordedMoves === 'function') {
          window.refreshRecordedMoves().then(function() {
            startIndividualPlayback();
          }).catch(function() {
            startIndividualPlayback();
          });
        } else {
          startIndividualPlayback();
        }
      }
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', function() {
      if (currentMode === 'world') {
        var WA = window.WorldAnimation;
        if (WA) WA.pause();
      } else if (currentMode === 'individual') {
        if (currentVariableName && RA) {
          RA.pauseVarAnimation(currentVariableName);
        }
      }
      updatePlaybackButtons();
    });
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', function() {
      if (currentMode === 'world') {
        var WA = window.WorldAnimation;
        if (WA) WA.stop();
      } else if (currentMode === 'individual') {
        if (currentVariableName && RA) {
          RA.stopVarAnimation(currentVariableName);
        }
      }
      updatePlaybackButtons();
    });
  }

  if (loopToggleBtn) {
    loopToggleBtn.addEventListener('click', function() {
      if (currentMode === 'world') {
        var WA = window.WorldAnimation;
        if (!WA) return;
        var newLoop = !WA.isLoopEnabled();
        WA.setLoop(newLoop);
        updateLoopToggle(newLoop);
      } else if (currentMode === 'individual') {
        if (!currentVariableName || !RA) return;
        var st = RA.getVariableState(currentVariableName);
        var newLoop = !st.loopEnabled;
        RA.setLoopEnabled(currentVariableName, newLoop);
        updateLoopToggle(newLoop);
      }
      updatePlaybackButtons();
    });
  }

  /**
   * Update the enabled/active state of play/pause/stop buttons
   * based on current animation state.
   */
  function updatePlaybackButtons() {
    if (!playBtn || !pauseBtn || !stopBtn) return;

    var isPlaying = false;
    var isPaused = false;
    var isStopped = true;

    if (currentMode === 'world') {
      var WA = window.WorldAnimation;
      if (WA) {
        isPlaying = WA.isRunning() && !WA.isPaused();
        isPaused = WA.isPaused();
        isStopped = !WA.isRunning() && !WA.isPaused();
      }
    } else if (currentMode === 'individual') {
      if (currentVariableName && RA) {
        var st = RA.getVariableState(currentVariableName);
        // Running = has an active timer or rAF, not paused, not done
        var hasTimer = st.animationTimer !== null || st.animRafId !== null;
        isPaused = st.pausedState !== null && !hasTimer;
        isPlaying = hasTimer && !st.animationDone;
        isStopped = !isPlaying && !isPaused;
      }
    }

    // Play: enabled when stopped or paused, highlighted when playing
    playBtn.disabled = isPlaying;
    if (isPlaying) {
      playBtn.classList.add('active');
    } else {
      playBtn.classList.remove('active');
    }

    // Pause: enabled only when playing
    pauseBtn.disabled = !isPlaying;

    // Stop: enabled when playing or paused
    stopBtn.disabled = isStopped;
  }

  function updateLoopToggle(loopEnabled) {
    if (!loopToggleBtn) return;
    if (loopEnabled) {
      loopToggleBtn.textContent = 'ON';
      loopToggleBtn.classList.add('active');
    } else {
      loopToggleBtn.textContent = 'OFF';
      loopToggleBtn.classList.remove('active');
    }
  }

  // ── World robot checklist ───────────────────────────────────────

  var worldRobotsSection = document.getElementById('world-robots-section');
  var worldRobotList = document.getElementById('world-robot-list');

  /**
   * Get the model type for a variable name from the Blockly workspace.
   * Returns 'Mirobot', 'MT4', 'E4', or 'Unknown'.
   */
  function getRobotModel(varName) {
    if (typeof getRobotModelForVarName === 'function') {
      return getRobotModelForVarName(varName) || 'Unknown';
    }
    return 'Unknown';
  }

  /**
   * Build/rebuild the robot checklist in the side panel for world mode.
   */
  function updateWorldRobotList() {
    if (!worldRobotList) return;
    var WV = window.WorldViewer;
    var WA = window.WorldAnimation;
    worldRobotList.innerHTML = '';

    for (var i = 0; i < currentRobotVars.length; i++) {
      var varName = currentRobotVars[i];
      var model = getRobotModel(varName);
      var isVisible = WV ? WV.isRobotVisible(varName) : true;

      var item = document.createElement('div');
      item.className = 'world-robot-item';
      item.dataset.varName = varName;

      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = isVisible;
      checkbox.id = 'world-robot-cb-' + varName;
      checkbox.dataset.varName = varName;

      var label = document.createElement('span');
      label.className = 'world-robot-label';
      label.innerHTML = varName + ' <span class="world-robot-model">(' + model + ')</span>';

      // Toggle visibility when checkbox changes
      (function(vName, cb) {
        cb.addEventListener('change', function(e) {
          e.stopPropagation();
          if (WV) {
            WV.setRobotVisible(vName, cb.checked);
            // If we just hid the currently-selected robot, deselect it
            if (!cb.checked && WV.getSelectedRobot() === vName) {
              WV.selectRobot(null);
            }
          }
          updatePlaybackButtons();
        });
      })(varName, checkbox);

      // Click row (not checkbox) to select the robot in the 3D scene
      (function(vName) {
        item.addEventListener('click', function(e) {
          // Don't select when clicking the checkbox itself
          if (e.target.tagName === 'INPUT') return;
          if (WV) {
            // Only allow selecting visible robots
            if (!WV.isRobotVisible(vName)) return;
            var current = WV.getSelectedRobot();
            WV.selectRobot(current === vName ? null : vName);
          }
        });
      })(varName);

      item.appendChild(checkbox);
      item.appendChild(label);
      worldRobotList.appendChild(item);
    }

    // Register for selection-change events from the 3D scene
    if (WV) {
      WV.setOnSelectionChange(onRobotSelectionChanged);
    }
  }

  /**
   * Called when the selected robot changes (from 3D click or panel click).
   * Syncs checklist highlight and properties panel.
   */
  function onRobotSelectionChanged(selectedVarName) {
    // Sync checklist highlight
    if (worldRobotList) {
      var items = worldRobotList.querySelectorAll('.world-robot-item');
      items.forEach(function(item) {
        if (item.dataset.varName === selectedVarName) {
          item.classList.add('selected');
        } else {
          item.classList.remove('selected');
        }
      });
    }
    // Show/hide and populate properties panel
    updatePropertiesPanel(selectedVarName);
  }

  // ── Robot properties panel ────────────────────────────────────

  var propsSection = document.getElementById('robot-properties-section');
  var propsRobotName = document.getElementById('props-robot-name');
  var propX = document.getElementById('prop-x');
  var propY = document.getElementById('prop-y');
  var propZ = document.getElementById('prop-z');
  var propRotZ = document.getElementById('prop-rot-z');
  var propsUpdating = false; // guard to avoid feedback loops

  function updatePropertiesPanel(varName) {
    if (!propsSection) return;
    if (!varName) {
      propsSection.style.display = 'none';
      return;
    }

    var WV = window.WorldViewer;
    if (!WV) return;

    propsSection.style.display = '';
    if (propsRobotName) propsRobotName.textContent = varName;

    var pose = WV.getRobotPose(varName);
    propsUpdating = true;
    if (propX) propX.value = parseFloat(pose.x.toFixed(3));
    if (propY) propY.value = parseFloat(pose.y.toFixed(3));
    if (propZ) propZ.value = parseFloat(pose.z.toFixed(3));
    if (propRotZ) propRotZ.value = parseFloat(pose.rotZ.toFixed(1));
    propsUpdating = false;
  }

  function onPropInput() {
    if (propsUpdating) return;
    var WV = window.WorldViewer;
    var sel = WV ? WV.getSelectedRobot() : null;
    if (!sel) return;

    WV.setRobotPose(sel, {
      x: propX ? parseFloat(propX.value) || 0 : 0,
      y: propY ? parseFloat(propY.value) || 0 : 0,
      z: propZ ? parseFloat(propZ.value) || 0 : 0,
      rotZ: propRotZ ? parseFloat(propRotZ.value) || 0 : 0
    });
  }

  if (propX) propX.addEventListener('input', onPropInput);
  if (propY) propY.addEventListener('input', onPropInput);
  if (propZ) propZ.addEventListener('input', onPropInput);
  if (propRotZ) propRotZ.addEventListener('input', onPropInput);

  // ── Unity-style drag-to-adjust on property labels ─────────────

  // Sensitivity: how many pixels of drag = one step increment
  var DRAG_PX_PER_STEP = 4;

  // Map each label's data-target to its input element and step size
  var dragTargets = {
    'prop-x':     { input: propX,    step: 0.01 },
    'prop-y':     { input: propY,    step: 0.01 },
    'prop-z':     { input: propZ,    step: 0.01 },
    'prop-rot-z': { input: propRotZ, step: 1 }
  };

  var dragState = null; // { label, input, step, startX, startValue }

  function onDragPointerDown(e) {
    var label = e.currentTarget;
    var targetId = label.dataset.target;
    var cfg = dragTargets[targetId];
    if (!cfg || !cfg.input) return;

    e.preventDefault();
    label.classList.add('dragging');
    label.setPointerCapture(e.pointerId);

    dragState = {
      label: label,
      input: cfg.input,
      step: cfg.step,
      startX: e.clientX,
      startValue: parseFloat(cfg.input.value) || 0,
      pointerId: e.pointerId
    };
  }

  function onDragPointerMove(e) {
    if (!dragState) return;
    e.preventDefault();

    var dx = e.clientX - dragState.startX;
    var steps = Math.round(dx / DRAG_PX_PER_STEP);
    var newValue = dragState.startValue + steps * dragState.step;

    // Round to avoid floating-point noise
    var decimals = dragState.step < 1 ? 3 : 1;
    newValue = parseFloat(newValue.toFixed(decimals));

    dragState.input.value = newValue;
    onPropInput();
  }

  function onDragPointerUp(e) {
    if (!dragState) return;
    dragState.label.classList.remove('dragging');
    dragState.label.releasePointerCapture(dragState.pointerId);
    dragState = null;
  }

  // Attach drag handlers to all property labels
  var propLabels = document.querySelectorAll('.viewer-prop-label');
  propLabels.forEach(function(label) {
    label.addEventListener('pointerdown', onDragPointerDown);
  });
  document.addEventListener('pointermove', onDragPointerMove);
  document.addEventListener('pointerup', onDragPointerUp);

  /**
   * Show/hide the robots section based on current mode.
   */
  function showWorldRobotsSection(visible) {
    if (worldRobotsSection) {
      worldRobotsSection.style.display = visible ? '' : 'none';
    }
    // Also hide properties when leaving world mode
    if (!visible && propsSection) {
      propsSection.style.display = 'none';
    }
  }

  // ── Canvas visibility helpers ─────────────────────────────────

  function showViewerCanvas() {
    viewerCanvas.style.display = '';
    worldCanvas.style.display = 'none';
  }

  function showWorldCanvas() {
    viewerCanvas.style.display = 'none';
    worldCanvas.style.display = '';
  }

  function hideAllCanvases() {
    viewerCanvas.style.display = '';
    worldCanvas.style.display = 'none';
  }

  // ── Leave-mode helpers (clean up when switching away) ─────────

  function leaveCurrentMode() {
    if (currentMode === 'individual') {
      // Pause individual animation and save joints
      if (currentVariableName && RA) {
        if (viewerInstance) {
          var st = RA.getVariableState(currentVariableName);
          st.savedJoints = viewerInstance.getJoints();
        }
        RA.pauseVarAnimation(currentVariableName);
      }
    } else if (currentMode === 'world') {
      // Stop world animation
      var WA = window.WorldAnimation;
      if (WA) WA.stop();
      if (worldProgressEl) worldProgressEl.style.display = 'none';
    }
  }

  // ── Individual viewer lifecycle ───────────────────────────────

  function ensureViewer() {
    if (viewerInstance) return Promise.resolve(viewerInstance);
    if (!window.RobotViewerClass) return Promise.resolve(null);

    viewerInstance = new window.RobotViewerClass(viewerCanvas);
    window._robotViewer = viewerInstance;
    console.log('[RobotViewer] Instance created');

    return viewerInstance.loadModel(
      './resources/wlkata_arm_virtual-reality/urdf/wlkata_mirobot_description.urdf',
      {
        meshBasePath: './resources/wlkata_arm_virtual-reality/',
        tcpOffset: [0, 0, 0.02428]
      }
    ).then(function() {
      modelLoaded = true;
      console.log('[RobotViewer] Mirobot model loaded');
      return viewerInstance;
    });
  }

  // ── World viewer lifecycle ────────────────────────────────────

  function ensureWorldProgressBar() {
    if (worldProgressCreated) return;
    worldProgressCreated = true;

    worldProgressEl = document.createElement('div');
    worldProgressEl.className = 'anim-progress';
    worldProgressEl.innerHTML =
      '<div class="anim-progress-label"></div>' +
      '<div class="anim-progress-track"><div class="anim-progress-fill"></div></div>';
    worldProgressEl.style.display = 'none';
    worldCanvas.appendChild(worldProgressEl);

    var WA = window.WorldAnimation;
    if (WA) {
      WA.setProgressElements(
        worldProgressEl,
        worldProgressEl.querySelector('.anim-progress-label'),
        worldProgressEl.querySelector('.anim-progress-fill')
      );
    }
  }

  function enterWorldMode() {
    var WV = window.WorldViewer;
    var WA = window.WorldAnimation;
    if (!WV || !WA) {
      console.warn('[WorldViewer] WorldViewer or WorldAnimation not available');
      return;
    }

    ensureWorldProgressBar();

    // Load all current robot variables into the world scene
    var loadPromises = [];
    for (var i = 0; i < currentRobotVars.length; i++) {
      loadPromises.push(WV.addRobot(currentRobotVars[i]));
    }

    Promise.all(loadPromises).then(function() {
      // Sync progress elements (in case WorldAnimation was loaded after creation)
      if (worldProgressEl) {
        WA.setProgressElements(
          worldProgressEl,
          worldProgressEl.querySelector('.anim-progress-label'),
          worldProgressEl.querySelector('.anim-progress-fill')
        );
      }

      // Build the robot checklist in the side panel
      updateWorldRobotList();

      // Sync loop toggle and playback buttons
      updateLoopToggle(WA.isLoopEnabled());

      updatePlaybackButtons();
      console.log('[WorldViewer] World mode ready with', currentRobotVars.length, 'robots');
    });
  }

  // ── Tab management ────────────────────────────────────────────

  function updateRobotTabs() {
    var codeEl = document.getElementById('code-preview');
    if (!codeEl) return;
    var code = codeEl.textContent || '';

    var analysis = window.analyzeRobotCode(code);
    window.RobotCodeAnalysis.lastAnalysis = analysis;

    var uniqueVars = [];
    var seen = {};
    var allVars = analysis.directVars.concat(analysis.funcReturnVars);
    for (var i = 0; i < allVars.length; i++) {
      if (!seen[allVars[i]]) {
        seen[allVars[i]] = true;
        uniqueVars.push(allVars[i]);
      }
    }
    currentRobotVars = uniqueVars;

    var viewTabs = document.getElementById('view-tabs');
    if (!viewTabs) return;

    var activeBtn = viewTabs.querySelector('.view-tab-btn.active');
    var activeView = activeBtn ? activeBtn.dataset.view : 'workspace';

    viewTabs.innerHTML = '';

    // Blockly tab (always first)
    var blocklyBtn = document.createElement('button');
    blocklyBtn.className = 'view-tab-btn' + (activeView === 'workspace' ? ' active' : '');
    blocklyBtn.dataset.view = 'workspace';
    blocklyBtn.textContent = 'Blockly';
    viewTabs.appendChild(blocklyBtn);

    // World tab (only when ≥2 robot variables)
    if (uniqueVars.length >= 2) {
      var worldBtn = document.createElement('button');
      worldBtn.className = 'view-tab-btn' + (activeView === 'world' ? ' active' : '');
      worldBtn.dataset.view = 'world';
      worldBtn.textContent = 'World';
      viewTabs.appendChild(worldBtn);
    }

    // Individual variable tabs
    for (var v = 0; v < uniqueVars.length; v++) {
      var varName = uniqueVars[v];
      var btn = document.createElement('button');
      var viewKey = 'var:' + varName;
      btn.className = 'view-tab-btn' + (activeView === viewKey ? ' active' : '');
      btn.dataset.view = viewKey;
      btn.textContent = varName;
      viewTabs.appendChild(btn);
    }

    attachViewTabHandlers();

    console.log('[RobotTabs] Detected variables:', uniqueVars,
      '| direct:', analysis.directVars,
      '| funcReturn:', analysis.funcReturnVars,
      '| robotFuncs:', Object.keys(analysis.robotFunctions));
  }

  function attachViewTabHandlers() {
    var btns = document.querySelectorAll('.view-tab-btn');
    btns.forEach(function(btn) {
      var newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      newBtn.addEventListener('click', function() { handleViewTabClick(newBtn); });
    });
  }

  function initVarState(variableName) {
    if (initializedVars[variableName]) return;
    initializedVars[variableName] = true;

    ensureRA();
    if (!RA) return;

    var state = RA.getVariableState(variableName);
    state.moveIndex = 0;
    state.pausedState = null;
    state.savedJoints = [0, 0, 0, 0, 0, 0];

    // Create progress bar (appended to individual viewer canvas)
    var progressEl = document.createElement('div');
    progressEl.className = 'anim-progress';
    progressEl.innerHTML =
      '<div class="anim-progress-label"></div>' +
      '<div class="anim-progress-track"><div class="anim-progress-fill"></div></div>';
    progressEl.style.display = 'none';
    viewerCanvas.appendChild(progressEl);
    state.progressEl = progressEl;
    state.progressLabel = progressEl.querySelector('.anim-progress-label');
    state.progressFill = progressEl.querySelector('.anim-progress-fill');

    console.log('[RobotViewer] State initialised for variable:', variableName);
  }

  function handleViewTabClick(btn) {
    var view = btn.dataset.view;

    document.querySelectorAll('.view-tab-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');

    ensureRA();

    // ── Leave previous mode ──
    leaveCurrentMode();

    if (view === 'workspace') {
      // ── Workspace (Blockly) ──
      currentMode = 'workspace';
      currentVariableName = null;
      workspaceArea.style.display = 'flex';
      workspaceArea.classList.remove('hidden');
      modelArea.classList.remove('visible');
      hideAllCanvases();
      showWorldRobotsSection(false);
      console.log('[View] Switched to Blockly workspace');
      updatePlaybackButtons();
      if (typeof getWorkspace === 'function' && typeof Blockly !== 'undefined') {
        Blockly.svgResize(getWorkspace());
      }

    } else if (view === 'world') {
      // ── World view ──
      currentMode = 'world';
      currentVariableName = null;
      workspaceArea.style.display = 'none';
      workspaceArea.classList.add('hidden');
      modelArea.classList.add('visible');
      showWorldCanvas();
      showWorldRobotsSection(true);
      console.log('[View] Switched to World view');

      enterWorldMode();

      setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 100);

    } else if (view.indexOf('var:') === 0) {
      // ── Individual variable view ──
      currentMode = 'individual';
      workspaceArea.style.display = 'none';
      workspaceArea.classList.add('hidden');
      modelArea.classList.add('visible');
      showViewerCanvas();
      showWorldRobotsSection(false);

      var variableName = view.slice(4);
      console.log('[View] Switched to Model view for:', variableName);

      // Save outgoing variable's joints if switching between individual tabs
      if (currentVariableName && currentVariableName !== variableName && RA) {
        if (viewerInstance) {
          var outSt = RA.getVariableState(currentVariableName);
          outSt.savedJoints = viewerInstance.getJoints();
        }
        RA.pauseVarAnimation(currentVariableName);
      }
      currentVariableName = variableName;

      // Ensure viewer exists (creates + loads model on first call)
      ensureViewer().then(function(viewer) {
        if (!viewer || !RA) return;

        initVarState(variableName);
        // Sync the loop toggle to this variable's state
        var inStForToggle = RA.getVariableState(variableName);
        updateLoopToggle(inStForToggle.loopEnabled);

        // Hide all other variables' progress bars
        for (var vname in initializedVars) {
          if (!initializedVars[vname]) continue;
          var vst = RA.getVariableState(vname);
          if (vst.progressEl) {
            vst.progressEl.style.display = (vname === variableName) ? '' : 'none';
          }
        }

        // Restore this variable's joint state
        var inSt = RA.getVariableState(variableName);
        if (inSt.savedJoints) {
          viewer.setJoints(inSt.savedJoints);
        }

        var currentSig = RA.getMovesSignature(variableName);
        var lastSig = lastMovesSignatures[variableName];
        var movesChanged = (currentSig !== lastSig);
        lastMovesSignatures[variableName] = currentSig;

        if (movesChanged) {
          console.log('[Animation] Moves changed for:', variableName, '- resetting to home');
          inSt.moveIndex = 0;
          inSt.pausedState = null;
          inSt.animationDone = false;
          viewer.setJoints([0, 0, 0, 0, 0, 0]);
          inSt.savedJoints = [0, 0, 0, 0, 0, 0];
        }
        updatePlaybackButtons();
      });

      setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 100);
    }
  }

  // ── Expose & initialise ───────────────────────────────────────

  window.updateRobotTabs = updateRobotTabs;

  // Observe #code-preview for changes and update tabs + dry-run moves
  var codePreviewEl = document.getElementById('code-preview');
  if (codePreviewEl) {
    var observer = new MutationObserver(function() {
      updateRobotTabs();
      // Invalidate recorded moves for old code; re-simulate shortly
      if (window.RobotCodeAnalysis) {
        window.RobotCodeAnalysis.recordedMovesCode = null;
      }
      if (typeof window.scheduleRecordedMovesRefresh === 'function') {
        window.scheduleRecordedMovesRefresh(400);
      }
    });
    observer.observe(codePreviewEl, { childList: true, characterData: true, subtree: true });
  }

  // When dry-run finishes, restart animation if moves changed for the active var
  window.addEventListener('robotMovesRecorded', function(ev) {
    ensureRA();
    if (!RA) return;
    var detail = (ev && ev.detail) || {};
    var movesByVar = detail.moves || {};
    console.log('[View] Dry-run moves ready:', Object.keys(movesByVar));

    if (currentMode === 'individual' && currentVariableName) {
      var sig = RA.getMovesSignature(currentVariableName);
      var lastSig = lastMovesSignatures[currentVariableName];
      if (sig !== lastSig) {
        lastMovesSignatures[currentVariableName] = sig;
        var st = RA.getVariableState(currentVariableName);
        st.moveIndex = 0;
        st.pausedState = null;
        st.animationDone = false;
        // Don't auto-play; just reset pose so Play uses the new sequence
        if (window._robotViewer) {
          window._robotViewer.setJoints([0, 0, 0, 0, 0, 0]);
        }
        st.savedJoints = [0, 0, 0, 0, 0, 0];
        updatePlaybackButtons();
        console.log('[View] Moves updated for', currentVariableName,
          '- count:', (movesByVar[currentVariableName] || []).length);
      }
    } else if (currentMode === 'world') {
      // World animation reads parseMovesFromCode on start; just clear signatures
      lastMovesSignatures = {};
    }
  });

  // Initial scan + dry-run
  setTimeout(function() {
    updateRobotTabs();
    if (typeof window.scheduleRecordedMovesRefresh === 'function') {
      window.scheduleRecordedMovesRefresh(100);
    }
  }, 500);

  console.log('[Init] View tabs ready. Dynamic robot tabs enabled (Three.js RobotViewer).');
})();