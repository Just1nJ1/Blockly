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
  var options = [];
  var ws = block.workspace;

  if (ws) {
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
  }

  // Keep the currently selected name visible even if it is an orphan (e.g. r3
  // with no setup_robot) or was just renamed on import (robot → robot_1).
  try {
    var field = block.getField && block.getField('VARIABLE');
    var cur = field ? field.getValue() : null;
    if (cur) {
      var found = false;
      for (var k = 0; k < options.length; k++) {
        if (options[k][1] === cur) { found = true; break; }
      }
      if (!found) options.unshift([cur, cur]);
    }
  } catch (e) { /* ignore */ }

  if (options.length === 0) {
    options.push(['robot', 'robot']);
  }
  return options;
}

/**
 * FieldDropdown for robot variable names.
 *
 * Blockly's default validation rejects any value not currently returned by the
 * menu generator. That silently rewrites import renames (robot_1) and orphan
 * names (r3) back to the first option ("robot"). Accept any non-empty string;
 * the generator still drives the open menu.
 *
 * @param {Blockly.Block} block
 * @param {Function=} opt_validator  optional change validator (coord/joint axes)
 * @returns {Blockly.FieldDropdown}
 */
function createRobotVarDropdown(fieldBlock, opt_validator) {
  var field = new Blockly.FieldDropdown(
    function() { return robotVarDropdownGenerator(fieldBlock); },
    opt_validator
  );
  field.doClassValidation_ = function(newValue) {
    if (newValue === undefined || newValue === null || newValue === '') {
      return null;
    }
    return String(newValue);
  };
  return field;
}

/**
 * Remember the default shadow for a connection so we can restore it when the
 * user pulls a value (or the shadow itself) out of the slot. Blockly clears
 * connection.shadowState when a shadow is dragged out and promoted to a real
 * block, which would otherwise leave an empty socket.
 */
function rememberDefaultShadow(connection, state) {
  if (!connection || !state) return;
  try {
    connection._studioxShadow = JSON.parse(JSON.stringify(state));
  } catch (e) {
    connection._studioxShadow = state;
  }
}

/**
 * Snapshot any current shadow definition on a connection (from toolbox flyout,
 * setShadowState, or a live shadow block).
 */
function captureConnectionShadowDefault(connection) {
  if (!connection) return;
  if (connection._studioxShadow) return;

  var state = null;
  try {
    if (typeof connection.getShadowState === 'function') {
      // Prefer the stored definition (survives a non-shadow replacement).
      state = connection.getShadowState(false);
      // When only a live shadow is present, serialize it.
      if (!state) state = connection.getShadowState(true);
    }
  } catch (e) { /* ignore */ }

  if (!state && connection.targetBlock && connection.targetBlock()) {
    var tb = connection.targetBlock();
    if (tb && tb.isShadow && tb.isShadow()) {
      try {
        if (Blockly.serialization && Blockly.serialization.blocks &&
            typeof Blockly.serialization.blocks.save === 'function') {
          state = Blockly.serialization.blocks.save(tb);
        }
      } catch (e2) { /* ignore */ }
      if (!state) {
        state = {
          type: tb.type,
          fields: {}
        };
        if (tb.type === 'math_number') {
          state.fields.NUM = tb.getFieldValue('NUM');
        } else if (tb.type === 'text') {
          state.fields.TEXT = tb.getFieldValue('TEXT');
        }
      }
    }
  }

  if (state) {
    // Drop ids so each respawn is a fresh shadow instance
    if (state.id) delete state.id;
    rememberDefaultShadow(connection, state);
  }
}

/**
 * If a value input is empty (no real block and no live shadow), re-apply the
 * remembered default or a type-based fallback (Number → math_number 0).
 */
