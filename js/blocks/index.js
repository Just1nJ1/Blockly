/**
 * Blocks Module Index
 * Aggregates all custom block definitions and provides initialization.
 */

var LOOP_BLOCK_COLOUR = '#32a54e';
var LOOP_BLOCK_TYPES = [
  'controls_repeat',
  'controls_repeat_ext',
  'controls_whileUntil',
  'controls_for',
  'controls_forEach',
  'controls_flow_statements'
];

/** Recolor built-in loop blocks (repeat, while, for, …) to the app green. */
function recolorBuiltInLoopBlocks() {
  if (typeof Blockly === 'undefined' || !Blockly.Blocks) return;
  for (var i = 0; i < LOOP_BLOCK_TYPES.length; i++) {
    (function(type) {
      var def = Blockly.Blocks[type];
      if (!def || typeof def.init !== 'function' || def._studioxGreen) return;
      var orig = def.init;
      def.init = function() {
        orig.apply(this, arguments);
        this.setColour(LOOP_BLOCK_COLOUR);
      };
      def._studioxGreen = true;
    })(LOOP_BLOCK_TYPES[i]);
  }
}

function applyLoopBlockColours(workspace) {
  workspace = workspace || (typeof getWorkspace === 'function' ? getWorkspace() : null);
  if (!workspace) return;
  for (var i = 0; i < LOOP_BLOCK_TYPES.length; i++) {
    var blocks = workspace.getBlocksByType(LOOP_BLOCK_TYPES[i], false) || [];
    for (var j = 0; j < blocks.length; j++) {
      try { blocks[j].setColour(LOOP_BLOCK_COLOUR); } catch (e) { /* ignore */ }
    }
  }
}

/**
 * Initialize all custom blocks.
 * This function should be called after Blockly is loaded but before workspace initialization.
 */
function initCustomBlocks() {
  initImportModuleBlock();
  initRawBlock();
  initFunctionCallBlock();
  initLibraryFunctionCallBlock();
  initLibraryConstantBlock();
  initInstanceFunctionCallBlock();
  initFunctionParamBlock();
  initSetupRobotBlock();
  initMoveRobotBlocks();
  initRobotCommandBlocks();
  initLocalVariablesIcon();
  initProcedureOverrides();
  installFilteredVariableDropdown();
  setupLocalVarIconListener();
  if (typeof initWorkflowBlocks === 'function') {
    initWorkflowBlocks();
  }
  recolorBuiltInLoopBlocks();
}
