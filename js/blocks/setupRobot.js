/**
 * Setup Robot Block Definition
 * A built-in block that generates the boilerplate code to initialize a robot arm.
 * Produces: import wlkatapython (hoisted), variable = wlkatapython.Model('port')
 */

/**
 * Initialize the setup_robot block.
 */
function initSetupRobotBlock() {
  Blockly.Blocks['setup_robot'] = {
    init: function() {
      this.appendDummyInput()
          .appendField('Setup')
          .appendField(new Blockly.FieldVariable('robot'), 'VARIABLE')
          .appendField('as')
          .appendField(new Blockly.FieldDropdown([
            ['Mirobot', 'Mirobot_UART'],
            ['MT4', 'MT4_UART']
          ]), 'MODEL')
          .appendField('on')
          .appendField(new Blockly.FieldDropdown(
            this.getPortOptions
          ), 'PORT');

      this.setPreviousStatement(true, null);
      this.setNextStatement(true, null);
      this.setColour('#E67E22');
      this.setTooltip('Initialize a robot arm connection. Generates import + constructor call.');
      this.setHelpUrl('');
    },

    /**
     * Dynamic dropdown generator for COM ports.
     * Returns detected ports if available, otherwise a default list.
     */
    getPortOptions: function() {
      // If device detector has populated available ports, use those.
      // detectedPorts is an array of [label, value] pairs,
      // e.g. [['COM3 (Mirobot)', 'COM3'], ['COM5', 'COM5']]
      if (window.detectedPorts && window.detectedPorts.length > 0) {
        return window.detectedPorts;
      }

      // Default fallback list (before first poll completes)
      var ports = [];
      for (var i = 1; i <= 10; i++) {
        ports.push(['COM' + i, 'COM' + i]);
      }
      for (var j = 0; j <= 3; j++) {
        ports.push(['/dev/ttyUSB' + j, '/dev/ttyUSB' + j]);
        ports.push(['/dev/ttyACM' + j, '/dev/ttyACM' + j]);
      }
      return ports;
    }
  };
}