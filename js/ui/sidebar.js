/**
 * Sidebar Module
 * Handles switching between top-level views (Command, Blockly, extensions).
 * Uses event delegation so dynamically added extension tabs work.
 */

function initSidebar() {
  var sidebar = document.getElementById('sidebar');

  sidebar.addEventListener('click', function(e) {
    var tab = e.target.closest('.sidebar-tab');
    if (!tab || tab.classList.contains('disabled')) return;

    var targetTab = tab.dataset.tab;
    if (!targetTab) return;

    // Detect previously active extension tab (before we clear classes)
    var prevExtTab = sidebar.querySelector('.sidebar-tab.active[data-extension]');
    var prevExtName = prevExtTab ? prevExtTab.dataset.extension : null;
    var extName = tab.dataset.extension || null;

    // Update sidebar active state (all tabs, including extension tabs)
    document.querySelectorAll('.sidebar-tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');

    // Switch views
    document.querySelectorAll('.app-view').forEach(function(v) { v.classList.remove('active'); });
    var targetView = document.getElementById(targetTab + '-view');
    if (targetView) targetView.classList.add('active');

    // Lazy-load extension frontend JS on first tab click
    if (extName && typeof activateExtensionFrontend === 'function') {
      activateExtensionFrontend(extName);
    }

    // Fire extension lifecycle events
    if (prevExtName && prevExtName !== extName) {
      ExtensionAPI._fireLifecycle(prevExtName, 'deactivate');
    }
    if (extName && extName !== prevExtName) {
      ExtensionAPI._fireLifecycle(extName, 'activate');
    }

    // When switching to Blockly, ensure workspace + Blockly are ready
    if (targetTab === 'blockly') {
      ensureBlocklyReady();
      if (typeof window.controlPanelCheckAndRefresh === 'function') {
        window.controlPanelCheckAndRefresh();
      }
    }

    // When switching to Teaching, refresh status if a port is selected
    if (targetTab === 'teaching') {
      var teachPort = document.getElementById('teach-port-select');
      if (teachPort && teachPort.value) {
        // Trigger a status refresh by firing the change event logic
      }
    }
  });
}