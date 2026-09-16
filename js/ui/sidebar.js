/**
 * Sidebar Module
 * Handles switching between top-level views (Command, Blockly, extensions).
 * Uses event delegation so dynamically added extension tabs work.
 */

function initSidebar() {
  var sidebar = document.getElementById('sidebar');
  var switching = false;

  function applyTabSwitch(tab) {
    var targetTab = tab.dataset.tab;
    var prevExtTab = sidebar.querySelector('.sidebar-tab.active[data-extension]');
    var prevExtName = prevExtTab ? prevExtTab.dataset.extension : null;
    var extName = tab.dataset.extension || null;

    document.querySelectorAll('.sidebar-tab').forEach(function(t) { t.classList.remove('active'); });
    tab.classList.add('active');

    document.querySelectorAll('.app-view').forEach(function(v) { v.classList.remove('active'); });
    var targetView = document.getElementById(targetTab + '-view');
    if (targetView) targetView.classList.add('active');

    if (extName && typeof activateExtensionFrontend === 'function') {
      activateExtensionFrontend(extName);
    }

    if (prevExtName && prevExtName !== extName) {
      ExtensionAPI._fireLifecycle(prevExtName, 'deactivate');
    }
    if (extName && extName !== prevExtName) {
      ExtensionAPI._fireLifecycle(extName, 'activate');
    }

    if (targetTab === 'blockly') {
      ensureBlocklyReady();
      if (typeof window.controlPanelCheckAndRefresh === 'function') {
        window.controlPanelCheckAndRefresh();
      }
    }

    if (targetTab === 'teaching') {
      var teachPort = document.getElementById('teach-port-select');
      if (teachPort && teachPort.value) {
        // Trigger a status refresh by firing the change event logic
      }
    }
  }

  sidebar.addEventListener('click', function(e) {
    var tab = e.target.closest('.sidebar-tab');
    if (!tab || tab.classList.contains('disabled') || switching) return;

    var targetTab = tab.dataset.tab;
    if (!targetTab) return;
    if (tab.classList.contains('active')) return;

    var extName = tab.dataset.extension || null;
    if (extName && typeof ensureExtensionPermissions === 'function') {
      switching = true;
      ensureExtensionPermissions(extName).then(function(ok) {
        switching = false;
        if (ok) applyTabSwitch(tab);
      }).catch(function() {
        switching = false;
      });
      return;
    }

    applyTabSwitch(tab);
  });
}