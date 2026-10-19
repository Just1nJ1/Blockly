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
  var ALL_VIEWS = ['workspace', 'world', 'camera'];
  var VIEW_LABELS = { workspace: 'Blockly', world: 'World', camera: 'Camera' };
  // One group when a single pane is showing. Two groups when docked:
  // each group is the tabs that live in that pane.
  var paneGroups = [{ views: ALL_VIEWS.slice(), active: 'workspace' }];
  var poppedOut = false;
  var dragging = false;
  var dragResizeTimer = null;
  var channel = null;

  var detached = {};
  var detachedWorkspaceXml = '';

  function popoutViewName() {
    try {
      var q = new URLSearchParams(location.search);
      if (q.get('viewPopout')) return q.get('viewPopout');
      if (q.get('worldPopout') === '1') return 'world';
    } catch (e) { /* ignore */ }
    if (/(?:^|[?&])worldPopout=1(?:&|$)/.test(location.search || '')) return 'world';
    return null;
  }

  function isPopoutWindow() {
    return !!popoutViewName();
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
      if (data.panes && data.panes.length) {
        paneGroups = data.panes;
      } else if (splitMode) {
        paneGroups = [
          { views: ['workspace'], active: 'workspace' },
          { views: ['world', 'camera'], active: 'world' }
        ];
      }
      ensureViewsPresent();
    } catch (e) { /* ignore */ }
  }

  function ensureViewsPresent() {
    if (!paneGroups.length || !paneGroups[0] || !paneGroups[0].views) {
      paneGroups = [{ views: [], active: null }];
    }
    var present = {};
    for (var i = 0; i < paneGroups.length; i++) {
      var views = paneGroups[i].views || [];
      paneGroups[i].views = views;
      for (var j = 0; j < views.length; j++) present[views[j]] = true;
    }
    for (var k = 0; k < ALL_VIEWS.length; k++) {
      var view = ALL_VIEWS[k];
      if (detached[view] || present[view]) continue;
      paneGroups[0].views.push(view);
      if (!paneGroups[0].active) paneGroups[0].active = view;
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        split: splitMode,
        ratio: splitRatio,
        panes: paneGroups
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

    layoutDockPanes();
  }

  function paneEl(view) {
    if (view === 'workspace') return workspaceArea;
    if (view === 'world') return modelArea;
    if (view === 'camera') return document.getElementById('camera-area');
    return null;
  }

  function ensurePaneDom() {
    if (!contentStage || document.getElementById('pane-0')) return;
    var overlay = document.getElementById('dock-overlay');
    function make(id) {
      var sec = document.createElement('section');
      sec.id = id;
      sec.className = 'view-pane';
      sec.innerHTML = '<div class="pane-tabbar"></div><div class="pane-host"></div>';
      return sec;
    }
    var pane0 = make('pane-0');
    var pane1 = make('pane-1');
    contentStage.insertBefore(pane0, contentStage.firstChild);
    if (splitter) contentStage.insertBefore(splitter, overlay || null);
    contentStage.insertBefore(pane1, overlay || null);
  }

  function paneHost(index) {
    var pane = document.getElementById('pane-' + index);
    return pane ? pane.querySelector('.pane-host') : null;
  }

  function paneBar(index) {
    var pane = document.getElementById('pane-' + index);
    return pane ? pane.querySelector('.pane-tabbar') : null;
  }

  function layoutDockPanes() {
    if (isPopoutWindow() || !contentStage) return;
    ensureViewsPresent();
    ensurePaneDom();
    var two = !!(splitMode && paneGroups.length > 1);
    var pane0 = document.getElementById('pane-0');
    var pane1 = document.getElementById('pane-1');
    if (pane0) {
      pane0.classList.add('pane-open');
      pane0.style.flex = two ? (splitRatio + ' 1 0') : '1 1 auto';
      pane0.style.order = '0';
    }
    if (pane1) {
      pane1.classList.toggle('pane-open', two);
      pane1.style.flex = two ? ((1 - splitRatio) + ' 1 0') : '';
      pane1.style.order = '2';
    }
    if (splitter) splitter.style.order = '1';

    var shown = {};
    var count = two ? 2 : 1;
    var groups = two ? paneGroups : [paneGroups[0] || { views: ALL_VIEWS.slice(), active: 'workspace' }];
    for (var i = 0; i < count; i++) {
      var group = groups[i];
      if (!group || !group.views || !group.views.length) continue;
      if (group.views.indexOf(group.active) < 0) group.active = group.views[0];
      var bar = paneBar(i);
      var host = paneHost(i);
      if (bar) {
        bar.innerHTML = '';
        for (var t = 0; t < group.views.length; t++) {
          var view = group.views[t];
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'view-tab-btn' + (view === group.active ? ' active' : '');
          btn.dataset.view = view;
          btn.dataset.pane = String(i);
          btn.textContent = VIEW_LABELS[view] || view;
          bar.appendChild(btn);
        }
      }
      if (!host) continue;
      for (var v = 0; v < group.views.length; v++) {
        var name = group.views[v];
        var el = paneEl(name);
        if (!el) continue;
        if (el.parentNode !== host) host.appendChild(el);
        var on = name === group.active;
        el.style.display = on ? 'flex' : 'none';
        el.classList.toggle('hidden', !on);
        if (name === 'world') el.classList.toggle('visible', on);
        shown[name] = shown[name] || on;
      }
    }
    for (var hidden = 0; hidden < ALL_VIEWS.length; hidden++) {
      var hiddenName = ALL_VIEWS[hidden];
      if (shown[hiddenName]) continue;
      var hiddenEl = paneEl(hiddenName);
      if (!hiddenEl) continue;
      hiddenEl.style.display = 'none';
      hiddenEl.classList.add('hidden');
      if (hiddenName === 'world') hiddenEl.classList.remove('visible');
    }
    if (window.ViewTabs && window.ViewTabs.showWorldSurface) {
      if (shown.world) window.ViewTabs.showWorldSurface();
      else window.ViewTabs.hideWorldSurface();
    }
    if (shown.camera && window.CameraView) window.CameraView.start();
    if (shown.workspace && window.ViewTabs && window.ViewTabs.resizeBlockly) {
      window.ViewTabs.resizeBlockly();
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
    if (!isPopoutWindow()) {
      layoutDockPanes();
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
      paneGroups = [{ views: ALL_VIEWS.slice(), active: 'workspace' }];
    } else {
      splitMode = mode;
      paneGroups = [
        { views: ['workspace'], active: 'workspace' },
        { views: ['world', 'camera'], active: 'world' }
      ];
    }
    save();
    applyLayout();
  }

  function findPane(view) {
    for (var i = 0; i < paneGroups.length; i++) {
      if (paneGroups[i].views.indexOf(view) >= 0) return i;
    }
    return -1;
  }

  function placeView(view, destIndex, insertAt) {
    var src = findPane(view);
    if (src < 0 || !paneGroups[src]) return;
    var srcGroup = paneGroups[src];
    var from = srcGroup.views.indexOf(view);
    if (src === destIndex) {
      var to = insertAt;
      if (to > from) to -= 1;
      if (to < 0) to = 0;
      if (to > srcGroup.views.length - 1) to = srcGroup.views.length - 1;
      if (to !== from) {
        srcGroup.views.splice(from, 1);
        srcGroup.views.splice(to, 0, view);
      }
      srcGroup.active = view;
      save();
      applyLayout();
      return;
    }
    srcGroup.views.splice(from, 1);
    if (srcGroup.active === view) srcGroup.active = srcGroup.views[0] || null;
    if (!srcGroup.views.length) {
      paneGroups.splice(src, 1);
      if (destIndex > src) destIndex -= 1;
      if (paneGroups.length < 2) splitMode = null;
    }
    var dest = paneGroups[destIndex];
    if (!dest) return;
    if (insertAt < 0 || insertAt > dest.views.length) insertAt = dest.views.length;
    dest.views.splice(insertAt, 0, view);
    dest.active = view;
    save();
    applyLayout();
  }

  function dockView(view, edge) {
    var rest = [];
    var restActive = null;
    for (var i = 0; i < paneGroups.length; i++) {
      var group = paneGroups[i];
      for (var j = 0; j < group.views.length; j++) {
        if (group.views[j] === view) continue;
        rest.push(group.views[j]);
        if (group.views[j] === group.active) restActive = group.views[j];
      }
    }
    if (!rest.length) return;
    if (!restActive || rest.indexOf(restActive) < 0) restActive = rest[0];
    var solo = { views: [view], active: view };
    var others = { views: rest, active: restActive };
    var axis = (edge === 'left' || edge === 'right') ? 'h' : 'v';
    if (edge === 'left' || edge === 'top') paneGroups = [solo, others];
    else paneGroups = [others, solo];
    splitMode = axis;
    if (poppedOut) closePopoutWindow();
    save();
    applyLayout();
  }

  function activatePaneView(index, view) {
    if (!paneGroups[index] || paneGroups[index].views.indexOf(view) < 0) return;
    paneGroups[index].active = view;
    save();
    applyLayout();
  }

  function edgeAt(e) {
    if (!contentStage) return null;
    var rect = contentStage.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    var band = Math.min(110, Math.min(rect.width, rect.height) * 0.3);
    var hits = [];
    if (x < band) hits.push({ edge: 'left', d: x });
    if (rect.width - x < band) hits.push({ edge: 'right', d: rect.width - x });
    if (y < band) hits.push({ edge: 'top', d: y });
    if (rect.height - y < band) hits.push({ edge: 'bottom', d: rect.height - y });
    if (!hits.length) return null;
    hits.sort(function (a, b) { return a.d - b.d; });
    return hits[0].edge;
  }

  function showDockOverlay(edge) {
    var overlay = document.getElementById('dock-overlay');
    if (!overlay) return;
    overlay.hidden = !edge;
    var zones = overlay.querySelectorAll('.dock-zone');
    for (var i = 0; i < zones.length; i++) {
      zones[i].classList.toggle('active', zones[i].dataset.edge === edge);
    }
  }

  function clearTabDrop() {
    var bars = document.querySelectorAll('.pane-tabbar');
    for (var i = 0; i < bars.length; i++) {
      bars[i].classList.remove('drop-target', 'drop-end');
    }
    var btns = document.querySelectorAll('.pane-tabbar .view-tab-btn');
    for (var j = 0; j < btns.length; j++) btns[j].classList.remove('drop-before');
  }

  function dropTarget(e) {
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var bar = el && el.closest && el.closest('.pane-tabbar');
    if (bar) {
      var pane = bar.closest('.view-pane');
      var index = pane && pane.id === 'pane-1' && splitMode ? 1 : 0;
      var buttons = bar.querySelectorAll('.view-tab-btn');
      var insertAt = buttons.length;
      for (var i = 0; i < buttons.length; i++) {
        var rect = buttons[i].getBoundingClientRect();
        if (e.clientX < rect.left + rect.width / 2) {
          insertAt = i;
          break;
        }
      }
      return { type: 'tabs', pane: index, index: insertAt };
    }
    var edge = edgeAt(e);
    if (edge) return { type: 'edge', edge: edge };
    var host = el && el.closest && el.closest('.view-pane');
    if (host) {
      var index2 = host.id === 'pane-1' && splitMode ? 1 : 0;
      var group = paneGroups[index2];
      return { type: 'tabs', pane: index2, index: group ? group.views.length : 0 };
    }
    return null;
  }

  function showDrop(target) {
    clearTabDrop();
    showDockOverlay(null);
    if (!target) return;
    if (target.type === 'edge') {
      showDockOverlay(target.edge);
      return;
    }
    var bar = paneBar(target.pane);
    if (!bar) return;
    bar.classList.add('drop-target');
    var buttons = bar.querySelectorAll('.view-tab-btn');
    if (target.index < buttons.length) buttons[target.index].classList.add('drop-before');
    else bar.classList.add('drop-end');
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
        if (!isPopoutWindow() && detached.world) {
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
        if (msg.type === 'workspace-xml' && msg.from === 'main') {
          restoreWorkspaceXml(msg.xml);
        }
        if (msg.type === 'request-workspace') {
          post({ type: 'workspace-xml', xml: currentWorkspaceXml(), from: 'popout' });
        }
      } else if (msg.type === 'control') {
        handleRemoteControl(msg.action);
      } else if (msg.type === 'request-snapshot') {
        sendSnapshotWhenReady(0);
      } else if (msg.type === 'request-state') {
        postControlState();
      } else if (msg.type === 'request-workspace') {
        post({ type: 'workspace-xml', xml: detachedWorkspaceXml, from: 'main' });
      } else if (msg.type === 'workspace-xml' && msg.from === 'popout') {
        detachedWorkspaceXml = msg.xml || '';
        if (findPane('workspace') >= 0) restoreWorkspaceXml(detachedWorkspaceXml);
      }
    };
  }

  function currentWorkspaceXml() {
    try {
      var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
      if (!ws || !window.Blockly) return '';
      return Blockly.Xml.domToText(Blockly.Xml.workspaceToDom(ws));
    } catch (e) {
      return '';
    }
  }

  function restoreWorkspaceXml(xml) {
    if (!xml) return;
    try {
      var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
      if (!ws || !window.Blockly) return;
      ws.clear();
      Blockly.Xml.domToWorkspace(Blockly.Xml.textToDom(xml), ws);
    } catch (e) { /* ignore */ }
  }

  function detachView(view) {
    if (detached[view]) {
      openViewPopout(view);
      return;
    }
    var src = findPane(view);
    if (src < 0) return;
    var group = paneGroups[src];
    var at = group.views.indexOf(view);
    if (at >= 0) group.views.splice(at, 1);
    if (group.active === view) group.active = group.views[0] || null;
    if (!group.views.length) {
      paneGroups.splice(src, 1);
      if (paneGroups.length < 2) splitMode = null;
    }
    if (!paneGroups.length) {
      paneGroups = [{ views: [], active: null }];
      splitMode = null;
    }
    if (view === 'workspace') detachedWorkspaceXml = currentWorkspaceXml();
    detached[view] = true;
    save();
    applyLayout();
    openViewPopout(view);
  }

  function restoreView(view) {
    if (!view || detached[view] === false) return;
    delete detached[view];
    if (findPane(view) < 0) {
      if (!paneGroups.length || !paneGroups[0] || !paneGroups[0].views) {
        paneGroups = [{ views: [], active: null }];
      }
      paneGroups[0].views.push(view);
      paneGroups[0].active = view;
    }
    if (view === 'workspace') restoreWorkspaceXml(detachedWorkspaceXml);
    save();
    applyLayout();
  }

  function openViewPopout(view) {
    var el = ipc();
    if (el) {
      el.invoke('view:open-popout', view).catch(function () {
        restoreView(view);
      });
      return;
    }
    var url = location.href.split('#')[0];
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'viewPopout=' + encodeURIComponent(view);
    if (view === 'world') url += '&worldPopout=1';
    window.open(url, 'studiox-view-' + view, 'width=960,height=720');
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
      if (!isPopoutWindow() && detached.world) {
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

  function onPopoutClosed(view) {
    poppedOut = false;
    restoreView(view || 'world');
  }

  function bindWorldTabDrag() {
    if (!contentStage) return;
    var drag = null;
    var suppressClick = false;

    contentStage.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('.pane-tabbar .view-tab-btn');
      if (suppressClick) {
        suppressClick = false;
        if (btn) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }
      if (!btn) return;
      activatePaneView(Number(btn.dataset.pane), btn.dataset.view);
    });

    contentStage.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      var btn = e.target.closest && e.target.closest('.view-tab-btn');
      if (!btn) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, btn: btn, view: btn.dataset.view };
    });

    window.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x;
      var dy = e.clientY - drag.y;
      if (dx * dx + dy * dy > 36) {
        drag.moved = true;
        drag.btn.classList.add('tab-dragging');
      }
      if (!drag.moved) return;
      if (pointerOutside(e)) showDrop(null);
      else showDrop(dropTarget(e));
    });

    window.addEventListener('pointerup', function (e) {
      if (!drag) return;
      var info = drag;
      info.btn.classList.remove('tab-dragging');
      drag = null;
      showDrop(null);
      if (!info.moved) return;
      suppressClick = true;
      if (pointerOutside(e)) {
        detachView(info.view);
        return;
      }
      var target = dropTarget(e);
      if (!target) return;
      if (target.type === 'edge') dockView(info.view, target.edge);
      else placeView(info.view, target.pane, target.index);
    });
  }

  function pointerOutside(e) {
    return e.clientX <= 0 || e.clientY <= 0 ||
      e.clientX >= window.innerWidth - 1 || e.clientY >= window.innerHeight - 1;
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
    var which = popoutViewName() || 'world';
    document.body.classList.add('view-popout', 'view-popout-' + which);
    if (which === 'world') document.body.classList.add('world-popout');
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
      if (window.ViewTabs && window.ViewTabs.showExclusive) {
        var mode = which === 'workspace' ? 'workspace' : (which === 'camera' ? 'camera' : 'world');
        window.ViewTabs.showExclusive(mode);
      }
      if (which === 'workspace') post({ type: 'request-workspace' });
      else post({ type: 'request-snapshot' });
    }, 400);
    setTimeout(function () {
      if (which === 'workspace') post({ type: 'request-workspace' });
      else post({ type: 'request-snapshot' });
    }, 1200);
    if (which === 'workspace') {
      window.addEventListener('beforeunload', function () {
        post({ type: 'workspace-xml', xml: currentWorkspaceXml(), from: 'popout' });
      });
    }
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
    bindWorldTabDrag();

    var el = ipc();
    if (el) {
      el.on('world:popout-closed', function () { onPopoutClosed('world'); });
      el.on('view:popout-closed', function (event, view) { onPopoutClosed(view); });
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
    isDocked: function () { return !!splitMode && !poppedOut && paneGroups.length > 1; },
    getDock: function () {
      if (paneGroups.length < 2) return null;
      return { first: paneGroups[0].active, second: paneGroups[1].active };
    },
    renderTabs: function () { layoutDockPanes(); },
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
      return false;
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
