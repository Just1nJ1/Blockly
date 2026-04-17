/**
 * Robot Movement Block Definitions
 * writeCoordinate and writeAngle blocks for moving robot arms.
 * Axis fields are ValueInputs so they accept variables, math, or raw numbers.
 * The block auto-detects the model (4 or 6 axes) from the setup_robot block
 * that created the selected variable.
 */

function initMoveRobotBlocks() {

  var COORD_LABELS_6 = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var COORD_KEYS_6   = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var COORD_LABELS_4 = ['X', 'Y', 'Z', 'A'];
  var COORD_KEYS_4   = ['X', 'Y', 'Z', 'A'];

  var JOINT_LABELS_6 = ['Joint 1', 'Joint 2', 'Joint 3', 'Joint 4', 'Joint 5', 'Joint 6'];
  var JOINT_KEYS_6   = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var JOINT_LABELS_4 = ['Joint 1', 'Joint 2', 'Joint 3', 'Joint 4'];
  var JOINT_KEYS_4   = ['X', 'Y', 'Z', 'A'];

  var ALL_AXIS_KEYS = ['X', 'Y', 'Z', 'A', 'B', 'C'];

  /**
   * Look up the model for a variable by finding its setup_robot block.
   * Returns 'Mirobot', 'MT4', 'E4', or null.
   */
  function getModelForVariable(workspace, varId) {
    if (!workspace) return null;
    var blocks = workspace.getBlocksByType('setup_robot', false);
    for (var i = 0; i < blocks.length; i++) {
      var field = blocks[i].getField('VARIABLE');
      if (field && field.getVariable() && field.getVariable().getId() === varId) {
        var modelValue = blocks[i].getFieldValue('MODEL');
        if (modelValue && modelValue.indexOf('MT4') !== -1) return 'MT4';
        if (modelValue && modelValue.indexOf('E4') !== -1) return 'E4';
        return 'Mirobot';
      }
    }
    return null;
  }

  function getAxisCountForModel(model) {
    return (model === 'MT4' || model === 'E4') ? 4 : 6;
  }

  function rebuildAxes(block, labels, keys) {
    // Save connected blocks before removing
    var savedBlocks = {};
    for (var i = 0; i < ALL_AXIS_KEYS.length; i++) {
      var inp = block.getInput('AXIS_' + ALL_AXIS_KEYS[i]);
      if (inp && inp.connection && inp.connection.targetBlock()) {
        savedBlocks[ALL_AXIS_KEYS[i]] = inp.connection.targetBlock();
        inp.connection.disconnect();
      }
      if (inp) block.removeInput('AXIS_' + ALL_AXIS_KEYS[i]);
    }
    // Add new ones
    for (var j = 0; j < keys.length; j++) {
      var newInp = block.appendValueInput('AXIS_' + keys[j])
          .setCheck('Number')
          .appendField(labels[j]);
      // Reconnect saved block if it exists
      if (savedBlocks[keys[j]] && newInp.connection) {
        newInp.connection.connect(savedBlocks[keys[j]].outputConnection);
      }
    }
  }

  function updateAxesForVariable(block, blockKind) {
    var field = block.getField('VARIABLE');
    if (!field) return;
    var varModel = field.getVariable();
    if (!varModel) return;
    var ws = block.workspace;
    var model = getModelForVariable(ws, varModel.getId()) || 'Mirobot';
    var count = getAxisCountForModel(model);

    var labels, keys;
    if (blockKind === 'coord') {
      labels = count === 4 ? COORD_LABELS_4 : COORD_LABELS_6;
      keys = count === 4 ? COORD_KEYS_4 : COORD_KEYS_6;
    } else {
      labels = count === 4 ? JOINT_LABELS_4 : JOINT_LABELS_6;
      keys = count === 4 ? JOINT_KEYS_4 : JOINT_KEYS_6;
    }

    // Check if axes need changing
    var currentCount = 0;
    for (var i = 0; i < ALL_AXIS_KEYS.length; i++) {
      if (block.getInput('AXIS_' + ALL_AXIS_KEYS[i])) currentCount++;
    }
    if (currentCount !== keys.length) {
      rebuildAxes(block, labels, keys);
    }
  }

  // ── writeCoordinate block ──
  Blockly.Blocks['write_coordinate'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldVariable('robot', function(newValue) {
            // When variable changes, update axes based on model
            setTimeout(function() { updateAxesForVariable(block, 'coord'); }, 0);
            return newValue;
          }), 'VARIABLE')
          .appendField('.writeCoordinate');
      this.appendDummyInput('OPTS_ROW')
          .appendField('motion')
          .appendField(new Blockly.FieldDropdown([
            ['Fast (G00)', '0'],
            ['Linear (G01)', '1'],
            ['Joint (G05)', '2']
          ]), 'MOTION')
          .appendField('mode')
          .appendField(new Blockly.FieldDropdown([
            ['Absolute', '0'],
            ['Incremental', '1']
          ]), 'POSITION');

      // Default: 6 axes
      for (var i = 0; i < COORD_KEYS_6.length; i++) {
        this.appendValueInput('AXIS_' + COORD_KEYS_6[i])
            .setCheck('Number')
            .appendField(COORD_LABELS_6[i]);
      }

      this.setInputsInline(false);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Move robot to Cartesian coordinates. Accepts variables or numbers.');
    }
  };

  // ── writeAngle block ──
  Blockly.Blocks['write_angle'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldVariable('robot', function(newValue) {
            setTimeout(function() { updateAxesForVariable(block, 'joint'); }, 0);
            return newValue;
          }), 'VARIABLE')
          .appendField('.writeAngle');
      this.appendDummyInput('OPTS_ROW')
          .appendField('mode')
          .appendField(new Blockly.FieldDropdown([
            ['Absolute', '0'],
            ['Incremental', '1']
          ]), 'POSITION');

      // Default: 6 axes
      for (var i = 0; i < JOINT_KEYS_6.length; i++) {
        this.appendValueInput('AXIS_' + JOINT_KEYS_6[i])
            .setCheck('Number')
            .appendField(JOINT_LABELS_6[i]);
      }

      this.setInputsInline(false);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Move robot to joint angles. Accepts variables or numbers.');
    }
  };
}

/**
 * Get the model associated with a variable name by scanning setup_robot blocks.
 * Returns 'Mirobot', 'MT4', 'E4', or null.
 */
function getRobotModelForVarName(varName) {
  var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;
  if (!workspace) return null;
  var blocks = workspace.getBlocksByType('setup_robot', false);
  for (var i = 0; i < blocks.length; i++) {
    var field = blocks[i].getField('VARIABLE');
    if (field && field.getVariable() && field.getVariable().name === varName) {
      var modelValue = blocks[i].getFieldValue('MODEL');
      if (modelValue && modelValue.indexOf('MT4') !== -1) return 'MT4';
      if (modelValue && modelValue.indexOf('E4') !== -1) return 'E4';
      return 'Mirobot';
    }
  }
  return null;
}