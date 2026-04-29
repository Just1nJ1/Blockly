/**
 * Custom Dialogs Module
 * Overrides Blockly's default dialogs with custom implementations for Electron.
 * Also provides the app-level Settings modal (gear icon in sidebar).
 */

// ── Developer Mode (global, persisted) ──
window.developerMode = false;
try { window.developerMode = localStorage.getItem('developer-mode') === 'true'; } catch(e) {}

// ── Ignored Firmware Versions (global, persisted) ──
// Format: { 'EXBOX:20230422': true, 'Mirobot:20230422': true, ... }
window.ignoredFirmwareVersions = {};
try {
  var stored = localStorage.getItem('ignored-firmware-versions');
  if (stored) window.ignoredFirmwareVersions = JSON.parse(stored);
} catch(e) {}

function ignoreFirmwareVersion(deviceType, version) {
  var key = deviceType + ':' + version;
  window.ignoredFirmwareVersions[key] = true;
  try { localStorage.setItem('ignored-firmware-versions', JSON.stringify(window.ignoredFirmwareVersions)); } catch(e) {}
}

function unignoreFirmwareVersion(deviceType, version) {
  var key = deviceType + ':' + version;
  delete window.ignoredFirmwareVersions[key];
  try { localStorage.setItem('ignored-firmware-versions', JSON.stringify(window.ignoredFirmwareVersions)); } catch(e) {}
}

function isFirmwareVersionIgnored(deviceType, version) {
  var key = deviceType + ':' + version;
  return !!window.ignoredFirmwareVersions[key];
}

function getIgnoredFirmwareVersions() {
  var result = [];
  for (var key in window.ignoredFirmwareVersions) {
    if (window.ignoredFirmwareVersions[key]) {
      var parts = key.split(':');
      result.push({ deviceType: parts[0], version: parts[1] });
    }
  }
  return result;
}

// ── App Settings Modal ──

var _appSettingsModal = null;

function openSettings() {
  if (!_appSettingsModal) _buildAppSettingsModal();

  // Sync checkbox state
  document.getElementById('app-dev-mode-cb').checked = window.developerMode;

  // Rebuild ignored versions list
  _rebuildIgnoredVersionsList();

  _appSettingsModal.style.display = 'flex';
}

function _rebuildIgnoredVersionsList() {
  var container = document.getElementById('app-ignored-versions-list');
  if (!container) return;

  var ignored = getIgnoredFirmwareVersions();
  if (ignored.length === 0) {
    container.innerHTML = '<div class="app-settings-empty">No ignored versions</div>';
    return;
  }

  container.innerHTML = '';
  for (var i = 0; i < ignored.length; i++) {
    (function(item) {
      var row = document.createElement('div');
      row.className = 'app-ignored-version-row';

      var label = document.createElement('span');
      label.className = 'app-ignored-version-label';
      label.textContent = item.deviceType + ' v' + item.version;

      var removeBtn = document.createElement('button');
      removeBtn.className = 'app-ignored-version-remove';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', function() {
        unignoreFirmwareVersion(item.deviceType, item.version);
        _rebuildIgnoredVersionsList();
      });

      row.appendChild(label);
      row.appendChild(removeBtn);
      container.appendChild(row);
    })(ignored[i]);
  }
}

function _buildAppSettingsModal() {
  var overlay = document.createElement('div');
  overlay.id = 'app-settings-modal';
  overlay.className = 'ctrl-modal-overlay';

  var dialog = document.createElement('div');
  dialog.className = 'ctrl-modal-dialog app-settings-dialog';
  dialog.innerHTML =
    '<div class="ctrl-modal-header">' +
      '<span class="ctrl-modal-title">Settings</span>' +
      '<button class="ctrl-modal-close" id="app-settings-close">&times;</button>' +
    '</div>' +
    '<div class="ctrl-modal-body">' +
      '<div class="ctrl-settings-section">' +
        '<div class="ctrl-settings-section-title">General</div>' +
        '<label class="app-settings-check-label">' +
          '<input type="checkbox" id="app-dev-mode-cb">' +
          '<span>Developer Mode</span>' +
        '</label>' +
        '<div class="app-settings-hint">Enables force firmware upload and other advanced options.</div>' +
      '</div>' +
      '<div class="ctrl-settings-section">' +
        '<div class="ctrl-settings-section-title">Ignored Firmware Updates</div>' +
        '<div class="app-settings-hint" style="margin-bottom:8px;">These firmware versions will not show update notifications.</div>' +
        '<div id="app-ignored-versions-list" class="app-ignored-versions-list"></div>' +
      '</div>' +
    '</div>' +
    '<div class="ctrl-modal-footer">' +
      '<button class="ctrl-modal-btn ctrl-modal-btn-cancel" id="app-settings-done">Done</button>' +
    '</div>';

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() { overlay.style.display = 'none'; }

  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
  document.getElementById('app-settings-close').addEventListener('click', close);
  document.getElementById('app-settings-done').addEventListener('click', close);

  document.getElementById('app-dev-mode-cb').addEventListener('change', function() {
    window.developerMode = this.checked;
    try { localStorage.setItem('developer-mode', window.developerMode ? 'true' : 'false'); } catch(e) {}
  });

  _appSettingsModal = overlay;
}

/**
 * Set up custom prompts, confirms, and alerts for Blockly.
 * This replaces the default browser dialogs with styled custom modals.
 */
function setupCustomPrompts() {
  // Override the default prompt function used by Blockly
  Blockly.dialog.setPrompt(function(message, defaultValue, callback) {
    // Create a custom modal dialog
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10000;
    `;

    const dialog = document.createElement('div');
    dialog.style.cssText = `
      background: white;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      min-width: 300px;
    `;

    const label = document.createElement('label');
    label.textContent = message;
    label.style.cssText = 'display: block; margin-bottom: 10px; font-weight: bold;';

    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue || '';
    input.style.cssText = `
      width: 100%;
      padding: 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      box-sizing: border-box;
      margin-bottom: 15px;
    `;

    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'display: flex; justify-content: flex-end; gap: 10px;';

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = `
      padding: 8px 16px;
      background: #ccc;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    const okBtn = document.createElement('button');
    okBtn.textContent = 'OK';
    okBtn.style.cssText = `
      padding: 8px 16px;
      background: #2196F3;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    `;

    cancelBtn.onclick = () => {
      document.body.removeChild(modal);
      callback(null);
    };

    okBtn.onclick = () => {
      document.body.removeChild(modal);
      callback(input.value);
    };

    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        document.body.removeChild(modal);
        callback(input.value);
      }
    });

    buttonContainer.appendChild(cancelBtn);
    buttonContainer.appendChild(okBtn);
    dialog.appendChild(label);
    dialog.appendChild(input);
    dialog.appendChild(buttonContainer);
    modal.appendChild(dialog);
    document.body.appendChild(modal);

    input.focus();
    input.select();
  });

  // Also override confirm for delete operations
  Blockly.dialog.setConfirm(function(message, callback) {
    callback(confirm(message));
  });

  // Override alert
  Blockly.dialog.setAlert(function(message, callback) {
    alert(message);
    callback();
  });
}
