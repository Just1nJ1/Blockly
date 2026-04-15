/**
 * Theme Module
 * Handles light/dark/system theme switching with localStorage persistence.
 * Modes: 'light', 'dark', 'system'
 */

(function() {
  var STORAGE_KEY = 'theme-preference';

  // SVG icons for each mode
  var ICONS = {
    light: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>',
    dark: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>',
    system: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>'
  };

  var TITLES = {
    light: 'Theme: Light (click to switch)',
    dark: 'Theme: Dark (click to switch)',
    system: 'Theme: System (click to switch)'
  };

  // Cycle order
  var MODES = ['system', 'light', 'dark'];

  function getPreference() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'system';
    } catch(e) { return 'system'; }
  }

  function setPreference(mode) {
    try { localStorage.setItem(STORAGE_KEY, mode); } catch(e) {}
  }

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(mode) {
    var resolved = mode === 'system' ? getSystemTheme() : mode;

    if (resolved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }

    // Update toggle button
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.innerHTML = ICONS[mode];
      btn.title = TITLES[mode];
    }

    // Override Blockly toolbox inline styles (Blockly's theme manager
    // sets background-color/color as inline styles which beat CSS)
    applyBlocklyTheme(resolved);
  }

  function applyBlocklyTheme(resolved) {
    // The toolbox element has class "blocklyToolbox" and Blockly sets
    // background-color as an inline style, so we must override it directly.
    var toolbox = document.querySelector('.blocklyToolbox');
    if (toolbox) {
      if (resolved === 'dark') {
        toolbox.style.setProperty('background-color', '#252526', 'important');
        toolbox.style.setProperty('color', '#d4d4d4', 'important');
      } else {
        toolbox.style.removeProperty('background-color');
        toolbox.style.removeProperty('color');
      }
    }
  }

  // Expose so it can be called after Blockly initializes
  window.applyBlocklyThemeOverrides = function() {
    var mode = getPreference();
    var resolved = mode === 'system' ? getSystemTheme() : mode;
    applyBlocklyTheme(resolved);
  };

  function init() {
    var mode = getPreference();
    applyTheme(mode);

    // Toggle button cycles: system -> light -> dark -> system
    var btn = document.getElementById('theme-toggle');
    if (btn) {
      btn.addEventListener('click', function() {
        var current = getPreference();
        var idx = MODES.indexOf(current);
        var next = MODES[(idx + 1) % MODES.length];
        setPreference(next);
        applyTheme(next);
      });
    }

    // Listen for system theme changes (only matters when mode is 'system')
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function() {
      if (getPreference() === 'system') {
        applyTheme('system');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();