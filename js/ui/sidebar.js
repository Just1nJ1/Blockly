/**
 * Sidebar Module
 * Handles switching between the Command and Blockly top-level views.
 */

function initSidebar() {
  var tabs = document.querySelectorAll('.sidebar-tab');
  var views = document.querySelectorAll('.app-view');

  tabs.forEach(function(tab) {
    tab.addEventListener('click', function() {
      var targetTab = tab.dataset.tab;

      // Update sidebar active state
      tabs.forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');

      // Switch views
      views.forEach(function(v) { v.classList.remove('active'); });
      var targetView = document.getElementById(targetTab + '-view');
      if (targetView) targetView.classList.add('active');

      // When switching to Blockly, ensure workspace + Blockly are ready
      if (targetTab === 'blockly') {
        ensureBlocklyReady();
      }
    });
  });
}