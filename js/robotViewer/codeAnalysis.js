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
    // source code fingerprint that recordedMoves was built from
    recordedMovesCode: null,
    // true while a /simulate-moves request is in flight
    recordingInFlight: false,
    // last error message from dry-run (if any)
    recordError: null
  };

  // Parse the generated Python code into structural info:
  //   - which variables are direct Mirobot_UART assignments at top level
  //   - which functions internally create Mirobot_UART and return it
  //   - which variables are assigned from calling those functions
  function analyzeRobotCode(code) {
    const lines = code.split('\n');
    const result = {
      directVars: [],
      funcReturnVars: [],
      robotFunctions: {},
      callerToFunc: {}
    };

    let inFunc = null;
    let funcIndent = 0;
    let funcBodyLines = [];
    let funcInternalVar = null;
    let funcReturnsRobot = false;

    function saveFunc() {
      if (inFunc && funcInternalVar && funcReturnsRobot) {
        result.robotFunctions[inFunc] = {
          internalVar: funcInternalVar,
          bodyLines: funcBodyLines.slice()
        };
      }
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
        funcReturnsRobot = false;
        continue;
      }

      if (inFunc !== null) {
        const lineIndent = line.search(/\S/);
        if (trimmed.length > 0 && lineIndent <= funcIndent) {
          saveFunc();
          inFunc = null;
          funcBodyLines = [];
          funcInternalVar = null;
          funcReturnsRobot = false;
        } else {
          funcBodyLines.push(trimmed);
          const innerAssign = trimmed.match(/^(\w+)\s*=\s*wlkatapython\.Mirobot_UART\s*\(/);
          if (innerAssign) {
            funcInternalVar = innerAssign[1];
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

      const directMatch = trimmed.match(/^(\w+)\s*=\s*wlkatapython\.Mirobot_UART\s*\(/);
      if (directMatch) {
        result.directVars.push(directMatch[1]);
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
      window.RobotCodeAnalysis.recordedMovesCode = code;
      window.RobotCodeAnalysis.recordError = null;
      return Promise.resolve({ success: true, moves: {} });
    }

    // Skip if we already have a fresh recording for this exact code
    if (window.RobotCodeAnalysis.recordedMoves &&
        window.RobotCodeAnalysis.recordedMovesCode === code &&
        !window.RobotCodeAnalysis.recordError) {
      return Promise.resolve({
        success: true,
        moves: window.RobotCodeAnalysis.recordedMoves,
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
          window.RobotCodeAnalysis.recordedMovesCode = code;
          window.RobotCodeAnalysis.recordError =
            result.error || (result.timed_out ? 'Simulation timed out' : null);
          console.log('[simulate-moves] Recorded moves for',
            Object.keys(result.moves),
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
              code: codeToRun,
              error: (result && result.error) || window.RobotCodeAnalysis.recordError,
              cached: !!(result && result.cached)
            }
          }));
        } catch (e) { /* ignore */ }
      });
    }, delayMs == null ? 400 : delayMs);
  }

  // Expose globally
  window.analyzeRobotCode = analyzeRobotCode;
  window.extractMovesFromLines = extractMovesFromLines;
  window.parseMovesFromCode = parseMovesFromCode;
  window.refreshRecordedMoves = refreshRecordedMoves;
  window.scheduleRecordedMovesRefresh = scheduleRecordedMovesRefresh;
})();
