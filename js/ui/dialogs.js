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
var _settingsPageStack = [];
var _settingsCurrentEnv = null;

function openSettings() {
  if (!_appSettingsModal) _buildAppSettingsModal();
  _settingsPageStack = ['main'];
  _settingsRenderPage('main');
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
      '<button class="app-settings-back" id="app-settings-back">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>' +
      '</button>' +
      '<span class="ctrl-modal-title" id="app-settings-title">Settings</span>' +
      '<button class="ctrl-modal-close" id="app-settings-close">&times;</button>' +
    '</div>' +
    '<div class="ctrl-modal-body" id="app-settings-body"></div>';

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  function close() { overlay.style.display = 'none'; }
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });
  document.getElementById('app-settings-close').addEventListener('click', close);
  document.getElementById('app-settings-back').addEventListener('click', _settingsNavBack);

  _appSettingsModal = overlay;
}

// ── Settings Page Navigation ──

function _settingsNavigateTo(page) {
  _settingsPageStack.push(page);
  _settingsRenderPage(page);
}

function _settingsNavBack() {
  if (_settingsPageStack.length > 1) {
    _settingsPageStack.pop();
    _settingsRenderPage(_settingsPageStack[_settingsPageStack.length - 1]);
  }
}

function _settingsRenderPage(page) {
  var body = document.getElementById('app-settings-body');
  var title = document.getElementById('app-settings-title');
  var backBtn = document.getElementById('app-settings-back');

  body.innerHTML = '';
  backBtn.style.display = _settingsPageStack.length <= 1 ? 'none' : '';

  switch (page) {
    case 'main':
      title.textContent = 'Settings';
      _buildSettingsMainPage(body);
      break;
    case 'extensions':
      title.textContent = 'Extensions';
      _buildSettingsExtensionsPage(body);
      break;
    case 'environments':
      title.textContent = 'Environments';
      _buildSettingsEnvironmentsPage(body);
      break;
    case 'env-packages':
      title.textContent = 'Packages \u2014 ' + (_settingsCurrentEnv || '');
      _buildSettingsEnvPackagesPage(body);
      break;
    case 'advanced':
      title.textContent = 'Advanced';
      _buildSettingsAdvancedPage(body);
      break;
  }
}

// ── Main Page ──

function _buildSettingsMainPage(container) {
  var items = [
    { id: 'extensions',   label: 'Extensions',   desc: 'Manage installed extensions' },
    { id: 'environments', label: 'Environments', desc: 'Create and manage Python environments' },
    { id: 'advanced',     label: 'Advanced',     desc: 'Developer mode, firmware settings' },
  ];
  for (var i = 0; i < items.length; i++) {
    (function(item) {
      var row = document.createElement('div');
      row.className = 'app-settings-nav-item';
      row.innerHTML =
        '<div class="app-settings-nav-label">' +
          '<div class="app-settings-nav-title">' + item.label + '</div>' +
          '<div class="app-settings-nav-desc">' + item.desc + '</div>' +
        '</div>' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      row.addEventListener('click', function() { _settingsNavigateTo(item.id); });
      container.appendChild(row);
    })(items[i]);
  }
}

// ── Extensions Page ──

function _buildSettingsExtensionsPage(container) {
  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}

  // Top bar: Install + Open Folder buttons
  var topBar = document.createElement('div');
  topBar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap;';

  var installFolderBtn = document.createElement('button');
  installFolderBtn.className = 'app-settings-btn app-settings-btn-primary';
  installFolderBtn.textContent = 'Install from Folder';
  installFolderBtn.addEventListener('click', function() { _installExtension('folder'); });

  var installZipBtn = document.createElement('button');
  installZipBtn.className = 'app-settings-btn app-settings-btn-primary';
  installZipBtn.textContent = 'Install from Zip';
  installZipBtn.addEventListener('click', function() { _installExtension('zip'); });

  var openBtn = document.createElement('button');
  openBtn.className = 'app-settings-btn';
  openBtn.textContent = 'Open Folder';
  openBtn.addEventListener('click', function() {
    if (!ipcRenderer) return;
    ipcRenderer.invoke('extensions:getDir').then(function(dir) {
      if (dir) require('electron').shell.openPath(dir);
    });
  });

  topBar.appendChild(installFolderBtn);
  topBar.appendChild(installZipBtn);
  topBar.appendChild(openBtn);
  container.appendChild(topBar);

  // Extension table
  var extSection = document.createElement('div');
  extSection.className = 'app-settings-pkg-section';
  extSection.innerHTML =
    '<div class="app-settings-pkg-header-row">' +
      '<span class="ctrl-settings-section-title" style="margin-bottom:0;">Installed Extensions</span>' +
      '<span class="app-settings-pkg-count" id="ext-count"></span>' +
    '</div>';
  var extWrap = document.createElement('div');
  extWrap.className = 'app-settings-pkg-table-wrap';
  extWrap.id = 'ext-list-container';
  extWrap.innerHTML = '<div class="app-settings-loading">Loading extensions\u2026</div>';
  extSection.appendChild(extWrap);
  container.appendChild(extSection);

  // Hint about restart
  var hint = document.createElement('div');
  hint.className = 'app-settings-hint';
  hint.textContent = 'Restart the app after installing or removing extensions.';
  hint.style.marginTop = '8px';
  container.appendChild(hint);

  _fetchExtensionList(extWrap);
}

