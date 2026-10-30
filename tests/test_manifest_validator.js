const assert = require('assert');
const validator = require('../js/extensions/manifestValidator.js');

const camera = {
  name: 'camera',
  displayName: 'Camera',
  version: '1.0.0',
  permissions: ['camera'],
  contributes: { backend: { main: 'backend/main.py' } },
};

const legacy = validator.validateManifest(camera, { directoryName: 'camera' });
assert.strictEqual(legacy.ok, true, legacy.errors.join('; '));
assert.strictEqual(legacy.normalized.manifestVersion, 1);

const future = validator.validateManifest(
  Object.assign({}, camera, { manifestVersion: 2, extensionApiVersion: 99 }),
  { directoryName: 'camera' }
);
assert.strictEqual(future.ok, false);
assert.ok(future.errors.some(function (error) { return error.indexOf('API version') >= 0; }));

const badPerm = validator.validateManifest(
  Object.assign({}, camera, { permissions: ['nope'] }),
  { directoryName: 'camera' }
);
assert.strictEqual(badPerm.ok, false);

const blocklyDeps = validator.validateManifest(Object.assign({}, camera, {
  pythonDependencies: { blockly: ['opencv-python>=4.8'] },
}), { directoryName: 'camera' });
assert.strictEqual(blocklyDeps.ok, true, blocklyDeps.errors.join('; '));
assert.deepStrictEqual(
  validator.blocklyRequirements(blocklyDeps.normalized).lines,
  ['opencv-python>=4.8']
);

const unsafeDeps = validator.validateManifest(Object.assign({}, camera, {
  pythonDependencies: { blockly: ['-r other.txt'] },
}), { directoryName: 'camera' });
assert.strictEqual(unsafeDeps.ok, false);

const escape = validator.validateManifest({
  name: 'badext',
  version: '1.0.0',
  contributes: { backend: { main: '../secret.py' } },
}, { directoryName: 'badext', root: '/tmp/extensions/badext' });
assert.strictEqual(escape.ok, false);

console.log('manifest validator ok');
