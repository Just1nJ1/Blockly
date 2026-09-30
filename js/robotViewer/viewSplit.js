/**
 * Blockly / World layout: exclusive tabs, resizable split, and World pop-out.
 * Persists split orientation + ratio in localStorage.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'studiox.viewLayout';
  var CHANNEL = 'studiox-world-sync';
  var MIN_PANE = 140;

  var contentStage = document.getElementById('content-stage');
  var workspaceArea = document.getElementById('workspace-area');
  var modelArea = document.getElementById('model-area');
  var splitter = document.getElementById('stage-splitter');
  var splitHBtn = document.getElementById('view-split-h');
  var splitVBtn = document.getElementById('view-split-v');
  var popoutBtn = document.getElementById('view-popout');

  var splitMode = null; // null | 'h' | 'v'
  var splitRatio = 0.55;
  var poppedOut = false;
  var dragging = false;
  var dragResizeTimer = null;
  var channel = null;

  function isPopoutWindow() {
    try {
      return new URLSearchParams(location.search).get('worldPopout') === '1';
    } catch (e) {
      return /worldPopout=1/.test(location.search || '');
    }
  }

  function loadSaved() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (data.split === 'h' || data.split === 'v') splitMode = data.split;
      if (typeof data.ratio === 'number' && data.ratio > 0.15 && data.ratio < 0.85) {
        splitRatio = data.ratio;
      }
    } catch (e) { /* ignore */ }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        split: splitMode,
        ratio: splitRatio
      }));
    } catch (e) { /* ignore */ }
  }

  function ipc() {
    try {
      return require('electron').ipcRenderer;
    } catch (e) {
      return null;
    }
  }

  function getChannel() {
    if (channel) return channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    channel = new BroadcastChannel(CHANNEL);
    return channel;
  }

  function post(msg) {
    var ch = getChannel();
    if (ch) ch.postMessage(msg);
  }

  function resizePanes() {
    if (typeof window.ViewTabs === 'object' && window.ViewTabs.resizeBlockly) {
      window.ViewTabs.resizeBlockly();
    }
    window.dispatchEvent(new Event('resize'));
  }

  function applySplitStyles() {
    if (!contentStage) return;
    contentStage.classList.toggle('split-h', splitMode === 'h' && !poppedOut);
    contentStage.classList.toggle('split-v', splitMode === 'v' && !poppedOut);
    contentStage.classList.toggle('world-popped', !!poppedOut);

    if (splitHBtn) splitHBtn.classList.toggle('active', splitMode === 'h' && !poppedOut);
    if (splitVBtn) splitVBtn.classList.toggle('active', splitMode === 'v' && !poppedOut);
    if (popoutBtn) {
      popoutBtn.classList.toggle('active', poppedOut);
      popoutBtn.title = poppedOut ? 'Bring World window to front' : 'Open World in a new window';
    }
    if (splitter) {
      splitter.setAttribute('aria-orientation', splitMode === 'v' ? 'horizontal' : 'vertical');
    }

    if (splitMode && !poppedOut && workspaceArea && modelArea) {
      var primary = splitRatio;
      var secondary = 1 - splitRatio;
      workspaceArea.style.flex = primary + ' 1 0';
      modelArea.style.flex = secondary + ' 1 0';
    } else if (workspaceArea && modelArea) {
      workspaceArea.style.flex = '';
      modelArea.style.flex = '';
    }
  }

  function isBlocklyViewActive() {
    var bv = document.getElementById('blockly-view');
    return !!(bv && bv.classList.contains('active'));
  }

  function applyLayout() {
    applySplitStyles();
    if (typeof window.ViewTabs !== 'object') return;

    if (isPopoutWindow()) {
      window.ViewTabs.showExclusive('world');
      return;
    }
    if (poppedOut) {
      window.ViewTabs.showExclusive('workspace');
      return;
    }
    if (splitMode && isBlocklyViewActive()) {
      window.ViewTabs.showSplit();
      setTimeout(resizePanes, 80);
      setTimeout(resizePanes, 350);
    }
    resizePanes();
  }

  function closePopoutWindow() {
    post({ type: 'close-popout' });
    var el = ipc();
    if (el) {
      el.invoke('world:close-popout').catch(function () { /* ignore */ });
    }
    poppedOut = false;
  }

  function setSplit(mode) {
    if (poppedOut) closePopoutWindow();
    if (splitMode === mode) {
      splitMode = null;
    } else {
      splitMode = mode;
    }
    save();
    applyLayout();
    if (!splitMode && window.ViewTabs) {
      window.ViewTabs.showExclusive('workspace');
    }
  }

  function onSplitterPointerDown(e) {
    if (!splitMode || poppedOut) return;
    dragging = true;
    if (splitter.setPointerCapture) splitter.setPointerCapture(e.pointerId);
    document.body.classList.add('stage-splitting');
    document.body.classList.toggle('stage-splitting-h', splitMode === 'h');
    document.body.classList.toggle('stage-splitting-v', splitMode === 'v');
    e.preventDefault();
  }

  function onSplitterPointerMove(e) {
    if (!dragging || !contentStage) return;
    var rect = contentStage.getBoundingClientRect();
    var ratio;
    if (splitMode === 'h') {
      ratio = (e.clientX - rect.left) / rect.width;
    } else {
      ratio = (e.clientY - rect.top) / rect.height;
    }
    var minR = MIN_PANE / (splitMode === 'h' ? rect.width : rect.height);
    if (!isFinite(minR) || minR <= 0) minR = 0.2;
    if (minR > 0.4) minR = 0.4;
    if (ratio < minR) ratio = minR;
    if (ratio > 1 - minR) ratio = 1 - minR;
    splitRatio = ratio;
    applySplitStyles();
    if (!dragResizeTimer) {
      dragResizeTimer = setTimeout(function () {
        dragResizeTimer = null;
        resizePanes();
      }, 50);
    }
  }

  function onSplitterPointerUp(e) {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('stage-splitting', 'stage-splitting-h', 'stage-splitting-v');
    save();
    resizePanes();
  }

  function snapshotWorld() {
    var WV = window.WorldViewer;
    if (!WV || !WV.isInitialized()) return null;
    var names = WV.getRobotNames() || [];
    var robots = {};
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      robots[n] = {
        joints: WV.getJoints(n),
        pose: WV.getRobotPose ? WV.getRobotPose(n) : null,
        visible: WV.isRobotVisible(n)
      };
    }
    return {
      type: 'snapshot',
      names: names,
      robots: robots,
      selected: WV.getSelectedRobot ? WV.getSelectedRobot() : null
    };
  }

  function applySnapshot(msg) {
    var WV = window.WorldViewer;
    if (!WV || !msg || !msg.names) return;
    var p = WV.syncRobots(msg.names);
    Promise.resolve(p).then(function () {
      var names = msg.names;
      for (var i = 0; i < names.length; i++) {
        var n = names[i];
        var r = msg.robots && msg.robots[n];
        if (!r) continue;
        if (r.pose && WV.setRobotPose) WV.setRobotPose(n, r.pose, { silent: true });
        if (r.joints) WV.setJoints(n, r.joints);
        if (typeof r.visible === 'boolean') WV.setRobotVisible(n, r.visible);
      }
      if (msg.selected && WV.selectRobot) WV.selectRobot(msg.selected);
    });
  }

  function hookWorldBroadcast() {
    var WV = window.WorldViewer;
    if (!WV || WV._viewSplitHooked) return;
    WV._viewSplitHooked = true;

    function wrap(name) {
      var orig = WV[name];
      if (typeof orig !== 'function') return;
      WV[name] = function () {
        var result = orig.apply(WV, arguments);
        if (!isPopoutWindow() && poppedOut) {
          if (name === 'setJoints') {
            post({ type: 'joints', name: arguments[0], angles: arguments[1] });
          } else {
            post(snapshotWorld());
          }
        }
        return result;
      };
    }
    wrap('setJoints');
    wrap('setRobotPose');
    wrap('setRobotVisible');
    wrap('syncRobots');
    wrap('selectRobot');
  }

  function listenChannel() {
    var ch = getChannel();
    if (!ch) return;
    ch.onmessage = function (ev) {
      var msg = ev && ev.data;
      if (!msg || !msg.type) return;
      if (isPopoutWindow()) {
        if (msg.type === 'snapshot') applySnapshot(msg);
        if (msg.type === 'joints' && window.WorldViewer) {
          window.WorldViewer.setJoints(msg.name, msg.angles);
        }
        if (msg.type === 'control-state') applyControlState(msg);
        if (msg.type === 'progress') applyRemoteProgress(msg.state);
        if (msg.type === 'close-popout') {
          window.close();
        }
      } else if (msg.type === 'control') {
        handleRemoteControl(msg.action);
      } else if (msg.type === 'request-snapshot') {
        sendSnapshotWhenReady(0);
      } else if (msg.type === 'request-state') {
        postControlState();
      }
    };
  }

  function postControlState() {
    var WA = window.WorldAnimation;
    if (!WA) return;
    post({
      type: 'control-state',
      playing: WA.isRunning() && !WA.isPaused(),
      paused: WA.isPaused(),
      stopped: !WA.isRunning() && !WA.isPaused(),
      loop: WA.isLoopEnabled()
    });
  }

  function handleRemoteControl(action) {
    var WA = window.WorldAnimation;
    if (!WA) return;
    if (action === 'play') {
      var startWorld = function () {
        if (WA.isPaused()) WA.resume();
        else WA.start();
        postControlState();
      };
      if (typeof window.refreshRecordedMoves === 'function') {
        window.refreshRecordedMoves().then(startWorld).catch(startWorld);
      } else {
        startWorld();
      }
      return;
    }
    if (action === 'pause') WA.pause();
    else if (action === 'stop') WA.stop();
    else if (action === 'loop') WA.setLoop(!WA.isLoopEnabled());
    postControlState();
  }

  function ensurePopoutProgressBar() {
    var canvas = document.getElementById('world-canvas');
    if (!canvas) return null;
    var el = canvas.querySelector('.anim-progress');
    if (el) return el;
    el = document.createElement('div');
    el.className = 'anim-progress';
    el.innerHTML =
      '<div class="anim-progress-label"></div>' +
      '<div class="anim-progress-track"><div class="anim-progress-fill"></div></div>';
    el.style.display = 'none';
    canvas.appendChild(el);
    return el;
  }

  function applyRemoteProgress(state) {
    if (!state) return;
    var el = ensurePopoutProgressBar();
    if (!el) return;
    el.style.display = state.visible ? '' : 'none';
    var label = el.querySelector('.anim-progress-label');
    var fill = el.querySelector('.anim-progress-fill');
    if (label) label.textContent = state.label || '';
    if (fill) {
      fill.style.width = state.width || '0%';
      fill.style.background = state.color || '#32a54e';
    }
  }

  function hookProgressBroadcast() {
    var WA = window.WorldAnimation;
    if (!WA || typeof WA.setOnProgress !== 'function' || WA._viewSplitProgressHooked) {
      return;
    }
    WA._viewSplitProgressHooked = true;
    WA.setOnProgress(function (state) {
      if (!isPopoutWindow() && poppedOut) {
        post({ type: 'progress', state: state });
      }
    });
  }

  function applyControlState(msg) {
    var playBtn = document.getElementById('anim-play-btn');
    var pauseBtn = document.getElementById('anim-pause-btn');
    var stopBtn = document.getElementById('anim-stop-btn');
    var loopBtn = document.getElementById('loop-toggle-btn');
    if (playBtn) {
      playBtn.disabled = !!msg.playing;
      playBtn.classList.toggle('active', !!msg.playing);
    }
    if (pauseBtn) pauseBtn.disabled = !msg.playing;
    if (stopBtn) stopBtn.disabled = !!msg.stopped;
    if (loopBtn) {
      loopBtn.textContent = msg.loop ? 'ON' : 'OFF';
      loopBtn.classList.toggle('active', !!msg.loop);
    }
  }

  function sendSnapshotWhenReady(attempt) {
    var snap = snapshotWorld();
    if (snap) {
      post(snap);
      return;
    }
    if ((attempt || 0) < 12) {
      setTimeout(function () { sendSnapshotWhenReady((attempt || 0) + 1); }, 250);
    }
  }

  function openPopout() {
    if (poppedOut) {
      var focusIpc = ipc();
      if (focusIpc) focusIpc.invoke('world:focus-popout');
      return;
    }
    poppedOut = true;
    if (window.ViewTabs && typeof window.ViewTabs.ensureWorldScene === 'function') {
      window.ViewTabs.ensureWorldScene();
    }
    applyLayout();
    var el = ipc();
    if (el) {
      el.invoke('world:open-popout').then(function () {
        sendSnapshotWhenReady(0);
      }).catch(function () {
        poppedOut = false;
        applyLayout();
      });
      return;
    }
    var url = location.href.split('#')[0];
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'worldPopout=1';
    window.open(url, 'studiox-world', 'width=960,height=720');
    sendSnapshotWhenReady(0);
  }

  function onPopoutClosed() {
    poppedOut = false;
    applyLayout();
  }

  function bindWorldTabDrag() {
    var viewTabs = document.getElementById('view-tabs');
    if (!viewTabs) return;
    var drag = null;

    viewTabs.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var btn = e.target.closest && e.target.closest('.view-tab-btn[data-view="world"]');
      if (!btn || poppedOut) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, btn: btn };
    });

    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (dx * dx + dy * dy > 256) {
        drag.moved = true;
        drag.btn.classList.add('tab-dragging');
      }
      var outside = e.clientY < 0 || e.clientX < 0 ||
        e.clientX > window.innerWidth || e.clientY > window.innerHeight;
      if (drag.moved && outside) {
        drag.btn.classList.remove('tab-dragging');
        drag = null;
        openPopout();
      }
    });

    window.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var info = drag;
      info.btn.classList.remove('tab-dragging');
      drag = null;
      if (!info.moved) return;
      if (Math.abs(e.clientY - info.y) > 48 || Math.abs(e.clientX - info.x) > 96) {
        openPopout();
      }
    });
  }

  function interceptPopoutPlayback() {
    function bind(id, action) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('click', function (e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        post({ type: 'control', action: action });
      }, true);
    }
    bind('anim-play-btn', 'play');
    bind('anim-pause-btn', 'pause');
    bind('anim-stop-btn', 'stop');
    bind('loop-toggle-btn', 'loop');
  }

  function bootPopoutWindow() {
    document.body.classList.add('world-popout');
    var bv = document.getElementById('blockly-view');
    var cv = document.getElementById('command-view');
    if (bv) bv.classList.add('active');
    if (cv) cv.classList.remove('active');
    if (popoutBtn) popoutBtn.style.display = 'none';
    if (splitHBtn) splitHBtn.style.display = 'none';
    if (splitVBtn) splitVBtn.style.display = 'none';
    listenChannel();
    interceptPopoutPlayback();
    ensurePopoutProgressBar();
    setTimeout(function () {
      if (window.ViewTabs) window.ViewTabs.showExclusive('world');
      post({ type: 'request-snapshot' });
    }, 400);
    setTimeout(function () { post({ type: 'request-snapshot' }); }, 1200);
  }

  function init() {
    if (isPopoutWindow()) {
      bootPopoutWindow();
      hookWorldBroadcast();
      return;
    }

    loadSaved();
    listenChannel();
    hookWorldBroadcast();
    hookProgressBroadcast();

    if (splitter) {
      splitter.addEventListener('pointerdown', onSplitterPointerDown);
      window.addEventListener('pointermove', onSplitterPointerMove);
      window.addEventListener('pointerup', onSplitterPointerUp);
    }
    if (splitHBtn) splitHBtn.addEventListener('click', function () { setSplit('h'); });
    if (splitVBtn) splitVBtn.addEventListener('click', function () { setSplit('v'); });
    if (popoutBtn) popoutBtn.addEventListener('click', openPopout);

    bindWorldTabDrag();

    var el = ipc();
    if (el) {
      el.on('world:popout-closed', onPopoutClosed);
    }
    window.addEventListener('storage', function () { /* ignore */ });

    if (splitMode) {
      setTimeout(applyLayout, 600);
    } else {
      applySplitStyles();
    }
  }

  window.ViewSplit = {
    isSplit: function () { return !!splitMode && !poppedOut; },
    isPoppedOut: function () { return !!poppedOut; },
    isPopoutWindow: isPopoutWindow,
    getMode: function () { return splitMode; },
    setSplit: setSplit,
    refresh: applyLayout,
    openPopout: openPopout,
    onTabClick: function (view) {
      if (poppedOut && view === 'world') {
        var el = ipc();
        if (el) el.invoke('world:focus-popout');
        return true;
      }
      if (splitMode && !poppedOut) {
        applyLayout();
        return true;
      }
      return false;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
