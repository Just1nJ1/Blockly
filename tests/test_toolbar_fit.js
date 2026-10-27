/**
 * A narrow toolbar hides trailing controls and leaves emergency stop visible.
 */
const fit = require('../js/ui/toolbarFit.js');
const fitToolbar = fit.fitToolbar;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function child(name, width, opts) {
  opts = opts || {};
  const el = {
    name: name,
    width: width,
    offsetWidth: width,
    hidden: false,
    attrs: {},
    classList: {
      contains: function (cls) { return (opts.classes || []).indexOf(cls) !== -1; },
    },
    getAttribute: function (key) { return this.attrs[key] || null; },
    setAttribute: function (key, value) { this.attrs[key] = value; },
    removeAttribute: function (key) { delete this.attrs[key]; },
  };
  return el;
}

function bar(children, clientWidth) {
  const node = {
    clientWidth: clientWidth,
    children: children,
    get scrollWidth() {
      return children.reduce(function (sum, el) {
        return sum + (el.hidden ? 0 : el.width);
      }, 0);
    },
  };
  return node;
}

const save = child('save', 56);
const run = child('run', 56);
const clear = child('clear', 56);
const flex = child('flex', 0, { classes: ['toolbar-flex'] });
const estop = child('estop', 56, { classes: ['toolbar-keep'] });
// Emergency stop sits beside this row, so the fitted width does not include it.
const toolbar = bar([save, run, clear, flex], 120);

fitToolbar(toolbar);

if (estop.hidden) fail('emergency stop was hidden');
if (!clear.hidden) fail('a trailing button should hide before emergency stop');
if (toolbar.scrollWidth > toolbar.clientWidth + 1) {
  fail('toolbar still overflows: ' + toolbar.scrollWidth);
}

// Wider than the buttons: nothing stays hidden.
toolbar.clientWidth = 400;
fitToolbar(toolbar);
if (save.hidden || run.hidden || clear.hidden || estop.hidden) {
  fail('wide toolbar hid a button');
}

console.log('toolbar fit ok');
