const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
assert.strictEqual(mainSrc.indexOf('resetRuntimeOnNewInstall'), -1);
assert.strictEqual(mainSrc.indexOf('.install-id'), -1);
assert.strictEqual(mainSrc.indexOf("rmSync(dir, { recursive: true, force: true })"), -1);

global.document = {
  readyState: 'complete',
  getElementById: function() { return null; },
  addEventListener: function() {},
  querySelectorAll: function() { return []; }
};
global.window = global;
const exec = require('../js/workspace/execution.js');

assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'error', data: 'boom' }), true);
assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'done', success: true }), false);
assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'done', success: false, reason: 'stop' }), false);
assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'done', success: false, reason: 'emergency' }), false);
assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'stderr', data: 'warning' }), false);
assert.strictEqual(exec.shouldRevealExecutionFailure({ type: 'stdout', data: 'ok' }), false);
assert.strictEqual(exec.shouldRevealExecutionFailure(null), false);

const buttons = [
  { dataset: { panel: 'control-panel' }, classList: { classes: [] } },
  { dataset: { panel: 'code-output' }, classList: { classes: [] } }
];
buttons.forEach(function(btn) {
  btn.classList.add = function(name) { if (this.classes.indexOf(name) < 0) this.classes.push(name); };
  btn.classList.remove = function(name) { this.classes = this.classes.filter(function(item) { return item !== name; }); };
  btn.classList.toggle = function(name, on) { if (on) this.add(name); else this.remove(name); };
});
const panels = {
  'panel-content-control-panel': { classList: { classes: ['active'] } },
  'panel-content-code-output': { classList: { classes: [] } }
};
Object.keys(panels).forEach(function(id) {
  panels[id].classList.add = buttons[0].classList.add;
  panels[id].classList.remove = buttons[0].classList.remove;
});
let refreshed = 0;
global.document.querySelectorAll = function(selector) {
  if (selector.indexOf('.panel-tab-btn') >= 0) return buttons;
  if (selector.indexOf('.panel-tab-content') >= 0) return Object.keys(panels).map(function(id) { return panels[id]; });
  return [];
};
global.document.getElementById = function(id) { return panels[id] || null; };
global.window.controlPanelCheckAndRefresh = function() { refreshed += 1; };

const tabs = require('../js/workspace/savedFunctions.js');
tabs.showOutputPanel('code-output');
assert.deepStrictEqual(buttons[1].classList.classes, ['active']);
assert.deepStrictEqual(buttons[0].classList.classes, []);
assert.ok(panels['panel-content-code-output'].classList.classes.indexOf('active') >= 0);
assert.strictEqual(panels['panel-content-control-panel'].classList.classes.indexOf('active'), -1);
assert.strictEqual(refreshed, 0);
tabs.showOutputPanel('control-panel');
assert.strictEqual(refreshed, 1);

const debugSrc = fs.readFileSync(path.join(root, 'js/workspace/debugExecution.js'), 'utf8');
const stopFn = debugSrc.slice(debugSrc.indexOf('async function debugStop'), debugSrc.indexOf('// ── Internal helpers'));
assert.strictEqual(stopFn.indexOf('revealExecutionError'), -1);
assert.ok(debugSrc.indexOf('if (state.error)') !== -1);
assert.ok(debugSrc.indexOf('revealExecutionError()') !== -1);

const runSrc = fs.readFileSync(path.join(root, 'js/workspace/execution.js'), 'utf8');
const stopProgram = runSrc.slice(runSrc.indexOf('async function stopRunningProgram'), runSrc.indexOf('async function stopAllRobots'));
assert.strictEqual(stopProgram.indexOf('revealExecutionError'), -1);

console.log('execution error tab ok');
