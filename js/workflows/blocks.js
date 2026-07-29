/**
 * workflow_run block — one Blockly block type, many templates via mutation.
 * Context: robot dropdown, value sockets (with number shadows), or text fields.
 * Steps: algorithm slot dropdowns (+ create function) or fixed calls.
 */
(function() {
  'use strict';

  var COLOUR = '#5B8C5A';

  // "+" icon — load from shared UI icon file when possible
  function getPlusIconUri() {
    if (window.AppIcons && typeof AppIcons.fileUrl === 'function') {
      return AppIcons.fileUrl('plus');
    }
    return './resources/icons/ui/plus.svg';
  }
  var PLUS_ICON_DATA_URI = getPlusIconUri();

  function getTemplate(block) {
    var id = block.templateId_ || block.getFieldValue('TEMPLATE_ID') || '';
    if (window.WorkflowRegistry) {
      return window.WorkflowRegistry.getById(id);
    }
    return null;
  }

  /**
   * Create a matching function for one step, select it on the slot dropdown,
   * and place the def near the workflow block.
   */
  function createFunctionForStep(workflowBlock, step) {
    if (!workflowBlock || !step || !step.slot) return;
    var ws = workflowBlock.workspace;
    if (!ws || !window.WorkflowSlots ||
        typeof window.WorkflowSlots.createMatchingProcedure !== 'function') {
      return;
    }

    var tpl = getTemplate(workflowBlock);
    var baseName = window.WorkflowSlots.suggestNameForStep(
      tpl && tpl.id, step);

    var result = window.WorkflowSlots.createMatchingProcedure(ws, {
      baseName: baseName,
      signature: step.slot.signature || { params: [], returns: 'Any' },
      anchorBlock: workflowBlock,
      comment: 'Step: ' + (step.label || step.id)
    });

    if (!result || !result.name) return;

    // Select the new function on this step's slot field
    var field = workflowBlock.getField('SLOT_' + step.id);
    if (field) {
      try {
        // Ensure the option exists: rebuild menu by setValue
        field.setValue(result.name);
      } catch (e) {
        // Rebuild shape with saved selection if setValue rejects unknown option
        var saved = {};
        var t = getTemplate(workflowBlock);
        if (t) {
          (t.steps || []).forEach(function(s) {
            if (workflowBlock.getField('SLOT_' + s.id)) {
              saved[s.id] = (s.id === step.id)
                ? result.name
                : (workflowBlock.getFieldValue('SLOT_' + s.id) || '');
            }
          });
          (t.context || []).forEach(function(c) {
            if (isValueContext(c)) {
              var vin = workflowBlock.getInput('CTX_' + c.name);
              if (vin && vin.connection && vin.connection.targetBlock()) {
                var tb = vin.connection.targetBlock();
                if (tb && !tb.isShadow()) {
                  try { vin.connection.disconnect(); } catch (eD) { /* ignore */ }
                  saved['__ctx_block_' + c.name] = tb;
                }
              }
            } else if (workflowBlock.getField('CTX_' + c.name)) {
              saved['__ctx_' + c.name] =
                workflowBlock.getFieldValue('CTX_' + c.name) || '';
            }
          });
        }
        saved[step.id] = result.name;
        rebuildShape(workflowBlock, saved);
      }
    }

    // Fire change so code preview updates
    try {
      if (typeof updateCodePreview === 'function') updateCodePreview();
    } catch (e2) { /* ignore */ }
  }

  /** True when context should be a Blockly value socket (not a plain text field). */
  function isValueContext(ctxItem) {
    if (!ctxItem) return false;
    var b = ctxItem.blockly;
    return b === 'value' || b === 'number' || b === 'any';
  }

  /**
   * Attach a default math_number shadow (editable default; replaceable by
   * variables / expressions). Uses shared setNumberShadow when available so
   * defaults can be restored after the user pulls a value out of the slot.
   */
  function attachNumberShadow(connection, defaultNum) {
    if (!connection) return;
    var num = defaultNum != null ? defaultNum : 0;
    if (typeof setNumberShadow === 'function') {
      setNumberShadow(connection, num);
      return;
    }
    if (!Blockly || !Blockly.utils || !Blockly.utils.xml) return;
    try {
      var shadow = Blockly.utils.xml.createElement('shadow');
      shadow.setAttribute('type', 'math_number');
      var field = Blockly.utils.xml.createElement('field');
      field.setAttribute('name', 'NUM');
      field.appendChild(Blockly.utils.xml.createTextNode(String(num)));
      shadow.appendChild(field);
      connection.setShadowDom(shadow);
    } catch (e) {
      console.warn('[Workflows] Could not attach number shadow', e);
    }
  }

  /**
   * Merge slot/context state onto the block so it survives rebuilds when the
   * template registry is not loaded yet (workspace open → loadCore later).
   */
  function rememberPendingState(block, partial) {
    if (!block) return;
    if (!block.pendingSlotState_) block.pendingSlotState_ = {};
    if (!partial) return;
    for (var k in partial) {
      if (!Object.prototype.hasOwnProperty.call(partial, k)) continue;
      // Don't store live block references in pending (only serializable slots)
      if (k.indexOf('__ctx_block_') === 0) continue;
      if (partial[k] != null && partial[k] !== '') {
        block.pendingSlotState_[k] = partial[k];
      }
    }
  }

  /**
   * Harvest current SLOT_* field values into a plain object.
   */
  function harvestSlotFields(block, tpl) {
    var saved = {};
    if (!block) return saved;
    var steps = (tpl && tpl.steps) || [];
    for (var s = 0; s < steps.length; s++) {
      var sid = steps[s].id;
      if (block.getField('SLOT_' + sid)) {
        var v = block.getFieldValue('SLOT_' + sid) || '';
        if (v) saved[sid] = v;
      }
    }
    // Also scan any SLOT_* field if template unknown
    if (!steps.length && block.inputList) {
      for (var i = 0; i < block.inputList.length; i++) {
        var fields = block.inputList[i].fieldRow || [];
        for (var f = 0; f < fields.length; f++) {
          var name = fields[f].name;
          if (name && name.indexOf('SLOT_') === 0) {
            var sv = fields[f].getValue && fields[f].getValue();
            if (sv) saved[name.substring(5)] = sv;
          }
        }
      }
    }
    return saved;
  }

  /**
   * Rebuild block inputs/fields from the current templateId_.
   * Preserves slot selections and value-input connections when possible.
   */
  function rebuildShape(block, preserveSlots) {
    // preserveSlots:
    //   false  → do not read existing fields (fresh template)
    //   object → use those slot/context values
    //   undefined / true → harvest current field values
    var savedSlots = {};
    var savedValueBlocks = {}; // contextName → non-shadow target block

    // Always start from last known good slot state (survives "template not loaded")
    if (block.pendingSlotState_) {
      for (var pk in block.pendingSlotState_) {
        if (Object.prototype.hasOwnProperty.call(block.pendingSlotState_, pk)) {
          savedSlots[pk] = block.pendingSlotState_[pk];
        }
      }
    }

    if (preserveSlots && typeof preserveSlots === 'object') {
      for (var key in preserveSlots) {
        if (Object.prototype.hasOwnProperty.call(preserveSlots, key)) {
          if (key.indexOf('__ctx_block_') === 0) {
            savedValueBlocks[key.substring(12)] = preserveSlots[key];
          } else if (preserveSlots[key] != null && preserveSlots[key] !== '') {
            savedSlots[key] = preserveSlots[key];
          }
        }
      }
    } else if (preserveSlots !== false) {
      var tpl0 = getTemplate(block);
      var harvested = harvestSlotFields(block, tpl0);
      for (var hk in harvested) {
        if (Object.prototype.hasOwnProperty.call(harvested, hk)) {
          savedSlots[hk] = harvested[hk];
        }
      }
      if (tpl0 && tpl0.context) {
        for (var ci = 0; ci < tpl0.context.length; ci++) {
          var cn = tpl0.context[ci].name;
          var cItem = tpl0.context[ci];
          if (isValueContext(cItem)) {
            var vin = block.getInput('CTX_' + cn);
            if (vin && vin.connection && vin.connection.targetBlock()) {
              var tb = vin.connection.targetBlock();
              if (tb && !tb.isShadow()) {
                // Disconnect so removeInput does not dispose the real block
                try { vin.connection.disconnect(); } catch (eDisc) { /* ignore */ }
                savedValueBlocks[cn] = tb;
              }
            }
          } else if (block.getField('CTX_' + cn)) {
            savedSlots['__ctx_' + cn] = block.getFieldValue('CTX_' + cn) || '';
          }
        }
      }
    }

    rememberPendingState(block, savedSlots);

    // Remove dynamic inputs (full rebuild)
    var inputList = block.inputList.slice();
    for (var i = 0; i < inputList.length; i++) {
      block.removeInput(inputList[i].name);
    }

    var tpl = getTemplate(block);
    if (!tpl) {
      block.appendDummyInput('HDR')
        .appendField('Workflow')
        .appendField(block.templateId_ || '(unknown)', 'TITLE');
      block.appendDummyInput('HINT')
        .appendField('Template not loaded');
      return;
    }

    // Header
    block.appendDummyInput('HDR')
      .appendField('Workflow:')
      .appendField(tpl.name || tpl.id, 'TITLE');

    // Context: robot dropdown, value socket (+ shadow), or text fallback
    var ctx = tpl.context || [];
    for (var c = 0; c < ctx.length; c++) {
      var ctxItem = ctx[c];
      if (ctxItem.blockly === 'robot_var') {
        var ctxInput = block.appendDummyInput('CTX_ROW_' + ctxItem.name);
        ctxInput.appendField(ctxItem.name);
        var robotField = new Blockly.FieldDropdown(
          function() {
            if (typeof robotVarDropdownGenerator === 'function') {
              return robotVarDropdownGenerator(block);
            }
            return [['robot', 'robot']];
          }
        );
        ctxInput.appendField(robotField, 'CTX_' + ctxItem.name);
        if (savedSlots['__ctx_' + ctxItem.name]) {
          try { robotField.setValue(savedSlots['__ctx_' + ctxItem.name]); } catch (e) { /* ignore */ }
        } else if (savedSlots.__ctx_robot && ctxItem.name === 'robot') {
          try { robotField.setValue(savedSlots.__ctx_robot); } catch (e) { /* ignore */ }
        }
      } else if (isValueContext(ctxItem)) {
        // No setCheck: allow math_number shadows and variables/expressions
        var valInput = block.appendValueInput('CTX_' + ctxItem.name)
          .setAlign(Blockly.ALIGN_RIGHT)
          .appendField(ctxItem.name);
        var defaultNum = 0;
        if (ctxItem.default != null && ctxItem.default !== '') {
          var parsed = Number(ctxItem.default);
          if (!isNaN(parsed)) defaultNum = parsed;
        }
        if (savedValueBlocks[ctxItem.name] &&
            savedValueBlocks[ctxItem.name].outputConnection) {
          try {
            valInput.connection.connect(
              savedValueBlocks[ctxItem.name].outputConnection);
          } catch (eConn) {
            attachNumberShadow(valInput.connection, defaultNum);
          }
        } else {
          attachNumberShadow(valInput.connection, defaultNum);
        }
      } else {
        // Plain text fallback (variable name / free string)
        var textRow = block.appendDummyInput('CTX_ROW_' + ctxItem.name);
        textRow.appendField(ctxItem.name);
        var defaultText = ctxItem.default != null ? String(ctxItem.default) : ctxItem.name;
        var textField = new Blockly.FieldTextInput(defaultText);
        textRow.appendField(textField, 'CTX_' + ctxItem.name);
        if (savedSlots['__ctx_' + ctxItem.name]) {
          try { textField.setValue(savedSlots['__ctx_' + ctxItem.name]); } catch (e) { /* ignore */ }
        }
      }
    }

    // Steps
    var steps = tpl.steps || [];
    for (var si = 0; si < steps.length; si++) {
      var step = steps[si];
      var row = block.appendDummyInput('STEP_' + step.id);

      var typeHint = '';
      if (step.output && step.output.type) {
        typeHint = ' → ' + step.output.type;
      } else if (step.pattern === 'list_iter') {
        typeHint = ' (loop)';
      }
      // Show expected function signature so "collect" vs "act" is obvious
      var sigText = '';
      if (step.slot && step.slot.signature) {
        var sp = step.slot.signature.params || [];
        var names = [];
        for (var spi = 0; spi < sp.length; spi++) {
          names.push((sp[spi] && sp[spi].name) || ('arg' + (spi + 1)));
        }
        sigText = '  ' + (step.slot.signature.returns && step.slot.signature.returns !== 'void'
          ? names.length ? '(' + names.join(', ') + ') → ' + step.slot.signature.returns
            : '() → ' + step.slot.signature.returns
          : names.length ? '(' + names.join(', ') + ')' : '()');
      }

      row.appendField((si + 1) + '. ' + (step.label || step.id) + typeHint + sigText);

      if (step.slot) {
        // IIFE: capture this step's signature so dropdowns don't all share
        // the last loop iteration (classic var-closure bug → "needs 2 params"
        // on collect because act is last).
        (function(stepRef, sigRef, phRef, savedFnRef) {
          var stepIdForSlot = stepRef.id;

          // Dynamic menu: re-scanned every time the dropdown opens so newly
          // created Functions appear without rebuilding the block.
          var dd = new Blockly.FieldDropdown(function() {
            var field = this;
            var src = field && field.getSourceBlock ? field.getSourceBlock() : block;
            var ws = null;
            if (src && src.workspace) {
              ws = src.workspace;
              if (ws.isFlyout && typeof getWorkspace === 'function') {
                ws = getWorkspace();
              } else if (ws.getRootWorkspace) {
                var root = ws.getRootWorkspace();
                if (root) ws = root;
              }
            }
            if (!ws && typeof getWorkspace === 'function') ws = getWorkspace();

            var opts = window.WorkflowSlots
              ? window.WorkflowSlots.slotDropdownOptions(ws, sigRef, phRef)
              : [[phRef, '']];

            var current = '';
            try {
              current = (field && field.getValue && field.getValue()) || savedFnRef || '';
            } catch (e) {
              current = savedFnRef || '';
            }
            if (current) {
              var found = false;
              for (var oi = 0; oi < opts.length; oi++) {
                if (opts[oi][1] === current) { found = true; break; }
              }
              if (!found) opts.push([current + ' (saved)', current]);
            }
            if (!opts.length) opts = [[phRef, '']];
            return opts;
          });

          var slotRow = block.appendDummyInput('SLOT_ROW_' + stepIdForSlot);
          slotRow.appendField('    fn')
            .appendField(dd, 'SLOT_' + stepIdForSlot);

          if (typeof dd.setValidator === 'function') {
            dd.setValidator(function(newVal) {
              if (!block.pendingSlotState_) block.pendingSlotState_ = {};
              if (newVal) block.pendingSlotState_[stepIdForSlot] = newVal;
              return newVal;
            });
          }

          var plusBtn = new Blockly.FieldImage(
            PLUS_ICON_DATA_URI,
            18,
            18,
            'Create function',
            function() {
              createFunctionForStep(block, stepRef);
            }
          );
          if (plusBtn.setTooltip) {
            plusBtn.setTooltip(
              'Create a new function for «' + (stepRef.label || stepRef.id) +
              '» with the right parameters');
          }
          slotRow.appendField(plusBtn, 'NEW_FN_' + stepRef.id);

          if (savedFnRef) {
            try {
              dd.setValue(savedFnRef);
              // Keep pending in sync so a later rebuild still has the selection
              if (!block.pendingSlotState_) block.pendingSlotState_ = {};
              block.pendingSlotState_[stepIdForSlot] = savedFnRef;
            } catch (e) { /* leave placeholder */ }
          }
        })(
          step,
          step.slot.signature,
          step.slot.placeholderLabel || 'Choose function…',
          savedSlots[step.id] ||
            (block.pendingSlotState_ && block.pendingSlotState_[step.id]) ||
            ''
        );
      } else if (step.call) {
        block.appendDummyInput('CALL_ROW_' + step.id)
          .appendField('    call ' + String(step.call));
      }
    }

    block.setTooltip(tpl.description || ('Run workflow ' + tpl.name));
  }

  function initWorkflowBlocks() {
    Blockly.Blocks['workflow_run'] = {
      init: function() {
        this.templateId_ = '';
        this.setPreviousStatement(true, null);
        this.setNextStatement(true, null);
        this.setColour(COLOUR);
        this.setInputsInline(false);
        this.setTooltip('Run a workflow template with swappable algorithm steps.');
        this.setHelpUrl('');
        this.appendDummyInput('HDR')
          .appendField('Workflow')
          .appendField('(loading…)', 'TITLE');
      },

      /**
       * Configure this block for a template id and rebuild UI.
       */
      setTemplateId: function(id) {
        this.templateId_ = id || '';
        rebuildShape(this, false);
      },

      mutationToDom: function() {
        var container = document.createElement('mutation');
        container.setAttribute('template_id', this.templateId_ || '');

        // Prefer live fields; fall back to pending state (template may be unloaded)
        var tpl = getTemplate(this);
        var slots = harvestSlotFields(this, tpl);
        if (this.pendingSlotState_) {
          for (var pk in this.pendingSlotState_) {
            if (!Object.prototype.hasOwnProperty.call(this.pendingSlotState_, pk)) continue;
            if (pk.indexOf('__ctx_') === 0) continue;
            if (!slots[pk] && this.pendingSlotState_[pk]) {
              slots[pk] = this.pendingSlotState_[pk];
            }
          }
        }
        for (var sid in slots) {
          if (Object.prototype.hasOwnProperty.call(slots, sid) && slots[sid]) {
            container.setAttribute('slot_' + sid, slots[sid]);
          }
        }

        if (tpl) {
          var ctx = tpl.context || [];
          for (var j = 0; j < ctx.length; j++) {
            var cn = ctx[j].name;
            // Value sockets serialize as nested blocks; only persist field-based context
            if (!isValueContext(ctx[j]) && this.getField('CTX_' + cn)) {
              container.setAttribute('ctx_' + cn, this.getFieldValue('CTX_' + cn) || '');
            }
          }
        } else if (this.pendingSlotState_) {
          for (var ck in this.pendingSlotState_) {
            if (ck.indexOf('__ctx_') === 0 && this.pendingSlotState_[ck]) {
              container.setAttribute('ctx_' + ck.substring(6), this.pendingSlotState_[ck]);
            }
          }
        }
        return container;
      },

      domToMutation: function(xmlElement) {
        this.templateId_ = xmlElement.getAttribute('template_id') || '';
        var saved = {};
        // Collect slot_* and ctx_* attributes
        if (xmlElement.attributes) {
          for (var i = 0; i < xmlElement.attributes.length; i++) {
            var attr = xmlElement.attributes[i];
            if (attr.name.indexOf('slot_') === 0) {
              saved[attr.name.substring(5)] = attr.value;
            } else if (attr.name.indexOf('ctx_') === 0) {
              saved['__ctx_' + attr.name.substring(4)] = attr.value;
            }
          }
        }
        rememberPendingState(this, saved);
        rebuildShape(this, saved);
      },

      saveExtraState: function() {
        var state = { templateId: this.templateId_ || '', slots: {}, context: {} };
        var tpl = getTemplate(this);
        var slots = harvestSlotFields(this, tpl);
        if (this.pendingSlotState_) {
          for (var pk in this.pendingSlotState_) {
            if (!Object.prototype.hasOwnProperty.call(this.pendingSlotState_, pk)) continue;
            if (pk.indexOf('__ctx_') === 0) continue;
            if (!slots[pk] && this.pendingSlotState_[pk]) {
              slots[pk] = this.pendingSlotState_[pk];
            }
          }
        }
        state.slots = slots;
        if (tpl) {
          var ctx = tpl.context || [];
          for (var j = 0; j < ctx.length; j++) {
            var cn = ctx[j].name;
            // Value sockets are saved via block connections, not extraState fields
            if (!isValueContext(ctx[j]) && this.getField('CTX_' + cn)) {
              state.context[cn] = this.getFieldValue('CTX_' + cn) || '';
            }
          }
        }
        return state;
      },

      loadExtraState: function(state) {
        if (!state) return;
        this.templateId_ = state.templateId || '';
        var saved = {};
        if (state.slots) {
          for (var k in state.slots) {
            if (Object.prototype.hasOwnProperty.call(state.slots, k) && state.slots[k]) {
              saved[k] = state.slots[k];
            }
          }
        }
        if (state.context) {
          for (var c in state.context) {
            if (Object.prototype.hasOwnProperty.call(state.context, c)) {
              saved['__ctx_' + c] = state.context[c];
            }
          }
        }
        rememberPendingState(this, saved);
        rebuildShape(this, saved);
      },

      /**
       * Right-click: one "Create function for …" entry per algorithm slot.
       */
      customContextMenu: function(options) {
        var block = this;
        var tpl = getTemplate(block);
        if (!tpl || !tpl.steps) return;

        for (var i = 0; i < tpl.steps.length; i++) {
          var step = tpl.steps[i];
          if (!step.slot) continue;
          (function(stepRef) {
            options.push({
              text: 'Create function for «' + (stepRef.label || stepRef.id) + '»',
              enabled: true,
              callback: function() {
                createFunctionForStep(block, stepRef);
              }
            });
          })(step);
        }
      }
    };
  }

  /**
   * After templates load, refresh any existing workflow_run blocks and toolbox.
   */
  function refreshWorkflowBlocks(workspace) {
    if (!workspace) return;
    var blocks = workspace.getBlocksByType('workflow_run', false);
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.templateId_) {
        // Rebuild using pending slot state (from mutation) + any live fields
        var saved = {};
        if (b.pendingSlotState_) {
          for (var pk in b.pendingSlotState_) {
            if (Object.prototype.hasOwnProperty.call(b.pendingSlotState_, pk)) {
              saved[pk] = b.pendingSlotState_[pk];
            }
          }
        }
        var tpl = getTemplate(b);
        var harvested = harvestSlotFields(b, tpl);
        for (var hk in harvested) {
          if (Object.prototype.hasOwnProperty.call(harvested, hk) && harvested[hk]) {
            saved[hk] = harvested[hk];
          }
        }
        if (tpl) {
          (tpl.context || []).forEach(function(ctx) {
            if (isValueContext(ctx)) {
              var vin = b.getInput('CTX_' + ctx.name);
              if (vin && vin.connection && vin.connection.targetBlock()) {
                var tb = vin.connection.targetBlock();
                if (tb && !tb.isShadow()) {
                  try { vin.connection.disconnect(); } catch (eD) { /* ignore */ }
                  saved['__ctx_block_' + ctx.name] = tb;
                }
              }
            } else if (b.getField('CTX_' + ctx.name)) {
              saved['__ctx_' + ctx.name] = b.getFieldValue('CTX_' + ctx.name) || '';
            }
          });
        }
        rebuildShape(b, saved);
      }
    }
  }

  /**
   * After procedures are renamed (e.g. import process → process2), update
   * workflow slot fields that still point at the old names.
   * @param {Blockly.Workspace} workspace
   * @param {Object.<string,string>} renameMap oldName → newName
   */
  function applyProcedureRenamesToWorkflows(workspace, renameMap) {
    if (!workspace || !renameMap) return;
    var blocks = workspace.getBlocksByType('workflow_run', false) || [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var changed = false;
      if (!b.pendingSlotState_) b.pendingSlotState_ = {};
      var tpl = getTemplate(b);
      var steps = (tpl && tpl.steps) || [];
      // Update pending state
      for (var pk in b.pendingSlotState_) {
        if (!Object.prototype.hasOwnProperty.call(b.pendingSlotState_, pk)) continue;
        if (pk.indexOf('__ctx_') === 0) continue;
        var oldFn = b.pendingSlotState_[pk];
        if (oldFn && renameMap[oldFn]) {
          b.pendingSlotState_[pk] = renameMap[oldFn];
          changed = true;
        }
      }
      // Update live fields
      for (var s = 0; s < steps.length; s++) {
        var sid = steps[s].id;
        var field = b.getField('SLOT_' + sid);
        if (!field) continue;
        var cur = field.getValue() || '';
        if (cur && renameMap[cur]) {
          try {
            field.setValue(renameMap[cur]);
            b.pendingSlotState_[sid] = renameMap[cur];
            changed = true;
          } catch (e) {
            b.pendingSlotState_[sid] = renameMap[cur];
            changed = true;
          }
        }
      }
      if (changed) {
        rebuildShape(b, b.pendingSlotState_);
      }
    }
  }

  window.initWorkflowBlocks = initWorkflowBlocks;
  window.refreshWorkflowBlocks = refreshWorkflowBlocks;
  window.rebuildWorkflowShape = rebuildShape;
  window.applyProcedureRenamesToWorkflows = applyProcedureRenamesToWorkflows;
})();