function _fetchExtensionList(listEl) {
  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}
  if (!ipcRenderer) {
    listEl.innerHTML = '<div class="app-settings-empty-msg">Extension management requires Electron.</div>';
    return;
  }

  ipcRenderer.invoke('extensions:list').then(function(exts) {
    listEl.innerHTML = '';
    var countEl = document.getElementById('ext-count');
    if (countEl) countEl.textContent = exts.length + ' extension' + (exts.length !== 1 ? 's' : '');

    if (exts.length === 0) {
      listEl.innerHTML = '<div class="app-settings-empty-msg">No extensions installed.</div>';
      return;
    }

    var table = document.createElement('table');
    table.className = 'app-settings-pkg-table';

    var thead = document.createElement('thead');
    thead.innerHTML =
      '<tr>' +
        '<th class="pkg-col-name">Extension</th>' +
        '<th class="pkg-col-ver">Version</th>' +
        '<th class="pkg-col-act"></th>' +
      '</tr>';
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var i = 0; i < exts.length; i++) {
      (function(ext) {
        var tr = document.createElement('tr');
        tr.title = ext.path;

        var tdName = document.createElement('td');
        tdName.className = 'pkg-col-name';
        var nameSpan = document.createElement('span');
        nameSpan.textContent = ext.displayName;
        tdName.appendChild(nameSpan);
        if (ext.description) {
          var descSpan = document.createElement('div');
          descSpan.style.cssText = 'font-size:10px;font-weight:normal;color:var(--text-muted);margin-top:1px;';
          descSpan.textContent = ext.description;
          tdName.appendChild(descSpan);
        }

        var tdVer = document.createElement('td');
        tdVer.className = 'pkg-col-ver';
        tdVer.textContent = ext.version || '';

        var tdAct = document.createElement('td');
        tdAct.className = 'pkg-col-act';
        var removeBtn = document.createElement('button');
        removeBtn.className = 'app-settings-pkg-remove-btn';
        removeBtn.title = 'Remove ' + ext.displayName;
        removeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
        removeBtn.addEventListener('click', function() {
          if (confirm('Remove extension "' + ext.displayName + '"?\nRestart the app to apply changes.')) {
            _removeExtension(ext.name, listEl);
          }
        });
        tdAct.appendChild(removeBtn);

        tr.appendChild(tdName);
        tr.appendChild(tdVer);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      })(exts[i]);
    }
    table.appendChild(tbody);
    listEl.appendChild(table);
  }).catch(function(err) {
    listEl.innerHTML = '<div class="app-settings-empty-msg">Error: ' + _escHtml(err.message) + '</div>';
  });
}

function _installExtension(mode) {
  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}
  if (!ipcRenderer) return;

  var channel = mode === 'zip' ? 'extensions:installZip' : 'extensions:installFolder';
  ipcRenderer.invoke(channel).then(function(result) {
    if (!result) return; // user cancelled
    if (!result.success) {
      alert('Install failed: ' + (result.error || 'Unknown error'));
      return;
    }
    var listEl = document.getElementById('ext-list-container');
    if (listEl) _fetchExtensionList(listEl);

    if (result.requirements && result.requirements.trim()) {
      _setupExtensionEnv(result.name, result.requirements);
    } else {
      alert('Extension "' + result.name + '" installed.\nRestart the app to load it.');
    }
  }).catch(function(err) {
    alert('Install error: ' + err.message);
  });
}

