/**
 * Robot catalog — client-side cache of robots.json (via GET /robots).
 * Single source for model names, Blockly dropdown values, axis layouts,
 * virtual ports, and 3D viewer config.
 */
(function (global) {
  'use strict';

  var _robots = [];
  var _byName = {};
  var _loaded = false;
  var _loadPromise = null;

  function _asObj(v) { return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
  function _asArr(v) {
    if (v == null) return [];
    return Array.isArray(v) ? v.slice() : [v];
  }

  /**
   * Normalize grouped or legacy-flat robot entry to flat + nested groups.
   * Groups: identity | library | firmware | blockly | kinematics | viewer
   */
  function normalizeRobotEntry(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var identity = _asObj(raw.identity);
    var library = _asObj(raw.library);
    var firmware = _asObj(raw.firmware);
    var blockly = _asObj(raw.blockly);
    var kinematics = _asObj(raw.kinematics);
    var viewer = _asObj(raw.viewer);

    var name = identity.name || raw.name || raw.id || '';
    name = String(name).trim();
    if (!name) return null;

    var label = identity.label || raw.label || name;
    var aliases = _asArr('aliases' in identity ? identity.aliases : raw.aliases);

    var sdkClass = library.sdkClass || raw.sdkClass || null;
    var simKey = library.simKey || raw.simKey || name.toLowerCase();

    var fwPrefix = _asArr('fwPrefix' in firmware ? firmware.fwPrefix : raw.fwPrefix);
    var assetPrefix = firmware.assetPrefix || raw.firmwareAssetPrefix || name;

    var blocklyValue = blockly.value || raw.blocklyValue || sdkClass || (name + '_UART');
    if (!sdkClass) sdkClass = blocklyValue;
    var virtualPort = ('virtualPort' in blockly) ? blockly.virtualPort : raw.virtualPort;
    var virtualDescription = ('virtualDescription' in blockly)
      ? blockly.virtualDescription
      : raw.virtualDescription;

    var axisCount = ('axisCount' in kinematics) ? kinematics.axisCount : raw.axisCount;
    axisCount = parseInt(axisCount, 10);
    if (isNaN(axisCount)) axisCount = 6;
    var joints = _asArr('joints' in kinematics ? kinematics.joints : raw.joints);
    var coords = _asArr('coords' in kinematics ? kinematics.coords : raw.coords);

    var viewerObj = Object.assign({}, viewer && Object.keys(viewer).length ? viewer : _asObj(raw.viewer));

    return {
      id: raw.id || name,
      name: name,
      label: label,
      aliases: aliases,
      sdkClass: sdkClass,
      simKey: simKey,
      fwPrefix: fwPrefix,
      firmwareAssetPrefix: assetPrefix,
      blocklyValue: blocklyValue,
      virtualPort: virtualPort == null ? null : virtualPort,
      virtualDescription: virtualDescription == null ? null : virtualDescription,
      axisCount: axisCount,
      joints: joints,
      coords: coords,
      viewer: viewerObj,
      identity: { name: name, label: label, aliases: aliases },
      library: { sdkClass: sdkClass, simKey: simKey },
      firmware: { fwPrefix: fwPrefix, assetPrefix: assetPrefix },
      blockly: {
        value: blocklyValue,
        virtualPort: virtualPort == null ? null : virtualPort,
        virtualDescription: virtualDescription == null ? null : virtualDescription
      },
      kinematics: { axisCount: axisCount, joints: joints, coords: coords }
    };
  }

  // Offline fallback — same grouped shape as robots.json
  var FALLBACK_ROBOTS_RAW = [
    {
      id: 'Mirobot',
      identity: {
        name: 'Mirobot',
        label: 'Mirobot',
        aliases: ['Mirobot_UART', 'mirobot']
      },
      library: { sdkClass: 'Mirobot_UART', simKey: 'mirobot' },
      firmware: { fwPrefix: ['Mirobot'], assetPrefix: 'Mirobot' },
      blockly: {
        value: 'Mirobot_UART',
        virtualPort: 'VirtualMirobot',
        virtualDescription: 'Virtual Mirobot (SDK simulator)'
      },
      kinematics: {
        axisCount: 6,
        joints: [
          { label: 'Joint 1', statusKey: 'X', sdkParam: 'x' },
          { label: 'Joint 2', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Joint 3', statusKey: 'Z', sdkParam: 'z' },
          { label: 'Joint 4', statusKey: 'A', sdkParam: 'a' },
          { label: 'Joint 5', statusKey: 'B', sdkParam: 'b' },
          { label: 'Joint 6', statusKey: 'C', sdkParam: 'c' }
        ],
        coords: [
          { label: 'X', statusKey: 'X', sdkParam: 'x' },
          { label: 'Y', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Z', statusKey: 'Z', sdkParam: 'z' },
          { label: 'RX', statusKey: 'Rx', sdkParam: 'a' },
          { label: 'RY', statusKey: 'Ry', sdkParam: 'b' },
          { label: 'RZ', statusKey: 'Rz', sdkParam: 'c' }
        ]
      },
      viewer: {
        id: 'mirobot',
        urdf: './resources/wlkata_arm_virtual-reality/urdf/wlkata_mirobot_description.urdf',
        meshBasePath: './resources/wlkata_arm_virtual-reality/',
        tcpOffset: [0, 0, 0.02428]
      }
    },
    {
      id: 'MT4',
      identity: {
        name: 'MT4',
        label: 'E4 / MT4',
        aliases: ['MT4_UART', 'mt4', 'Haro380', 'Harobot', 'haro380']
      },
      library: { sdkClass: 'MT4_UART', simKey: 'mt4' },
      firmware: { fwPrefix: ['E4', 'MT4'], assetPrefix: 'MT4' },
      blockly: {
        value: 'MT4_UART',
        virtualPort: 'VirtualMT4',
        virtualDescription: 'Virtual MT4 (SDK simulator)'
      },
      kinematics: {
        axisCount: 4,
        joints: [
          { label: 'Joint 1', statusKey: 'X', sdkParam: 'x' },
          { label: 'Joint 2', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Joint 3', statusKey: 'Z', sdkParam: 'z' },
          { label: 'Joint 4', statusKey: 'A', sdkParam: 'a' }
        ],
        coords: [
          { label: 'X', statusKey: 'X', sdkParam: 'x' },
          { label: 'Y', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Z', statusKey: 'Z', sdkParam: 'z' },
          { label: 'RX', statusKey: 'Rx', sdkParam: 'a' }
        ]
      },
      viewer: {
        id: 'haro380',
        urdf: './resources/wlkata_arm_virtual-reality/urdf/wlkata_haro380_description.urdf',
        meshBasePath: './resources/wlkata_arm_virtual-reality/',
        tcpOffset: [0, 0, -0.041]
      }
    },
    {
      id: 'E4',
      identity: {
        name: 'E4',
        label: 'E4',
        aliases: ['E4_UART', 'e4']
      },
      library: { sdkClass: 'E4_UART', simKey: 'e4' },
      firmware: { fwPrefix: [], assetPrefix: 'MT4' },
      blockly: {
        value: 'E4_UART',
        virtualPort: null,
        virtualDescription: null
      },
      kinematics: {
        axisCount: 4,
        joints: [
          { label: 'Joint 1', statusKey: 'X', sdkParam: 'x' },
          { label: 'Joint 2', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Joint 3', statusKey: 'Z', sdkParam: 'z' },
          { label: 'Joint 4', statusKey: 'A', sdkParam: 'a' }
        ],
        coords: [
          { label: 'X', statusKey: 'X', sdkParam: 'x' },
          { label: 'Y', statusKey: 'Y', sdkParam: 'y' },
          { label: 'Z', statusKey: 'Z', sdkParam: 'z' },
          { label: 'RX', statusKey: 'Rx', sdkParam: 'a' }
        ]
      },
      viewer: {
        id: 'haro380',
        urdf: './resources/wlkata_arm_virtual-reality/urdf/wlkata_haro380_description.urdf',
        meshBasePath: './resources/wlkata_arm_virtual-reality/',
        tcpOffset: [0, 0, -0.041]
      }
    }
  ];

  var FALLBACK_ROBOTS = FALLBACK_ROBOTS_RAW.map(normalizeRobotEntry).filter(Boolean);

  function _index(list) {
    _robots = [];
    _byName = {};
    for (var i = 0; i < list.length; i++) {
      var n = normalizeRobotEntry(list[i]);
      if (!n || !n.name) continue;
      _robots.push(n);
      _byName[n.name] = n;
    }
    _loaded = true;
  }

  // Seed fallback immediately so offline UI works before /robots returns
  _index(FALLBACK_ROBOTS);

  function getServerUrl() {
    return (typeof global.getServerUrl === 'function')
      ? global.getServerUrl()
      : 'http://127.0.0.1:5080';
  }

  function load(force) {
    if (_loadPromise && !force) return _loadPromise;
    _loadPromise = fetch(getServerUrl() + '/robots')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.success && Array.isArray(data.robots) && data.robots.length) {
          _index(data.robots);
          console.log('[RobotCatalog] Loaded', _robots.length, 'robot(s) from server');
        } else {
          console.warn('[RobotCatalog] /robots empty or failed; keeping fallback');
        }
        return _robots;
      })
      .catch(function (err) {
        console.warn('[RobotCatalog] Failed to load /robots:', err);
        return _robots;
      });
    return _loadPromise;
  }

  function getAll() {
    return _robots.slice();
  }

  function getByName(name) {
    if (!name) return null;
    return _byName[name] || null;
  }

  function getDefault() {
    return _robots[0] || FALLBACK_ROBOTS[0];
  }

  function getDefaultName() {
    var d = getDefault();
    return d ? d.name : 'Mirobot';
  }

  /**
   * Map MODEL field / ctor / alias → canonical name from catalog.
   */
  function normalizeModelName(raw) {
    if (raw == null || raw === '') return null;
    var s = String(raw).replace(/^wlkatapython\./i, '').trim();
    if (!s) return null;

    if (_byName[s]) return s;

    var i, r, a, sl = s.toLowerCase();
    for (i = 0; i < _robots.length; i++) {
      r = _robots[i];
      if (s === r.blocklyValue) return r.name;
      if (String(r.name).toLowerCase() === sl) return r.name;
      if (String(r.blocklyValue || '').toLowerCase() === sl) return r.name;
      var aliases = r.aliases || [];
      for (var j = 0; j < aliases.length; j++) {
        if (s === aliases[j] || String(aliases[j]).toLowerCase() === sl) {
          return r.name;
        }
      }
    }

    var base = s.replace(/_UART$/i, '').replace(/_USB$/i, '');
    if (_byName[base]) return base;
    var bl = base.toLowerCase();
    for (i = 0; i < _robots.length; i++) {
      r = _robots[i];
      if (String(r.name).toLowerCase() === bl) return r.name;
      aliases = r.aliases || [];
      for (j = 0; j < aliases.length; j++) {
        if (String(aliases[j]).toLowerCase() === bl ||
            String(aliases[j]).toLowerCase().replace(/_uart$/i, '') === bl) {
          return r.name;
        }
      }
    }

    // Longer names first for substring match
    var ordered = _robots.slice().sort(function (a, b) {
      return String(b.name || '').length - String(a.name || '').length;
    });
    for (i = 0; i < ordered.length; i++) {
      r = ordered[i];
      var n = r.name;
      if (n && new RegExp('\\b' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s)) {
        return r.name;
      }
      aliases = r.aliases || [];
      for (var k = 0; k < aliases.length; k++) {
        a = String(aliases[k]);
        if (a && new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(s)) {
          return r.name;
        }
      }
    }

    return base || s;
  }

  function getRobot(modelOrRaw) {
    var name = normalizeModelName(modelOrRaw) || getDefaultName();
    return getByName(name) || getDefault();
  }

  function getAxisCount(modelOrRaw) {
    var r = getRobot(modelOrRaw);
    var n = parseInt(r.axisCount, 10);
    return isNaN(n) ? 6 : n;
  }

  function getModelDropdownOptions() {
    // Prefer unique blocklyValue entries; E4 has its own value
    var opts = [];
    var seen = {};
    for (var i = 0; i < _robots.length; i++) {
      var r = _robots[i];
      var val = r.blocklyValue || (r.name + '_UART');
      if (seen[val]) continue;
      // Skip E4 as separate dropdown if label is only for internal — keep E4 if it has blocklyValue
      // Show label for MT4 as "E4 / MT4" from JSON
      if (r.virtualPort === null && r.name === 'E4') {
        // Still include E4 as selectable model
      }
      seen[val] = true;
      opts.push([r.label || r.name, val]);
    }
    if (!opts.length) {
      opts = [['Mirobot', 'Mirobot_UART'], ['MT4', 'MT4_UART']];
    }
    return opts;
  }

  /** setup_robot style: typically Mirobot + MT4 label; include all with blocklyValue */
  function getSetupModelDropdownOptions() {
    return getModelDropdownOptions();
  }

  function getVirtualDeviceEntries() {
    var out = [];
    for (var i = 0; i < _robots.length; i++) {
      var r = _robots[i];
      if (!r.virtualPort) continue;
      out.push({
        port: r.virtualPort,
        model: r.name,
        description: r.virtualDescription || ('Virtual ' + r.name + ' (SDK simulator)'),
        virtual: true
      });
    }
    return out;
  }

  function getVirtualPortOptions() {
    // [label, value] for Blockly port dropdown offline defaults
    return getVirtualDeviceEntries().map(function (d) {
      return [d.port + ' (' + d.model + ')', d.port];
    });
  }

  function getVirtualPortModelMap() {
    var map = {};
    var entries = getVirtualDeviceEntries();
    for (var i = 0; i < entries.length; i++) {
      var r = getByName(entries[i].model);
      map[entries[i].port] = (r && r.blocklyValue) || (entries[i].model + '_UART');
    }
    return map;
  }

  function isVirtualPort(port) {
    if (!port) return false;
    for (var i = 0; i < _robots.length; i++) {
      if (_robots[i].virtualPort === port) return true;
    }
    return false;
  }

  function resolveViewerConfig(modelOrRaw) {
    var r = getRobot(modelOrRaw);
    var v = r.viewer || {};
    var BASE = (global.StudioXViewerPaths && global.StudioXViewerPaths.getViewerRoot)
      ? global.StudioXViewerPaths.getViewerRoot()
      : './resources/wlkata_arm_virtual-reality/';
    var cfg = {
      id: v.id || 'mirobot',
      label: r.label || r.name || 'Mirobot',
      urdf: v.urdf || (BASE + 'urdf/wlkata_mirobot_description.urdf'),
      meshBasePath: v.meshBasePath || BASE,
      tcpOffset: Array.isArray(v.tcpOffset) ? v.tcpOffset.slice() : [0, 0, 0.02428]
    };
    if (global.StudioXViewerPaths && typeof global.StudioXViewerPaths.resolveViewerConfig === 'function') {
      return global.StudioXViewerPaths.resolveViewerConfig(cfg);
    }
    return cfg;
  }

  function getControlLayout(modelOrRaw) {
    var r = getRobot(modelOrRaw);
    return {
      joints: (r.joints && r.joints.length) ? r.joints : getDefault().joints,
      coords: (r.coords && r.coords.length) ? r.coords : getDefault().coords
    };
  }

  function getModelConfigMap() {
    // { Mirobot: { joints, coords }, MT4: {...}, ... }
    var map = {};
    for (var i = 0; i < _robots.length; i++) {
      var r = _robots[i];
      map[r.name] = {
        joints: r.joints || [],
        coords: r.coords || []
      };
    }
    return map;
  }

  function modelToBlocklyValue(modelOrRaw) {
    var r = getRobot(modelOrRaw);
    return r.blocklyValue || (r.name + '_UART');
  }

  function nameFromOptionText(text) {
    if (!text) return getDefaultName();
    var t = String(text);
    // Longer names first
    var ordered = _robots.slice().sort(function (a, b) {
      return String(b.name || '').length - String(a.name || '').length;
    });
    for (var i = 0; i < ordered.length; i++) {
      if (t.indexOf(ordered[i].name) !== -1) return ordered[i].name;
      var aliases = ordered[i].aliases || [];
      for (var j = 0; j < aliases.length; j++) {
        if (t.indexOf(aliases[j]) !== -1) return ordered[i].name;
      }
    }
    return getDefaultName();
  }

  function isLoaded() {
    return _loaded;
  }

  global.RobotCatalog = {
    load: load,
    getAll: getAll,
    getByName: getByName,
    getDefault: getDefault,
    getDefaultName: getDefaultName,
    normalizeModelName: normalizeModelName,
    getRobot: getRobot,
    getAxisCount: getAxisCount,
    getModelDropdownOptions: getModelDropdownOptions,
    getSetupModelDropdownOptions: getSetupModelDropdownOptions,
    getVirtualDeviceEntries: getVirtualDeviceEntries,
    getVirtualPortOptions: getVirtualPortOptions,
    getVirtualPortModelMap: getVirtualPortModelMap,
    isVirtualPort: isVirtualPort,
    resolveViewerConfig: resolveViewerConfig,
    getControlLayout: getControlLayout,
    getModelConfigMap: getModelConfigMap,
    modelToBlocklyValue: modelToBlocklyValue,
    nameFromOptionText: nameFromOptionText,
    isLoaded: isLoaded
  };

  // Back-compat globals used across the app
  global.normalizeRobotModelName = function (raw) {
    return normalizeModelName(raw);
  };
  global.resolveRobotViewerConfig = function (model) {
    return resolveViewerConfig(model);
  };
})(typeof window !== 'undefined' ? window : this);
