const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const registry = require('../js/extensions/extensionRegistry.js');
registry.claimBlock('camera', 'camera_setup');
registry.claimBlock('camera', 'camera_capture');
registry.claimBlock('test-device', 'test_device_setup');

const workspace = {
  getAllBlocks: function () {
    return [
      { type: 'controls_if', isEnabled: function () { return true; } },
      { type: 'camera_setup', isEnabled: function () { return true; } },
      { type: 'camera_capture', isEnabled: function () { return true; } },
      { type: 'test_device_setup', isEnabled: function () { return false; } },
      { type: 'test_device_setup', isEnabled: function () { return true; } }
    ];
  }
};
assert.deepStrictEqual(registry.collectUsedExtensionIds(workspace), ['camera', 'test-device']);
assert.deepStrictEqual(registry.collectUsedExtensionIds(null), []);

global.window = global;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'extensions', 'extensionBlocks.js'), 'utf8'),
  { filename: 'extensionBlocks.js' }
);
const blocks = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'extension_contract', 'test-device', 'blocks', 'blocks.json'),
  'utf8'
));
const setup = blocks[0];
const mode = blocks[1];
const fakeGen = { valueToCode: function () { return 'None'; }, ORDER_NONE: 99 };
const block = { getFieldValue: function (name) { return name === 'PORT' ? 'A' : 'on'; } };
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(block, fakeGen, setup.python, setup.args0),
  "__studiox_extensions['test-device'].open(\"A\")\n"
);
assert.strictEqual(
  ExtensionPython.selectTemplate(block, mode.python),
  'device.on()\n'
);
const core = fs.readFileSync(path.join(__dirname, '..', 'js', 'extensions', 'extensionBlocks.js'), 'utf8');
assert.strictEqual(core.indexOf("name == 'test-device'"), -1);
assert.strictEqual(core.indexOf("name === 'test-device'"), -1);
console.log('extension registry ok');
