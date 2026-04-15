// Robot code analysis: parse generated Python to find robot variables and moves.
// Exposes: window.analyzeRobotCode, window.extractMovesFromLines, window.parseMovesFromCode,
//          window.RobotCodeAnalysis (shared state)

(function() {
  // Shared state for cached analysis
  window.RobotCodeAnalysis = {
    lastAnalysis: null
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

  // Extract moves from an array of code lines for a given variable name
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

      const wa = trimmed.match(/\.writeangle\s*\(\s*([^)]+)\s*\)/);
      if (wa) {
        const args = wa[1].split(',').map(s => parseFloat(s.trim()) || 0);
        moves.push({
          Axis1: args[1] || 0,
          Axis2: args[2] || 0,
          Axis3: args[3] || 0,
          Axis4: args[4] || 0,
          Axis5: args[5] || 0,
          type: 'writeangle'
        });
      }

      const wc = trimmed.match(/\.(writecoordinate|set_wrist_pose|p2p_interpolation)\s*\(\s*([^)]+)\s*\)/);
      if (wc) {
        const args = wc[2].split(',').map(s => parseFloat(s.trim()) || 0);
        moves.push({
          Axis1: args[0] || 0,
          Axis2: args[1] || 0,
          Axis3: args[2] || 0,
          Axis4: args[3] || 0,
          Axis5: args[4] || 0,
          type: wc[1]
        });
      }
    }
    return moves;
  }

  // Parse code to extract move sequence for a specific variable.
  function parseMovesFromCode(variableName) {
    const codeEl = document.getElementById('code-preview');
    if (!codeEl) return [];
    const code = codeEl.textContent || '';
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

  // Expose globally
  window.analyzeRobotCode = analyzeRobotCode;
  window.extractMovesFromLines = extractMovesFromLines;
  window.parseMovesFromCode = parseMovesFromCode;
})();