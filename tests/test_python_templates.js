const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

global.window = global;
vm.runInThisContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'extensions', 'extensionBlocks.js'), 'utf8'),
  { filename: 'extensionBlocks.js' }
);

function block(fields) {
  return {
    type: 'sample',
    getFieldValue: function (name) { return fields[name]; }
  };
}

const convert = {
  select: {
    field: 'MODE',
    cases: { BGR: '{IMAGE}' },
    default: 'cv2.cvtColor({IMAGE}, cv2.COLOR_BGR2{MODE})'
  }
};
assert.strictEqual(
  ExtensionPython.selectTemplate(block({ MODE: 'BGR' }), convert),
  '{IMAGE}'
);
assert.strictEqual(
  ExtensionPython.selectTemplate(block({ MODE: 'GRAY' }), convert),
  'cv2.cvtColor({IMAGE}, cv2.COLOR_BGR2{MODE})'
);

const args = [
  { type: 'field_checkbox', name: 'ON' },
  { type: 'field_dropdown', name: 'MODE', unquoted: true, options: [['Gray', 'GRAY'], ['RGB', 'RGB']] },
  { type: 'input_value', name: 'IMAGE' }
];
const fakeGen = {
  valueToCode: function () { return 'frame' },
  ORDER_NONE: 99
};
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(block({ ON: 'TRUE', MODE: 'GRAY' }), fakeGen, 'power({ON})', args),
  'power(True)'
);
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(block({ ON: 'FALSE', MODE: 'GRAY' }), fakeGen, '{MODE}', args),
  'GRAY'
);
const device = {
  select: {
    field: 'POWER',
    cases: { on: 'device.on({PORT})', off: 'device.off({PORT})' },
    default: 'device.off({PORT})'
  }
};
assert.strictEqual(
  ExtensionPython.selectTemplate(block({ POWER: 'on' }), device),
  'device.on({PORT})'
);
assert.throws(function () {
  ExtensionPython.selectTemplate(block({ POWER: 'maybe' }), { select: { field: 'POWER', cases: {} } });
});

const ranged = [{ type: 'field_number', name: 'WIDTH', min: 1, max: 4096 }];
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(block({ WIDTH: '99999' }), fakeGen, '{WIDTH}', ranged),
  '4096'
);
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(block({ WIDTH: 'nope' }), fakeGen, '{WIDTH}', ranged),
  '1'
);
assert.throws(function () {
  ExtensionPython.fillBlockTemplate(
    block({ MODE: 'GRAY; print(1)' }),
    fakeGen,
    '{MODE}',
    [{ type: 'field_dropdown', name: 'MODE', unquoted: true, options: [['Gray', 'GRAY']] }]
  );
});
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(
    block({ MODE: 'RGB' }),
    fakeGen,
    ExtensionPython.selectTemplate(block({ MODE: 'RGB' }), convert),
    [{ type: 'input_value', name: 'IMAGE' }, { type: 'field_dropdown', name: 'MODE', unquoted: true, options: [['RGB', 'RGB']] }]
  ),
  'cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)'
);
assert.strictEqual(
  ExtensionPython.fillBlockTemplate(
    block({ MODE: 'HSV' }),
    fakeGen,
    ExtensionPython.selectTemplate(block({ MODE: 'HSV' }), convert),
    [{ type: 'input_value', name: 'IMAGE' }, { type: 'field_dropdown', name: 'MODE', unquoted: true, options: [['HSV', 'HSV']] }]
  ),
  'cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)'
);

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'extensions', 'extensionBlocks.js'), 'utf8');
assert.strictEqual(src.indexOf("def.type === 'camera_convert'"), -1);
assert.strictEqual(src.indexOf('camdef_'), -1);
assert.strictEqual(src.indexOf('open_camera'), -1);
assert.strictEqual(src.indexOf("=== 'camera'"), -1);

function fieldBlock(type, fields) {
  return {
    type: type,
    getFieldValue: function (name) { return fields[name]; },
    getField: function (name) {
      return { getText: function () { return fields[name]; } };
    },
    getSurroundParent: function () { return null; }
  };
}

const cameraBlocks = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'extensions', 'camera', 'blocks', 'blocks.json'),
  'utf8'
));
const setupDef = cameraBlocks.filter(function (item) { return item.type === 'camera_setup'; })[0];
const previewDef = cameraBlocks.filter(function (item) { return item.type === 'camera_preview'; })[0];
const resizeDef = cameraBlocks.filter(function (item) { return item.type === 'camera_resize'; })[0];
const setupBlock = fieldBlock('camera_setup', { CAMERA: '0', CAP: 'cap' });

const studio = ExtensionPython.renderExtensionBlock(setupDef, setupBlock, {
  target: 'studiox', purpose: 'execute'
});
assert.strictEqual(studio.code, "cap = __studiox_extensions['camera'].open_camera(0)\n");
assert.strictEqual(studio.cleanup, '');

const portable = ExtensionPython.renderExtensionBlock(setupDef, setupBlock, {
  target: 'portable', purpose: 'export'
});
assert.strictEqual(portable.code, 'cap = cv2.VideoCapture(0)\n');
assert.deepStrictEqual(portable.imports, ['import cv2']);
assert.strictEqual(portable.cleanup, '');
assert.strictEqual(portable.code.indexOf('try:'), -1);
assert.strictEqual(portable.code.indexOf('release'), -1);

const releaseDef = cameraBlocks.filter(function (item) { return item.type === 'camera_release'; })[0];
const releaseBlock = fieldBlock('camera_release', { CAP: 'cap' });
['execute', 'export', 'simulation'].forEach(function (purpose) {
  const target = purpose === 'export' ? 'portable' : 'studiox';
  const rendered = ExtensionPython.renderExtensionBlock(releaseDef, releaseBlock, {
    target: target, purpose: purpose
  });
  assert.strictEqual(rendered.code, 'cap.release()\n', purpose);
  assert.strictEqual(rendered.cleanup, '', purpose);
});

