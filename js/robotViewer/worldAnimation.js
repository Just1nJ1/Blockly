// World Animation — synchronized multi-robot animation for the World tab.
// All robots play their moves in lockstep: each "step" advances every robot
// by one move simultaneously. When a robot runs out of moves, it holds its
// final pose until the slowest robot finishes. Then all reset together.
//
// Depends on: animation.js (window.RobotAnimation — for ANIM_CONSTS and
//             targetJointsFromMove), worldViewer.js (window.WorldViewer),
//             codeAnalysis.js (window.parseMovesFromCode)
// Exposes: window.WorldAnimation

(function() {
  'use strict';

  var ANIM_CONSTS = null;  // populated from RobotAnimation
  var loopEnabled = true;
  var running = false;
  var paused = false;
  var animTimer = null;
  var rafId = null;

  // Saved state for pause/resume
  var savedStepIndex = 0;
  var savedAllTargets = null;
  var savedRobotNames = null;
  var savedMaxSteps = 0;
  var pausedMoveElapsed = 0;   // how far into the current move when paused
  var pausedPhase = null;       // 'move', 'interval', or null

  // Progress bar refs (created by viewTabs)
  var progressEl = null;
  var progressLabel = null;
  var progressFill = null;
  var progressRafId = null;

  // Current animation state
  var phase = null;
  var phaseStart = null;
  var phaseDuration = null;
  var phaseDisplay = '';

  function getConsts() {
    if (!ANIM_CONSTS && window.RobotAnimation) {
      ANIM_CONSTS = window.RobotAnimation.ANIM_CONSTS;
    }
    return ANIM_CONSTS;
  }

  // ── Progress bar (mirrors animation.js pattern) ──

  function tickProgress() {
    if (!phase || !phaseStart || !progressFill || !progressLabel) return;
    var now = Date.now();
    var elapsed = now - phaseStart;
    var dur = phaseDuration || 1;
    var frac = Math.min(elapsed / dur, 1);
    var elSec = (elapsed / 1000).toFixed(1);
    var durSec = (dur / 1000).toFixed(1);

    progressFill.style.width = (frac * 100) + '%';

    if (phase === 'move') {
      progressFill.style.background = '#4CAF50';
      progressLabel.textContent = 'Step ' + phaseDisplay + '  ' + elSec + 's / ' + durSec + 's';
    } else if (phase === 'interval') {
      progressFill.style.background = '#FF9800';
      progressLabel.textContent = 'Interval  ' + elSec + 's / ' + durSec + 's';
    } else if (phase === 'stay') {
      progressFill.style.background = '#2196F3';
      progressLabel.textContent = 'Reset  ' + elSec + 's / ' + durSec + 's';
    }

    if (frac < 1) {
      progressRafId = requestAnimationFrame(tickProgress);
    }
  }

  function startPhase(p, duration, display) {
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }
    phase = p;
    phaseStart = Date.now();
    phaseDuration = duration;
    phaseDisplay = display || '';
    if (progressEl) progressEl.style.display = '';
    progressRafId = requestAnimationFrame(tickProgress);
  }

  function stopPhase() {
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }
    phase = null;
    if (progressFill) progressFill.style.width = '0%';
    if (progressLabel) progressLabel.textContent = '';
  }

  // ── Joint interpolation for world robots ──

  /**
   * Smoothstep-interpolate joints for all robots simultaneously.
   * targets: { varName: { start: [6], end: [6] }, ... }
   */
  function animateAllRobots(targets, durationMs) {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    var WV = window.WorldViewer;
    if (!WV) return;

    var t0 = performance.now();
    var names = Object.keys(targets);

    function step() {
      var elapsed = performance.now() - t0;
      var t = Math.min(elapsed / durationMs, 1);
      var s = t * t * (3 - 2 * t); // smoothstep

      for (var n = 0; n < names.length; n++) {
        var name = names[n];
        var tgt = targets[name];
        var cur = [];
        for (var i = 0; i < 6; i++) {
          cur[i] = tgt.start[i] + (tgt.end[i] - tgt.start[i]) * s;
        }
        WV.setJoints(name, cur);
      }

      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = null;
      }
    }

    rafId = requestAnimationFrame(step);
  }

  // ── Pre-compute all move targets for a variable ──

  /**
   * Compute the full list of target joint arrays for a variable's moves.
   * Uses the individual RobotViewer's IK (via targetJointsFromMove) for
   * coordinate moves, then restores the viewer's state.
   */
  function precomputeTargets(varName) {
    var moves = window.parseMovesFromCode(varName);
    if (moves.length === 0) return [];

    var targetFn = window.RobotAnimation.targetJointsFromMove;
    if (!targetFn) return [];

    // Save individual viewer state
    var viewer = window._robotViewer;
    var savedJoints = viewer ? viewer.getJoints() : [0, 0, 0, 0, 0, 0];

    // Reset viewer to home for consistent computation
    if (viewer) viewer.setJoints([0, 0, 0, 0, 0, 0]);

    var targets = [];
    for (var i = 0; i < moves.length; i++) {
      var target = targetFn(moves[i]);
      targets.push(target);
      // For incremental moves, the viewer needs to be at the target position
      // for the next move's computation
      if (viewer) viewer.setJoints(target);
    }

    // Restore viewer state
    if (viewer) viewer.setJoints(savedJoints);

    return targets;
  }

  // ── Core synchronized animation loop ──

  var moveStartTime = 0; // tracks when the current move phase started

  function startAnimation() {
    var C = getConsts();
    var WV = window.WorldViewer;
    if (!C || !WV) return;

    haltAnimation();
    running = true;
    paused = false;

    // Only animate visible (checked) robots
    var robotNames = WV.getVisibleRobotNames();
    if (robotNames.length === 0) {
      if (progressEl) progressEl.style.display = '';
      if (progressFill) {
        progressFill.style.width = '100%';
        progressFill.style.background = '#9E9E9E';
      }
      if (progressLabel) progressLabel.textContent = 'No robots selected';
      running = false;
      return;
    }

    // Pre-compute all targets for visible robots only
    var allTargets = {};
    var maxSteps = 0;
    for (var r = 0; r < robotNames.length; r++) {
      var name = robotNames[r];
      var targets = precomputeTargets(name);
      allTargets[name] = targets;
      if (targets.length > maxSteps) maxSteps = targets.length;
    }

    if (maxSteps === 0) {
      if (progressEl) progressEl.style.display = 'none';
      running = false;
      return;
    }

    // Save for pause/resume
    savedAllTargets = allTargets;
    savedRobotNames = robotNames;
    savedMaxSteps = maxSteps;

    // Reset visible robots to home
    for (var r = 0; r < robotNames.length; r++) {
      WV.setJoints(robotNames[r], [0, 0, 0, 0, 0, 0]);
    }

    savedStepIndex = 0;
    runStepLoop(robotNames, allTargets, maxSteps, 0, 500);
  }

  /**
   * Run the step loop starting at stepIndex, with an initial delay.
   */
  function runStepLoop(robotNames, allTargets, maxSteps, stepIndex, initialDelay) {
    var C = getConsts();
    var WV = window.WorldViewer;

    function runStep() {
      if (!running || paused) return;
      savedStepIndex = stepIndex;

      if (stepIndex >= maxSteps) {
        if (!loopEnabled) {
          if (progressEl) progressEl.style.display = '';
          if (progressFill) {
            progressFill.style.width = '100%';
            progressFill.style.background = '#9E9E9E';
          }
          if (progressLabel) progressLabel.textContent = 'Done';
          running = false;
          return;
        }
        startPhase('stay', C.STAY_DUR);
        animTimer = setTimeout(function() {
          for (var r = 0; r < robotNames.length; r++) {
            WV.setJoints(robotNames[r], [0, 0, 0, 0, 0, 0]);
          }
          stepIndex = 0;
          savedStepIndex = 0;
          animTimer = setTimeout(runStep, 100);
        }, C.STAY_DUR);
        return;
      }

      // Build interpolation targets
      var interpTargets = {};
      for (var r = 0; r < robotNames.length; r++) {
        var name = robotNames[r];
        var robotTargets = allTargets[name];
        var startJoints = WV.getJoints(name);
        var endJoints;

        if (stepIndex < robotTargets.length) {
          endJoints = robotTargets[stepIndex];
        } else {
          endJoints = startJoints.slice();
        }

        interpTargets[name] = { start: startJoints, end: endJoints };
      }

      var label = (stepIndex + 1) + '/' + maxSteps;
      startPhase('move', C.MOVE_DUR, label);
      moveStartTime = Date.now();
      pausedPhase = 'move';
      animateAllRobots(interpTargets, C.MOVE_DUR);
      stepIndex++;
      savedStepIndex = stepIndex;

      animTimer = setTimeout(function() {
        pausedPhase = 'interval';
        startPhase('interval', C.INTERVAL);
        animTimer = setTimeout(function() {
          pausedPhase = null;
          runStep();
        }, C.INTERVAL);
      }, C.MOVE_DUR);
    }

    animTimer = setTimeout(runStep, initialDelay);
  }

  /**
   * Halt all timers and animation frames (internal helper).
   */
  function haltAnimation() {
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopPhase();
  }

  /**
   * Stop animation and reset all robots to home.
   */
  function stopAnimation() {
    haltAnimation();
    running = false;
    paused = false;
    pausedPhase = null;
    savedStepIndex = 0;

    // Reset all visible robots to home
    var WV = window.WorldViewer;
    if (WV) {
      var names = WV.getVisibleRobotNames();
      for (var i = 0; i < names.length; i++) {
        WV.setJoints(names[i], [0, 0, 0, 0, 0, 0]);
      }
    }
    if (progressEl) progressEl.style.display = 'none';
  }

  /**
   * Pause animation mid-playback (can be resumed).
   */
  function pauseAnimation() {
    if (!running || paused) return;
    paused = true;
    pausedMoveElapsed = Date.now() - moveStartTime;

    // Freeze timers and rAF but keep running=true
    if (animTimer) { clearTimeout(animTimer); animTimer = null; }
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

    // Freeze progress bar
    if (progressRafId) { cancelAnimationFrame(progressRafId); progressRafId = null; }

    if (progressLabel) {
      progressLabel.textContent = '⏸ Paused — Step ' + savedStepIndex + '/' + savedMaxSteps;
    }
    if (progressFill) {
      progressFill.style.background = '#FF9800';
    }
    if (progressEl) progressEl.style.display = '';
  }

  /**
   * Resume from paused state, finishing the interrupted move if mid-move.
   */
  function resumeAnimation() {
    if (!running || !paused) return;
    paused = false;

    var C = getConsts();
    var WV = window.WorldViewer;
    if (!C || !WV || !savedRobotNames || !savedAllTargets) {
      // Can't resume — start fresh
      startAnimation();
      return;
    }

    if (pausedPhase === 'move' && pausedMoveElapsed < C.MOVE_DUR) {
      // We were mid-move. savedStepIndex was already incremented to the
      // NEXT step, so the move we interrupted is at savedStepIndex - 1.
      var pausedStepIdx = savedStepIndex - 1;
      if (pausedStepIdx < 0) pausedStepIdx = 0;

      var remaining = C.MOVE_DUR - pausedMoveElapsed;

      // Build interpolation targets: current joints → original target
      var interpTargets = {};
      for (var r = 0; r < savedRobotNames.length; r++) {
        var name = savedRobotNames[r];
        var robotTargets = savedAllTargets[name];
        var currentJoints = WV.getJoints(name);
        var endJoints;

        if (pausedStepIdx < robotTargets.length) {
          endJoints = robotTargets[pausedStepIdx];
        } else {
          endJoints = currentJoints.slice();
        }

        interpTargets[name] = { start: currentJoints, end: endJoints };
      }

      // Finish the interrupted move over the remaining time
      var label = (pausedStepIdx + 1) + '/' + savedMaxSteps;
      startPhase('move', remaining, label);
      // Backdate phase start so progress bar shows cumulative time
      phaseStart = Date.now() - pausedMoveElapsed;
      phaseDuration = C.MOVE_DUR;
      moveStartTime = Date.now() - pausedMoveElapsed;
      animateAllRobots(interpTargets, remaining);

      // After the remaining move time, continue with interval → next step
      animTimer = setTimeout(function() {
        pausedPhase = 'interval';
        startPhase('interval', C.INTERVAL);
        animTimer = setTimeout(function() {
          pausedPhase = null;
          runStepLoop(savedRobotNames, savedAllTargets, savedMaxSteps, savedStepIndex, 0);
        }, C.INTERVAL);
      }, remaining);

    } else if (pausedPhase === 'interval') {
      // Paused during interval — just continue to the next step
      pausedPhase = null;
      runStepLoop(savedRobotNames, savedAllTargets, savedMaxSteps, savedStepIndex, 100);

    } else {
      // Paused in an unknown phase — resume from next step
      runStepLoop(savedRobotNames, savedAllTargets, savedMaxSteps, savedStepIndex, 100);
    }
  }

  function setProgressElements(el, label, fill) {
    progressEl = el;
    progressLabel = label;
    progressFill = fill;
  }

  function setLoop(enabled) {
    loopEnabled = enabled;
    // Restart from beginning
    var WV = window.WorldViewer;
    if (WV) {
      var names = WV.getRobotNames();
      for (var i = 0; i < names.length; i++) {
        WV.setJoints(names[i], [0, 0, 0, 0, 0, 0]);
      }
    }
    startAnimation();
  }

  function isLoopEnabled() {
    return loopEnabled;
  }

  function isRunning() {
    return running;
  }

  function isPaused() {
    return paused;
  }

  window.WorldAnimation = {
    start: startAnimation,
    stop: stopAnimation,
    pause: pauseAnimation,
    resume: resumeAnimation,
    setProgressElements: setProgressElements,
    isPaused: isPaused,
    setLoop: setLoop,
    isLoopEnabled: isLoopEnabled,
    isRunning: isRunning
  };
})();
