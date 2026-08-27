/**
 * Runtime roots for the 3D viewer and Three.js.
 *
 * Dev (electron .):
 *   ./resources/wlkata_arm_virtual-reality/
 *   ./node_modules/three/
 *
 * Packaged (extraResources, same place as server.py):
 *   <Resources>/wlkata_arm_virtual-reality/
 *   <Resources>/three/
 *
 * The page lives inside app.asar, so the renderer cannot use plain
 * relative paths to reach extraResources. Main registers studiox://app/*
 * → process.resourcesPath/* (see main.js). Dev keeps file-relative URLs.
 */
(function (global) {
  'use strict';

  var MARKER = 'wlkata_arm_virtual-reality/';

  function isPackagedApp() {
    try {
      if (typeof process !== 'undefined' && process.defaultApp) return false;
      var href = String((global.location && global.location.href) || '');
      return href.indexOf('app.asar') !== -1;
    } catch (e) {
      return false;
    }
  }

  /** Always trailing slash. */
  function getViewerRoot() {
    return isPackagedApp()
      ? 'studiox://app/wlkata_arm_virtual-reality/'
      : './resources/wlkata_arm_virtual-reality/';
  }

  /** Always trailing slash. */
  function getThreeRoot() {
    return isPackagedApp()
      ? 'studiox://app/three/'
      : './node_modules/three/';
  }

  /**
   * Map robots.json / legacy paths onto the runtime viewer root.
   * e.g. ./resources/wlkata_arm_virtual-reality/urdf/foo.urdf
   */
  function resolveViewerAsset(p) {
    if (p == null || p === '') return p;
    var s = String(p).replace(/\\/g, '/');

    if (
      s.indexOf('studiox://') === 0 ||
      /^https?:\/\//i.test(s) ||
      /^file:/i.test(s)
    ) {
      return s;
    }

    var idx = s.indexOf(MARKER);
    if (idx !== -1) {
      return getViewerRoot() + s.substring(idx + MARKER.length);
    }

    if (s.indexOf('./resources/') === 0 || s.indexOf('resources/') === 0) {
      return s;
    }

    s = s.replace(/^\.\//, '');
    return getViewerRoot() + s;
  }

  function resolveViewerConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return cfg;
    var out = {};
    for (var k in cfg) {
      if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = cfg[k];
    }
    if (out.urdf) out.urdf = resolveViewerAsset(out.urdf);
    if (out.meshBasePath != null && out.meshBasePath !== '') {
      out.meshBasePath = resolveViewerAsset(out.meshBasePath);
      if (out.meshBasePath.slice(-1) !== '/') out.meshBasePath += '/';
    } else {
      out.meshBasePath = getViewerRoot();
    }
    return out;
  }

  global.StudioXViewerPaths = {
    isPackagedApp: isPackagedApp,
    getViewerRoot: getViewerRoot,
    getThreeRoot: getThreeRoot,
    resolveViewerAsset: resolveViewerAsset,
    resolveViewerConfig: resolveViewerConfig
  };
})(typeof window !== 'undefined' ? window : globalThis);
