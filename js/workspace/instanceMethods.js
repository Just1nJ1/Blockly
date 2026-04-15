/**
 * Instance Methods Module
 * Handles inspection and updating of instance method information.
 */

/**
 * Preprocess generated Python code for instance inspection.
 *
 * When a variable is assigned from a user-defined function that creates and
 * returns an instance (e.g. `asd = do_something()` where `do_something`
 * creates a Mirobot_UART and returns it), the server's exec() may fail
 * because the constructor tries to open hardware.  We flatten the function
 * body so the server sees a direct assignment instead.
 *
 * Example input:
 *   def do_something():
 *     a = wlkatapython.Mirobot_UART()
 *     a.homing()
 *     return a
 *   asd = do_something()
 *
 * Example output:
 *   import wlkatapython
 *   asd = wlkatapython.Mirobot_UART()
 *
 * @param {string} code - The full generated Python code
 * @param {string} instanceName - The variable name to inspect
 * @returns {string} Preprocessed code suitable for exec()
 */
function preprocessCodeForInspection(code, instanceName) {
  const lines = code.split('\n');
  const escaped = instanceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // Step 1: Find how instanceName is assigned.
  //   Case A: direct constructor — "x = wlkatapython.Mirobot_UART(...)"
  //   Case B: function return   — "x = GetMirobot(...)"
  //   Case C: variable alias    — "x = otherVar" (trace back to otherVar's origin)
  let assignmentLine = null;   // the constructor line to keep (possibly extracted from a function)
  let assignedFunc = null;     // function name if Case B

  // Resolve variable aliases: follow "x = y" chains to find the original source.
  // Always uses the LAST assignment to the variable (handles reassignment like
  // x = A() ... x = B() — the last one wins).
  let targetVar = instanceName;
  const seen = new Set();
  while (!seen.has(targetVar)) {
    seen.add(targetVar);
    const esc = targetVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('^' + esc + '\\s*=\\s*(.+)');

    // Scan ALL lines and keep the last match
    let lastRhs = null;
    for (const line of lines) {
      const trimmed = line.trim();
      const m = trimmed.match(pattern);
      if (m) lastRhs = m[1].trim();
    }

    if (!lastRhs) break;

    const beforeParen = lastRhs.split('(')[0];
    if (beforeParen.includes('.')) {
      // Case A: direct constructor — rewrite to use the original instanceName
      assignmentLine = instanceName + ' = ' + lastRhs;
    } else if (/^\w+\s*\(/.test(lastRhs)) {
      // Case B: function call
      const funcMatch = lastRhs.match(/^(\w+)\s*\(/);
      if (funcMatch) assignedFunc = funcMatch[1];
    } else if (/^\w+$/.test(lastRhs)) {
      // Case C: bare variable alias — follow the chain
      targetVar = lastRhs;
      continue;
    }
    break;
  }

  // Step 2: If Case B, find the constructor line inside the function body
  if (assignedFunc) {
    console.log('[preprocessCodeForInspection] Found "' + instanceName + ' = ' + assignedFunc + '()", inlining function body');
    let inFunc = false;
    let funcIndent = 0;
    let internalVar = null;
    let creationLine = null;
    let returnsVar = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!inFunc) {
        if (trimmed.match(new RegExp('^def\\s+' + assignedFunc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\('))) {
          inFunc = true;
          funcIndent = line.search(/\S/);
        }
        continue;
      }
      // Inside function body
      const lineIndent = line.search(/\S/);
      if (trimmed.length > 0 && lineIndent <= funcIndent) break;

      const createMatch = trimmed.match(/^(\w+)\s*=\s*\w+\.\w+\s*\(/);
      if (createMatch) {
        internalVar = createMatch[1];
        creationLine = trimmed;
      }
      const retMatch = trimmed.match(/^return\s+(\w+)/);
      if (retMatch) returnsVar = retMatch[1];
    }

    if (internalVar && returnsVar && creationLine) {
      // Rename internal variable to instanceName
      const re = new RegExp('\\b' + internalVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
      assignmentLine = creationLine.replace(re, instanceName);
    }
  }

  if (!assignmentLine) {
    console.log('[preprocessCodeForInspection] Could not find constructor for "' + instanceName + '", returning imports only');
    // Return only import lines — never return the full raw code, as it
    // would be exec'd on the server and could trigger hardware side effects.
    var importOnly = [];
    for (var ii = 0; ii < lines.length; ii++) {
      var tl = lines[ii].trim();
      if (tl.match(/^(import\s+|from\s+\S+\s+import\s+)/)) {
        importOnly.push(tl);
      }
    }
    return importOnly.join('\n');
  }

  // Step 3: Build minimal safe code — only imports + the one assignment line.
  const safeLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.match(/^(import\s+|from\s+\S+\s+import\s+)/)) {
      safeLines.push(trimmed);
    }
  }
  safeLines.push(assignmentLine);

  const result = safeLines.join('\n');
  console.log('[preprocessCodeForInspection] Safe code for "' + instanceName + '":\n' + result);
  return result;
}

/**
 * Update the method dropdown for an instance_function_call block based on the instance variable.
 * @param {Blockly.Block} block - The instance_function_call block
 */
async function updateInstanceMethodsForBlock(block) {
  if (!block || block.disposed) {
    return;
  }

  const instanceField = block.getField('INSTANCE');
  const instanceModel = instanceField ? instanceField.getVariable() : null;
  const instanceName = instanceModel ? instanceModel.name : block.getFieldValue('INSTANCE');
  if (!instanceName) {
    return;
  }

  // Use a debounce to avoid rapid-fire requests while dragging/typing
  if (block.updateTimer_) {
    clearTimeout(block.updateTimer_);
  }

  block.updateTimer_ = setTimeout(async () => {
    const workspace = getWorkspace ? getWorkspace() : null;
    const serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';

    if (!workspace) return;

    try {
      const rawCode = Blockly.Python.workspaceToCode(workspace);
      // Preprocess: flatten function-return assignments so the server
      // sees a direct instance creation for the variable.
      const code = preprocessCodeForInspection(rawCode, instanceName);

      const response = await fetch(`${serverUrl}/inspect-instance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, instance: instanceName })
      });

      const info = await response.json();
      if (info.success) {
        const methods = info.methods || [];

        const currentMethod = block.getFieldValue('METHOD');
        block.updateOptions(methods);

        if (methods.length > 0) {
          if (!currentMethod || currentMethod === '...' || !methods.includes(currentMethod)) {
            block.setFieldValue(methods[0], 'METHOD');
            block.updateFunctionInfo(methods[0]);
          }
        }
      } else {
        console.warn(`Instance inspection failed for ${instanceName}: ${info.error}`);
        block.updateOptions([]);
      }
    } catch (error) {
      console.error('Failed to inspect instance:', error);
    }
  }, 300);
}

/**
 * Fetch and apply method information for an instance method call.
 * @param {Blockly.Block} block - The instance_function_call block
 * @param {string} methodName - The method name to inspect
 */
async function updateInstanceMethodInfo(block, methodName) {
  if (!block || block.disposed || !methodName || methodName === '...') {
    return;
  }

  const instanceField = block.getField('INSTANCE');
  const instanceModel = instanceField ? instanceField.getVariable() : null;
  const instanceName = instanceModel ? instanceModel.name : block.getFieldValue('INSTANCE');
  if (!instanceName) {
    return;
  }

  const cleanMethod = methodName.includes('.') ? methodName.split('.').pop() : methodName;

  const workspace = getWorkspace ? getWorkspace() : null;
  const serverUrl = getServerUrl ? getServerUrl() : 'http://127.0.0.1:5080';

  if (!workspace) return;

  try {
    const rawCode = Blockly.Python.workspaceToCode(workspace);
    const code = preprocessCodeForInspection(rawCode, instanceName);
    const response = await fetch(`${serverUrl}/inspect-instance-method`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, instance: instanceName, method: cleanMethod })
    });

    const info = await response.json();
    if (info.success) {
      block.applyFunctionInfo(info);
      block.functionInfo_ = info;
    } else {
      block.setTooltip(`Error: ${info.error}`);
    }
  } catch (error) {
    console.error('Failed to fetch instance method info:', error);
  }
}
