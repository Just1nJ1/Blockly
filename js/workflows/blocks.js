/**
 * workflow_run block — one Blockly block type, many templates via mutation.
 * Context fields (e.g. robot var) + per-step algorithm slot dropdowns.
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
            if (workflowBlock.getField('CTX_' + c.name)) {
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

  /**
   * Rebuild block inputs/fields from the current templateId_.
   * Preserves slot selections when possible.
   */
  function rebuildShape(block, preserveSlots) {
    // preserveSlots:
    //   false  → do not read existing fields (fresh template)
    //   object → use those slot/context values
    //   undefined / true → harvest current field values
    var savedSlots = {};
    if (preserveSlots && typeof preserveSlots === 'object') {
      for (var key in preserveSlots) {
        if (Object.prototype.hasOwnProperty.call(preserveSlots, key)) {
          savedSlots[key] = preserveSlots[key];
        }
      }
    } else if (preserveSlots !== false) {
      var tpl0 = getTemplate(block);
      if (tpl0 && tpl0.steps) {
        for (var s = 0; s < tpl0.steps.length; s++) {
          var sid = tpl0.steps[s].id;
          var fieldName = 'SLOT_' + sid;
          if (block.getField(fieldName)) {
            savedSlots[sid] = block.getFieldValue(fieldName) || '';
          }
        }
      }
      if (tpl0 && tpl0.context) {
        for (var ci = 0; ci < tpl0.context.length; ci++) {
          var cn = tpl0.context[ci].name;
          if (block.getField('CTX_' + cn)) {
            savedSlots['__ctx_' + cn] = block.getFieldValue('CTX_' + cn) || '';
          }
        }
      }
    }

    // Remove dynamic inputs (keep none — full rebuild)
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

    // Context fields
    var ctx = tpl.context || [];
    for (var c = 0; c < ctx.length; c++) {
      var ctxItem = ctx[c];
      var ctxInput = block.appendDummyInput('CTX_ROW_' + ctxItem.name);
      ctxInput.appendField(ctxItem.name);
      if (ctxItem.blockly === 'robot_var') {
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
      } else {
        // Generic text fallback for future context kinds
        ctxInput.appendField(new Blockly.FieldTextInput(ctxItem.name), 'CTX_' + ctxItem.name);
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
            try { dd.setValue(savedFnRef); } catch (e) { /* leave placeholder */ }
          }
        })(
          step,
          step.slot.signature,
          step.slot.placeholderLabel || 'Choose function…',
          savedSlots[step.id] || ''
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

        var tpl = getTemplate(this);
        if (tpl) {
          // Persist slot selections
          var steps = tpl.steps || [];
          for (var i = 0; i < steps.length; i++) {
            var sid = steps[i].id;
            if (this.getField('SLOT_' + sid)) {
              container.setAttribute('slot_' + sid, this.getFieldValue('SLOT_' + sid) || '');
            }
          }
          var ctx = tpl.context || [];
          for (var j = 0; j < ctx.length; j++) {
            var cn = ctx[j].name;
            if (this.getField('CTX_' + cn)) {
              container.setAttribute('ctx_' + cn, this.getFieldValue('CTX_' + cn) || '');
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
        rebuildShape(this, saved);
      },

      saveExtraState: function() {
        var state = { templateId: this.templateId_ || '', slots: {}, context: {} };
        var tpl = getTemplate(this);
        if (tpl) {
          var steps = tpl.steps || [];
          for (var i = 0; i < steps.length; i++) {
            var sid = steps[i].id;
            if (this.getField('SLOT_' + sid)) {
              state.slots[sid] = this.getFieldValue('SLOT_' + sid) || '';
            }
          }
          var ctx = tpl.context || [];
          for (var j = 0; j < ctx.length; j++) {
            var cn = ctx[j].name;
            if (this.getField('CTX_' + cn)) {
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
            if (Object.prototype.hasOwnProperty.call(state.slots, k)) {
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
        // Rebuild preserving slots
        var saved = {};
        var tpl = getTemplate(b);
        if (tpl) {
          (tpl.steps || []).forEach(function(step) {
            if (b.getField('SLOT_' + step.id)) {
              saved[step.id] = b.getFieldValue('SLOT_' + step.id) || '';
            }
          });
          (tpl.context || []).forEach(function(ctx) {
            if (b.getField('CTX_' + ctx.name)) {
              saved['__ctx_' + ctx.name] = b.getFieldValue('CTX_' + ctx.name) || '';
            }
          });
        }
        rebuildShape(b, saved);
      }
    }
  }

  window.initWorkflowBlocks = initWorkflowBlocks;
  window.refreshWorkflowBlocks = refreshWorkflowBlocks;
  window.rebuildWorkflowShape = rebuildShape;
})();
