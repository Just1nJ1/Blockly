/**
 * App preferences: UI font size + Blockly block scale.
 * Persisted in localStorage; applied on load and from Settings → Appearance.
 */
(function() {
  var FONT_KEY = 'app-font-size';
  var BLOCK_KEY = 'app-block-scale';

  var FONT_MIN = 12;
  var FONT_MAX = 20;
  var FONT_DEFAULT = 14;

  var BLOCK_MIN = 0.6;
  var BLOCK_MAX = 2.0;
  var BLOCK_DEFAULT = 1.0;

  function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
  }

  function getFontSize() {
    try {
      var v = parseInt(localStorage.getItem(FONT_KEY), 10);
      if (!isNaN(v)) return clamp(v, FONT_MIN, FONT_MAX);
    } catch (e) { /* ignore */ }
    return FONT_DEFAULT;
  }

  function getBlockScale() {
    try {
      var v = parseFloat(localStorage.getItem(BLOCK_KEY));
      if (!isNaN(v)) return clamp(v, BLOCK_MIN, BLOCK_MAX);
    } catch (e) { /* ignore */ }
    return BLOCK_DEFAULT;
  }

  function setFontSize(px) {
    var n = clamp(Math.round(Number(px) || FONT_DEFAULT), FONT_MIN, FONT_MAX);
    try { localStorage.setItem(FONT_KEY, String(n)); } catch (e) { /* ignore */ }
    applyFontSize(n);
    return n;
  }

  function setBlockScale(scale) {
    var n = clamp(Number(scale) || BLOCK_DEFAULT, BLOCK_MIN, BLOCK_MAX);
    // Snap to 0.05 for cleaner storage
    n = Math.round(n * 20) / 20;
    try { localStorage.setItem(BLOCK_KEY, String(n)); } catch (e) { /* ignore */ }
    applyBlockScale(n);
    return n;
  }

  function applyFontSize(px) {
    var n = px != null ? px : getFontSize();
    document.documentElement.style.setProperty('--app-font-size', n + 'px');
    // Root font-size so rem-based UI (panels, controls) scales with the setting
    document.documentElement.style.fontSize = n + 'px';
  }

  function applyBlockScale(scale) {
    var n = scale != null ? scale : getBlockScale();
    try {
      var ws = (typeof getWorkspace === 'function') ? getWorkspace() : null;
      if (ws && typeof ws.setScale === 'function') {
        ws.setScale(n);
        // Keep metrics/canvas in sync after scale change
        if (typeof Blockly !== 'undefined' && Blockly.svgResize) {
          try { Blockly.svgResize(ws); } catch (e2) { /* ignore */ }
        }
      }
    } catch (e) { /* workspace may not exist yet */ }
  }

  /** Apply stored prefs (call early + after Blockly inject). */
  function applyAll() {
    applyFontSize();
    applyBlockScale();
  }

  // Early apply so first paint uses saved font size
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { applyFontSize(); });
  } else {
    applyFontSize();
  }

  window.AppPreferences = {
    getFontSize: getFontSize,
    setFontSize: setFontSize,
    applyFontSize: applyFontSize,
    getBlockScale: getBlockScale,
    setBlockScale: setBlockScale,
    applyBlockScale: applyBlockScale,
    applyAll: applyAll,
    FONT_MIN: FONT_MIN,
    FONT_MAX: FONT_MAX,
    FONT_DEFAULT: FONT_DEFAULT,
    BLOCK_MIN: BLOCK_MIN,
    BLOCK_MAX: BLOCK_MAX,
    BLOCK_DEFAULT: BLOCK_DEFAULT
  };
})();
