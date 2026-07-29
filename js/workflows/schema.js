/**
 * Workflow template schema validation (v1).
 * Templates are JSON objects describing a fixed pipeline with swappable algorithm slots.
 */
(function() {
  'use strict';

  var VALID_PATTERNS = { single: true, list_iter: true, pass_through: true };

  /**
   * Validate a template object. Returns { ok: boolean, errors: string[], template? }.
   */
  function validateWorkflowTemplate(raw) {
    var errors = [];
    if (!raw || typeof raw !== 'object') {
      return { ok: false, errors: ['Template must be an object'] };
    }

    if (!raw.id || typeof raw.id !== 'string') {
      errors.push('Missing string "id"');
    }
    if (!raw.name || typeof raw.name !== 'string') {
      errors.push('Missing string "name"');
    }
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
      errors.push('"steps" must be a non-empty array');
    }

    var context = Array.isArray(raw.context) ? raw.context : [];
    var contextNames = {};
    for (var ci = 0; ci < context.length; ci++) {
      var c = context[ci];
      if (!c || !c.name) {
        errors.push('context[' + ci + '] needs a name');
        continue;
      }
      contextNames[c.name] = true;
    }

    var outputNames = {};
    var steps = Array.isArray(raw.steps) ? raw.steps : [];
    for (var si = 0; si < steps.length; si++) {
      var step = steps[si];
      var prefix = 'steps[' + si + ']';
      if (!step || !step.id) {
        errors.push(prefix + ' needs an id');
        continue;
      }
      if (!step.pattern || !VALID_PATTERNS[step.pattern]) {
        errors.push(prefix + ' ("' + (step.id || '?') + '") has invalid pattern');
      }
      if (step.pattern === 'list_iter') {
        if (!step.iterOver) {
          errors.push(prefix + ' list_iter needs iterOver');
        } else if (!outputNames[step.iterOver] && !contextNames[step.iterOver]) {
          // Allow forward ref only to prior outputs — check known so far
          errors.push(prefix + ' list_iter iterOver "' + step.iterOver +
            '" is not a prior step output or context name');
        }
        if (!step.itemName) {
          errors.push(prefix + ' list_iter needs itemName');
        }
      }
      if (step.output && step.output.name) {
        if (outputNames[step.output.name]) {
          errors.push(prefix + ' duplicate output name "' + step.output.name + '"');
        }
        outputNames[step.output.name] = step.id;
      }
      if (step.slot) {
        if (!step.slot.signature || !Array.isArray(step.slot.signature.params)) {
          errors.push(prefix + ' slot needs signature.params array');
        }
      } else if (step.pattern !== 'pass_through') {
        // Fixed callables allowed later via step.call — for v1 require slot or pass_through
        if (!step.call) {
          errors.push(prefix + ' needs "slot" or "call" (or pattern pass_through)');
        }
      }
    }

    return {
      ok: errors.length === 0,
      errors: errors,
      template: raw
    };
  }

  window.WorkflowSchema = {
    validate: validateWorkflowTemplate,
    VALID_PATTERNS: VALID_PATTERNS
  };
})();