/**
 * After installing an extension that has requirements.txt, create
 * an environment named after the extension and install the deps.
 */
function _setupExtensionEnv(extName, requirementsText) {
  var doSetup = confirm(
    'Extension "' + extName + '" has Python dependencies.\n\n' +
    'Create an environment and install them automatically?'
  );
  if (!doSetup) {
    alert('Extension installed. You can set up its environment later\nvia Settings > Environments.');
    return;
  }

  // Show progress in the extension list area
  var listEl = document.getElementById('ext-list-container');
  if (listEl) {
    listEl.innerHTML =
      '<div class="app-settings-progress">' +
        '<div class="progress-spinner"></div>' +
        '<div class="progress-stage" id="ext-env-stage">Creating environment "' + _escHtml(extName) + '"\u2026</div>' +
        '<div class="progress-detail" id="ext-env-detail">Setting up virtual environment</div>' +
      '</div>';
  }

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';

  // Step 1: Create the environment
  fetch(serverUrl + '/env/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: extName })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) {
        alert('Environment creation failed: ' + (data.error || 'Unknown'));
        if (listEl) _fetchExtensionList(listEl);
        return;
      }

      // Step 2: Install requirements
      var stageEl = document.getElementById('ext-env-stage');
      var detailEl = document.getElementById('ext-env-detail');
      if (stageEl) stageEl.textContent = 'Installing requirements\u2026';
      if (detailEl) detailEl.textContent = requirementsText.trim().split('\n').slice(0, 5).join(', ');

      return fetch(serverUrl + '/env/install-requirements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ env: extName, requirements: requirementsText })
      })
        .then(function(r) { return r.json(); })
        .then(function(installData) {
          if (listEl) _fetchExtensionList(listEl);
          if (installData.success) {
            alert('Extension "' + extName + '" installed with environment.\nRestart the app to load it.');
          } else {
            alert('Extension installed, but some packages failed:\n' +
                  (installData.error || 'Unknown'));
          }
        });
    })
    .catch(function(err) {
      alert('Setup error: ' + err.message);
      if (listEl) _fetchExtensionList(listEl);
    });
}

function _removeExtension(name, listEl) {
  var ipcRenderer = null;
  try { ipcRenderer = require('electron').ipcRenderer; } catch (e) {}
  if (!ipcRenderer) return;

  listEl.innerHTML =
    '<div class="app-settings-progress">' +
      '<div class="progress-spinner"></div>' +
      '<div class="progress-stage">Removing extension\u2026</div>' +
    '</div>';

  ipcRenderer.invoke('extensions:remove', name).then(function(result) {
    if (!result.success) {
      alert('Error: ' + (result.error || 'Unknown'));
    }
    _fetchExtensionList(listEl);
  }).catch(function(err) {
    alert('Error: ' + err.message);
    _fetchExtensionList(listEl);
  });
}

// ── Environments Page ──

function _buildSettingsEnvironmentsPage(container) {
  var topBar = document.createElement('div');
  topBar.style.cssText = 'margin-bottom:12px;display:flex;gap:8px;align-items:center;';

  var createBtn = document.createElement('button');
  createBtn.className = 'app-settings-btn app-settings-btn-primary';
  createBtn.textContent = '+ Create Environment';
  createBtn.addEventListener('click', function() { _showCreateEnvDialog(); });
  topBar.appendChild(createBtn);
  container.appendChild(topBar);

  var listContainer = document.createElement('div');
  listContainer.id = 'settings-env-list';
  listContainer.innerHTML = '<div class="app-settings-loading">Loading environments\u2026</div>';
  container.appendChild(listContainer);

  _fetchEnvironments(listContainer);
}

