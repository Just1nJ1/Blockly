/**
 * Robot Movement Block Definitions
 * writeCoordinate and writeAngle blocks for moving robot arms.
 * Axis fields are ValueInputs so they accept variables, math, or raw numbers.
 * The block auto-detects the model (4 or 6 axes) from the setup_robot block
 * that created the selected variable.
 */

/**
 * Build a dynamic dropdown menu of robot variables based on scope.
 * Inside a function: only params/local vars.
 * At top level: only workspace-level variables (exclude func params/locals).
 * Shared by all robot blocks.
 */
function robotVarDropdownGenerator(block) {
  var ws = block.workspace;
  if (!ws) return [['robot', 'robot']];

  var options = [];
  var enclosingProc = findEnclosingProcedure(block);

  if (enclosingProc) {
    var info = getProcLocalNames(enclosingProc);
    for (var i = 0; i < info.all.length; i++) {
      options.push([info.all[i], info.all[i]]);
    }
  } else {
    var localNames = getAllLocalScopeNames(ws);
    var allVars = ws.getAllVariables();
    for (var j = 0; j < allVars.length; j++) {
      if (!localNames.has(allVars[j].name)) {
        options.push([allVars[j].name, allVars[j].name]);
      }
    }
  }

  if (options.length === 0) {
    options.push(['robot', 'robot']);
  }
  return options;
}

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
    var savedBlocks = {};
    for (var i = 0; i < ALL_AXIS_KEYS.length; i++) {
      var inp = block.getInput('AXIS_' + ALL_AXIS_KEYS[i]);
      if (inp && inp.connection && inp.connection.targetBlock()) {
        savedBlocks[ALL_AXIS_KEYS[i]] = inp.connection.targetBlock();
        inp.connection.disconnect();
      }
      if (inp) block.removeInput('AXIS_' + ALL_AXIS_KEYS[i]);
    }
    for (var j = 0; j < keys.length; j++) {
      var newInp = block.appendValueInput('AXIS_' + keys[j])
          .setCheck('Number')
          .appendField(labels[j]);
      if (savedBlocks[keys[j]] && newInp.connection) {
        newInp.connection.connect(savedBlocks[keys[j]].outputConnection);
      }
    }
  }

  function updateAxesForVariable(block, blockKind) {
    var varName = block.getFieldValue('VARIABLE');
    if (!varName) return;

    var ws = block.workspace;
    // Look up model by variable name
    var model = null;
    if (typeof getRobotModelForVarName === 'function') {
      model = getRobotModelForVarName(varName);
    }
    model = model || 'Mirobot';
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

  function createVarValidator(block, blockKind) {
    return function(newValue) {
      setTimeout(function() { updateAxesForVariable(block, blockKind); }, 0);
      return newValue;
    };
  }

  // ── writeCoordinate block ──
  Blockly.Blocks['write_coordinate'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); },
            createVarValidator(this, 'coord')
          ), 'VARIABLE')
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

      this.setInputsInline(true);
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
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); },
            createVarValidator(this, 'joint')
          ), 'VARIABLE')
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

      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Move robot to joint angles. Accepts variables or numbers.');
    }
  };
}

/**
 * Additional robot command blocks: homing, zero, speed, delay, sendMsg.
 */
