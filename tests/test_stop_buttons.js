/**
 * Program Stop and Emergency Stop send different abort reasons.
 * A normal stop is a system line. An emergency stop keeps its own notice.
 * A Python exception stays a red error.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fail(message) {
  console.error(message);
  process.exit(1);
}

function createEl(tag) {
  const el = {
    tag: tag,
    className: '',
    textContent: '',
    disabled: false,
    title: '',
    value: '',
    children: [],
    style: {},
    classList: { add: function () {}, remove: function () {} },
    appendChild: function (child) { this.children.push(child); },
    addEventListener: function () {},
    querySelector: function (sel) {
      if (sel === '.toolbar-btn-label') return this.label;
      return null;
    },
    label: { textContent: '' },
  };
  return el;
}

const log = {
  className: 'console-log',
  children: [],
  scrollTop: 0,
  innerHTML: '',
  appendChild: function (child) { this.children.push(child); },
};
const input = createEl('input');
input.id = 'console-input';
const inputRow = createEl('div');
const prompt = createEl('span');
const content = {
  id: 'output-content',
  classList: { add: function () {} },
  innerHTML: '',
  querySelector: function (sel) {
    if (sel === '.console-log') return log;
    if (sel === '#console-input') return input;
    if (sel === '.console-input-row') return inputRow;
    if (sel === '.console-prompt') return prompt;
    return null;
  },
};
const runBtn = createEl('button');
const stopBtn = createEl('button');
stopBtn.disabled = true;

const calls = [];
function fakeFetch(url, opts) {
  calls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
  return Promise.resolve({
    ok: true,
    status: 200,
    json: function () { return Promise.resolve({ success: true }); },
  });
}

function FakeSource() {
  this.readyState = 1;
  this.close = function () { this.readyState = 2; };
}

const context = {
  document: {
    readyState: 'complete',
    getElementById: function (id) {
      if (id === 'output-content') return content;
      if (id === 'runBtn') return runBtn;
      if (id === 'stopProgramBtn') return stopBtn;
      if (id === 'console-input') return input;
      return null;
    },
    createElement: createEl,
    addEventListener: function () {},
  },
  fetch: fakeFetch,
  AbortSignal: AbortSignal,
  EventSource: { CLOSED: 2 },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  window: {},
};
vm.createContext(context);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'workspace', 'execution.js'), 'utf8'),
  context,
);

function lines() {
  return log.children.map(function (line) {
    return { type: line.className, text: line.textContent };
  });
}

function hasError(text) {
  return lines().some(function (line) {
    return line.type.indexOf('output-error') !== -1 && line.text.indexOf(text) !== -1;
  });
}

function hasSystem(text) {
  return lines().some(function (line) {
    return line.type.indexOf('output-system') !== -1 && line.text.indexOf(text) !== -1;
  });
}

async function testNormalStop() {
  calls.length = 0;
  log.children.length = 0;
  context._execRunning = true;
  context._execStopping = false;
  context._execSessionId = 'sess-stop';
  context._execEventSource = new FakeSource();
  const pending = context.stopRunningProgram();
  await Promise.resolve();
  await pending;
  const abort = calls.filter(function (call) { return call.url.indexOf('/execute/abort') !== -1; });
  if (abort.length !== 1 || abort[0].body.reason !== 'stop') {
    fail('Stop did not send reason stop: ' + JSON.stringify(calls));
  }
  if (hasError('Execution aborted') || hasError('emergency')) {
    fail('normal Stop showed an error before the program finished: ' + JSON.stringify(lines()));
  }
  context.handleExecEvent({ type: 'done', success: false, reason: 'stop', data: '' });
  if (!hasSystem('— Program stopped —')) {
    fail('normal Stop did not show the system message: ' + JSON.stringify(lines()));
  }
  if (hasError('Execution aborted') || hasError('emergency') || hasError('Program stopped')) {
    fail('normal Stop was reported as an error: ' + JSON.stringify(lines()));
  }
  if (context._execRunning) fail('Run was left disabled-running after normal Stop');
}

async function testEmergencyStop() {
  calls.length = 0;
  log.children.length = 0;
  context._execRunning = true;
  context._execStopping = false;
  context._execSessionId = 'sess-estop';
  context._execEventSource = new FakeSource();
  const pending = context.stopAllRobots();
  await Promise.resolve();
  await pending;
  const cancel = calls.filter(function (call) { return call.url.indexOf('/cmd/cancel') !== -1; });
  const abort = calls.filter(function (call) { return call.url.indexOf('/execute/abort') !== -1; });
  if (cancel.length !== 1) fail('Emergency Stop did not cancel the robot');
  if (abort.length !== 1 || abort[0].body.reason !== 'emergency') {
    fail('Emergency Stop did not send reason emergency: ' + JSON.stringify(calls));
  }
  if (!hasError('EMERGENCY STOP')) {
    fail('Emergency Stop lost its notification: ' + JSON.stringify(lines()));
  }
  context.handleExecEvent({ type: 'done', success: false, reason: 'emergency', data: '' });
  if (hasError('Execution aborted by emergency stop')) {
    fail('Emergency Stop added the Python abort error: ' + JSON.stringify(lines()));
  }
  if (hasSystem('— Program stopped —')) {
    fail('Emergency Stop was labeled as a normal program stop');
  }
  if (!hasError('EMERGENCY STOP')) {
    fail('emergency notification disappeared after done');
  }
}

function testPythonError() {
  log.children.length = 0;
  context._execRunning = true;
  context._execStopping = false;
  context.handleExecEvent({ type: 'error', data: 'boom' });
  context.handleExecEvent({ type: 'done', success: false, data: '' });
  if (!hasError('Error: boom')) fail('Python exception was not shown as an error: ' + JSON.stringify(lines()));
  if (hasSystem('— Program stopped —')) fail('Python exception was labeled as a normal stop');
  if (hasError('Execution aborted')) fail('Python exception was labeled as an abort');
}

(async function () {
  await testNormalStop();
  await testEmergencyStop();
  testPythonError();
  console.log('stop buttons ok');
})().catch(function (err) {
  fail(err && err.stack ? err.stack : String(err));
});
