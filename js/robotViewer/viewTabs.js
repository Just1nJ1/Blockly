// View & panel tab switching, 3D viewer creation, and initialization.
// Uses the Three.js-based RobotViewer from wlkata_arm_virtual-reality.
// Depends on: codeAnalysis.js, animation.js
// Exposes: window.updateRobotTabs, window._robotViewer

(function() {
  const workspaceArea = document.getElementById('workspace-area');
  const modelArea = document.getElementById('model-area');

  let currentRobotVars = [];
  let currentVariableName = null;
  let lastMovesSignatures = {};
  let viewerReady = false;         // true after RobotViewer class is available
  let viewerInstance = null;       // single shared RobotViewer
  let modelLoaded = false;         // true after URDF is loaded
  let initializedVars = {};        // tracks which variables have had their progress bar created

  // Will be populated once RobotAnimation is available
  var RA = null;

  function ensureRA() {
    if (!RA && window.RobotAnimation) {
      RA = window.RobotAnimation;
    }
    return RA;
  }

  // ── Viewer lifecycle ──────────────────────────────────────────

  function ensureViewer() {
    if (viewerInstance) return Promise.resolve(viewerInstance);
    if (!window.RobotViewerClass) return Promise.resolve(null);

    viewerInstance = new window.RobotViewerClass(modelArea);
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
    var blocklyBtn = document.createElement('button');
    blocklyBtn.className = 'view-tab-btn' + (activeView === 'workspace' ? ' active' : '');
    blocklyBtn.dataset.view = 'workspace';
    blocklyBtn.textContent = 'Blockly';
    viewTabs.appendChild(blocklyBtn);

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
    // Save initial joints (all zeros)
    state.savedJoints = [0, 0, 0, 0, 0, 0];

    // Create progress bar
    var progressEl = document.createElement('div');
    progressEl.className = 'anim-progress';
    progressEl.innerHTML =
      '<div class="anim-progress-label"></div>' +
      '<div class="anim-progress-track"><div class="anim-progress-fill"></div></div>';
    progressEl.style.display = 'none';
    modelArea.appendChild(progressEl);
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

    if (view === 'workspace') {
      workspaceArea.style.display = 'flex';
      workspaceArea.classList.remove('hidden');
      modelArea.classList.remove('visible');
      console.log('[View] Switched to Blockly workspace');
      if (currentVariableName && RA) {
        // Save current joints before leaving
        if (viewerInstance) {
          var st = RA.getVariableState(currentVariableName);
          st.savedJoints = viewerInstance.getJoints();
        }
        RA.pauseVarAnimation(currentVariableName);
      }
      if (typeof getWorkspace === 'function' && typeof Blockly !== 'undefined') {
        Blockly.svgResize(getWorkspace());
      }
    } else if (view.indexOf('var:') === 0) {
      workspaceArea.style.display = 'none';
      workspaceArea.classList.add('hidden');
      modelArea.classList.add('visible');

      var variableName = view.slice(4);
      console.log('[View] Switched to Model view for:', variableName);

      // Save outgoing variable's joints and pause its animation
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
          console.log('[Animation] Moves changed for:', variableName, '- resetting');
          inSt.moveIndex = 0;
          inSt.pausedState = null;
          // Reset joints to home for fresh animation
          viewer.setJoints([0, 0, 0, 0, 0, 0]);
          inSt.savedJoints = [0, 0, 0, 0, 0, 0];
          RA.startVarAnimation(variableName, null);
        } else {
          console.log('[Animation] Resuming for:', variableName);
          RA.resumeVarAnimation(variableName);
        }
      });

      setTimeout(function() { window.dispatchEvent(new Event('resize')); }, 100);
    }
  }

  // ── Expose & initialise ───────────────────────────────────────

  window.updateRobotTabs = updateRobotTabs;

  // Observe #code-preview for changes and update tabs
  var codePreviewEl = document.getElementById('code-preview');
  if (codePreviewEl) {
    var observer = new MutationObserver(function() {
      updateRobotTabs();
    });
    observer.observe(codePreviewEl, { childList: true, characterData: true, subtree: true });
  }

  // Initial scan
  setTimeout(updateRobotTabs, 500);

  console.log('[Init] View tabs ready. Dynamic robot tabs enabled (Three.js RobotViewer).');
})();