const simulated = ExtensionPython.renderExtensionBlock(setupDef, setupBlock, {
  target: 'studiox', purpose: 'simulation'
});
assert.ok(simulated.code.indexOf('__studiox_simulation_placeholder') !== -1);
assert.strictEqual(simulated.code.indexOf('VideoCapture'), -1);
assert.strictEqual(simulated.code.indexOf('open_camera('), -1);

const previewBlock = fieldBlock('camera_preview', { SLOT: '1' });
assert.strictEqual(
  ExtensionPython.renderExtensionBlock(previewDef, previewBlock, {
    target: 'studiox', purpose: 'execute'
  }).code,
  '__studiox_preview(None, 1)\n'
);
['portable export', 'studiox simulation', 'studiox export'].forEach(function (label) {
  var parts = label.split(' ');
  assert.strictEqual(
    ExtensionPython.renderExtensionBlock(previewDef, previewBlock, {
      target: parts[0], purpose: parts[1]
    }).code,
    'pass  # preview block call\n',
    label
  );
});
const resizeSim = ExtensionPython.renderExtensionBlock(resizeDef, fieldBlock('camera_resize', {
  WIDTH: '32', HEIGHT: '32'
}), { target: 'studiox', purpose: 'simulation' });
assert.ok(resizeSim.code.indexOf('__studiox_simulation_note') !== -1);
assert.strictEqual(resizeSim.code.indexOf('cv2.resize'), -1);
const resizeRun = ExtensionPython.renderExtensionBlock(resizeDef, fieldBlock('camera_resize', {
  WIDTH: '32', HEIGHT: '32'
}), { target: 'portable', purpose: 'export' });
assert.ok(resizeRun.code.indexOf('cv2.resize') !== -1);

const studioxOnly = {
  type: 'arm_log',
  previousStatement: null,
  nextStatement: null,
  codegen: 'studiox',
  python: 'arm.log()\n'
};
assert.strictEqual(
  ExtensionPython.renderExtensionBlock(studioxOnly, fieldBlock('arm_log', {}), {
    target: 'portable', purpose: 'export'
  }).code,
  'pass\n'
);
assert.strictEqual(
  ExtensionPython.renderExtensionBlock(studioxOnly, fieldBlock('arm_log', {}), {
    target: 'studiox', purpose: 'simulation'
  }).code,
  'arm.log()\n'
);
const noted = {
  type: 'arm_note',
  previousStatement: null,
  nextStatement: null,
  codegen: 'studiox',
  passComment: 'arm note\nnot a second statement',
  python: 'arm.log()\n'
};
assert.strictEqual(
  ExtensionPython.renderExtensionBlock(noted, fieldBlock('arm_note', {}), {
    target: 'portable', purpose: 'export'
  }).code,
  'pass  # arm note not a second statement\n'
);
assert.strictEqual(
  ExtensionPython.renderExtensionBlock(noted, fieldBlock('arm_note', {}), {
    target: 'studiox', purpose: 'execute'
  }).code,
  'arm.log()\n'
);

const hardwareOnly = {
  type: 'pump_on',
  previousStatement: null,
  nextStatement: null,
  hardware: true,
  python: 'pump.start()\n'
};
assert.ok(
  ExtensionPython.renderExtensionBlock(hardwareOnly, fieldBlock('pump_on', {}), {
    target: 'studiox', purpose: 'simulation'
  }).code.indexOf('__studiox_simulation_unsupported') !== -1
);

const wrapped = ExtensionPython.wrapCleanups(
  'import cv2\n\ncap = cv2.VideoCapture(0)\ncap2 = cv2.VideoCapture(1)\n',
  [{ code: 'cap.release()' }, { code: 'cap2.release()' }]
);
assert.ok(wrapped.indexOf('try:') !== -1);
assert.ok(wrapped.indexOf('finally:') !== -1);
assert.ok(wrapped.indexOf('cap2.release()') < wrapped.indexOf('cap.release()'));
assert.ok(wrapped.indexOf('except Exception:') !== -1);
assert.ok(wrapped.indexOf('import cv2') > wrapped.indexOf('try:'));

const functionWrapped = ExtensionPython.wrapCleanups(
  'def take():\n    cap = cv2.VideoCapture(0)\n    return cap\n',
  [{ code: 'cap.release()', scope: 'take' }]
);
assert.ok(functionWrapped.indexOf('def take():') === 0);
assert.ok(functionWrapped.indexOf('try:') > 0);
assert.ok(functionWrapped.indexOf('cap.release()') > functionWrapped.indexOf('try:'));

['js/robotViewer/codeAnalysis.js', 'js/robotViewer/viewTabs.js', 'js/workspace/gcodeExport.js', 'js/blocks/moveRobot.js'].forEach(function (relative) {
  const text = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
  assert.strictEqual(text.indexOf("getElementById('code-preview')"), -1, relative);
  assert.strictEqual(text.indexOf('__studiox_preview'), -1, relative);
});
const previewSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'workspace', 'codePreview.js'), 'utf8');
assert.ok(previewSrc.indexOf("target: 'portable'") !== -1);
assert.strictEqual(previewSrc.indexOf('__studiox_preview'), -1);
const exportSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'workspace', 'gcodeExport.js'), 'utf8');
assert.ok(exportSrc.indexOf("purpose: 'export'") !== -1);
const analysisSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'robotViewer', 'codeAnalysis.js'), 'utf8');
assert.ok(analysisSrc.indexOf("purpose: 'simulation'") !== -1);

console.log('python templates ok');