function _fetchEnvironments(listContainer) {
  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  fetch(serverUrl + '/env/list')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      listContainer.innerHTML = '';
      if (!data.success) {
        listContainer.innerHTML = '<div class="app-settings-empty-msg">Error: ' + _escHtml(data.error || 'Unknown') + '</div>';
        return;
      }
      var envs = data.environments || [];
      if (envs.length === 0) {
        listContainer.innerHTML = '<div class="app-settings-empty-msg">No environments created yet.</div>';
        return;
      }
      for (var i = 0; i < envs.length; i++) {
        (function(env) {
          var item = document.createElement('div');
          item.className = 'app-settings-list-item';
          item.innerHTML =
            '<div class="app-settings-item-header">' +
              '<span class="app-settings-item-name">' + _escHtml(env.name) + '</span>' +
              '<span class="app-settings-item-badge">' + (env.valid ? 'valid' : 'invalid') + '</span>' +
            '</div>' +
            '<div class="app-settings-item-meta">' + _escHtml(env.path) + '</div>';

          var actions = document.createElement('div');
          actions.className = 'app-settings-item-actions';

          var manageBtn = document.createElement('button');
          manageBtn.className = 'app-settings-btn app-settings-btn-sm';
          manageBtn.textContent = 'Manage Packages';
          manageBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            _settingsCurrentEnv = env.name;
            _settingsNavigateTo('env-packages');
          });

          var deleteBtn = document.createElement('button');
          deleteBtn.className = 'app-settings-btn app-settings-btn-sm app-settings-btn-danger';
          deleteBtn.textContent = 'Delete';
          deleteBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            if (confirm('Delete environment "' + env.name + '"? This cannot be undone.')) {
              _deleteEnvironment(env.name, listContainer);
            }
          });

          actions.appendChild(manageBtn);
          actions.appendChild(deleteBtn);
          item.appendChild(actions);
          listContainer.appendChild(item);
        })(envs[i]);
      }
    })
    .catch(function(err) {
      listContainer.innerHTML = '<div class="app-settings-empty-msg">Failed to load: ' + _escHtml(err.message) + '</div>';
    });
}

function _showCreateEnvDialog() {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);display:flex;justify-content:center;align-items:center;z-index:10001;';

  var box = document.createElement('div');
  box.style.cssText = 'background:var(--bg-primary,#fff);padding:20px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.3);min-width:340px;border:1px solid var(--border-primary,#ccc);';

  var label = document.createElement('label');
  label.textContent = 'Environment name:';
  label.style.cssText = 'display:block;margin-bottom:8px;font-weight:600;font-size:13px;color:var(--text-primary,#333);';

  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'e.g. cv, ml, robotics';
  input.style.cssText = 'width:100%;padding:8px;border:1px solid var(--border-primary,#ccc);border-radius:4px;box-sizing:border-box;margin-bottom:4px;font-size:13px;background:var(--bg-primary,#fff);color:var(--text-primary,#333);';

  var hint = document.createElement('div');
  hint.textContent = 'Letters, numbers, hyphens, and underscores only.';
  hint.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);margin-bottom:14px;';

  // Python version (optional, uv handles download)
  var pyLabel = document.createElement('label');
  pyLabel.textContent = 'Python version (optional):';
  pyLabel.style.cssText = 'display:block;margin-bottom:8px;font-weight:600;font-size:13px;color:var(--text-primary,#333);';

  var pyInput = document.createElement('input');
  pyInput.type = 'text';
  pyInput.placeholder = 'e.g. 3.11, 3.12 (leave empty for default)';
  pyInput.style.cssText = 'width:100%;padding:8px;border:1px solid var(--border-primary,#ccc);border-radius:4px;box-sizing:border-box;margin-bottom:4px;font-size:13px;background:var(--bg-primary,#fff);color:var(--text-primary,#333);';

  var pyHint = document.createElement('div');
  pyHint.style.cssText = 'font-size:11px;color:var(--text-secondary,#888);margin-bottom:14px;';
  pyHint.textContent = 'Powered by uv. Any version can be auto-downloaded if not installed.';

  var btns = document.createElement('div');
  btns.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';

  var cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  cancelBtn.className = 'app-settings-btn';

  var okBtn = document.createElement('button');
  okBtn.textContent = 'Create';
  okBtn.className = 'app-settings-btn app-settings-btn-primary';

  function close() { if (overlay.parentNode) document.body.removeChild(overlay); }

  function submit() {
    var name = (input.value || '').trim();
    if (!name) return;
    var pythonVersion = (pyInput.value || '').trim();
    close();
    _createEnvironment(name, pythonVersion);
  }

  cancelBtn.addEventListener('click', close);
  okBtn.addEventListener('click', submit);
  input.addEventListener('keypress', function(e) { if (e.key === 'Enter') submit(); });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });

  btns.appendChild(cancelBtn);
  btns.appendChild(okBtn);
  box.appendChild(label);
  box.appendChild(input);
  box.appendChild(hint);
  box.appendChild(pyLabel);
  box.appendChild(pyInput);
  box.appendChild(pyHint);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  input.focus();
}

