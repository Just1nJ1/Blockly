/**
 * Manifest rules shared with server/manifest_schema.py.
 * Legacy manifests with no manifestVersion are version 1.
 */
(function (root) {
  var HOST_EXTENSION_API = 1;
  var NAME_RE = /^[a-z][a-z0-9_-]{1,63}$/;
  var SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  var RESERVED = { blockly: true, core: true };
  var PERMISSIONS = { camera: true, microphone: true };

  function validateManifest(manifest, options) {
    options = options || {};
    var errors = [];
    var warnings = [];
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      return { ok: false, errors: ['Manifest must be a JSON object.'], warnings: [], normalized: null };
    }
    var version = manifest.manifestVersion === undefined ? 1 : manifest.manifestVersion;
    if (version !== 1 && version !== 2) {
      errors.push('Unsupported manifestVersion ' + JSON.stringify(manifest.manifestVersion) + '. Supported versions: 1, 2.');
      version = 1;
    }
    var name = manifest.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      errors.push('Extension name must match ' + NAME_RE + '.');
      name = '';
    } else if (RESERVED[name]) {
      errors.push('Extension name ' + JSON.stringify(name) + ' is reserved.');
    }
    if (options.directoryName && name && options.directoryName !== name) {
      var mismatch = 'Directory ' + JSON.stringify(options.directoryName) + ' does not match extension name ' + JSON.stringify(name) + '.';
      if (version >= 2) errors.push(mismatch);
      else warnings.push(mismatch);
    }
    var extApi = manifest.extensionApiVersion === undefined ? 1 : manifest.extensionApiVersion;
    if (typeof extApi !== 'number' || extApi < 1 || extApi !== Math.floor(extApi)) {
      errors.push('extensionApiVersion must be a positive integer.');
    } else if (extApi > HOST_EXTENSION_API) {
      errors.push('Extension ' + (name || options.directoryName || 'extension') + ' requires API version ' + extApi + '. This StudioX supports version ' + HOST_EXTENSION_API + '.');
    }
    var declared = manifest.version || '';
    if (typeof declared !== 'string' || !SEMVER_RE.test(declared)) {
      var versionMessage = 'Version ' + JSON.stringify(declared) + ' is not SemVer (for example 1.2.3).';
      if (version >= 2) errors.push(versionMessage);
      else warnings.push(versionMessage);
    }
    permissionList(manifest).forEach(function (perm) {
      if (!PERMISSIONS[perm]) {
        errors.push('Unknown permission ' + JSON.stringify(perm) + ' on ' + (name || options.directoryName || 'extension') + '.');
      }
    });
    var contributes = manifest.contributes || {};
    if (manifest.contributes && (typeof contributes !== 'object' || Array.isArray(contributes))) {
      errors.push('contributes must be an object.');
      contributes = {};
    }
    if (options.root) {
      errors = errors.concat(checkPaths(name || options.directoryName, options.root, contributes));
    }
    errors = errors.concat(checkDynamicFields(name, contributes.dynamicFields));
    var normalized = {};
    Object.keys(manifest).forEach(function (key) { normalized[key] = manifest[key]; });
    normalized.manifestVersion = version;
    normalized.extensionApiVersion = (typeof extApi === 'number' && extApi >= 1) ? extApi : 1;
    return { ok: errors.length === 0, errors: errors, warnings: warnings, normalized: normalized };
  }

  function permissionList(manifest) {
    var raw = manifest.permissions || [];
    if (typeof raw === 'string') return [raw];
    if (!Array.isArray(raw)) return ['<invalid>'];
    return raw.map(function (item) { return typeof item === 'string' ? item : '<invalid>'; });
  }

  function containedPath(rootDir, relative) {
    if (!rootDir || typeof relative !== 'string' || !relative) return '';
    if (relative.charAt(0) === '/' || relative.charAt(0) === '\\') return '';
    if (relative.indexOf('://') >= 0 || relative.indexOf('//') === 0) return '';
    var parts = relative.split(/[\\/]/);
    if (parts.some(function (part) { return part === '..' || part === ''; })) return '';
    if (typeof require !== 'function') return rootDir + '/' + parts.join('/');
    var path = require('path');
    var resolved = path.resolve(rootDir, parts.join(path.sep));
    var base = path.resolve(rootDir);
    if (resolved !== base && resolved.indexOf(base + path.sep) !== 0) return '';
    return resolved;
  }

  function checkPaths(name, rootDir, contributes) {
    var errors = [];
    var backend = contributes.backend || {};
    if (backend.main && !containedPath(rootDir, String(backend.main))) {
      errors.push(name + ' backend path escapes the extension directory.');
    }
    var runtime = contributes.runtime || {};
    if (runtime.python && !containedPath(rootDir, String(runtime.python))) {
      errors.push(name + ' runtime path escapes the extension directory.');
    }
    var files = blockFiles(contributes.blocks);
    files.forEach(function (rel) {
      if (!containedPath(rootDir, String(rel))) {
        errors.push(name + ' block file ' + JSON.stringify(rel) + ' escapes the extension directory.');
      }
    });
    var windowSpec = contributes.window || {};
    ['html', 'js', 'css'].forEach(function (key) {
      if (windowSpec[key] && !containedPath(rootDir, String(windowSpec[key]))) {
        errors.push(name + ' window ' + key + ' escapes the extension directory.');
      }
    });
    return errors;
  }

  function blockFiles(blocks) {
    if (!blocks) return [];
    if (typeof blocks === 'string') return [blocks];
    if (Array.isArray(blocks)) return blocks;
    var files = [];
    if (Array.isArray(blocks.files)) files = files.concat(blocks.files);
    if (Array.isArray(blocks.definitions)) files = files.concat(blocks.definitions);
    if (typeof blocks.file === 'string') files.push(blocks.file);
    return files;
  }

  function checkDynamicFields(name, fields) {
    if (fields == null) return [];
    if (typeof fields !== 'object' || Array.isArray(fields)) {
      return [(name || 'extension') + ' dynamicFields must be an object.'];
    }
    var allowed = {
      kind: true, path: true, refreshPath: true, itemsKey: true, labelKey: true,
      valueKey: true, refresh: true, cacheMs: true
    };
    var errors = [];
    Object.keys(fields).forEach(function (providerId) {
      var spec = fields[providerId];
      if (!NAME_RE.test(providerId)) {
        errors.push(name + ' has an invalid dynamic field id ' + JSON.stringify(providerId) + '.');
        return;
      }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        errors.push(name + ' field ' + providerId + ' must be an object.');
        return;
      }
      var extra = Object.keys(spec).filter(function (key) { return !allowed[key]; });
      if (extra.length) {
        errors.push(name + ' field ' + providerId + ' has unknown keys: ' + extra.join(', ') + '.');
      }
      if (spec.kind != null && spec.kind !== 'httpOptions') {
        errors.push(name + ' field ' + providerId + ' kind must be httpOptions.');
      }
      ['path', 'refreshPath'].forEach(function (key) {
        if (spec[key] != null && !safeHttpPath(spec[key])) {
          errors.push(name + ' field ' + providerId + ' ' + key + ' must be a relative extension path.');
        }
      });
      if (spec.refresh != null && spec.refresh !== 'onOpen' && spec.refresh !== 'explicit') {
        errors.push(name + ' field ' + providerId + ' refresh must be onOpen or explicit.');
      }
    });
    return errors;
  }

  function safeHttpPath(value) {
    if (typeof value !== 'string' || value.charAt(0) !== '/' || value.indexOf('//') === 0) return false;
    if (value.indexOf('://') >= 0 || value.indexOf('\\') >= 0) return false;
    return value.split('/').indexOf('..') < 0;
  }

  var api = {
    HOST_EXTENSION_API: HOST_EXTENSION_API,
    validateManifest: validateManifest,
    containedPath: containedPath
  };
  if (typeof module !== 'undefined' && module.exports && typeof window === 'undefined') {
    module.exports = api;
  }
  root.StudioxManifest = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
