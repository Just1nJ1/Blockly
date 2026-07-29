// World Animation — multi-robot animation for the World tab.
//
// Layers:
//   1. Dry-run schedule — waitIdle concurrent timing (free_at / code_time).
//   2. Per-robot IK chain — joint home (J=0°) then moveBy/moveTo via
//      RobotAnimation.computeMoveTargets (proven path, not XYZ origin).
//   3. Playback — unit time slots + pause/resume.
//
// Depends on: animation.js, worldViewer.js, codeAnalysis.js
// Optional: window.ensureIkViewer(varName) → Promise (loads _robotViewer mesh)
// Exposes: window.WorldAnimation

(function() {
  'use strict';

  var ANIM_CONSTS = null;  // populated from RobotAnimation
  var loopEnabled = false;
  var running = false;
  var paused = false;
  var animTimer = null;
  var rafId = null;

  // Saved state for pause/resume
  var savedStepIndex = 0;
  var savedAllTargets = null;   // { name: [{start, end, joints, move}, ...] }
  var savedRobotNames = null;
  var savedMaxSteps = 0;        // max end time (unit slots)
  var pausedMoveElapsed = 0;
  var pausedPhase = null;

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

  /** Joint home: J1…J6 = 0° (not Cartesian XYZ origin). */
  function jointHome() {
    if (window.RobotAnimation && typeof window.RobotAnimation.jointHome === 'function') {
      return window.RobotAnimation.jointHome();
    }
    return [0, 0, 0, 0, 0, 0];
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
   * Joint targets for an ordered move list via proven moveBy/moveTo chain.
   */
  function precomputeTargetsFromMoves(varName, moves, startJoints) {
    if (!moves || moves.length === 0) return [];
    var compute = window.RobotAnimation && window.RobotAnimation.computeMoveTargets;
    var seed = startJoints || jointHome();
    if (compute) return compute(moves, seed);

    var targetFn = window.RobotAnimation && window.RobotAnimation.targetJointsFromMove;
    if (!targetFn) return [];
    var viewer = window._robotViewer;
    var saved = viewer ? viewer.getJoints() : null;
    if (viewer) viewer.setJoints(seed.slice());
    var targets = [];
    for (var i = 0; i < moves.length; i++) {
      var target = targetFn(moves[i]);
      targets.push(target);
      if (viewer) viewer.setJoints(target);
    }
    if (viewer && saved) viewer.setJoints(saved);
    return targets;
  }

  function precomputeTargets(varName) {
    var moves = window.parseMovesFromCode(varName);
    return precomputeTargetsFromMoves(varName, moves, jointHome());
  }

  // ── Core synchronized animation loop ──

  var moveStartTime = 0; // tracks when the current move phase started

  /**
   * Group schedule rows by robot (sorted by start time).
   */
  function groupScheduleByRobot(robotNames, schedule) {
    var groups = {};
    var r, i, item, name;
    for (r = 0; r < robotNames.length; r++) {
      groups[robotNames[r]] = [];
    }
    for (i = 0; i < schedule.length; i++) {
      item = schedule[i];
      name = item.var || item.varName;
      if (robotNames.indexOf(name) < 0) continue;
      if (!groups[name]) groups[name] = [];
      groups[name].push(item);
    }
    for (r = 0; r < robotNames.length; r++) {
      groups[robotNames[r]].sort(function(a, b) {
        return (Number(a.start) || 0) - (Number(b.start) || 0);
      });
    }
    return groups;
  }

  /**
   * Sync IK for one robot's schedule items (caller must load matching model first).
   * Returns [{ start, end, joints, move }, ...]
   */
  function precomputeRobotSlots(items) {
    var home = jointHome();
    if (!items || !items.length) return [];

    var moves = [];
    var i;
    for (i = 0; i < items.length; i++) {
      moves.push(items[i].move);
    }

    var jointTargets = precomputeTargetsFromMoves(null, moves, home);
    var slots = [];
    for (i = 0; i < items.length; i++) {
      slots.push({
        start: Number(items[i].start) || 0,
        end: Number(items[i].end) || ((Number(items[i].start) || 0) + 1),
        joints: (jointTargets[i] && jointTargets[i].slice)
          ? jointTargets[i].slice()
          : home.slice(),
        move: items[i].move
      });
    }
    return slots;
  }

  /**
   * Build per-robot { start, end, joints } from the concurrent schedule.
   * Loads each robot's IK model when window.ensureIkViewer is available so
   * Mirobot vs MT4 kinematics match the mesh family.
   * @returns {Promise<object>}
   */
  function precomputeScheduleTargets(robotNames, schedule) {
    var groups = groupScheduleByRobot(robotNames, schedule);
    var byRobot = {};
    var ensure = typeof window.ensureIkViewer === 'function'
      ? window.ensureIkViewer
      : null;

    var chain = Promise.resolve();
    var r;

    for (r = 0; r < robotNames.length; r++) {
      (function(name) {
        chain = chain.then(function() {
          var load = ensure ? ensure(name) : Promise.resolve(window._robotViewer);
          return load.then(function() {
            byRobot[name] = precomputeRobotSlots(groups[name] || []);
          }).catch(function(err) {
            console.warn('[WorldAnimation] IK precompute failed for', name, err);
            byRobot[name] = precomputeRobotSlots(groups[name] || []);
          });
        });
      })(robotNames[r]);
    }

    return chain.then(function() { return byRobot; });
  }

  function startAnimation() {
    var C = getConsts();
    var WV = window.WorldViewer;
    if (!C || !WV) return;

    haltAnimation();
    running = true;
    paused = false;

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

    var schedule = (typeof window.getAnimationSchedule === 'function')
      ? window.getAnimationSchedule()
      : [];

    schedule = (schedule || []).filter(function(item) {
      var v = item.var || item.varName;
      return robotNames.indexOf(v) >= 0;
    });

    if (schedule.length === 0) {
      if (progressEl) progressEl.style.display = 'none';
      running = false;
      return;
    }

    var maxEnd = 0;
    for (var i = 0; i < schedule.length; i++) {
      if (schedule[i].end > maxEnd) maxEnd = schedule[i].end;
    }

    if (progressLabel) {
      progressLabel.textContent = 'Preparing IK…';
    }
    if (progressEl) progressEl.style.display = '';

    // Capture generation so a newer start/stop can cancel this prepare
    var prepareGen = (startAnimation._gen = (startAnimation._gen || 0) + 1);

    precomputeScheduleTargets(robotNames, schedule).then(function(allTargets) {
      if (!running || prepareGen !== startAnimation._gen) return;

      savedAllTargets = allTargets;
      savedRobotNames = robotNames;
      savedMaxSteps = maxEnd;
      savedStepIndex = 0;

      var homePose = jointHome();
      for (var r = 0; r < robotNames.length; r++) {
        WV.setJoints(robotNames[r], homePose.slice());
      }

      runTimeLoop(robotNames, allTargets, maxEnd, 0, 300);
    }).catch(function(err) {
      console.error('[WorldAnimation] start failed:', err);
      running = false;
      if (progressLabel) progressLabel.textContent = 'IK prepare failed';
    });
  }

  /**
   * Advance global unit time t = 0 .. maxEnd-1.
   * At each t, robots that have a move with start===t animate; others hold.
   * Empty slots (no robot moving) are skipped immediately — waitIdle does not
   * insert its own pause; program stalls only delay later move *start* times.
   */
  function runTimeLoop(robotNames, allTargets, maxEnd, t, initialDelay) {
    var C = getConsts();
    var WV = window.WorldViewer;

    function finishOrLoop() {
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
        var home = jointHome();
        for (var r = 0; r < robotNames.length; r++) {
          WV.setJoints(robotNames[r], home.slice());
        }
        t = 0;
        savedStepIndex = 0;
        animTimer = setTimeout(runStep, 100);
      }, C.STAY_DUR);
    }

    function scheduleNext(afterMs) {
      animTimer = setTimeout(function() {
        pausedPhase = null;
        runStep();
      }, afterMs);
    }

    function runStep() {
      if (!running || paused) return;
      savedStepIndex = t;

      if (t >= maxEnd) {
        finishOrLoop();
        return;
      }

      var interpTargets = {};
      var anyMoving = false;
      for (var r = 0; r < robotNames.length; r++) {
        var name = robotNames[r];
        var slots = allTargets[name] || [];
        var startJoints = WV.getJoints(name);
        var endJoints = startJoints.slice();
        for (var s = 0; s < slots.length; s++) {
          if (Number(slots[s].start) === t) {
            endJoints = slots[s].joints;
            anyMoving = true;
            break;
          }
        }
        interpTargets[name] = { start: startJoints, end: endJoints };
      }

      // Skip empty time slots instantly (no artificial lag / "segment gap")
      if (!anyMoving) {
        t++;
        savedStepIndex = t;
        scheduleNext(0);
        return;
      }

      var label = (t + 1) + '/' + maxEnd;
      startPhase('move', C.MOVE_DUR, label);
      moveStartTime = Date.now();
      pausedPhase = 'move';
      animateAllRobots(interpTargets, C.MOVE_DUR);
      t++;
      savedStepIndex = t;

      // After the last move: go straight to done/loop (no trailing interval lag)
      if (t >= maxEnd) {
        animTimer = setTimeout(function() {
          pausedPhase = null;
          finishOrLoop();
        }, C.MOVE_DUR);
        return;
      }

      // Normal inter-move gap (same as single-robot animation)
      animTimer = setTimeout(function() {
        pausedPhase = 'interval';
        startPhase('interval', C.INTERVAL);
        scheduleNext(C.INTERVAL);
      }, C.MOVE_DUR);
    }

    animTimer = setTimeout(runStep, initialDelay);
  }

  /**
   * Halt all timers and animation frames (internal helper).
   */
  function haltAnimation() {
    // Invalidate in-flight async IK prepare
    startAnimation._gen = (startAnimation._gen || 0) + 1;
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

    // Reset all visible robots to joint home (J1…J6 = 0°)
    var WV = window.WorldViewer;
    if (WV) {
      var home = jointHome();
      var names = WV.getVisibleRobotNames();
      for (var i = 0; i < names.length; i++) {
        WV.setJoints(names[i], home.slice());
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
      // savedStepIndex was already advanced to the next unit time; the
      // interrupted move is at unit time (savedStepIndex - 1).
      var pausedT = savedStepIndex - 1;
      if (pausedT < 0) pausedT = 0;

      var remaining = C.MOVE_DUR - pausedMoveElapsed;

      // Build interpolation targets: current joints → slot with start === pausedT
      var interpTargets = {};
      for (var r = 0; r < savedRobotNames.length; r++) {
        var name = savedRobotNames[r];
        var slots = savedAllTargets[name] || [];
        var currentJoints = WV.getJoints(name);
        var endJoints = currentJoints.slice();
        for (var s = 0; s < slots.length; s++) {
          if (Number(slots[s].start) === pausedT) {
            endJoints = slots[s].joints;
            break;
          }
        }
        interpTargets[name] = { start: currentJoints, end: endJoints };
      }

      var label = (pausedT + 1) + '/' + savedMaxSteps;
      startPhase('move', remaining, label);
      phaseStart = Date.now() - pausedMoveElapsed;
      phaseDuration = C.MOVE_DUR;
      moveStartTime = Date.now() - pausedMoveElapsed;
      animateAllRobots(interpTargets, remaining);

      animTimer = setTimeout(function() {
        if (savedStepIndex >= savedMaxSteps) {
          pausedPhase = null;
          _resumeStepLoop(savedStepIndex, 0);
          return;
        }
        pausedPhase = 'interval';
        startPhase('interval', C.INTERVAL);
        animTimer = setTimeout(function() {
          pausedPhase = null;
          _resumeStepLoop(savedStepIndex, 0);
        }, C.INTERVAL);
      }, remaining);

    } else if (pausedPhase === 'interval') {
      pausedPhase = null;
      _resumeStepLoop(savedStepIndex, 100);

    } else {
      _resumeStepLoop(savedStepIndex, 100);
    }
  }

  function _resumeStepLoop(stepIndex, delay) {
    runTimeLoop(
      savedRobotNames,
      savedAllTargets,
      savedMaxSteps,
      stepIndex,
      delay
    );
  }

  function setProgressElements(el, label, fill) {
    progressEl = el;
    progressLabel = label;
    progressFill = fill;
  }

  function setLoop(enabled) {
    loopEnabled = enabled;
    // Restart from joint home
    var WV = window.WorldViewer;
    if (WV) {
      var home = jointHome();
      var names = WV.getRobotNames();
      for (var i = 0; i < names.length; i++) {
        WV.setJoints(names[i], home.slice());
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
