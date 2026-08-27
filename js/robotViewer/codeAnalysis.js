// Robot code analysis: parse generated Python to find robot variables and moves.
// Exposes: window.analyzeRobotCode, window.extractMovesFromLines, window.parseMovesFromCode,
//          window.refreshRecordedMoves, window.scheduleRecordedMovesRefresh,
//          window.RobotCodeAnalysis (shared state)
//
// Move values for animation come from a server dry-run (/simulate-moves) that
// executes the code with mock robots and records every writeCoordinate/writeAngle.
// Static parsing below is only a last-resort fallback (literals only).

(function() {
  // Shared state for cached analysis / dry-run recordings
  window.RobotCodeAnalysis = {
    lastAnalysis: null,
    // movesByVar from server dry-run: { arm: [move, ...], ... }
    recordedMoves: null,
    // waitIdle-aware segments (legacy coarse split)
    recordedSegments: null,
    // Concurrent schedule: [{ var, start, end, move }, ...] unit time slots
    // start/end are integers; real waitIdle semantics (see move_simulator).
    recordedSchedule: null,
    // Named timeline from dry-run (for client-side schedule rebuild)
    recordedTimeline: null,
    // source code fingerprint that recordedMoves was built from
    recordedMovesCode: null,
    // true while a /simulate-moves request is in flight
    recordingInFlight: false,
    // last error message from dry-run (if any)
    recordError: null
  };

  // Match any wlkatapython robot constructor: Mirobot_UART, MT4_UART, E4_UART, etc.
  var ROBOT_CTOR_RE = /^(\w+)\s*=\s*wlkatapython\.(\w+_UART)\s*\(/;

  /**
   * Map a constructor class / setup_robot MODEL string to a short model label.
   * e.g. 'MT4_UART' → 'MT4', 'wlkatapython.Mirobot_UART' → 'Mirobot'
   * Prefer RobotCatalog (robots.json); keep local heuristics as fallback.
   */
  function normalizeRobotModelName(raw) {
    if (window.RobotCatalog && typeof window.RobotCatalog.normalizeModelName === 'function') {
      return window.RobotCatalog.normalizeModelName(raw);
    }
    if (!raw) return null;
    var s = String(raw).replace(/^wlkatapython\./i, '').trim();
    if (!s) return null;
    if (/MT4/i.test(s)) return 'MT4';
    if (/\bE4\b/i.test(s) || /^E4/i.test(s)) return 'E4';
    if (/Haro/i.test(s)) return 'MT4';
    if (/Mirobot/i.test(s)) return 'Mirobot';
    // Generic: strip common suffixes
    s = s.replace(/_UART$/i, '').replace(/_USB$/i, '');
    return s || null;
  }

  // Parse the generated Python code into structural info:
  //   - which variables are direct robot UART assignments at top level
  //   - which functions internally create a robot UART and return it
  //   - which variables are assigned from calling those functions
  //   - varModels maps each robot var → constructor class (e.g. 'MT4_UART')
  function analyzeRobotCode(code) {
    const lines = code.split('\n');
    const result = {
      directVars: [],
      funcReturnVars: [],
      robotFunctions: {},
      callerToFunc: {},
      // varName -> constructor class name (e.g. 'MT4_UART')
      varModels: {}
    };

    let inFunc = null;
    let funcIndent = 0;
    let funcBodyLines = [];
    let funcInternalVar = null;
    let funcInternalModel = null;
    let funcReturnsRobot = false;

    function saveFunc() {
      if (inFunc && funcInternalVar && funcReturnsRobot) {
        result.robotFunctions[inFunc] = {
          internalVar: funcInternalVar,
          bodyLines: funcBodyLines.slice(),
          // Constructor class used inside the function (e.g. 'MT4_UART')
          model: funcInternalModel || null
        };
      }
    }

    function resetFuncState() {
      inFunc = null;
      funcBodyLines = [];
      funcInternalVar = null;
      funcInternalModel = null;
      funcReturnsRobot = false;
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      const defMatch = trimmed.match(/^def\s+(\w+)\s*\(/);
      if (defMatch) {
        saveFunc();
        inFunc = defMatch[1];
        funcIndent = line.search(/\S/);
        funcBodyLines = [];
        funcInternalVar = null;
        funcInternalModel = null;
        funcReturnsRobot = false;
        continue;
      }

      if (inFunc !== null) {
        const lineIndent = line.search(/\S/);
        if (trimmed.length > 0 && lineIndent <= funcIndent) {
          saveFunc();
          resetFuncState();
          // Fall through — this line may be a top-level assignment after the def
        } else {
          funcBodyLines.push(trimmed);
          const innerAssign = trimmed.match(ROBOT_CTOR_RE);
          if (innerAssign) {
            funcInternalVar = innerAssign[1];
            funcInternalModel = innerAssign[2];
          }
          if (funcInternalVar) {
            const retMatch = trimmed.match(/^return\s+(\w+)/);
            if (retMatch && retMatch[1] === funcInternalVar) {
              funcReturnsRobot = true;
            }
          }
          continue;
        }
      }

      const directMatch = trimmed.match(ROBOT_CTOR_RE);
      if (directMatch) {
        result.directVars.push(directMatch[1]);
        result.varModels[directMatch[1]] = directMatch[2];
        continue;
      }

      const callMatch = trimmed.match(/^(\w+)\s*=\s*(\w+)\s*\(/);
      if (callMatch) {
        const varName = callMatch[1];
        const funcName = callMatch[2];
        result.callerToFunc[varName] = funcName;
      }
    }

    saveFunc();

    for (const [varName, funcName] of Object.entries(result.callerToFunc)) {
      if (result.robotFunctions[funcName]) {
        result.funcReturnVars.push(varName);
        // Propagate constructor model from the factory function to the caller var
        const model = result.robotFunctions[funcName].model;
        if (model) {
          result.varModels[varName] = model;
        }
      }
    }
    for (const varName of Object.keys(result.callerToFunc)) {
      if (!result.robotFunctions[result.callerToFunc[varName]]) {
        delete result.callerToFunc[varName];
      }
    }

    return result;
  }

  // Extract moves from an array of code lines for a given variable name.
  // Fallback only: numeric literals via parseFloat; variables become 0.
  // Prefer dry-run recordings (parseMovesFromCode) for real values / loops.
  function extractMovesFromLines(lines, varName) {
    const moves = [];
    let varPattern = null;
    if (varName) {
      const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      varPattern = new RegExp('(^|\\W)' + escapedVar + '\\.');
    }

    for (const line of lines) {
      const trimmed = (typeof line === 'string') ? line.trim() : '';
      if (varPattern && !varPattern.test(trimmed)) continue;

      if (/\.homing\s*\(/.test(trimmed)) {
        moves.push({ Axis1: 0, Axis2: 0, Axis3: 0, Axis4: 0, Axis5: 0, type: 'homing' });
      }

      // writeAngle(positionMode, J1, J2, J3, J4, J5, J6)
      //   args[0] = position mode (0=absolute, 1=incremental)
      //   args[1..6] = joint angles
      const wa = trimmed.match(/\.writeAngle\s*\(\s*([^)]+)\s*\)/);
      if (wa) {
        const args = wa[1].split(',').map(s => parseFloat(s.trim()) || 0);
        moves.push({
          Axis1: args[1] || 0,
          Axis2: args[2] || 0,
          Axis3: args[3] || 0,
          Axis4: args[4] || 0,
          Axis5: args[5] || 0,
          Axis6: args[6] || 0,
          incremental: args[0] === 1,
          type: 'writeAngle'
        });
      }

      // writeCoordinate(motionMode, positionMode, X, Y, Z, A, B, C)
      //   args[0] = motion mode (0=fast, 1=linear, 2=joint)
      //   args[1] = position mode (0=absolute, 1=incremental)
      //   args[2..7] = X, Y, Z, A, B, C
      const wc = trimmed.match(/\.writeCoordinate\s*\(\s*([^)]+)\s*\)/);
      if (wc) {
        const args = wc[1].split(',').map(s => parseFloat(s.trim()) || 0);
        moves.push({
          Axis1: args[2] || 0,
          Axis2: args[3] || 0,
          Axis3: args[4] || 0,
          Axis4: args[5] || 0,
          Axis5: args[6] || 0,
          Axis6: args[7] || 0,
          incremental: args[1] === 1,
          type: 'writeCoordinate'
        });
      }
    }
    return moves;
  }

  // Parse code to extract move sequence for a specific variable.
  // Prefers server dry-run recordings when available and fresh for the
  // current code; falls back to static literal parsing otherwise.
  function parseMovesFromCode(variableName) {
    const codeEl = document.getElementById('code-preview');
    if (!codeEl) return [];
    const code = codeEl.textContent || '';

    const rec = window.RobotCodeAnalysis.recordedMoves;
    const recCode = window.RobotCodeAnalysis.recordedMovesCode;
    if (rec && recCode === code && variableName &&
        Object.prototype.hasOwnProperty.call(rec, variableName)) {
      return (rec[variableName] || []).slice();
    }

    const allLines = code.split('\n');
    const analysis = window.RobotCodeAnalysis.lastAnalysis || analyzeRobotCode(code);
    const moves = [];

    if (variableName && analysis.callerToFunc[variableName]) {
      const funcName = analysis.callerToFunc[variableName];
      const funcInfo = analysis.robotFunctions[funcName];
      if (funcInfo) {
        const bodyMoves = extractMovesFromLines(funcInfo.bodyLines, funcInfo.internalVar);
        moves.push(...bodyMoves);
        console.log('[parseMovesFromCode] Inlined', bodyMoves.length,
          'moves from function', funcName, 'for variable', variableName);
      }
    }

    if (variableName) {
      const topLevelLines = [];
      let insideFunc = false;
      let funcDefIndent = 0;
      for (const line of allLines) {
        const trimmed = line.trim();
        const defMatch = trimmed.match(/^def\s+\w+\s*\(/);
        if (defMatch) {
          insideFunc = true;
          funcDefIndent = line.search(/\S/);
          continue;
        }
        if (insideFunc) {
          const lineIndent = line.search(/\S/);
          if (trimmed.length > 0 && lineIndent <= funcDefIndent) {
            insideFunc = false;
          } else {
            continue;
          }
        }
        topLevelLines.push(trimmed);
      }

      const directMoves = extractMovesFromLines(topLevelLines, variableName);
      moves.push(...directMoves);
    } else {
      const allMoves = extractMovesFromLines(allLines, null);
      moves.push(...allMoves);
    }

    return moves;
  }

  /**
   * Ask the server to dry-run the current (or provided) code and cache
   * the fully unrolled move lists per robot variable.
   * Debounced callers should use scheduleRecordedMovesRefresh().
   */
  function refreshRecordedMoves(codeOverride) {
    var codeEl = document.getElementById('code-preview');
    var code = (codeOverride != null) ? codeOverride : (codeEl ? (codeEl.textContent || '') : '');
    if (!code.trim()) {
      window.RobotCodeAnalysis.recordedMoves = {};
      window.RobotCodeAnalysis.recordedSegments = [];
      window.RobotCodeAnalysis.recordedSchedule = [];
      window.RobotCodeAnalysis.recordedTimeline = [];
      window.RobotCodeAnalysis.recordedMovesCode = code;
      window.RobotCodeAnalysis.recordError = null;
      return Promise.resolve({ success: true, moves: {}, segments: [], schedule: [], timeline: [] });
    }

    // Skip if we already have a fresh recording for this exact code.
    // Require schedule to be an array so pre-schedule cache entries re-fetch.
    if (window.RobotCodeAnalysis.recordedMoves &&
        window.RobotCodeAnalysis.recordedMovesCode === code &&
        !window.RobotCodeAnalysis.recordError &&
        Array.isArray(window.RobotCodeAnalysis.recordedSchedule)) {
      return Promise.resolve({
        success: true,
        moves: window.RobotCodeAnalysis.recordedMoves,
        segments: window.RobotCodeAnalysis.recordedSegments || [],
        schedule: window.RobotCodeAnalysis.recordedSchedule || [],
        timeline: window.RobotCodeAnalysis.recordedTimeline || [],
        cached: true
      });
    }

    var serverUrl = (typeof getServerUrl === 'function')
      ? getServerUrl()
      : 'http://127.0.0.1:5080';

    window.RobotCodeAnalysis.recordingInFlight = true;

    return fetch(serverUrl + '/simulate-moves', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, timeout: 3.0 }),
      signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
        ? AbortSignal.timeout(10000)
        : undefined
    })
      .then(function(resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return resp.json();
      })
      .then(function(result) {
        window.RobotCodeAnalysis.recordingInFlight = false;
        if (result && result.moves) {
          window.RobotCodeAnalysis.recordedMoves = result.moves;
          window.RobotCodeAnalysis.recordedSegments =
            Array.isArray(result.segments) ? result.segments : null;
          window.RobotCodeAnalysis.recordedTimeline =
            Array.isArray(result.timeline) ? result.timeline : null;
          var sch = Array.isArray(result.schedule) ? result.schedule : null;
          // Rebuild from timeline if server omitted schedule (older backend)
          if ((!sch || !sch.length) && result.timeline && result.timeline.length) {
            sch = buildScheduleFromTimeline(result.timeline);
          }
          window.RobotCodeAnalysis.recordedSchedule = sch || [];
          window.RobotCodeAnalysis.recordedMovesCode = code;
          window.RobotCodeAnalysis.recordError =
            result.error || (result.timed_out ? 'Simulation timed out' : null);
          console.log('[simulate-moves] Recorded moves for',
            Object.keys(result.moves),
            'schedule slots:', (window.RobotCodeAnalysis.recordedSchedule || []).length,
            result.timed_out ? '(timed out, partial)' : '');
        } else {
          window.RobotCodeAnalysis.recordError =
            (result && result.error) || 'No moves returned';
        }
        return result;
      })
      .catch(function(err) {
        window.RobotCodeAnalysis.recordingInFlight = false;
        window.RobotCodeAnalysis.recordError = String(err && err.message || err);
        // Keep previous recordedMoves if any; static analysis remains fallback
        console.warn('[simulate-moves] Failed:', err);
        return { success: false, error: String(err && err.message || err) };
      });
  }

  var _recordRefreshTimer = null;
  var _recordRefreshPendingCode = null;

  /**
   * Debounced dry-run refresh. Fires `robotMovesRecorded` on window when done
   * so viewers can restart animation with the unrolled sequence.
   */
  function scheduleRecordedMovesRefresh(delayMs) {
    var codeEl = document.getElementById('code-preview');
    var code = codeEl ? (codeEl.textContent || '') : '';
    _recordRefreshPendingCode = code;
    if (_recordRefreshTimer) clearTimeout(_recordRefreshTimer);
    _recordRefreshTimer = setTimeout(function() {
      _recordRefreshTimer = null;
      var codeToRun = _recordRefreshPendingCode;
      refreshRecordedMoves(codeToRun).then(function(result) {
        try {
          window.dispatchEvent(new CustomEvent('robotMovesRecorded', {
            detail: {
              moves: (result && result.moves) || window.RobotCodeAnalysis.recordedMoves,
              segments: (result && result.segments) || window.RobotCodeAnalysis.recordedSegments,
              schedule: (result && result.schedule) || window.RobotCodeAnalysis.recordedSchedule,
              code: codeToRun,
              error: (result && result.error) || window.RobotCodeAnalysis.recordError,
              cached: !!(result && result.cached)
            }
          }));
        } catch (e) { /* ignore */ }
      });
    }, delayMs == null ? 400 : delayMs);
  }

  /**
   * Mirror of server build_move_schedule — real waitIdle semantics.
   *
   * Motion is non-blocking (queued per robot). waitIdle(R) only stalls the
   * *program* until R is free; wait on an already-idle robot is a no-op.
   *
   * Example: A.1, A.2, waitIdle(B), A.3, B.1
   *   → A at t=0,1,2; B at t=0  (B starts with A; wait B does nothing)
   */
  function buildScheduleFromTimeline(timeline) {
    if (!Array.isArray(timeline) || timeline.length === 0) return [];
    var codeTime = 0;
    var freeAt = {};
    var schedule = [];
    for (var i = 0; i < timeline.length; i++) {
      var ev = timeline[i];
      var name = ev.var || ev.varName;
      if (!name) continue;
      if (ev.type === 'move') {
        var start = Math.max(freeAt[name] || 0, codeTime);
        var end = start + 1;
        freeAt[name] = end;
        schedule.push({
          var: name,
          start: start,
          end: end,
          move: ev.move
        });
      } else if (ev.type === 'waitIdle') {
        codeTime = Math.max(codeTime, freeAt[name] || 0);
      }
    }
    return schedule;
  }

  /**
   * Concurrent move schedule for World animation (true waitIdle semantics).
   * [{ var, start, end, move }, ...] with integer unit times.
   */
  function getAnimationSchedule() {
    var sch = window.RobotCodeAnalysis.recordedSchedule;
    if (Array.isArray(sch) && sch.length > 0) {
      // Coerce start/end to numbers (defensive against JSON quirks)
      return sch.map(function(item) {
        return {
          var: item.var || item.varName,
          start: Number(item.start) || 0,
          end: Number(item.end) || ((Number(item.start) || 0) + 1),
          move: item.move
        };
      });
    }
    // Rebuild from timeline if available
    var tl = window.RobotCodeAnalysis.recordedTimeline;
    if (Array.isArray(tl) && tl.length > 0) {
      var rebuilt = buildScheduleFromTimeline(tl);
      if (rebuilt.length) return rebuilt;
    }
    // Last resort: sequential slots from flat move lists (ignores waitIdle)
    var moves = window.RobotCodeAnalysis.recordedMoves;
    if (!moves) return [];
    var out = [];
    Object.keys(moves).forEach(function(k) {
      var list = moves[k] || [];
      for (var i = 0; i < list.length; i++) {
        out.push({ var: k, start: i, end: i + 1, move: list[i] });
      }
    });
    return out;
  }

  /** @deprecated use getAnimationSchedule */
  function getAnimationSegments() {
    var segs = window.RobotCodeAnalysis.recordedSegments;
    if (Array.isArray(segs) && segs.length > 0) return segs;
    return [];
  }

  // Expose globally
  window.analyzeRobotCode = analyzeRobotCode;
  window.normalizeRobotModelName = normalizeRobotModelName;
  window.extractMovesFromLines = extractMovesFromLines;
  window.parseMovesFromCode = parseMovesFromCode;
  window.refreshRecordedMoves = refreshRecordedMoves;
  window.scheduleRecordedMovesRefresh = scheduleRecordedMovesRefresh;
  window.getAnimationSegments = getAnimationSegments;
  window.getAnimationSchedule = getAnimationSchedule;
})();