function initRobotCommandBlocks() {

  // ── Homing block ──
  Blockly.Blocks['robot_homing'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('.homing()');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Home the robot arm (move all axes to home position).');
    }
  };

  // ── Zero block ──
  Blockly.Blocks['robot_zero'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('.zero()');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Move robot to zero position (all angles = 0).');
    }
  };

  // ── Set Speed block ──
  Blockly.Blocks['robot_speed'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('.speed(');
      this.appendValueInput('SPEED')
          .setCheck('Number');
      this.appendDummyInput()
          .appendField(')');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Set robot movement speed (0-100).');
    }
  };

  // ── Delay block (no variable field — not an instance method) ──
  Blockly.Blocks['robot_delay'] = {
    init: function() {
      this.appendDummyInput()
          .appendField('delay');
      this.appendValueInput('TIME')
          .setCheck('Number');
      this.appendDummyInput()
          .appendField('seconds');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#5CA65C');
      this.setTooltip('Wait for a specified number of seconds.');
    }
  };

  // ── Send Command block ──
  Blockly.Blocks['robot_send_msg'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('.sendMsg(');
      this.appendValueInput('MESSAGE')
          .setCheck('String');
      this.appendDummyInput()
          .appendField(')');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Send a raw G-code command to the robot.');
    }
  };
  // ── Wait Idle block ──
  Blockly.Blocks['robot_wait_idle'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('.waitIdle()');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Wait until the robot finishes moving and is idle.');
    }
  };

  // ── Suction Cup block ──
  Blockly.Blocks['robot_pump'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('suction cup')
          .appendField(new Blockly.FieldDropdown([
            ['SUCTION', '1'],
            ['BLOW', '2'],
            ['OFF', '0']
          ]), 'MODE');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Control the suction cup: Suction (1), Blowing (2), Off (0).');
    }
  };

  // ── Gripper block ──
  Blockly.Blocks['robot_gripper'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('gripper')
          .appendField(new Blockly.FieldDropdown([
            ['OPEN', '1'],
            ['CLOSE', '2'],
            ['OFF', '0']
          ]), 'MODE');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Control the gripper: Open (1), Close (2), Stop (0).');
    }
  };

  // ── Three-Finger Gripper block ──
  Blockly.Blocks['robot_three_finger'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(new Blockly.FieldDropdown(
            function() { return robotVarDropdownGenerator(block); }
          ), 'VARIABLE')
          .appendField('three-finger gripper')
          .appendField(new Blockly.FieldDropdown([
            ['OPEN', '1'],
            ['CLOSE', '2'],
            ['OFF', '0']
          ]), 'MODE');
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Control the three-finger soft gripper: Open (1), Close (2), Stop (0).');
    }
  };
}

/**
 * Color palette for robot variables. Each robot gets a distinct color.
 */
var ROBOT_COLORS = [
  '#E67E22',  // orange (default)
  '#27AE60',  // green
  '#8E44AD',  // purple
  '#2980B9',  // blue
  '#C0392B',  // red
  '#16A085',  // teal
  '#D35400',  // dark orange
  '#2C3E50',  // dark blue
];

var _robotVarColorMap = {};  // varName -> color

// Block types that have a VARIABLE field referencing a robot
var ROBOT_BLOCK_TYPES = [
  'setup_robot', 'write_coordinate', 'write_angle',
  'robot_homing', 'robot_zero', 'robot_speed', 'robot_wait_idle',
  'robot_send_msg', 'robot_pump', 'robot_gripper', 'robot_three_finger'
];

/**
 * Scan setup_robot blocks, assign a color to each variable, then
 * update all robot blocks to match their variable's color.
 */
function updateRobotBlockColors() {
  var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
  if (!ws) return;

  // Build color map from setup_robot blocks
  var setupBlocks = ws.getBlocksByType('setup_robot', false);
  var usedColors = 0;
  var newMap = {};

  for (var i = 0; i < setupBlocks.length; i++) {
    var field = setupBlocks[i].getField('VARIABLE');
    if (!field || !field.getVariable()) continue;
    var varName = field.getVariable().name;
    if (!newMap[varName]) {
      // Reuse existing color if the variable was already assigned
      if (_robotVarColorMap[varName]) {
        newMap[varName] = _robotVarColorMap[varName];
      } else {
        newMap[varName] = ROBOT_COLORS[usedColors % ROBOT_COLORS.length];
      }
      usedColors++;
    }
  }

  _robotVarColorMap = newMap;

  // Update all robot blocks
  for (var t = 0; t < ROBOT_BLOCK_TYPES.length; t++) {
    var blocks = ws.getBlocksByType(ROBOT_BLOCK_TYPES[t], false);
    for (var j = 0; j < blocks.length; j++) {
      var block = blocks[j];
      var varField = block.getField('VARIABLE');
      var vName = null;

      if (varField) {
        // FieldVariable has getVariable(), FieldDropdown returns string
        if (typeof varField.getVariable === 'function' && varField.getVariable()) {
          vName = varField.getVariable().name;
        } else {
          vName = block.getFieldValue('VARIABLE');
        }
      }

      var color = (vName && _robotVarColorMap[vName]) || ROBOT_COLORS[0];
      if (block.getColour() !== color) {
        block.setColour(color);
      }
    }
  }
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