function restoreDefaultShadowIfEmpty(connection) {
  if (!connection) return;
  // Only value sockets
  var INPUT_VALUE = (Blockly.ConnectionType && Blockly.ConnectionType.INPUT_VALUE) ||
    (Blockly.INPUT_VALUE !== undefined ? Blockly.INPUT_VALUE : 1);
  if (connection.type !== undefined && connection.type !== INPUT_VALUE) return;

  var target = connection.targetBlock ? connection.targetBlock() : null;
  if (target) return; // real or shadow already present

  // Capture type-based fallback if we never stored a default
  if (!connection._studioxShadow) {
    var checks = null;
    try {
      checks = connection.getCheck && connection.getCheck();
    } catch (e) { /* ignore */ }
    if (checks && checks.indexOf('Number') !== -1) {
      rememberDefaultShadow(connection, {
        type: 'math_number',
        fields: { NUM: 0 }
      });
    } else if (checks && checks.indexOf('String') !== -1) {
      rememberDefaultShadow(connection, {
        type: 'text',
        fields: { TEXT: '' }
      });
    }
  }

  var def = connection._studioxShadow;
  if (!def || !def.type) return;

  // If Blockly still has shadowState but no block, just respawn
  try {
    var hasState = typeof connection.getShadowState === 'function' &&
      connection.getShadowState(false);
    var hasDom = typeof connection.getShadowDom === 'function' &&
      connection.getShadowDom();
    if ((hasState || hasDom) && typeof connection.createShadowBlock === 'function') {
      connection.createShadowBlock(true);
      if (connection.targetBlock && connection.targetBlock()) return;
    }
  } catch (eRespawn) { /* fall through to re-set */ }

  // Re-apply definition (also recreates the shadow block)
  try {
    if (typeof connection.setShadowState === 'function') {
      connection.setShadowState(def);
      return;
    }
  } catch (eSet) { /* fall through */ }

  if (def.type === 'math_number') {
    setNumberShadow(connection, def.fields && def.fields.NUM);
  } else if (def.type === 'text') {
    setTextShadow(connection, def.fields && def.fields.TEXT);
  }
}

/**
 * Capture + restore defaults for every value input on a block.
 */
function ensureBlockValueShadows(block) {
  if (!block || block.isDisposed && block.isDisposed()) return;
  var inputs = block.inputList || [];
  for (var i = 0; i < inputs.length; i++) {
    var conn = inputs[i].connection;
    if (!conn) continue;
    captureConnectionShadowDefault(conn);
    restoreDefaultShadowIfEmpty(conn);
  }
}

/**
 * Attach a default number shadow block to a value input connection.
 * Uses setShadowState when available (Blockly 9+), else XML setShadowDom.
 */
function setNumberShadow(connection, value) {
  if (!connection) return;
  var num = (value === undefined || value === null || value === '') ? 0 : value;
  var state = { type: 'math_number', fields: { NUM: num } };
  rememberDefaultShadow(connection, state);
  try {
    if (typeof connection.setShadowState === 'function') {
      connection.setShadowState(state);
      return;
    }
  } catch (e) { /* fall through */ }
  try {
    var xml = Blockly.utils.xml.textToDom(
      '<shadow type="math_number"><field name="NUM">' + num + '</field></shadow>'
    );
    connection.setShadowDom(xml);
  } catch (e2) {
    console.warn('[moveRobot] Could not set number shadow', e2);
  }
}

/**
 * Attach a default text shadow block to a value input connection.
 */
function setTextShadow(connection, text) {
  if (!connection) return;
  var t = (text === undefined || text === null) ? '' : String(text);
  var state = { type: 'text', fields: { TEXT: t } };
  rememberDefaultShadow(connection, state);
  try {
    if (typeof connection.setShadowState === 'function') {
      connection.setShadowState(state);
      return;
    }
  } catch (e) { /* fall through */ }
  try {
    var escaped = t
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    var xml = Blockly.utils.xml.textToDom(
      '<shadow type="text"><field name="TEXT">' + escaped + '</field></shadow>'
    );
    connection.setShadowDom(xml);
  } catch (e2) {
    console.warn('[moveRobot] Could not set text shadow', e2);
  }
}

window.setNumberShadow = setNumberShadow;
window.setTextShadow = setTextShadow;
window.ensureBlockValueShadows = ensureBlockValueShadows;
window.captureConnectionShadowDefault = captureConnectionShadowDefault;
window.restoreDefaultShadowIfEmpty = restoreDefaultShadowIfEmpty;

