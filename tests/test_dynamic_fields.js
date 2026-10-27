const assert = require('assert');
const fields = require('../js/extensions/dynamicFields.js');

const calls = [];
global.fetch = function (url) {
  calls.push(url);
  const payload = url.indexOf('/ext/camera/') >= 0
    ? { cameras: [{ name: 'FaceTime', id: 0 }, { name: '', id: '' }, { name: 'Dup', id: 0 }] }
    : { ports: [{ name: 'A', id: 'a' }, { name: 'B', id: 'b' }] };
  return Promise.resolve({ json: function () { return Promise.resolve(payload); } });
};
global.getServerUrl = function () { return 'http://127.0.0.1:5080'; };

fields.register('camera', 'devices', {
  kind: 'httpOptions',
  path: '/cameras',
  refreshPath: '/cameras?refresh=1',
  itemsKey: 'cameras',
  labelKey: 'name',
  valueKey: 'id',
  refresh: 'onOpen',
  cacheMs: 20000
});
fields.register('test-device', 'ports', {
  kind: 'httpOptions',
  path: '/ports',
  refreshPath: '/ports?refresh=1',
  itemsKey: 'ports',
  labelKey: 'name',
  valueKey: 'id',
  refresh: 'onOpen',
  cacheMs: 20000
});

fields.refresh('camera', 'devices', { explicit: false }).then(function (cameraOpts) {
  return fields.refresh('test-device', 'ports', { explicit: false }).then(function (ports) {
    return fields.refresh('camera', 'devices', { explicit: false }).then(function () {
      assert.deepStrictEqual(cameraOpts, [['FaceTime', '0']]);
      assert.deepStrictEqual(ports, [['A', 'a'], ['B', 'b']]);
      assert.strictEqual(calls.filter(function (url) { return url.indexOf('/ext/camera/cameras?refresh=1') >= 0; }).length, 1);
      assert.ok(calls.some(function (url) { return url.indexOf('/ext/test-device/ports?refresh=1') >= 0; }));
      assert.strictEqual(calls.length, 2);
      console.log('dynamic fields ok');
    });
  });
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
