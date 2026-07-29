// Per-variable robot animation system.
// Uses the Three.js-based RobotViewer (window._robotViewer) instead of A-Frame.
// Depends on: codeAnalysis.js (window.parseMovesFromCode)
// Exposes: window.RobotAnimation (shared state + functions)

(function() {
  var ANIM_CONSTS = { MOVE_DUR: 3000, INTERVAL: 1000, STAY_DUR: 3000 };

  /**
   * Animation / IK always starts at joint home (all joint angles 0°).
   * That is NOT Cartesian XYZ (0,0,0) — at J=0 the TCP is still at the
   * arm's mechanical rest pose (model-dependent, often ~200mm out).
   * Relative writeCoordinate offsets are applied from that FK TCP.
   */
  var JOINT_HOME = [0, 0, 0, 0, 0, 0];

  var variableStates = {};

  function getVariableState(variableName) {
    if (!variableStates[variableName]) {
      variableStates[variableName] = {
        moveIndex: 0,
        animationTimer: null,
        moveStartTime: null,
        pausedState: null,
        savedJoints: [0, 0, 0, 0, 0, 0],
        loopEnabled: false,
        animationDone: false,  // true when play-once finishes
        progressEl: null,
        progressLabel: null,
        progressFill: null,
        rafId: null,           // progress bar rAF
        animRafId: null,       // joint interpolation rAF
        phase: null,
        phaseStart: null,
        phaseDuration: null
      };
    }
    return variableStates[variableName];
  }

  function getMovesSignature(variableName) {
    var moves = window.parseMovesFromCode(variableName);
    if (moves.length === 0) return 'empty';
    return JSON.stringify(moves.map(function(m) {
      return { type: m.type, A1: m.Axis1, A2: m.Axis2, A3: m.Axis3, A4: m.Axis4, A5: m.Axis5, A6: m.Axis6, inc: m.incremental };
    }));
  }

  // ── Progress bar helpers (unchanged) ─────────────────────────

  function tickProgress(varName) {
    var st = getVariableState(varName);
    if (!st.phase || !st.phaseStart || !st.progressFill || !st.progressLabel) return;
    var now = Date.now();
    var elapsed = now - st.phaseStart;
    var dur = st.phaseDuration || 1;
    var frac = Math.min(elapsed / dur, 1);
    var elSec = (elapsed / 1000).toFixed(1);
    var durSec = (dur / 1000).toFixed(1);

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
    var st = getVariableState(varName);
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.phase = phase;
    st.phaseStart = Date.now();
    st.phaseDuration = duration;
    st.moveDisplay = moveDisplay || '';
    if (st.progressEl) st.progressEl.style.display = '';
    st.rafId = requestAnimationFrame(function() { tickProgress(varName); });
  }

  function stopProgress(varName) {
    var st = getVariableState(varName);
    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
    st.phase = null;
    if (st.progressFill) st.progressFill.style.width = '0%';
    if (st.progressLabel) st.progressLabel.textContent = '';
  }

  // ── Joint interpolation via requestAnimationFrame ────────────

  /**
   * Smoothly interpolate the viewer's joints from startJoints to targetJoints
   * over durationMs using smoothstep easing.
   */
  function animateJoints(varName, startJoints, targetJoints, durationMs) {
    var st = getVariableState(varName);
    var viewer = window._robotViewer;
    if (!viewer) return;

    // Cancel any in-flight joint interpolation for this variable
    if (st.animRafId) { cancelAnimationFrame(st.animRafId); st.animRafId = null; }

    var t0 = performance.now();

    function step() {
      var elapsed = performance.now() - t0;
      var t = Math.min(elapsed / durationMs, 1);
      // smoothstep easing
      var s = t * t * (3 - 2 * t);
      var cur = [];
      for (var i = 0; i < 6; i++) {
        cur[i] = startJoints[i] + (targetJoints[i] - startJoints[i]) * s;
      }
      viewer.setJoints(cur);
      if (t < 1) {
        st.animRafId = requestAnimationFrame(step);
      } else {
        st.animRafId = null;
      }
    }

    st.animRafId = requestAnimationFrame(step);
  }

  function isIncremental(move) {
    return !!(move && (move.incremental === true || move.incremental === 1 ||
      move.inc === true || move.inc === 1));
  }

  /** Copy of joint-home pose (J1…J6 = 0°). Not Cartesian XYZ origin. */
  function jointHome() {
    return JOINT_HOME.slice();
  }

  /**
   * Compute the target 6-joint array from a single move.
   *
   * Proven path (same as 28f47caa): writeCoordinate uses viewer.moveBy /
   * moveTo so relative offsets are applied from the FK TCP at the *current
   * joint pose* (after joint home or previous move), never from XYZ (0,0,0).
   *
   * Temporarily applies IK then restores the viewer so callers can chain
   * with setJoints(result) between moves (see computeMoveTargets).
   *
   * @param {object} move
   * @param {number[]} [fromJoints] if set, seed the viewer before this move
   */
  function targetJointsFromMove(move, fromJoints) {
    var viewer = window._robotViewer;
    var type = move && move.type;

    if (type === 'homing') {
      return jointHome();
    }

    if (fromJoints && fromJoints.length >= 6 && viewer) {
      viewer.setJoints(fromJoints.slice(0, 6));
    }

    if (type === 'writeAngle') {
      var angles = [
        move.Axis1 || 0,
        move.Axis2 || 0,
        move.Axis3 || 0,
        move.Axis4 || 0,
        move.Axis5 || 0,
        move.Axis6 || 0
      ];
      if (isIncremental(move) && viewer) {
        var cur = viewer.getJoints();
        for (var i = 0; i < 6; i++) angles[i] += cur[i];
      }
      return angles;
    }

    // writeCoordinate — IK via moveBy (relative) / moveTo (absolute)
    if (type === 'writeCoordinate' && viewer) {
      var saved = viewer.getJoints();
      if (isIncremental(move)) {
        viewer.moveBy(move.Axis1 || 0, move.Axis2 || 0, move.Axis3 || 0);
      } else {
        viewer.moveTo(move.Axis1 || 0, move.Axis2 || 0, move.Axis3 || 0);
      }
      var result = viewer.getJoints();
      viewer.setJoints(saved);
      return result;
    }

    // No viewer or unknown type: do not treat XYZ mm as joint degrees
    if (type === 'writeCoordinate') {
      console.warn('[RobotAnimation] No IK viewer for writeCoordinate; holding pose');
      return viewer ? viewer.getJoints() : jointHome();
    }

    return [
      (move && move.Axis1) || 0,
      (move && move.Axis2) || 0,
      (move && move.Axis3) || 0,
      (move && move.Axis4) || 0,
      (move && move.Axis5) || 0,
      (move && move.Axis6) || 0
    ];
  }

  /**
   * Compute joint targets for a full move list with correct relative chaining.
   *
   * Starts at joint home (J1…J6 = 0°) unless startJoints is provided, then
   * for each move: targetJointsFromMove → setJoints(target) so the next
   * relative moveBy sees the real TCP at that pose.
   *
   * @param {object[]} moves
   * @param {number[]} [startJoints]
   * @returns {number[][]} one 6-joint target per move
   */
  function computeMoveTargets(moves, startJoints) {
    var viewer = window._robotViewer;
    if (!moves || moves.length === 0) return [];

    var seed = (startJoints && startJoints.length >= 6)
      ? startJoints.slice(0, 6)
      : jointHome();

    if (!viewer) {
      console.warn('[RobotAnimation] computeMoveTargets: no _robotViewer (IK unavailable)');
      return moves.map(function() { return seed.slice(); });
    }

    var saved = viewer.getJoints();
    viewer.setJoints(seed.slice());

    var targets = [];
    for (var i = 0; i < moves.length; i++) {
      var target = targetJointsFromMove(moves[i]);
      targets.push(target.slice());
      // Chain: next relative moveBy reads FK from this pose
      viewer.setJoints(target);
    }

    viewer.setJoints(saved);
    return targets;
  }

  // ── Core animation — fully self-contained per variable ──────

  function startVarAnimation(varName, resumeFrom) {
    var st = getVariableState(varName);
    var viewer = window._robotViewer;
    if (!viewer) return;

    if (st.animationTimer) { clearTimeout(st.animationTimer); st.animationTimer = null; }
    if (st.animRafId) { cancelAnimationFrame(st.animRafId); st.animRafId = null; }
    stopProgress(varName);

    var moves = window.parseMovesFromCode(varName);
    if (moves.length === 0) {
      if (st.progressEl) st.progressEl.style.display = 'none';
      return;
    }

    // Precompute the full IK chain once so relative Cartesian moves accumulate
    // from the running TCP at joint home (J=0), not Cartesian XYZ (0,0,0).
    var seedJoints = (resumeFrom && resumeFrom.seedJoints)
      ? resumeFrom.seedJoints
      : jointHome();
    if (!resumeFrom) {
      viewer.setJoints(seedJoints.slice());
    }
    var precomputedTargets = computeMoveTargets(moves, seedJoints);
    st.precomputedTargets = precomputedTargets;

    function runSequence() {
      if (st.moveIndex >= moves.length) {
        if (!st.loopEnabled) {
          // Play-once mode: show "Done", keep final pose, stop
          st.animationDone = true;
          if (st.progressEl) st.progressEl.style.display = '';
          if (st.progressFill) {
            st.progressFill.style.width = '100%';
            st.progressFill.style.background = '#9E9E9E';
          }
          if (st.progressLabel) st.progressLabel.textContent = 'Done';
          return;
        }
        // Loop mode: stay, then reset to home and loop
        startPhase(varName, 'stay', ANIM_CONSTS.STAY_DUR);
        st.animationTimer = setTimeout(function() {
          viewer.setJoints(jointHome());
          st.moveIndex = 0;
          // Recompute from joint home (J1…J6 = 0°)
          precomputedTargets = computeMoveTargets(moves, jointHome());
          st.precomputedTargets = precomputedTargets;
          st.animationTimer = setTimeout(runSequence, 100);
        }, ANIM_CONSTS.STAY_DUR);
        return;
      }

      var label = (st.moveIndex + 1) + '/' + moves.length;
      startPhase(varName, 'move', ANIM_CONSTS.MOVE_DUR, label);

      var startJoints = viewer.getJoints();
      var targetJoints = precomputedTargets[st.moveIndex] || startJoints.slice();
      st.moveStartTime = Date.now();
      st.currentTargetJoints = targetJoints;
      st.currentStartJoints = startJoints;

      animateJoints(varName, startJoints, targetJoints, ANIM_CONSTS.MOVE_DUR);
      st.moveIndex++;

      st.animationTimer = setTimeout(function() {
        // Snap to exact target so the next move's start is correct
        viewer.setJoints(targetJoints);
        startPhase(varName, 'interval', ANIM_CONSTS.INTERVAL);
        st.animationTimer = setTimeout(runSequence, ANIM_CONSTS.INTERVAL);
      }, ANIM_CONSTS.MOVE_DUR);
    }

    // Resume from paused state
    if (resumeFrom && resumeFrom.moveIndex <= moves.length) {
      if (resumeFrom.elapsedInMove < ANIM_CONSTS.MOVE_DUR
          && resumeFrom.moveIndex < moves.length) {
        // Paused mid-move — finish the interrupted move from current position
        var remaining = ANIM_CONSTS.MOVE_DUR - resumeFrom.elapsedInMove;

        var targetJoints = precomputedTargets[resumeFrom.moveIndex]
          || viewer.getJoints();
        var currentJoints = viewer.getJoints();

        st.moveStartTime = Date.now() - resumeFrom.elapsedInMove;
        st.currentTargetJoints = targetJoints;
        st.currentStartJoints = currentJoints;

        // Animate from current position to target over the remaining time
        animateJoints(varName, currentJoints, targetJoints, remaining);

        st.moveIndex = resumeFrom.moveIndex + 1;
        st.phase = 'move';
        st.phaseStart = Date.now() - resumeFrom.elapsedInMove;
        st.phaseDuration = ANIM_CONSTS.MOVE_DUR;
        st.moveDisplay = (resumeFrom.moveIndex + 1) + '/' + moves.length;
        if (st.progressEl) st.progressEl.style.display = '';
        st.rafId = requestAnimationFrame(function() { tickProgress(varName); });

        st.animationTimer = setTimeout(function() {
          viewer.setJoints(targetJoints);
          startPhase(varName, 'interval', ANIM_CONSTS.INTERVAL);
          st.animationTimer = setTimeout(runSequence, ANIM_CONSTS.INTERVAL);
        }, remaining);
      } else {
        // Paused during interval — the move was complete, continue from next step
        st.moveIndex = resumeFrom.moveIndex;
        st.animationTimer = setTimeout(runSequence, 100);
      }
      return;
    }

    // Normal start
    st.animationTimer = setTimeout(runSequence, 500);
  }

  function pauseVarAnimation(varName) {
    if (!varName) return;
    var st = getVariableState(varName);

    // Nothing to pause if no animation is active
    var hasActivity = st.animationTimer !== null || st.animRafId !== null;
    if (!hasActivity) return;

    var now = Date.now();
    var elapsed = st.moveStartTime ? (now - st.moveStartTime) : 0;
    var moves = window.parseMovesFromCode(varName);
    var animIdx = (st.moveIndex > 0 && st.moveIndex <= moves.length) ? (st.moveIndex - 1) : null;

    if (st.animationTimer) { clearTimeout(st.animationTimer); st.animationTimer = null; }
    if (st.animRafId) { cancelAnimationFrame(st.animRafId); st.animRafId = null; }
    stopProgress(varName);
    if (st.progressEl) st.progressEl.style.display = 'none';

    // Save current joints so they can be restored later
    var viewer = window._robotViewer;
    if (viewer) {
      st.savedJoints = viewer.getJoints();
    }

    if (animIdx !== null && elapsed < ANIM_CONSTS.MOVE_DUR) {
      // Paused mid-move — save the move index and how far we got
      st.pausedState = { moveIndex: animIdx, elapsedInMove: elapsed };
    } else {
      // Paused during interval or between moves — save the next step index
      // so we can resume from the right position instead of restarting
      st.pausedState = { moveIndex: st.moveIndex, elapsedInMove: ANIM_CONSTS.MOVE_DUR };
    }
  }

  function resumeVarAnimation(varName) {
    var st = getVariableState(varName);
    startVarAnimation(varName, st.pausedState);
  }

  /**
   * Stop animation and reset robot to home position.
   */
  function stopVarAnimation(varName) {
    if (!varName) return;
    var st = getVariableState(varName);
    if (st.animationTimer) { clearTimeout(st.animationTimer); st.animationTimer = null; }
    if (st.animRafId) { cancelAnimationFrame(st.animRafId); st.animRafId = null; }
    stopProgress(varName);
    if (st.progressEl) st.progressEl.style.display = 'none';

    st.moveIndex = 0;
    st.pausedState = null;
    st.animationDone = false;

    var viewer = window._robotViewer;
    if (viewer) {
      viewer.setJoints(jointHome());
    }
    st.savedJoints = jointHome();
  }

  /**
   * Toggle loop mode for a variable and restart its animation from the beginning.
   */
  function setLoopEnabled(varName, enabled) {
    var st = getVariableState(varName);
    st.loopEnabled = enabled;
    st.animationDone = false;

    // Restart animation from the beginning
    var viewer = window._robotViewer;
    if (viewer) {
      viewer.setJoints(jointHome());
    }
    st.moveIndex = 0;
    st.pausedState = null;
    st.savedJoints = jointHome();
    startVarAnimation(varName, null);
  }

  // Expose globally
  window.RobotAnimation = {
    ANIM_CONSTS: ANIM_CONSTS,
    JOINT_HOME: JOINT_HOME,
    jointHome: jointHome,
    getVariableState: getVariableState,
    getMovesSignature: getMovesSignature,
    targetJointsFromMove: targetJointsFromMove,
    computeMoveTargets: computeMoveTargets,
    isIncremental: isIncremental,
    startVarAnimation: startVarAnimation,
    pauseVarAnimation: pauseVarAnimation,
    resumeVarAnimation: resumeVarAnimation,
    stopVarAnimation: stopVarAnimation,
    setLoopEnabled: setLoopEnabled
  };
})();