function initMoveRobotBlocks() {

  // Labels shown on the block; keys stay A/B/C for generators & shadows (AXIS_A…)
  var COORD_LABELS_6 = ['X', 'Y', 'Z', 'RX', 'RY', 'RZ'];
  var COORD_KEYS_6   = ['X', 'Y', 'Z', 'A', 'B', 'C'];
  var COORD_LABELS_4 = ['X', 'Y', 'Z', 'RX'];
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
        if (typeof normalizeRobotModelName === 'function') {
          return normalizeRobotModelName(modelValue);
        }
        if (window.RobotCatalog) {
          return window.RobotCatalog.normalizeModelName(modelValue);
        }
        return modelValue || null;
      }
    }
    return null;
  }

  function getAxisCountForModel(model) {
    if (window.RobotCatalog && typeof window.RobotCatalog.getAxisCount === 'function') {
      return window.RobotCatalog.getAxisCount(model);
    }
    return (model === 'MT4' || model === 'E4') ? 4 : 6;
  }

  function rebuildAxes(block, labels, keys) {
    // When switching 6↔4 axes (e.g. Mirobot var remapped onto MT4), keep
    // X/Y/Z/A values and only drop B/C — do not zero the remaining axes.
    var savedBlocks = {};
    var savedShadowValues = {};
    for (var i = 0; i < ALL_AXIS_KEYS.length; i++) {
      var key = ALL_AXIS_KEYS[i];
      var inp = block.getInput('AXIS_' + key);
      if (inp && inp.connection && inp.connection.targetBlock()) {
        var tb = inp.connection.targetBlock();
        if (tb && !tb.isShadow()) {
          // Real plugged-in number/expression blocks
          savedBlocks[key] = tb;
          inp.connection.disconnect();
        } else if (tb) {
          // Default math_number shadows — preserve NUM for axes we keep
          var num = tb.getFieldValue('NUM');
          if (num !== null && num !== undefined && num !== '') {
            savedShadowValues[key] = num;
          }
        }
      }
      if (inp) block.removeInput('AXIS_' + key);
    }
    for (var j = 0; j < keys.length; j++) {
      var keepKey = keys[j];
      var newInp = block.appendValueInput('AXIS_' + keepKey)
          .setCheck('Number')
          .appendField(labels[j]);
      if (savedBlocks[keepKey] && newInp.connection) {
        newInp.connection.connect(savedBlocks[keepKey].outputConnection);
        delete savedBlocks[keepKey];
      } else if (newInp.connection) {
        var defVal = 0;
        if (Object.prototype.hasOwnProperty.call(savedShadowValues, keepKey)) {
          defVal = savedShadowValues[keepKey];
        }
        setNumberShadow(newInp.connection, defVal);
      }
    }
    // Dispose real blocks that belonged to dropped axes (B/C on 6→4)
    for (var dropKey in savedBlocks) {
      if (!Object.prototype.hasOwnProperty.call(savedBlocks, dropKey)) continue;
      try {
        savedBlocks[dropKey].dispose(false);
      } catch (eDisp) { /* ignore */ }
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
          .appendField(createRobotVarDropdown(block, createVarValidator(this, 'coord')), 'VARIABLE')
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

      // Default: 6 axes, each with a number shadow (0)
      for (var i = 0; i < COORD_KEYS_6.length; i++) {
        var cInp = this.appendValueInput('AXIS_' + COORD_KEYS_6[i])
            .setCheck('Number')
            .appendField(COORD_LABELS_6[i]);
        if (cInp.connection) setNumberShadow(cInp.connection, 0);
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
          .appendField(createRobotVarDropdown(block, createVarValidator(this, 'joint')), 'VARIABLE')
          .appendField('.writeAngle');
      this.appendDummyInput('OPTS_ROW')
          .appendField('mode')
          .appendField(new Blockly.FieldDropdown([
            ['Absolute', '0'],
            ['Incremental', '1']
          ]), 'POSITION');

      // Default: 6 axes, each with a number shadow (0)
      for (var i = 0; i < JOINT_KEYS_6.length; i++) {
        var jInp = this.appendValueInput('AXIS_' + JOINT_KEYS_6[i])
            .setCheck('Number')
            .appendField(JOINT_LABELS_6[i]);
        if (jInp.connection) setNumberShadow(jInp.connection, 0);
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
          .appendField('.speed(');
      var speedInp = this.appendValueInput('SPEED')
          .setCheck('Number');
      if (speedInp.connection) setNumberShadow(speedInp.connection, 0);
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
      var timeInp = this.appendValueInput('TIME')
          .setCheck('Number');
      if (timeInp.connection) setNumberShadow(timeInp.connection, 1);
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
          .appendField('.sendMsg(');
      var msgInp = this.appendValueInput('MESSAGE')
          .setCheck('String');
      if (msgInp.connection) setTextShadow(msgInp.connection, '');
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
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

  // ── Conveyor belt / 7th-axis (writeExpand) ──
  Blockly.Blocks['robot_conveyor'] = {
    init: function() {
      var block = this;
      this.appendDummyInput()
          .appendField(createRobotVarDropdown(block), 'VARIABLE')
          .appendField('conveyor belt');
      this.appendDummyInput('OPTS_ROW')
          .appendField('motion')
          .appendField(new Blockly.FieldDropdown([
            ['Fast (G00)', '0'],
            ['Linear (G01)', '1']
          ]), 'MOTION')
          .appendField('mode')
          .appendField(new Blockly.FieldDropdown([
            ['Absolute', '0'],
            ['Incremental', '1']
          ]), 'POSITION');
      this.appendDummyInput()
          .appendField('D');
      var dInp = this.appendValueInput('D')
          .setCheck('Number');
      if (dInp.connection) setNumberShadow(dInp.connection, 0);
      this.setInputsInline(true);
      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip(
        'Move the 7th axis (conveyor belt / external rail). ' +
        'Calls writeExpand(motion, position, d).'
      );
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
  'robot_send_msg', 'robot_pump', 'robot_gripper', 'robot_three_finger',
  'robot_conveyor'
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
 * Map a setup_robot MODEL / constructor class name to a short label.
 * e.g. 'MT4_UART' → 'MT4', 'wlkatapython.Harobot_UART' → 'MT4'
 * Delegates to RobotCatalog when available.
 */
function normalizeRobotModelName(raw) {
  if (window.RobotCatalog && typeof window.RobotCatalog.normalizeModelName === 'function') {
    return window.RobotCatalog.normalizeModelName(raw);
  }
  if (typeof window.normalizeRobotModelName === 'function' &&
      window.normalizeRobotModelName !== normalizeRobotModelName) {
    return window.normalizeRobotModelName(raw);
  }
  if (!raw) return null;
  var s = String(raw).replace(/^wlkatapython\./i, '').trim();
  if (!s) return null;
  if (/MT4/i.test(s)) return 'MT4';
  if (/\bE4\b/i.test(s) || /^E4/i.test(s)) return 'E4';
  if (/Haro/i.test(s)) return 'MT4';
  if (/Mirobot/i.test(s)) return 'Mirobot';
  s = s.replace(/_UART$/i, '').replace(/_USB$/i, '');
  return s || null;
}

/**
 * Find a UART constructor class used inside a procedure definition block tree.
 * Looks for library_function_call / function_call with names like
 * wlkatapython.MT4_UART.
 */
function findUartCtorInBlockTree(root) {
  if (!root) return null;
  var stack = [root];
  var found = null;
  while (stack.length) {
    var b = stack.pop();
    if (!b) continue;
    if (b.type === 'library_function_call' || b.type === 'function_call') {
      var fname = b.getFieldValue('FUNC_NAME') || '';
      if (/_UART\b/i.test(fname) || /wlkatapython\./i.test(fname)) {
        found = fname; // last match wins (walk order is not guaranteed)
      }
    }
    var children = b.getChildren(false);
    for (var c = 0; c < children.length; c++) {
      stack.push(children[c]);
    }
  }
  return found;
}

/**
 * Infer model for a variable created via a factory function
 * (variables_set ← procedures_callreturn → procedures_defreturn body).
 */
function getModelFromFactoryFunction(workspace, varName) {
  if (!workspace || !varName) return null;

  var setBlocks = workspace.getBlocksByType('variables_set', false);
  var callBlock = null;
  for (var i = 0; i < setBlocks.length; i++) {
    var vf = setBlocks[i].getField('VAR');
    var v = vf && vf.getVariable ? vf.getVariable() : null;
    var name = v ? v.name : setBlocks[i].getFieldValue('VAR');
    if (name !== varName) continue;
    var val = setBlocks[i].getInputTargetBlock('VALUE');
    if (val && (val.type === 'procedures_callreturn' || val.type === 'procedures_callnoreturn')) {
      callBlock = val;
      break;
    }
  }
  if (!callBlock) return null;

  var procName = (typeof callBlock.getProcedureCall === 'function')
    ? callBlock.getProcedureCall()
    : callBlock.getFieldValue('NAME');
  if (!procName) return null;

  var defs = workspace.getBlocksByType('procedures_defreturn', false)
    .concat(workspace.getBlocksByType('procedures_defnoreturn', false));
  for (var d = 0; d < defs.length; d++) {
    var defName = defs[d].getFieldValue('NAME');
    if (defName !== procName) continue;
    var ctor = findUartCtorInBlockTree(defs[d]);
    if (ctor) return normalizeRobotModelName(ctor);
  }
  return null;
}

/**
 * Get the model associated with a variable name.
 * Priority:
 *   1. setup_robot MODEL field
 *   2. analyzeRobotCode varModels (direct + factory-function callers)
 *   3. workspace factory-function block tree (library_function_call)
 * Returns 'Mirobot', 'MT4', 'E4', 'Haro380', or null.
 */
function getRobotModelForVarName(varName) {
  if (!varName) return null;
  var workspace = (typeof getWorkspace === 'function') ? getWorkspace() : null;

  // 1. setup_robot blocks (explicit model dropdown)
  if (workspace) {
    var blocks = workspace.getBlocksByType('setup_robot', false);
    for (var i = 0; i < blocks.length; i++) {
      var field = blocks[i].getField('VARIABLE');
      if (field && field.getVariable() && field.getVariable().name === varName) {
        var modelValue = blocks[i].getFieldValue('MODEL');
        return normalizeRobotModelName(modelValue) || 'Mirobot';
      }
    }
  }

  // 2. Generated-code analysis (includes factory functions like GetMirobot)
  var analysis = (window.RobotCodeAnalysis && window.RobotCodeAnalysis.lastAnalysis) || null;
  if (!analysis || !analysis.varModels || !analysis.varModels[varName]) {
    var codeEl = document.getElementById('code-preview');
    var code = codeEl ? (codeEl.textContent || '') : '';
    if (code && typeof window.analyzeRobotCode === 'function') {
      analysis = window.analyzeRobotCode(code);
      if (window.RobotCodeAnalysis) {
        window.RobotCodeAnalysis.lastAnalysis = analysis;
      }
    }
  }
  if (analysis && analysis.varModels && analysis.varModels[varName]) {
    return normalizeRobotModelName(analysis.varModels[varName]);
  }

  // 3. Blockly tree: variables_set ← call → procedure body with UART ctor
  if (workspace) {
    var fromFactory = getModelFromFactoryFunction(workspace, varName);
    if (fromFactory) return fromFactory;
  }

  return null;
}

/**
 * Map a logical robot model name to 3D viewer assets (URDF + TCP offset).
 * Prefer RobotCatalog (robots.json viewer block); keep inline fallback.
 *
 * @param {string|null} model — 'Mirobot' | 'MT4' | 'E4' | ...
 * @returns {{id:string, label:string, urdf:string, meshBasePath:string, tcpOffset:number[]}}
 */
function resolveRobotViewerConfig(model) {
  if (window.RobotCatalog && typeof window.RobotCatalog.resolveViewerConfig === 'function') {
    return window.RobotCatalog.resolveViewerConfig(model);
  }
  var BASE = './resources/wlkata_arm_virtual-reality/';
  var key = model || 'Mirobot';
  if (key === 'MT4' || key === 'E4' || key === 'Haro380' || key === 'haro380') {
    return {
      id: 'haro380',
      label: (key === 'E4') ? 'E4' : (key === 'MT4' ? 'MT4' : 'Haro380'),
      urdf: BASE + 'urdf/wlkata_haro380_description.urdf',
      meshBasePath: BASE,
      tcpOffset: [0, 0, -0.041]
    };
  }
  return {
    id: 'mirobot',
    label: 'Mirobot',
    urdf: BASE + 'urdf/wlkata_mirobot_description.urdf',
    meshBasePath: BASE,
    tcpOffset: [0, 0, 0.02428]
  };
}

window.getRobotModelForVarName = getRobotModelForVarName;
// Prefer catalog globals if already set by robotCatalog.js; else export local
if (typeof window.normalizeRobotModelName !== 'function') {
  window.normalizeRobotModelName = normalizeRobotModelName;
}
if (typeof window.resolveRobotViewerConfig !== 'function') {
  window.resolveRobotViewerConfig = resolveRobotViewerConfig;
} else {
  // Keep name available but catalog owns the implementation
  window.resolveRobotViewerConfig = function (model) {
    if (window.RobotCatalog) return window.RobotCatalog.resolveViewerConfig(model);
    return resolveRobotViewerConfig(model);
  };
}

window.setRobotColorForVar = function(varName, color) {
  _robotVarColorMap[varName] = color;
  updateRobotBlockColors();
};