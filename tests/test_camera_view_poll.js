/**
 * Sequential preview polling. A slow /preview-frames response must not be
 * dropped, and two polls must not be in flight together.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function createEl(tag) {
  const el = {
    tag: tag,
    children: [],
    style: {},
    dataset: {},
    attrs: {},
    className: '',
    textContent: '',
    parent: null,
    setAttribute: function (key, value) { this.attrs[key] = value; },
    getAttribute: function (key) { return this.attrs[key]; },
    appendChild: function (child) {
      this.children.push(child);
      child.parent = this;
    },
    querySelector: function (sel) {
      if (sel === 'span' || sel === 'img') {
        for (var i = 0; i < this.children.length; i++) {
          if (this.children[i].tag === sel) return this.children[i];
        }
        return null;
      }
      var slotMatch = /^\[data-slot="([^"]+)"\]$/.exec(sel);
      if (slotMatch) {
        for (var j = 0; j < this.children.length; j++) {
          if (this.children[j].dataset && this.children[j].dataset.slot === slotMatch[1]) {
            return this.children[j];
          }
        }
      }
      return null;
    },
    querySelectorAll: function (sel) {
      if (sel === '.camera-slot') {
        return this.children.filter(function (child) {
          return child.className === 'camera-slot';
        });
      }
      return [];
    },
    remove: function () {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter(function (child) {
        return child !== this;
      }, this);
    },
  };
  var html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: function () { return html; },
    set: function (value) {
      html = String(value);
      el.children = [];
      if (html.indexOf('<span') !== -1) {
        el.appendChild(createEl('span'));
        el.appendChild(createEl('img'));
      }
    },
  });
  return el;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const grid = createEl('div');
const empty = createEl('div');
const document = {
  getElementById: function (id) {
    if (id === 'camera-preview-grid') return grid;
    if (id === 'camera-empty') return empty;
    return null;
  },
  createElement: createEl,
};

let active = 0;
let maxActive = 0;
let rev = 0;
const fetches = [];

function fakeFetch() {
  active += 1;
  if (active > maxActive) maxActive = active;
  const mine = ++rev;
  const started = Date.now();
  fetches.push(started);
  return new Promise(function (resolve) {
    setTimeout(function () {
      active -= 1;
      if (mine === 1) {
        resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              success: true,
              rev: 1,
              frames: [{ slot: 1, image: 'frame-a' }],
              error: '',
            });
          },
        });
        return;
      }
      if (mine === 2) {
        resolve({
          ok: true,
          status: 200,
          json: function () {
            return Promise.resolve({
              success: true,
              rev: 2,
              frames: [{ slot: 1, image: 'frame-b' }],
              error: 'OpenCV encode failed',
            });
          },
        });
        return;
      }
      resolve({
        ok: true,
        status: 200,
        json: function () {
          return Promise.resolve({
            success: true,
            rev: mine,
            frames: [{ slot: 1, image: 'frame-' + mine }],
            error: '',
          });
        },
      });
    }, 150);
  });
}

const context = {
  window: {},
  document: document,
  fetch: fakeFetch,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  console: console,
};
context.window = context;
vm.runInContext(
  fs.readFileSync(path.join(__dirname, '..', 'js', 'ui', 'cameraView.js'), 'utf8'),
  vm.createContext(context),
);

const view = context.CameraView || context.window.CameraView;
if (!view) fail('CameraView was not installed');

view.arm();

// Request 1 occupies 0–150ms, then 100ms gap, request 2 occupies 250–400ms.
setTimeout(function () {
  if (maxActive !== 1) fail('overlapping polls: ' + maxActive);
  if (fetches.length < 2) fail('slow responses were dropped; fetches=' + fetches.length);
  const cell = grid.children[0];
  const image = cell && cell.querySelector('img');
  if (!image || image.getAttribute('data-src') !== 'data:image/jpeg;base64,frame-b') {
    fail('preview did not advance to the latest frame: ' + (image && image.getAttribute('data-src')));
  }
  if (empty.textContent !== 'OpenCV encode failed' || empty.style.display === 'none') {
    fail('encode error was hidden by a cached frame: ' + empty.textContent);
  }
  view.arm();
  const cleared = grid.children.length === 0 && empty.textContent.indexOf('Waiting') === 0;
  if (!cleared) fail('arm() did not clear the previous frame');
  view.stop();
  const stoppedAt = fetches.length;
  setTimeout(function () {
    if (fetches.length > stoppedAt) {
      fail('stop() left polling running: ' + fetches.length + ' after ' + stoppedAt);
    }
    console.log('camera view poll ok (' + stoppedAt + ' requests, max in flight ' + maxActive + ')');
  }, 500);
}, 450);
