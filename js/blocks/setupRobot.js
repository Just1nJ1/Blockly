/**
 * Setup Robot Block Definition
 * A built-in block that generates the boilerplate code to initialize a robot arm.
 * Produces: import wlkatapython (hoisted), variable = wlkatapython.Model('port')
 *
 * MODEL and offline PORT options come from RobotCatalog (robots.json).
 */

/**
 * Initialize the setup_robot block.
 */
function initSetupRobotBlock() {
  function getModelOptions() {
    if (window.RobotCatalog && typeof window.RobotCatalog.getSetupModelDropdownOptions === 'function') {
      return window.RobotCatalog.getSetupModelDropdownOptions();
    }
    return [['Mirobot', 'Mirobot_UART'], ['E4 / MT4', 'MT4_UART']];
  }

  function getOfflinePortOptions() {
    if (window.RobotCatalog && typeof window.RobotCatalog.getVirtualPortOptions === 'function') {
      var opts = window.RobotCatalog.getVirtualPortOptions();
      if (opts && opts.length) return opts;
    }
    return [
      ['VirtualMirobot (Mirobot)', 'VirtualMirobot'],
      ['VirtualMT4 (MT4)', 'VirtualMT4']
    ];
  }

  Blockly.Blocks['setup_robot'] = {
    init: function() {
      this.appendDummyInput()
          .appendField('Setup')
          .appendField(new Blockly.FieldVariable('robot'), 'VARIABLE')
          .appendField('as')
          .appendField(new Blockly.FieldDropdown(getModelOptions), 'MODEL')
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
     * Returns detected ports if available, otherwise virtual devices from catalog.
     */
    getPortOptions: function() {
      // detectedPorts is an array of [label, value] pairs
      if (window.detectedPorts && window.detectedPorts.length > 0) {
        return window.detectedPorts;
      }
      return getOfflinePortOptions();
    }
  };
}