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
     * Returns detected ports if available, otherwise built-in virtual devices
     * (VirtualMirobot / VirtualMT4) so Blockly works offline.
     */
    getPortOptions: function() {
      // If device detector has populated available ports, use those.
      // detectedPorts is an array of [label, value] pairs,
      // e.g. [['VirtualMirobot (Mirobot)', 'VirtualMirobot'], ['COM3 (Mirobot)', 'COM3']]
      if (window.detectedPorts && window.detectedPorts.length > 0) {
        return window.detectedPorts;
      }

      // Offline defaults — same virtual ports the server always advertises
      return [
        ['VirtualMirobot (Mirobot)', 'VirtualMirobot'],
        ['VirtualMT4 (MT4)', 'VirtualMT4']
      ];
    }
  };
}