function _createEnvironment(name, pythonVersion) {
  var listContainer = document.getElementById('settings-env-list');
  if (!listContainer) return;

  listContainer.innerHTML =
    '<div class="app-settings-progress" id="env-create-progress">' +
      '<div class="progress-spinner"></div>' +
      '<div class="progress-stage" id="env-create-stage">Creating virtual environment\u2026</div>' +
      '<div class="progress-detail" id="env-create-detail">' + _escHtml(name) + '</div>' +
    '</div>';

  var stageTimer = setTimeout(function() {
    var stageEl = document.getElementById('env-create-stage');
    var detailEl = document.getElementById('env-create-detail');
    if (stageEl) stageEl.textContent = 'Installing base packages\u2026';
    if (detailEl) detailEl.textContent = 'flask, flask-cors \u2014 this may take a moment';
  }, 3000);

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  var body = { name: name };
  if (pythonVersion) body.python_version = pythonVersion;
  fetch(serverUrl + '/env/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      clearTimeout(stageTimer);
      if (data.success) {
        if (data.warning) alert(data.warning);
      } else {
        alert('Error: ' + (data.error || 'Unknown'));
      }
      _fetchEnvironments(listContainer);
    })
    .catch(function(err) {
      clearTimeout(stageTimer);
      alert('Error: ' + err.message);
      _fetchEnvironments(listContainer);
    });
}

function _deleteEnvironment(name, listContainer) {
  listContainer.innerHTML =
    '<div class="app-settings-progress">' +
      '<div class="progress-spinner"></div>' +
      '<div class="progress-stage">Deleting environment\u2026</div>' +
    '</div>';

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  fetch(serverUrl + '/env/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) alert('Error: ' + (data.error || 'Unknown'));
      _fetchEnvironments(listContainer);
    })
    .catch(function(err) {
      alert('Error: ' + err.message);
      _fetchEnvironments(listContainer);
    });
}

// ── Environment Packages Page ──

function _buildSettingsEnvPackagesPage(container) {
  if (!_settingsCurrentEnv) return;

  // Install form
  var form = document.createElement('div');
  form.className = 'app-settings-install-form';
  form.innerHTML =
    '<div class="app-settings-install-title">Install Package</div>' +
    '<div class="app-settings-search-row">' +
      '<input type="text" class="app-settings-input" id="pkg-search-input" placeholder="Package name (e.g. opencv-python)" autocomplete="off" spellcheck="false" />' +
      '<button class="app-settings-btn app-settings-btn-primary" id="pkg-search-btn">Search</button>' +
    '</div>' +
    '<div id="pkg-search-result"></div>' +
    '<div class="app-settings-extra-index">' +
      '<label class="app-settings-hint" style="padding-left:0;">' +
        'Extra Index URL (for private / TestPyPI packages):' +
      '</label>' +
      '<input type="text" class="app-settings-input" id="pkg-extra-index" placeholder="https://test.pypi.org/simple/" autocomplete="off" style="margin-top:4px;" />' +
    '</div>';
  container.appendChild(form);

  // Package table
  var pkgSection = document.createElement('div');
  pkgSection.className = 'app-settings-pkg-section';
  pkgSection.innerHTML =
    '<div class="app-settings-pkg-header-row">' +
      '<span class="ctrl-settings-section-title" style="margin-bottom:0;">Installed Packages</span>' +
      '<span class="app-settings-pkg-count" id="pkg-count"></span>' +
    '</div>';
  var pkgWrap = document.createElement('div');
  pkgWrap.className = 'app-settings-pkg-table-wrap';
  pkgWrap.id = 'pkg-list-container';
  pkgWrap.innerHTML = '<div class="app-settings-loading">Loading packages\u2026</div>';
  pkgSection.appendChild(pkgWrap);
  container.appendChild(pkgSection);

  _fetchPackages(_settingsCurrentEnv, pkgWrap);

  document.getElementById('pkg-search-btn').addEventListener('click', _searchPyPI);
  document.getElementById('pkg-search-input').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') _searchPyPI();
  });
}

