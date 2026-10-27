/**
 * When a toolbar is narrower than its buttons, hide controls from the
 * trailing side. The emergency-stop button (.toolbar-keep) stays visible.
 */
(function () {
  var BARS = ['#toolbar', '.teach-toolbar', '#command-toolbar'];

  function displayed(el) {
    if (el.hidden && el.getAttribute('data-toolbar-collapsed') !== '1') return false;
    if (typeof getComputedStyle !== 'function') return true;
    try {
      return getComputedStyle(el).display !== 'none';
    } catch (e) {
      return true;
    }
  }

  function pinEmergencyStop(bar) {
    var keep = null;
    var i;
    for (i = 0; i < bar.children.length; i++) {
      if (bar.children[i].classList && bar.children[i].classList.contains('toolbar-keep')) {
        keep = bar.children[i];
        break;
      }
    }
    if (!keep || keep.parentElement !== bar) return null;
    var main = null;
    for (i = 0; i < bar.children.length; i++) {
      if (bar.children[i].classList && bar.children[i].classList.contains('toolbar-main')) {
        main = bar.children[i];
        break;
      }
    }
    if (!main) {
      main = document.createElement('div');
      main.className = 'toolbar-main';
      while (bar.firstChild && bar.firstChild !== keep) {
        main.appendChild(bar.firstChild);
      }
      bar.insertBefore(main, keep);
    }
    return main;
  }

  function fitToolbar(bar) {
    if (!bar) return;
    var i;
    var el;
    for (i = 0; i < bar.children.length; i++) {
      el = bar.children[i];
      if (el.getAttribute('data-toolbar-collapsed') === '1') {
        el.hidden = false;
        el.removeAttribute('data-toolbar-collapsed');
      }
    }
    if (!bar.clientWidth) return;
    var gap = 0;
    if (typeof getComputedStyle === 'function') {
      try {
        var style = getComputedStyle(bar);
        gap = parseFloat(style.columnGap || style.gap) || 0;
      } catch (e) {
        gap = 0;
      }
    }
    var items = [];
    var used = 0;
    for (i = 0; i < bar.children.length; i++) {
      el = bar.children[i];
      if (el.classList && el.classList.contains('toolbar-keep')) continue;
      if (el.classList && el.classList.contains('toolbar-flex')) continue;
      if (!displayed(el)) continue;
      var width = el.offsetWidth || el.width || 0;
      items.push({ el: el, width: width });
      used += width;
    }
    if (items.length > 1) used += gap * (items.length - 1);
    for (i = items.length - 1; i >= 0 && used > bar.clientWidth + 1; i--) {
      items[i].el.hidden = true;
      items[i].el.setAttribute('data-toolbar-collapsed', '1');
      used -= items[i].width;
      if (i > 0) used -= gap;
    }
  }

  function fitToolbars() {
    if (typeof document === 'undefined') return;
    BARS.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (bar) {
        var main = pinEmergencyStop(bar);
        fitToolbar(main || bar);
      });
    });
  }

  function init() {
    if (typeof document === 'undefined') return;
    fitToolbars();
    if (typeof ResizeObserver === 'function') {
      var observer = new ResizeObserver(function () { fitToolbars(); });
      BARS.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (bar) { observer.observe(bar); });
      });
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', fitToolbars);
    }
  }

  if (typeof window !== 'undefined') window.fitToolbars = fitToolbars;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  if (typeof module !== 'undefined' && module.exports && typeof document === 'undefined') {
    module.exports = { fitToolbar: fitToolbar };
  }
})();
