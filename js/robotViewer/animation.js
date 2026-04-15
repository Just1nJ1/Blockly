// Per-variable robot animation system.
// Depends on: codeAnalysis.js (window.parseMovesFromCode)
// Exposes: window.RobotAnimation (shared state + functions)

(function() {
  const ANIM_CONSTS = { MOVE_DUR: 3000, INTERVAL: 1000, STAY_DUR: 3000 };

  const AXIS_MAP = {
    pivot1: 'rotY', pivot2: 'rotZ', pivot3: 'rotZ',
    pivot4: 'rotY', pivot5: 'rotZ'
  };
  const PRESET_BASE = {
    pivot1: { rotX: 0, rotY: 0, rotZ: 0 },
    pivot2: { rotX: -90, rotY: 0, rotZ: -90 },
    pivot3: { rotX: 0, rotY: 0, rotZ: 0 },
    pivot4: { rotX: 0, rotY: 0, rotZ: 0 },
    pivot5: { rotX: -90, rotY: 0, rotZ: 0 }
  };

  let variableStates = {};

  function getVariableState(variableName) {
    if (!variableStates[variableName]) {
      variableStates[variableName] = {
        moveIndex: 0,
        animationTimer: null,
        moveStartTime: null,
        pausedState: null,
        pivots: null,
        scene: null,
        progressEl: null,
        progressLabel: null,
        progressFill: null,
        rafId: null,
        phase: null,
        phaseStart: null,
        phaseDuration: null
      };
    }
    return variableStates[variableName];
  }

  function getMovesSignature(variableName) {
    const moves = window.parseMovesFromCode(variableName);
    if (moves.length === 0) return 'empty';
    return JSON.stringify(moves.map(m => ({ type: m.type, A1: m.Axis1, A2: m.Axis2, A3: m.Axis3, A4: m.Axis4, A5: m.Axis5 })));
  }

  // Progress bar helpers
  function tickProgress(varName) {
    const st = getVariableState(varName);
    if (!st.phase || !st.phaseStart || !st.progressFill || !st.progressLabel) return;
    const now = Date.now();
    const elapsed = now - st.phaseStart;
    const dur = st.phaseDuration || 1;
    const frac = Math.min(elapsed / dur, 1);
    const elSec = (elapsed / 1000).toFixed(1);
    const durSec = (dur / 1000).toFixed(1);

    st.progressFill.style.width = (frac * 100) + '%';

    if (st.phase === 'move') {
      st.progressFill.style.background = '#4CAF50';
      st.progressLabel.textContent = 'Action ' + st.moveDisplay + '  ' + elSec + 's / ' + durSec + 's';
    } else if (st.phase === 'interval') {
      st.progressFill.style.background = '#FF9800';
      st.progressLabel.textContent = 'Interval  ' + elSec + 's / ' + durSec + 's';
    } else if (st.phase === 'stay') {
      st.progressFill.style.background = '#2196F3';
      st.progressLabel.textContent = 'Reset  ' + elSec + 's / ' + durSec + 's';
    }

    if (frac < 1) {
      st.rafId = requestAnimationFrame(function() { tickProgress(varName); });
    }
  }

  function startPhase(varName, phase, duration, moveDisplay) {
    const st = getVariableState(varName);
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.phase = phase;
    st.phaseStart = Date.now();
    st.phaseDuration = duration;
    st.moveDisplay = moveDisplay || '';
    if (st.progressEl) st.progressEl.style.display = '';
    st.rafId = requestAnimationFrame(function() { tickProgress(varName); });
  }

  function stopProgress(varName) {
    const st = getVariableState(varName);
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.phase = null;
    if (st.progressFill) st.progressFill.style.width = '0%';
    if (st.progressLabel) st.progressLabel.textContent = '';
  }

  // Core animation -- fully self-contained per variable
  function startVarAnimation(varName, resumeFrom) {
    const st = getVariableState(varName);
    const scene = st.scene;
    if (!scene) return;

    if (st.animationTimer) { clearTimeout(st.animationTimer); st.animationTimer = null; }
    stopProgress(varName);

    const moves = window.parseMovesFromCode(varName);
    if (moves.length === 0) {
      if (st.progressEl) st.progressEl.style.display = 'none';
      return;
    }

    if (!st.pivots) {
      st.pivots = {};
      for (let i = 1; i <= 5; i++) {
        st.pivots['pivot' + i] = scene.querySelector('#pivot' + i);
      }
    }
    const pivots = st.pivots;

    function applyAxisState(axisValues, durationMs) {
      st.moveStartTime = Date.now();
      for (const pivotId of Object.keys(AXIS_MAP)) {
        const pivot = pivots[pivotId];
        if (!pivot) continue;
        const axis = AXIS_MAP[pivotId];
        const base = PRESET_BASE[pivotId];
        const axisNum = pivotId.slice(-1);
        const offset = axisValues['Axis' + axisNum] || 0;
        const targetRot = axis === 'rotY'
          ? `${base.rotX} ${base.rotY + offset} ${base.rotZ}`
          : `${base.rotX} ${base.rotY} ${base.rotZ + offset}`;
        pivot.setAttribute('animation',
          `property: rotation; to: ${targetRot}; dur: ${durationMs}; easing: easeInOutQuad`);
      }
    }

    function resetToHome() {
      for (const pivotId of Object.keys(AXIS_MAP)) {
        const pivot = pivots[pivotId];
        if (!pivot) continue;
        const base = PRESET_BASE[pivotId];
        pivot.removeAttribute('animation');
        pivot.setAttribute('rotation', `${base.rotX} ${base.rotY} ${base.rotZ}`);
      }
    }

    function runSequence() {
      if (st.moveIndex >= moves.length) {
        startPhase(varName, 'stay', ANIM_CONSTS.STAY_DUR);
        st.animationTimer = setTimeout(function() {
          resetToHome();
          st.moveIndex = 0;
          st.animationTimer = setTimeout(runSequence, 100);
        }, ANIM_CONSTS.STAY_DUR);
        return;
      }

      const move = moves[st.moveIndex];
      const label = (st.moveIndex + 1) + '/' + moves.length;
      startPhase(varName, 'move', ANIM_CONSTS.MOVE_DUR, label);
      applyAxisState(move, ANIM_CONSTS.MOVE_DUR);
      st.moveIndex++;

      st.animationTimer = setTimeout(function() {
        startPhase(varName, 'interval', ANIM_CONSTS.INTERVAL);
        st.animationTimer = setTimeout(runSequence, ANIM_CONSTS.INTERVAL);
      }, ANIM_CONSTS.MOVE_DUR);
    }

    // Resume from paused state
    if (resumeFrom && resumeFrom.elapsedInMove < ANIM_CONSTS.MOVE_DUR
        && resumeFrom.moveIndex < moves.length) {
      const resumeMove = moves[resumeFrom.moveIndex];
      const frac = resumeFrom.elapsedInMove / ANIM_CONSTS.MOVE_DUR;
      const remaining = ANIM_CONSTS.MOVE_DUR - resumeFrom.elapsedInMove;

      for (const pivotId of Object.keys(AXIS_MAP)) {
        const pivot = pivots[pivotId];
        if (!pivot) continue;
        const axis = AXIS_MAP[pivotId];
        const base = PRESET_BASE[pivotId];
        const axisNum = pivotId.slice(-1);
        const offset = resumeMove['Axis' + axisNum] || 0;
        if (axis === 'rotY') {
          const cur = base.rotY + offset * frac;
          pivot.setAttribute('rotation', `${base.rotX} ${cur} ${base.rotZ}`);
          pivot.setAttribute('animation',
            `property: rotation; to: ${base.rotX} ${base.rotY + offset} ${base.rotZ}; dur: ${remaining}; easing: easeInOutQuad`);
        } else {
          const cur = base.rotZ + offset * frac;
          pivot.setAttribute('rotation', `${base.rotX} ${base.rotY} ${cur}`);
          pivot.setAttribute('animation',
            `property: rotation; to: ${base.rotX} ${base.rotY} ${base.rotZ + offset}; dur: ${remaining}; easing: easeInOutQuad`);
        }
      }
      st.moveIndex = resumeFrom.moveIndex + 1;
      st.moveStartTime = Date.now() - resumeFrom.elapsedInMove;
      st.phase = 'move';
      st.phaseStart = Date.now() - resumeFrom.elapsedInMove;
      st.phaseDuration = ANIM_CONSTS.MOVE_DUR;
      st.moveDisplay = (resumeFrom.moveIndex + 1) + '/' + moves.length;
      if (st.progressEl) st.progressEl.style.display = '';
      st.rafId = requestAnimationFrame(function() { tickProgress(varName); });

      st.animationTimer = setTimeout(function() {
        startPhase(varName, 'interval', ANIM_CONSTS.INTERVAL);
        st.animationTimer = setTimeout(runSequence, ANIM_CONSTS.INTERVAL);
      }, remaining);
      return;
    }

    // Normal start
    st.animationTimer = setTimeout(runSequence, 500);
  }

  function pauseVarAnimation(varName) {
    if (!varName) return;
    const st = getVariableState(varName);
    const now = Date.now();
    const elapsed = st.moveStartTime ? (now - st.moveStartTime) : 0;
    const moves = window.parseMovesFromCode(varName);
    const animIdx = (st.moveIndex > 0 && st.moveIndex <= moves.length) ? (st.moveIndex - 1) : null;

    if (st.animationTimer) { clearTimeout(st.animationTimer); st.animationTimer = null; }
    stopProgress(varName);
    if (st.progressEl) st.progressEl.style.display = 'none';

    if (st.pivots) {
      for (const pivotId of Object.keys(st.pivots)) {
        const pivot = st.pivots[pivotId];
        if (pivot) pivot.removeAttribute('animation');
      }
    }

    if (animIdx !== null && elapsed < ANIM_CONSTS.MOVE_DUR) {
      st.pausedState = { moveIndex: animIdx, elapsedInMove: elapsed };
    } else {
      st.pausedState = null;
    }
  }

  function resumeVarAnimation(varName) {
    const st = getVariableState(varName);
    startVarAnimation(varName, st.pausedState);
  }

  // Expose globally
  window.RobotAnimation = {
    ANIM_CONSTS: ANIM_CONSTS,
    AXIS_MAP: AXIS_MAP,
    PRESET_BASE: PRESET_BASE,
    getVariableState: getVariableState,
    getMovesSignature: getMovesSignature,
    startVarAnimation: startVarAnimation,
    pauseVarAnimation: pauseVarAnimation,
    resumeVarAnimation: resumeVarAnimation
  };
})();