function _fetchPackages(envName, pkgListEl) {
  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  fetch(serverUrl + '/env/' + encodeURIComponent(envName) + '/packages')
    .then(function(r) { return r.json(); })
    .then(function(data) {
      pkgListEl.innerHTML = '';
      var countEl = document.getElementById('pkg-count');

      if (!data.success) {
        pkgListEl.innerHTML = '<div class="app-settings-empty-msg">Error: ' + _escHtml(data.error || 'Unknown') + '</div>';
        if (countEl) countEl.textContent = '';
        return;
      }
      var pkgs = data.packages || [];
      if (countEl) countEl.textContent = pkgs.length + ' package' + (pkgs.length !== 1 ? 's' : '');

      if (pkgs.length === 0) {
        pkgListEl.innerHTML = '<div class="app-settings-empty-msg">No packages installed.</div>';
        return;
      }

      var table = document.createElement('table');
      table.className = 'app-settings-pkg-table';

      // Header
      var thead = document.createElement('thead');
      thead.innerHTML =
        '<tr>' +
          '<th class="pkg-col-name">Package</th>' +
          '<th class="pkg-col-ver">Version</th>' +
          '<th class="pkg-col-act"></th>' +
        '</tr>';
      table.appendChild(thead);

      // Body
      var tbody = document.createElement('tbody');
      for (var i = 0; i < pkgs.length; i++) {
        (function(pkg) {
          var tr = document.createElement('tr');

          var tdName = document.createElement('td');
          tdName.className = 'pkg-col-name';
          tdName.textContent = pkg.name;

          var tdVer = document.createElement('td');
          tdVer.className = 'pkg-col-ver';
          tdVer.textContent = pkg.version || '';

          var tdAct = document.createElement('td');
          tdAct.className = 'pkg-col-act';
          var removeBtn = document.createElement('button');
          removeBtn.className = 'app-settings-pkg-remove-btn';
          removeBtn.title = 'Uninstall ' + pkg.name;
          removeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>';
          removeBtn.addEventListener('click', function() {
            if (confirm('Uninstall ' + pkg.name + '?')) {
              _uninstallPackage(_settingsCurrentEnv, pkg.name, pkgListEl);
            }
          });
          tdAct.appendChild(removeBtn);

          tr.appendChild(tdName);
          tr.appendChild(tdVer);
          tr.appendChild(tdAct);
          tbody.appendChild(tr);
        })(pkgs[i]);
      }
      table.appendChild(tbody);
      pkgListEl.appendChild(table);
    })
    .catch(function(err) {
      pkgListEl.innerHTML = '<div class="app-settings-empty-msg">Error: ' + _escHtml(err.message) + '</div>';
    });
}

function _searchPyPI() {
  var input = document.getElementById('pkg-search-input');
  var resultDiv = document.getElementById('pkg-search-result');
  var query = (input.value || '').trim();
  if (!query) return;

  resultDiv.innerHTML = '<div class="app-settings-loading">Searching PyPI\u2026</div>';

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  fetch(serverUrl + '/env/search-pypi', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: query })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      resultDiv.innerHTML = '';
      if (!data.success) {
        resultDiv.innerHTML = '<div class="app-settings-search-error">Error: ' + _escHtml(data.error || 'Unknown') + '</div>';
        return;
      }
      if (!data.found) {
        resultDiv.innerHTML = '<div class="app-settings-search-error">Package \u201c' + _escHtml(query) + '\u201d not found on PyPI.</div>';
        return;
      }

      var html =
        '<div class="app-settings-search-found">' +
          '<div class="app-settings-search-name">' + _escHtml(data.name) +
            ' <span class="app-settings-pkg-version">' + _escHtml(data.version) + '</span></div>' +
          (data.summary ? '<div class="app-settings-search-summary">' + _escHtml(data.summary) + '</div>' : '') +
          '<div class="app-settings-search-install-row">' +
            '<select id="pkg-version-select" class="app-settings-select">';

      var versions = (data.versions || []).slice().reverse();
      for (var v = 0; v < versions.length; v++) {
        var sel = versions[v] === data.version ? ' selected' : '';
        html += '<option value="' + _escHtml(versions[v]) + '"' + sel + '>' + _escHtml(versions[v]) + '</option>';
      }
      html +=
            '</select>' +
            '<button class="app-settings-btn app-settings-btn-primary" id="pkg-install-btn">Install</button>' +
          '</div>' +
        '</div>';

      resultDiv.innerHTML = html;

      document.getElementById('pkg-install-btn').addEventListener('click', function() {
        var version = document.getElementById('pkg-version-select').value;
        var extraIndex = (document.getElementById('pkg-extra-index').value || '').trim();
        _installPackage(_settingsCurrentEnv, data.name, version, extraIndex);
      });
    })
    .catch(function(err) {
      resultDiv.innerHTML = '<div class="app-settings-search-error">Error: ' + _escHtml(err.message) + '</div>';
    });
}

