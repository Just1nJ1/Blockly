/**
 * Resolve algorithm slot candidates from the Blockly workspace.
 *
 * Discovery (in order):
 *  1. Scan procedures_defreturn / procedures_defnoreturn blocks (legacy + overrides)
 *  2. Blockly 12 procedure map
 *  3. Blockly.Procedures.allProcedures fallback
 *
 * Matching is soft: preferred candidates match arity (+ return kind);
 * all other procedures still appear in the menu so users can always pick.
 */
(function() {
  'use strict';

  var PLACEHOLDER = ['(choose function…)', ''];

  /**
   * List procedures in the workspace.
   * @returns {{name:string, params:string[], hasReturn:boolean}[]}
   */
  function listProcedures(workspace) {
    var out = [];
    var seen = Object.create(null);
    if (!workspace) return out;

    function add(name, params, hasReturn) {
      if (!name || seen[name]) return;
      seen[name] = true;
      out.push({
        name: name,
        params: params || [],
        hasReturn: !!hasReturn
      });
    }

    // 1) Direct block scan — most reliable with this app's procedure overrides
    try {
      var types = ['procedures_defreturn', 'procedures_defnoreturn'];
      for (var t = 0; t < types.length; t++) {
        if (typeof workspace.getBlocksByType !== 'function') break;
        var blocks = workspace.getBlocksByType(types[t], false) || [];
        for (var i = 0; i < blocks.length; i++) {
          var b = blocks[i];
          if (b.isInFlyout) continue;
          var name = null;
          var params = [];
          var hasReturn = (types[t] === 'procedures_defreturn');

          if (typeof b.getProcedureDef === 'function') {
            try {
              var def = b.getProcedureDef();
              // ProcedureTuple: [name, paramNames[], hasReturn]
              name = def[0];
              params = def[1] || [];
              if (typeof def[2] === 'boolean') hasReturn = def[2];
            } catch (e1) { /* fall through */ }
          }
          if (!name) {
            name = b.getFieldValue('NAME') || b.getFieldValue('PROCNAME');
          }
          if ((!params || !params.length) && b.arguments_ && b.arguments_.length) {
            params = b.arguments_.slice();
          }
          if ((!params || !params.length) && typeof b.getVars === 'function') {
            try { params = b.getVars() || []; } catch (e2) { /* ignore */ }
          }
          add(name, params, hasReturn);
        }
      }
    } catch (e) {
      console.warn('[Workflows] block scan failed', e);
    }

    // 2) Blockly 12 procedure map
    try {
      if (typeof workspace.getProcedureMap === 'function') {
        var map = workspace.getProcedureMap();
        var models = map && typeof map.getProcedures === 'function'
          ? map.getProcedures()
          : [];
        for (var m = 0; m < models.length; m++) {
          var proc = models[m];
          var pName = proc.getName ? proc.getName() : null;
          var pParams = [];
          if (proc.getParameters) {
            var plist = proc.getParameters() || [];
            for (var pi = 0; pi < plist.length; pi++) {
              pParams.push(plist[pi].getName ? plist[pi].getName() : String(plist[pi]));
            }
          }
          var pRet = false;
          if (proc.getReturnTypes) {
            var rt = proc.getReturnTypes();
            pRet = !!(rt && (Array.isArray(rt) ? rt.length : rt));
          }
          add(pName, pParams, pRet);
        }
      }
    } catch (e3) {
      console.warn('[Workflows] procedure map scan failed', e3);
    }

    // 3) Legacy allProcedures API
    try {
      if (window.Blockly && Blockly.Procedures && Blockly.Procedures.allProcedures) {
        var all = Blockly.Procedures.allProcedures(workspace);
        function addList(list, hasReturn) {
          for (var j = 0; j < (list || []).length; j++) {
            var p = list[j];
            add(p[0], p[1] || [], typeof p[2] === 'boolean' ? p[2] : hasReturn);
          }
        }
        addList(all[0], false);
        addList(all[1], true);
      }
    } catch (e4) {
      console.warn('[Workflows] allProcedures failed', e4);
    }

    out.sort(function(a, b) {
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return out;
  }

  /**
   * Soft signature match — primarily parameter count.
   * Return kind is a preference, not a hard filter for listing.
   */
  function matchesSignature(proc, signature) {
    if (!signature) return true;
    var wantParams = signature.params || [];
    var procParams = proc.params || [];
    if (procParams.length !== wantParams.length) return false;

    var ret = signature.returns || 'Any';
    // Prefer return-procs for non-void slots, but still "match" for listing priority
    if (ret !== 'void' && ret !== 'Any' && !proc.hasReturn) {
      return false;
    }
    return true;
  }

  function formatProcLabel(proc, match, signature) {
    var sig = (proc.params || []).join(', ');
    var label = proc.name + '(' + sig + ')';
    if (!match && signature && signature.params) {
      var need = signature.params.length;
      var got = (proc.params || []).length;
      if (need !== got) {
        label += '  · needs ' + need + ' param' + (need === 1 ? '' : 's');
      } else if (!proc.hasReturn && signature.returns &&
                 signature.returns !== 'void' && signature.returns !== 'Any') {
        label += '  · should return a value';
      }
    }
    return label;
  }

  /**
   * Dropdown options for a slot: [[label, value], ...]
   * Matching procedures first, then the rest (so the menu is never empty
   * when the user has defined functions).
   */
  function slotDropdownOptions(workspace, signature, placeholderLabel) {
    var opts = [[placeholderLabel || PLACEHOLDER[0], '']];
    var procs = listProcedures(workspace);
    var matched = [];
    var other = [];

    for (var i = 0; i < procs.length; i++) {
      var proc = procs[i];
      var ok = matchesSignature(proc, signature);
      var entry = [formatProcLabel(proc, ok, signature), proc.name];
      if (ok) matched.push(entry);
      else other.push(entry);
    }

    for (var m = 0; m < matched.length; m++) opts.push(matched[m]);
    for (var o = 0; o < other.length; o++) opts.push(other[o]);
    return opts;
  }

  /**
   * Build Blockly.FieldDropdown menu generator that refreshes from the workspace.
   */
  function makeSlotDropdown(stepId, signature, placeholderLabel) {
    return function() {
      var field = this;
      var block = field && field.getSourceBlock ? field.getSourceBlock() : null;
      var ws = block && block.workspace
        ? block.workspace
        : (typeof getWorkspace === 'function' ? getWorkspace() : null);
      if (ws && ws.isFlyout && typeof getWorkspace === 'function') {
        ws = getWorkspace();
      }
      var opts = slotDropdownOptions(ws, signature, placeholderLabel);
      if (!opts.length) opts = [PLACEHOLDER];
      return opts;
    };
  }

  /**
   * Sanitize a base name into a valid Python/Blockly procedure identifier.
   */
  function sanitizeProcName(raw) {
    var s = String(raw || 'algorithm').trim();
    s = s.replace(/[^A-Za-z0-9_]+/g, '_');
    s = s.replace(/^_+|_+$/g, '');
    if (!s) s = 'algorithm';
    if (!/^[A-Za-z_]/.test(s)) s = 'fn_' + s;
    return s;
  }

  /**
   * Return a procedure name that does not collide with existing ones.
   * Uses Blockly.Procedures.findLegalName when available.
   */
  function uniqueProcedureName(workspace, baseName) {
    var base = sanitizeProcName(baseName);
    var used = Object.create(null);
    var procs = listProcedures(workspace);
    for (var i = 0; i < procs.length; i++) {
      used[procs[i].name] = true;
    }

    function isTaken(name) {
      if (used[name]) return true;
      if (Blockly.Procedures && typeof Blockly.Procedures.isNameUsed === 'function') {
        try {
          if (Blockly.Procedures.isNameUsed(name, workspace)) return true;
        } catch (e) { /* ignore */ }
      }
      return false;
    }

    if (!isTaken(base)) return base;
    var n = 2;
    while (isTaken(base + '_' + n)) n++;
    return base + '_' + n;
  }

  /**
   * Suggest a base function name for a workflow step (templateId + step id).
   */
  function suggestNameForStep(templateId, step) {
    var stepPart = (step && (step.id || step.label)) || 'step';
    // Prefer short id: "collect" not "Collect items"
    if (step && step.id) stepPart = step.id;
    var prefix = templateId ? String(templateId).replace(/[^A-Za-z0-9_]+/g, '_') + '_' : '';
    // Keep names readable: collect / scan_and_act_collect if needed
    // Prefer just the step id when short
    return sanitizeProcName(stepPart);
  }

  /**
   * Apply parameter names onto a procedure definition block.
   * Tries several Blockly APIs so params actually appear on the block UI.
   */
  function applyParamsToProcedure(nb, workspace, paramNames) {
    if (!nb || !paramNames || !paramNames.length) return;

    // Build variable models first (needed by loadExtraState / argumentVarModels_)
    var models = [];
    for (var i = 0; i < paramNames.length; i++) {
      var pname = paramNames[i];
      var model = null;
      try {
        if (Blockly.Variables && Blockly.Variables.getOrCreateVariablePackage) {
          model = Blockly.Variables.getOrCreateVariablePackage(
            workspace, null, pname, '');
        } else if (workspace.getVariableMap &&
                   typeof workspace.getVariableMap().createVariable === 'function') {
          model = workspace.getVariableMap().createVariable(pname, '');
        }
      } catch (e) {
        try {
          if (Blockly.Variables && Blockly.Variables.createVariable) {
            model = Blockly.Variables.createVariable(workspace, pname, '');
          }
        } catch (e2) { /* ignore */ }
      }
      models.push(model);
    }

    // Preferred path: loadExtraState with name+id
    try {
      if (typeof nb.loadExtraState === 'function') {
        var payload = {
          params: paramNames.map(function(name, idx) {
            var m = models[idx];
            return {
              name: name,
              id: m && m.getId ? m.getId() : undefined
            };
          }),
          hasStatements: true
        };
        nb.loadExtraState(payload);
        if ((nb.arguments_ || []).length === paramNames.length) return;
      }
    } catch (eLoad) {
      console.warn('[Workflows] loadExtraState params failed', eLoad);
    }

    // Mutation XML path
    try {
      if (typeof nb.domToMutation === 'function') {
        var mut = document.createElement('mutation');
        for (var mi = 0; mi < paramNames.length; mi++) {
          var argEl = document.createElement('arg');
          argEl.setAttribute('name', paramNames[mi]);
          if (models[mi] && models[mi].getId) {
            argEl.setAttribute('varid', models[mi].getId());
          }
          mut.appendChild(argEl);
        }
        nb.domToMutation(mut);
        if ((nb.arguments_ || []).length === paramNames.length) return;
      }
    } catch (eMut) {
      console.warn('[Workflows] domToMutation params failed', eMut);
    }

    // Direct property + updateParams_ fallback
    try {
      nb.arguments_ = paramNames.slice();
      nb.argumentVarModels_ = [];
      nb.paramIds_ = [];
      for (var j = 0; j < paramNames.length; j++) {
        if (models[j]) nb.argumentVarModels_.push(models[j]);
        nb.paramIds_.push((nb.id || 'arg') + '_' + j);
      }
      if (typeof nb.updateParams_ === 'function') {
        nb.updateParams_();
      }
      if (Blockly.Procedures && typeof Blockly.Procedures.mutateCallers === 'function') {
        Blockly.Procedures.mutateCallers(nb);
      }
    } catch (eDirect) {
      console.warn('[Workflows] direct params apply failed', eDirect);
    }
  }

  /**
   * Create a procedures_def* block matching the slot signature, with a unique name.
   * Positions it near anchorBlock when provided.
   *
   * @returns {{block: Blockly.Block, name: string}|null}
   */
  function createMatchingProcedure(workspace, options) {
    if (!workspace || !Blockly) return null;
    options = options || {};
    var signature = options.signature || { params: [], returns: 'Any' };
    var baseName = options.baseName || 'algorithm';
    var anchorBlock = options.anchorBlock || null;
    var comment = options.comment || '';

    var legalName = uniqueProcedureName(workspace, baseName);
    // Always use defreturn — matches the app's Functions flyout and allows
    // returning values for List/PoseList slots. Void slots can ignore the return.
    var blockType = 'procedures_defreturn';
    if (!Blockly.Blocks[blockType]) {
      blockType = 'procedures_defnoreturn';
    }
    if (!Blockly.Blocks[blockType]) {
      console.error('[Workflows] No procedure definition block type available');
      return null;
    }

    var prevGroup = null;
    try {
      if (Blockly.Events && Blockly.Events.getGroup) {
        prevGroup = Blockly.Events.getGroup();
        Blockly.Events.setGroup(true);
      }
    } catch (e0) { /* ignore */ }

    var nb = null;
    try {
      nb = workspace.newBlock(blockType);

      // Init SVG first so param UI can render when updateParams_ runs
      if (typeof nb.initSvg === 'function') nb.initSvg();

      if (nb.setFieldValue) {
        nb.setFieldValue(legalName, 'NAME');
      }

      var paramSpecs = signature.params || [];
      var paramNames = [];
      for (var pi = 0; pi < paramSpecs.length; pi++) {
        var pn = paramSpecs[pi] && paramSpecs[pi].name
          ? String(paramSpecs[pi].name)
          : ('arg' + (pi + 1));
        paramNames.push(sanitizeProcName(pn));
      }

      applyParamsToProcedure(nb, workspace, paramNames);

      // Ensure name stuck after mutation (some paths reset NAME)
      if (nb.setFieldValue) {
        nb.setFieldValue(legalName, 'NAME');
      }

      // Hint comment for the user
      var retHint = signature.returns && signature.returns !== 'void'
        ? 'Return type hint: ' + signature.returns
        : 'No return value required (void).';
      var paramHint = paramNames.length
        ? 'Parameters: ' + paramNames.join(', ')
        : 'No parameters.';
      var fullComment = (comment ? comment + '\n' : '') +
        'Workflow algorithm stub.\n' + paramHint + '\n' + retHint +
        '\nEdit this function body — it is already selected on the workflow.';
      if (typeof nb.setCommentText === 'function') {
        nb.setCommentText(fullComment);
      }

      if (typeof nb.render === 'function') nb.render();

      // Place below / beside the workflow block
      if (anchorBlock && typeof anchorBlock.getRelativeToSurfaceXY === 'function') {
        try {
          var xy = anchorBlock.getRelativeToSurfaceXY();
          var hw = anchorBlock.getHeightWidth ? anchorBlock.getHeightWidth() : { height: 80, width: 200 };
          nb.moveBy(xy.x + Math.min(hw.width + 20, 40), xy.y + hw.height + 24);
        } catch (eMove) { /* ignore */ }
      }

      // Highlight selection so the user sees the new block
      try {
        if (workspace.getBlockById && nb.id) {
          if (typeof workspace.centerOnBlock === 'function') {
            workspace.centerOnBlock(nb.id);
          }
          if (Blockly.common && Blockly.common.setSelected) {
            Blockly.common.setSelected(nb);
          }
        }
      } catch (eSel) { /* ignore */ }

      console.log('[Workflows] Created procedure', legalName,
        'params=', paramNames,
        'block.arguments_=', nb.arguments_);
      return { block: nb, name: legalName };
    } catch (err) {
      console.error('[Workflows] createMatchingProcedure failed', err);
      if (nb && typeof nb.dispose === 'function') {
        try { nb.dispose(false); } catch (e2) { /* ignore */ }
      }
      return null;
    } finally {
      try {
        if (Blockly.Events && Blockly.Events.setGroup) {
          Blockly.Events.setGroup(prevGroup);
        }
      } catch (e3) { /* ignore */ }
    }
  }

  window.WorkflowSlots = {
    listProcedures: listProcedures,
    matchesSignature: matchesSignature,
    slotDropdownOptions: slotDropdownOptions,
    makeSlotDropdown: makeSlotDropdown,
    uniqueProcedureName: uniqueProcedureName,
    suggestNameForStep: suggestNameForStep,
    createMatchingProcedure: createMatchingProcedure,
    PLACEHOLDER: PLACEHOLDER
  };
})();
