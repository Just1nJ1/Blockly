/**
 * Dropdown options declared by an extension. Fetching options never connects
 * a device. Menus read the cache synchronously and refresh in the background.
 */
(function (root) {
  var providers = {};
  var cache = {};
  var inflight = {};
  var hooks = {};

  function key(extensionId, providerId) {
    return extensionId + '.' + providerId;
  }

  function registerAll(extensionId, fields) {
    if (!extensionId || !fields || typeof fields !== 'object') return;
    Object.keys(fields).forEach(function (providerId) {
      register(extensionId, providerId, fields[providerId]);
    });
  }

  function register(extensionId, providerId, descriptor) {
    if (!extensionId || !providerId || !descriptor) return;
    providers[key(extensionId, providerId)] = descriptor;
  }

  function getCachedOptions(extensionId, providerId) {
    var entry = cache[key(extensionId, providerId)];
    return entry && entry.options ? entry.options.slice() : [];
  }

  function disposeExtension(extensionId) {
    Object.keys(providers).forEach(function (item) {
      if (item.indexOf(extensionId + '.') === 0) {
        delete providers[item];
        delete cache[item];
        delete inflight[item];
      }
    });
  }

  function serverBase() {
    if (typeof root.getServerUrl === 'function') return root.getServerUrl();
    return 'http://127.0.0.1:5080';
  }

  function requestPath(descriptor, explicit) {
    if (explicit && descriptor.refreshPath) return descriptor.refreshPath;
    return descriptor.path || '/';
  }

  function parseOptions(descriptor, payload) {
    var items = payload && payload[descriptor.itemsKey || 'items'];
    if (!Array.isArray(items)) return [];
    var labelKey = descriptor.labelKey || 'label';
    var valueKey = descriptor.valueKey || 'value';
    var options = [];
    var seen = {};
    items.forEach(function (item) {
      if (!item) return;
      var label = item[labelKey];
      var value = item[valueKey];
      if (label == null || value == null || value === '') return;
      var text = String(value);
      if (seen[text]) return;
      seen[text] = true;
      options.push([String(label), text]);
    });
    return options;
  }

  function refresh(extensionId, providerId, options) {
    var id = key(extensionId, providerId);
    var descriptor = providers[id];
    if (!descriptor) return Promise.resolve([]);
    var explicit = !!(options && options.explicit);
    var cached = cache[id];
    var maxAge = Number(descriptor.cacheMs);
    if (!explicit && cached && isFinite(maxAge) && maxAge > 0 && (Date.now() - cached.at) < maxAge) {
      return Promise.resolve(cached.options.slice());
    }
    if (inflight[id]) return inflight[id];
    var path = requestPath(descriptor, explicit || !cached);
    if (path.charAt(0) !== '/' || path.indexOf('//') === 0 || path.indexOf('..') >= 0) {
      return Promise.resolve(cached ? cached.options.slice() : []);
    }
    inflight[id] = fetch(serverBase() + '/ext/' + extensionId + path)
      .then(function (response) { return response.json(); })
      .then(function (payload) {
        var parsed = parseOptions(descriptor, payload);
        if (parsed.length) cache[id] = { at: Date.now(), options: parsed };
        delete inflight[id];
        return getCachedOptions(extensionId, providerId);
      })
      .catch(function () {
        delete inflight[id];
        return getCachedOptions(extensionId, providerId);
      });
    return inflight[id];
  }

  function withCurrent(field, options) {
    var list = options.slice();
    var current = field && typeof field.getValue === 'function' ? field.getValue() : '';
    if (current && !list.some(function (pair) { return String(pair[1]) === String(current); })) {
      list.unshift([String(current) + ' unavailable', String(current)]);
    }
    if (!list.length) list = [['No devices', '']];
    return list;
  }

  function attach(json, fieldName, extensionId, source) {
    var resolved = resolveSource(extensionId, source);
    if (!resolved) return;
    var hook = 'studiox_dyn_' + extensionId + '_' + fieldName + '_' + resolved.providerId;
    if (!hooks[hook] && root.Blockly && root.Blockly.Extensions && !root.Blockly.Extensions.isRegistered(hook)) {
      hooks[hook] = true;
      root.Blockly.Extensions.register(hook, function () {
        var field = this.getField(fieldName);
        if (!field) return;
        field.menuGenerator_ = function () {
          refresh(resolved.extensionId, resolved.providerId, { explicit: false });
          return withCurrent(field, getCachedOptions(resolved.extensionId, resolved.providerId));
        };
      });
    }
    var existing = json.extensions ? json.extensions.slice() : [];
    if (existing.indexOf(hook) < 0) existing.push(hook);
    json.extensions = existing;
  }

  function resolveSource(extensionId, source) {
    var text = String(source || '');
    if (!text || text.indexOf('/') >= 0) return null;
    if (text.indexOf('.') < 0) return { extensionId: extensionId, providerId: text };
    var parts = text.split('.');
    if (parts.length !== 2 || parts[0] !== extensionId) return null;
    return { extensionId: parts[0], providerId: parts[1] };
  }

  var api = {
    register: register,
    registerAll: registerAll,
    getCachedOptions: getCachedOptions,
    refresh: refresh,
    disposeExtension: disposeExtension,
    attach: attach,
    parseOptions: parseOptions
  };
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = api;
  }
  root.DynamicFields = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
