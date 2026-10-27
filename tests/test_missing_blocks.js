const assert = require('assert');
const missing = require('../js/workspace/missingBlocks.js');

const xml = [
  '<xml>',
  '<block type="camera_setup"><field name="CAMERA">0</field>',
  '<next><block type="controls_if"></block></next>',
  '</block>',
  '<shadow type="math_number"></shadow>',
  '</xml>'
].join('');

assert.deepStrictEqual(
  missing.missingBlockTypes(xml, { controls_if: true, math_number: true }),
  ['camera_setup']
);
assert.deepStrictEqual(missing.missingBlockTypes(xml, {
  camera_setup: true,
  controls_if: true,
  math_number: true
}), []);
const message = missing.missingBlockMessage(['camera_setup']);
assert.ok(message.indexOf('Missing extension block: camera_setup') === 0);
assert.ok(message.indexOf('saved workspace was not changed') !== -1);
console.log('missing blocks ok');
