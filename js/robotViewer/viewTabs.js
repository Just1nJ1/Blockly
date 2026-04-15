// View & panel tab switching, 3D scene creation, and initialization.
// Depends on: codeAnalysis.js, animation.js
// Exposes: window.updateRobotTabs

(function() {
  const workspaceArea = document.getElementById('workspace-area');
  const modelArea = document.getElementById('model-area');

  let currentRobotVars = [];
  let scenes = {};
  let currentVariableName = null;
  let lastMovesSignatures = {};

  const { getVariableState, startVarAnimation, pauseVarAnimation, resumeVarAnimation,
          getMovesSignature, AXIS_MAP, PRESET_BASE } = window.RobotAnimation;

  function updateRobotTabs() {
    const codeEl = document.getElementById('code-preview');
    if (!codeEl) return;
    const code = codeEl.textContent || '';

    const analysis = window.analyzeRobotCode(code);
    window.RobotCodeAnalysis.lastAnalysis = analysis;

    const uniqueVars = [...new Set([...analysis.directVars, ...analysis.funcReturnVars])];
    currentRobotVars = uniqueVars;

    const viewTabs = document.getElementById('view-tabs');
    if (!viewTabs) return;

    const activeBtn = viewTabs.querySelector('.view-tab-btn.active');
    const activeView = activeBtn ? activeBtn.dataset.view : 'workspace';

    viewTabs.innerHTML = '';
    const blocklyBtn = document.createElement('button');
    blocklyBtn.className = 'view-tab-btn' + (activeView === 'workspace' ? ' active' : '');
    blocklyBtn.dataset.view = 'workspace';
    blocklyBtn.textContent = 'Blockly';
    viewTabs.appendChild(blocklyBtn);

    uniqueVars.forEach(varName => {
      const btn = document.createElement('button');
      const viewKey = 'var:' + varName;
      btn.className = 'view-tab-btn' + (activeView === viewKey ? ' active' : '');
      btn.dataset.view = viewKey;
      btn.textContent = varName;
      viewTabs.appendChild(btn);
    });

    attachViewTabHandlers();

    console.log('[RobotTabs] Detected variables:', uniqueVars,
      '| direct:', analysis.directVars,
      '| funcReturn:', analysis.funcReturnVars,
      '| robotFuncs:', Object.keys(analysis.robotFunctions));
  }

  function attachViewTabHandlers() {
    const btns = document.querySelectorAll('.view-tab-btn');
    btns.forEach(btn => {
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);
      newBtn.addEventListener('click', () => handleViewTabClick(newBtn));
    });
  }

  function createModelScene(variableName) {
    if (scenes[variableName]) {
      console.log('[A-Frame] Scene already exists for variable:', variableName);
      return scenes[variableName];
    }

    const scene = document.createElement('a-scene');
    scene.id = 'model-scene-' + variableName;
    scene.setAttribute('embedded', '');
    scene.setAttribute('vr-mode-ui', 'enabled: false');
    scene.setAttribute('background', 'color: #1a1a1a');
    scene.style.display = 'none';

    const createEl = (tag, attrs) => {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'children') v.forEach(c => el.appendChild(c));
        else el.setAttribute(k, v);
      }
      return el;
    };

    scene.appendChild(createEl('a-entity', { light: 'type:ambient; color:#ccc; intensity:0.6' }));
    scene.appendChild(createEl('a-entity', { light: 'type:directional; color:#fff; intensity:0.8', position: '5 10 5' }));
    scene.appendChild(createEl('a-camera', { position: '3 1.5 6', 'look-controls': 'enabled: false' }));

    const presetBase = {
      "pivot0":  {posX:0,   posY:-0.2,  posZ:0,    rotX:0,   rotY:-5,   rotZ:0},
      "model0":  {posX:0,   posY:0.5,   posZ:0,    rotX:0,   rotY:0,    rotZ:0},
      "pivot1":  {posX:0,   posY:0.5,   posZ:0,    rotX:0,   rotY:0,    rotZ:0},
      "model1":  {posX:0,   posY:0,     posZ:0,    rotX:-90, rotY:0,    rotZ:0},
      "pivot2":  {posX:0.6, posY:-0.3,  posZ:1.2,  rotX:-90, rotY:0,    rotZ:-90},
      "model2":  {posX:0,   posY:0,     posZ:0,    rotX:0,   rotY:0,    rotZ:0},
      "pivot3":  {posX:2.15,posY:0,     posZ:-0.2, rotX:0,   rotY:0,    rotZ:0},
      "model3":  {posX:0.1, posY:0,     posZ:0,    rotX:0,   rotY:0,    rotZ:0},
      "pivot4":  {posX:0.4, posY:2.25,  posZ:0.625,rotX:0,   rotY:0,    rotZ:0},
      "model4":  {posX:0,   posY:-0.1,  posZ:0,    rotX:-90, rotY:0,    rotZ:0},
      "pivot5":  {posX:0,   posY:0,     posZ:1.2,  rotX:-90, rotY:0,    rotZ:0},
      "model5":  {posX:0,   posY:0,     posZ:-0.2, rotX:0,   rotY:0,    rotZ:0},
      "pivot6":  {posX:0,   posY:0,     posZ:0.2,  rotX:-90, rotY:0,    rotZ:0},
      "model6":  {posX:0,   posY:0,     posZ:-0.3, rotX:0,   rotY:0,    rotZ:0}
    };
    const applyPreset = (el, id) => {
      const p = presetBase[id];
      if (p) { el.setAttribute('position', `${p.posX} ${p.posY} ${p.posZ}`); el.setAttribute('rotation', `${p.rotX} ${p.rotY} ${p.rotZ}`); }
    };

    const pivot0 = createEl('a-entity', { id: 'pivot0' });
    applyPreset(pivot0, 'pivot0');
    const model0 = createEl('a-entity', { id: 'model0' });
    applyPreset(model0, 'model0');
    model0.appendChild(createEl('a-cylinder', { color: '#888', height: '1', radius: '0.2', material: 'opacity:0.5; transparent:true' }));

    const linkColors = ['red', 'green', 'blue', 'yellow', 'magenta', 'cyan'];
    let current = model0;
    for (let i = 1; i <= 6; i++) {
      const pivotId = `pivot${i}`, modelId = `model${i}`;
      const pivot = createEl('a-entity', { id: pivotId });
      applyPreset(pivot, pivotId);
      const model = createEl('a-entity', { id: modelId });
      applyPreset(model, modelId);
      const link = createEl('a-entity', { 'translucent-gltf': `src:resources/6dof/Mirobot-GLB/Link${i}.glb; color:${linkColors[i-1]}; scale:20 20 20` });
      model.appendChild(link);
      pivot.appendChild(model);
      current.appendChild(pivot);
      current = model;
    }
    pivot0.appendChild(model0);
    scene.appendChild(pivot0);
    modelArea.appendChild(scene);

    scenes[variableName] = scene;
    const state = getVariableState(variableName);
    state.scene = scene;
    state.moveIndex = 0;
    state.pausedState = null;

    const progressEl = document.createElement('div');
    progressEl.className = 'anim-progress';
    progressEl.innerHTML =
      '<div class="anim-progress-label"></div>' +
      '<div class="anim-progress-track"><div class="anim-progress-fill"></div></div>';
    progressEl.style.display = 'none';
    modelArea.appendChild(progressEl);
    state.progressEl = progressEl;
    state.progressLabel = progressEl.querySelector('.anim-progress-label');
    state.progressFill = progressEl.querySelector('.anim-progress-fill');

    console.log('[A-Frame] Scene created for variable tab:', variableName);

    setTimeout(() => {
      startVarAnimation(variableName, null);
    }, 500);

    return scene;
  }

  function handleViewTabClick(btn) {
    const view = btn.dataset.view;

    document.querySelectorAll('.view-tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (view === 'workspace') {
      workspaceArea.style.display = 'flex';
      workspaceArea.classList.remove('hidden');
      modelArea.classList.remove('visible');
      console.log('[View] Switched to Blockly workspace');
      if (currentVariableName) pauseVarAnimation(currentVariableName);
      if (typeof getWorkspace === 'function' && typeof Blockly !== 'undefined') {
        Blockly.svgResize(getWorkspace());
      }
    } else if (view.startsWith('var:')) {
      workspaceArea.style.display = 'none';
      workspaceArea.classList.add('hidden');
      modelArea.classList.add('visible');

      const variableName = view.slice(4);
      console.log('[View] Switched to Model view for:', variableName);

      if (currentVariableName && currentVariableName !== variableName) {
        pauseVarAnimation(currentVariableName);
      }
      currentVariableName = variableName;

      const currentSig = getMovesSignature(variableName);
      const lastSig = lastMovesSignatures[variableName];
      const movesChanged = (currentSig !== lastSig);
      lastMovesSignatures[variableName] = currentSig;

      const scene = createModelScene(variableName);

      for (const vname of Object.keys(scenes)) {
        scenes[vname].style.display = (vname === variableName) ? 'block' : 'none';
        const vst = getVariableState(vname);
        if (vst.progressEl) vst.progressEl.style.display = (vname === variableName) ? '' : 'none';
      }

      if (movesChanged) {
        console.log('[Animation] Moves changed for:', variableName, '- resetting');
        const st = getVariableState(variableName);
        st.moveIndex = 0;
        st.pausedState = null;

        const pivots = st.pivots || {};
        for (const pivotId of Object.keys(AXIS_MAP)) {
          const pivot = pivots[pivotId] || scene.querySelector('#' + pivotId);
          if (pivot) {
            const base = PRESET_BASE[pivotId];
            pivot.removeAttribute('animation');
            pivot.setAttribute('rotation', `${base.rotX} ${base.rotY} ${base.rotZ}`);
          }
        }
        startVarAnimation(variableName, null);
      } else {
        console.log('[Animation] Resuming for:', variableName);
        resumeVarAnimation(variableName);
      }

      setTimeout(() => { window.dispatchEvent(new Event('resize')); }, 100);
    }
  }

  // Expose updateRobotTabs for external call
  window.updateRobotTabs = updateRobotTabs;

  // Observe #code-preview for changes and update tabs
  const codePreviewEl = document.getElementById('code-preview');
  if (codePreviewEl) {
    const observer = new MutationObserver(() => {
      updateRobotTabs();
    });
    observer.observe(codePreviewEl, { childList: true, characterData: true, subtree: true });
  }

  // Initial scan
  setTimeout(updateRobotTabs, 500);

  // Initial debug
  console.log('[Init] View tabs ready. Dynamic robot tabs enabled.');
  console.log('[Init] Model area border: ORANGE (debug mode)');

  // A-Frame loaded callback
  document.addEventListener('aframeReady', () => {
    console.log('[A-Frame] aframeReady event fired');
  });

  // Check A-Frame loading
  if (typeof AFRAME !== 'undefined') {
    console.log('[A-Frame] AFRAME global exists, version:', AFRAME.version || 'unknown');

    document.addEventListener('DOMContentLoaded', () => {
      const sceneEls = document.querySelectorAll('[id^="model-scene-"]');
      sceneEls.forEach(scene => {
        scene.addEventListener('loaded', () => {
          console.log('[A-Frame] Scene loaded event fired for:', scene.id);
          console.log('[A-Frame] Scene ready:', scene.id);
        });
      });
    });
  } else {
    console.warn('[A-Frame] AFRAME not yet loaded');
  }
})();