function _installPackage(envName, pkgName, version, extraIndexUrl) {
  var resultDiv = document.getElementById('pkg-search-result');
  resultDiv.innerHTML =
    '<div class="app-settings-progress">' +
      '<div class="progress-spinner"></div>' +
      '<div class="progress-stage">Installing ' + _escHtml(pkgName) + '\u2026</div>' +
      '<div class="progress-detail">Downloading package and dependencies</div>' +
    '</div>';

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  var body = { env: envName, package: pkgName };
  if (version) body.version = version;
  if (extraIndexUrl) body.extra_index_url = extraIndexUrl;

  fetch(serverUrl + '/env/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.success) {
        resultDiv.innerHTML = '<div class="app-settings-search-found" style="color:var(--text-secondary);">Installed ' + _escHtml(pkgName) + ' successfully.</div>';
        var pkgList = document.getElementById('pkg-list-container');
        if (pkgList) _fetchPackages(envName, pkgList);
      } else {
        resultDiv.innerHTML = '<div class="app-settings-search-error">Install failed:<br>' + _escHtml(data.error || 'Unknown') + '</div>';
      }
    })
    .catch(function(err) {
      resultDiv.innerHTML = '<div class="app-settings-search-error">Error: ' + _escHtml(err.message) + '</div>';
    });
}

function _uninstallPackage(envName, pkgName, pkgListEl) {
  pkgListEl.innerHTML =
    '<div class="app-settings-progress">' +
      '<div class="progress-spinner"></div>' +
      '<div class="progress-stage">Removing ' + _escHtml(pkgName) + '\u2026</div>' +
      '<div class="progress-detail">Cleaning up unused dependencies</div>' +
    '</div>';

  var serverUrl = typeof getServerUrl === 'function' ? getServerUrl() : 'http://127.0.0.1:5080';
  fetch(serverUrl + '/env/uninstall', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: envName, package: pkgName, remove_deps: true })
  })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (!data.success) {
        alert('Error: ' + (data.error || 'Unknown'));
      } else {
        var removed = data.removed || [pkgName];
        if (removed.length > 1) {
          alert('Removed ' + removed.length + ' packages:\n' + removed.join(', '));
        }
      }
      _fetchPackages(envName, pkgListEl);
    })
    .catch(function(err) {
      alert('Error: ' + err.message);
      _fetchPackages(envName, pkgListEl);
    });
}

// ── Advanced Page ──

function _buildSettingsAdvancedPage(container) {
  // Developer Mode
  var devSection = document.createElement('div');
  devSection.className = 'ctrl-settings-section';
  devSection.innerHTML =
    '<div class="ctrl-settings-section-title">General</div>' +
    '<label class="app-settings-check-label">' +
      '<input type="checkbox" id="app-dev-mode-cb">' +
      '<span>Developer Mode</span>' +
    '</label>' +
    '<div class="app-settings-hint">Enables force firmware upload and other advanced options.</div>';
  container.appendChild(devSection);

  document.getElementById('app-dev-mode-cb').checked = window.developerMode;
  document.getElementById('app-dev-mode-cb').addEventListener('change', function() {
    window.developerMode = this.checked;
    try { localStorage.setItem('developer-mode', window.developerMode ? 'true' : 'false'); } catch(e) {}
  });

  // Ignored Firmware Versions
  var fwSection = document.createElement('div');
  fwSection.className = 'ctrl-settings-section';
  fwSection.innerHTML =
    '<div class="ctrl-settings-section-title">Ignored Firmware Updates</div>' +
    '<div class="app-settings-hint" style="margin-bottom:8px;">These firmware versions will not show update notifications.</div>' +
    '<div id="app-ignored-versions-list" class="app-ignored-versions-list"></div>';
  container.appendChild(fwSection);

  _rebuildIgnoredVersionsList();
}

// ── Utility ──

function _escHtml(str) {
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str || ''));
  return div.innerHTML;
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
