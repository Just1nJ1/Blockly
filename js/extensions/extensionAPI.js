/**
 * Extension API
 *
 * Provides a stable interface for extensions to interact with the app.
 * Extensions access this via the global `ExtensionAPI` object.
 */
window.ExtensionAPI = {

  // ── Lifecycle ──

  _lifecycleCallbacks: {},

  /**
   * Register a callback for when the extension's tab becomes active.
   * Called every time the user switches to this extension's tab
   * (including the first time, after the JS has loaded).
   */
  onActivate: function(extensionName, fn) {
    var cbs = this._lifecycleCallbacks[extensionName] = this._lifecycleCallbacks[extensionName] || {};
    (cbs.activate = cbs.activate || []).push(fn);
  },

  /**
   * Register a callback for when the user switches away from this extension's tab.
   */
  onDeactivate: function(extensionName, fn) {
    var cbs = this._lifecycleCallbacks[extensionName] = this._lifecycleCallbacks[extensionName] || {};
    (cbs.deactivate = cbs.deactivate || []).push(fn);
  },

  /** Returns true if this extension's tab is currently visible. */
  isActive: function(extensionName) {
    var view = document.getElementById(extensionName + '-view');
    return view ? view.classList.contains('active') : false;
  },

  /** @internal Called by sidebar.js — do not use in extensions. */
  _fireLifecycle: function(extensionName, event) {
    var cbs = (this._lifecycleCallbacks[extensionName] || {})[event];
    if (!cbs) return;
    for (var i = 0; i < cbs.length; i++) {
      try { cbs[i](); } catch(e) { console.error('[ExtensionAPI] lifecycle error (' + event + '/' + extensionName + '):', e); }
    }
  },

  // ── Server Communication ──

  getServerUrl: function() {
    return typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  },

  /** Convenience: fetch from an extension's backend endpoint */
  fetch: async function(extensionName, path, options) {
    options = options || {};
    var url = this.getServerUrl() + '/ext/' + extensionName + path;
    var defaults = { headers: { 'Content-Type': 'application/json' } };
    var merged = Object.assign({}, defaults, options);
    if (options.headers) {
      merged.headers = Object.assign({}, defaults.headers, options.headers);
    }
    var resp = await fetch(url, merged);
    return resp.json();
  },

  // ── Serial / Robot Access ──

  sendCommand: async function(command, port) {
    var body = { command: command };
    if (port) body.port = port;
    var resp = await fetch(this.getServerUrl() + '/cmd/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return resp.json();
  },

  getRobotStatus: async function(port) {
    var resp = await fetch(this.getServerUrl() + '/cmd/get-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: port, silent: true })
    });
    return resp.json();
  },

  getDevices: async function() {
    var resp = await fetch(this.getServerUrl() + '/detect-devices');
    return resp.json();
  },

  // ── UI Helpers ──

  showNotification: function(message, type) {
    type = type || 'info';
    var output = document.getElementById('command-output');
    if (output) {
      var div = document.createElement('div');
      div.style.cssText = 'padding:6px 12px;margin:4px 8px;border-radius:4px;font-size:13px;';
      if (type === 'error') {
        div.style.background = 'var(--output-stderr-bg, #FFF0F0)';
        div.style.color = 'var(--output-stderr, #D32F2F)';
      } else {
        div.style.background = 'var(--output-result-bg, #F0F4FF)';
        div.style.color = 'var(--output-result, #1565C0)';
      }
      div.textContent = message;
      output.appendChild(div);
    }
  },

  // ── Extension Settings (localStorage) ──

  getSetting: function(key, defaultValue) {
    try {
      var val = localStorage.getItem('ext.' + key);
      return val !== null ? JSON.parse(val) : defaultValue;
    } catch(e) { return defaultValue; }
  },

  setSetting: function(key, value) {
    localStorage.setItem('ext.' + key, JSON.stringify(value));
  },

  getData: function(extensionName, key) {
    return this.getSetting(extensionName + '.data.' + key, null);
  },

  setData: function(extensionName, key, value) {
    this.setSetting(extensionName + '.data.' + key, value);
  }
};
