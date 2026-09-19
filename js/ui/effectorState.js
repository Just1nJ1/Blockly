/**
 * Shared end-effector UI state for Control and Teaching.
 * Last commanded type + mode per serial port (not live firmware readout).
 */
(function() {
  var STORAGE_KEY = 'studiox-effector-state';
  var _byPort = {};
  var _listeners = [];

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) _byPort = JSON.parse(raw) || {};
    } catch (e) {
      _byPort = {};
    }
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_byPort)); } catch (e) { /* ignore */ }
  }

  function normalizeType(type) {
    if (type === 'pump') return 'suction';
    if (type === 'suction' || type === 'gripper' || type === 'soft') return type;
    return 'none';
  }

  function normalizeMode(mode) {
    var n = parseInt(mode, 10);
    return (n === 1 || n === 2) ? n : 0;
  }

  function get(port) {
    if (!port || !_byPort[port]) return { type: 'none', mode: 0 };
    var s = _byPort[port];
    return { type: normalizeType(s.type), mode: normalizeMode(s.mode) };
  }

  function set(port, patch) {
    if (!port) return get(port);
    var cur = get(port);
    var next = {
      type: patch.type != null ? normalizeType(patch.type) : cur.type,
      mode: patch.mode != null ? normalizeMode(patch.mode) : cur.mode
    };
    if (next.type === 'none') next.mode = 0;
    _byPort[port] = next;
    persist();
    for (var i = 0; i < _listeners.length; i++) {
      try { _listeners[i](port, next); } catch (e) { /* ignore */ }
    }
    return next;
  }

  function subscribe(fn) {
    if (typeof fn === 'function') _listeners.push(fn);
  }

  load();

  window.EffectorState = {
    get: get,
    set: set,
    subscribe: subscribe
  };
})();
