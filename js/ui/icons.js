/**
 * App UI icons loader.
 *
 * Source of truth: SVG files in resources/icons/ui/
 *   - icons.svg          shared sprite (#icon-save, #icon-run, …)
 *   - save.svg, run.svg  individual files (edit / reuse)
 *
 * On load, injects icons.svg so markup can use:
 *   <svg class="toolbar-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
 *     <use href="#icon-save"></use>
 *   </svg>
 *
 * See resources/icons/ui/README.md
 */
(function () {
  'use strict';

  var SPRITE_URL = './resources/icons/ui/icons.svg';
  var SPRITE_ID = 'app-icon-sprite';

  function injectMarkup(svgText) {
    if (document.getElementById(SPRITE_ID)) return;
    var host = document.createElement('div');
    host.id = 'app-icon-sprite-host';
    host.setAttribute('hidden', '');
    host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    // Ensure the root svg has our id even if the file uses a plain <svg>
    var text = svgText;
    if (text.indexOf('id="' + SPRITE_ID + '"') === -1) {
      text = text.replace(
        /<svg\b/,
        '<svg id="' + SPRITE_ID + '"'
      );
    }
    host.innerHTML = text;
    var parent = document.body || document.documentElement;
    parent.insertBefore(host, parent.firstChild);
  }

  function loadSprite() {
    if (document.getElementById(SPRITE_ID)) {
      return Promise.resolve();
    }
    return fetch(SPRITE_URL)
      .then(function (resp) {
        if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading ' + SPRITE_URL);
        return resp.text();
      })
      .then(function (text) {
        injectMarkup(text);
      })
      .catch(function (err) {
        console.error('[AppIcons] Failed to load sprite:', err);
      });
  }

  /**
   * Build an SVG snippet that references a sprite symbol.
   * Requires the sprite to be injected first (loadSprite).
   */
  function svg(name, className, opts) {
    opts = opts || {};
    var cls = className ? ' class="' + className + '"' : '';
    var wh = '';
    if (opts.width) wh += ' width="' + opts.width + '"';
    if (opts.height) wh += ' height="' + opts.height + '"';
    return (
      '<svg' + cls + wh + ' viewBox="0 0 24 24" aria-hidden="true">' +
        '<use href="#icon-' + name + '"></use>' +
      '</svg>'
    );
  }

  /** URL for a standalone icon file (for <img src> or CSS mask). */
  function fileUrl(name) {
    return './resources/icons/ui/' + name + '.svg';
  }

  // Start load immediately; re-run after DOM ready if body was missing
  function boot() {
    loadSprite();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);

  window.AppIcons = {
    load: loadSprite,
    svg: svg,
    fileUrl: fileUrl,
    /** Known icon names (for docs / tooling) */
    NAMES: [
      'command', 'blockly', 'teaching', 'settings',
      'save', 'run', 'step', 'stop', 'continue', 'sel',
      'clear', 'export', 'import', 'estop',
      'up', 'down', 'delay', 'blocks', 'chevron-down', 'plus'
    ]
  };
})();
