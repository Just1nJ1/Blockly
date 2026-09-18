/**
 * Workspace Manager Module
 *
 * Manages project workspaces stored on disk.
 * A workspace is any user-chosen folder. Inside it we store:
 *   <folder>/blocks.xml       - the Blockly workspace state
 *   <folder>/world.json       - World viewer robot base poses (optional)
 *   <folder>/functions/       - saved function JSON files
 *
 * The user picks (or creates) the folder using the native OS file picker
 * (Finder on macOS, Explorer on Windows) via Electron's dialog API.
 *
 * Uses Node.js fs/path (available because nodeIntegration is enabled).
 */

var _fs = require('fs');
var _path = require('path');
var _ipcRenderer = require('electron').ipcRenderer;

// ── State ───────────────────────────────────────────────────────

var _currentWorkspacePath = null;  // full folder path
var _currentWorkspaceName = null;  // folder basename (display name)
var _workspaceDirty = false;
var _suppressDirty = false;
var _autosaveTimer = null;
var _saveToastTimer = null;

// ── Helpers ─────────────────────────────────────────────────────

function _ensureDir(dirPath) {
  if (!_fs.existsSync(dirPath)) {
    _fs.mkdirSync(dirPath, { recursive: true });
  }
}

function _getBlocksFile(wsPath) {
  return _path.join(wsPath, 'blocks.xml');
}

function _getWorldFile(wsPath) {
  return _path.join(wsPath, 'world.json');
}

function _getFunctionsDir(wsPath) {
  return _path.join(wsPath, 'functions');
}

function _getFunctionFile(wsPath, funcName) {
  var safeName = funcName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return _path.join(_getFunctionsDir(wsPath), safeName + '.json');
}

// ── Workspace registry ──────────────────────────────────────────
//
// Two lists in localStorage:
//   recentWorkspaces  — capped at MAX_RECENT, shown in the startup dialog
//   allWorkspaces     — every workspace ever opened, used to scan saved functions

var RECENT_KEY = 'recentWorkspaces';
var ALL_KEY = 'allWorkspaces';
var MAX_RECENT = 10;

function _getRecentWorkspaces() {
  try {
    var raw = localStorage.getItem(RECENT_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function _getAllWorkspaces() {
  try {
    var raw = localStorage.getItem(ALL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}

function _addRecentWorkspace(wsPath) {
  // Update recent list (capped)
  var recents = _getRecentWorkspaces();
  recents = recents.filter(function(r) { return r !== wsPath; });
  recents.unshift(wsPath);
  if (recents.length > MAX_RECENT) recents = recents.slice(0, MAX_RECENT);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recents)); } catch(e) {}

  // Update all-workspaces list (uncapped, no duplicates)
  var all = _getAllWorkspaces();
  if (all.indexOf(wsPath) === -1) {
    all.push(wsPath);
    try { localStorage.setItem(ALL_KEY, JSON.stringify(all)); } catch(e) {}
  }

  console.log('[WorkspaceManager] Recent workspaces:', recents);
  console.log('[WorkspaceManager] All workspaces:', _getAllWorkspaces());
}

// ── Public API ──────────────────────────────────────────────────

function getCurrentWorkspaceName() {
  return _currentWorkspaceName;
}

function getCurrentWorkspacePath() {
  return _currentWorkspacePath;
}

/**
 * Set the current workspace by folder path.
 * Creates the functions/ subfolder if needed.
 */
function setCurrentWorkspace(wsPath) {
  _currentWorkspacePath = wsPath;
  _currentWorkspaceName = _path.basename(wsPath);
  _ensureDir(wsPath);
  _ensureDir(_getFunctionsDir(wsPath));
  _addRecentWorkspace(wsPath);

  _updateWorkspaceChrome();
}

function _updateWorkspaceChrome() {
  var name = _currentWorkspaceName || 'Workspace';
  var dirtyMark = _workspaceDirty ? ' *' : '';
  document.title = name + dirtyMark + ' - WLKATA StudioX';
  var label = document.getElementById('workspace-name-label');
  if (label) {
    label.textContent = name + dirtyMark;
  } else {
    var indicator = document.getElementById('workspace-name-indicator');
    if (indicator) indicator.textContent = name + dirtyMark;
  }
}

function isWorkspaceDirty() {
  return !!_workspaceDirty;
}

function markWorkspaceDirty() {
  if (_suppressDirty) return;
  if (_workspaceDirty) return;
  _workspaceDirty = true;
  _updateWorkspaceChrome();
  startAutosaveTimer();
}

function _setWorkspaceDirty(dirty) {
  var wasDirty = _workspaceDirty;
  _workspaceDirty = !!dirty;
  _updateWorkspaceChrome();
  if (_workspaceDirty && !wasDirty) startAutosaveTimer();
  if (!_workspaceDirty && !_canAutosave()) stopAutosaveTimer();
}

function withWorkspaceLoad(fn) {
  _suppressDirty = true;
  try {
    fn();
  } finally {
    // Blockly may flush FINISHED_LOADING / create events on the next tick
    setTimeout(function() {
      _suppressDirty = false;
      _setWorkspaceDirty(false);
    }, 0);
  }
}

function isSignificantBlocklyEvent(event) {
  if (!event) return false;
  if (event.isUiEvent) return false;
  if (event.recordUndo === false) return false;
  var t = event.type;
  if (typeof Blockly !== 'undefined' && Blockly.Events) {
    if (t === Blockly.Events.FINISHED_LOADING) return false;
    if (t === Blockly.Events.VIEWPORT_CHANGE) return false;
    if (t === Blockly.Events.THEME_CHANGE) return false;
    if (t === Blockly.Events.SELECTED) return false;
    if (t === Blockly.Events.CLICK) return false;
    if (t === Blockly.Events.BLOCK_DRAG) return false;
  }
  if (t === 'finished_loading' || t === 'viewport_change' || t === 'theme_change' ||
      t === 'selected' || t === 'click' || t === 'drag' || t === 'ui') {
    return false;
  }
  return true;
}

function showSaveToast(message, kind) {
  if (!document.body) return;
  var host = document.getElementById('save-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'save-toast-host';
    host.className = 'save-toast-host';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  var toast = document.createElement('div');
  toast.className = 'save-toast' + (kind === 'error' ? ' save-toast-error' : '');
  toast.textContent = message || 'Saved';
  host.appendChild(toast);
  // Force layout so the fade-in transition runs
  void toast.offsetWidth;
  toast.classList.add('save-toast-visible');
  if (_saveToastTimer) clearTimeout(_saveToastTimer);
  _saveToastTimer = setTimeout(function() {
    toast.classList.remove('save-toast-visible');
    setTimeout(function() {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 220);
  }, 2200);
}

function _getAutosaveMs() {
  if (window.AppPreferences && typeof AppPreferences.getAutosaveIntervalMs === 'function') {
    return AppPreferences.getAutosaveIntervalMs();
  }
  return 30000;
}

function _canAutosave() {
  if (_workspaceDirty && _currentWorkspacePath) return true;
  return !!(window.TeachingPanel &&
    typeof TeachingPanel.canAutosave === 'function' &&
    TeachingPanel.canAutosave());
}

function stopAutosaveTimer() {
  if (_autosaveTimer) {
    clearTimeout(_autosaveTimer);
    _autosaveTimer = null;
  }
}

/** Start (or restart) the countdown. No-op until there is something to save. */
function startAutosaveTimer() {
  stopAutosaveTimer();
  var ms = _getAutosaveMs();
  if (!ms || !_canAutosave()) return;
  _autosaveTimer = setTimeout(function() {
    _autosaveTimer = null;
    runAutosave();
    if (_canAutosave()) startAutosaveTimer();
  }, ms);
}

/** Settings changed: restart countdown only if an edit is already pending. */
function restartAutosaveTimer() {
  if (_canAutosave()) startAutosaveTimer();
  else stopAutosaveTimer();
}

function _workspaceIsDragging() {
  try {
    var ws = getWorkspace ? getWorkspace() : null;
    if (ws && typeof ws.isDragging === 'function' && ws.isDragging()) return true;
  } catch (e) { /* ignore */ }
  return false;
}

function runAutosave() {
  if (_workspaceIsDragging()) return;
  var saved = [];
  if (_workspaceDirty && _currentWorkspacePath) {
    if (saveWorkspaceBlocks({ silent: true })) saved.push('workspace');
  }
  if (window.TeachingPanel && typeof TeachingPanel.autosave === 'function') {
    if (TeachingPanel.autosave()) saved.push('teaching');
  }
  if (!saved.length) return;
  if (saved.length === 2) showSaveToast('Auto-saved');
  else if (saved[0] === 'workspace') showSaveToast('Workspace auto-saved');
  else showSaveToast('Teaching file auto-saved');
}

function _teachingIsDirty() {
  return !!(window.TeachingPanel &&
    typeof TeachingPanel.isDirty === 'function' &&
    TeachingPanel.isDirty());
}

function _collectUnsavedSources() {
  var sources = [];
  if (_workspaceDirty) {
    sources.push(_currentWorkspaceName
      ? 'workspace \u201c' + _currentWorkspaceName + '\u201d'
      : 'the workspace');
  }
  if (_teachingIsDirty()) {
    var teachName = (window.TeachingPanel && TeachingPanel.getFileDisplayName)
      ? TeachingPanel.getFileDisplayName()
      : 'Untitled';
    sources.push('Teaching file \u201c' + teachName + '\u201d');
  }
  return sources;
}

/** Sync snapshot for the main-process quit dialog. */
function getUnsavedCloseState() {
  var sources = _collectUnsavedSources();
  if (!sources.length) return { dirty: false, detail: '' };
  var list = sources.length === 1
    ? sources[0]
    : sources.slice(0, -1).join(', ') + ' and ' + sources[sources.length - 1];
  return {
    dirty: true,
    detail: 'You have unsaved changes in ' + list + '.'
  };
}

function hasUnsavedChanges() {
  return _workspaceDirty || _teachingIsDirty();
}

function saveAllBeforeExit() {
  return Promise.resolve().then(function() {
    if (_workspaceDirty) {
      if (!saveWorkspaceBlocks({ silent: true })) return false;
    }
    if (!_teachingIsDirty()) return true;
    if (!window.TeachingPanel || typeof TeachingPanel.saveFile !== 'function') return true;
    return Promise.resolve(TeachingPanel.saveFile()).then(function(ok) {
      return ok !== false;
    });
  }).then(function(ok) {
    if (ok) showSaveToast('Saved');
    return ok;
  }).catch(function(err) {
    console.error('[WorkspaceManager] Save before exit failed:', err);
    showSaveToast('Save failed', 'error');
    return false;
  });
}

window.restartAutosaveTimer = restartAutosaveTimer;
window.startAutosaveTimer = startAutosaveTimer;
window.getUnsavedCloseState = getUnsavedCloseState;
window.saveAllBeforeExit = saveAllBeforeExit;
window.hasUnsavedChanges = hasUnsavedChanges;
window.markWorkspaceDirty = markWorkspaceDirty;
window.isWorkspaceDirty = isWorkspaceDirty;
window.showSaveToast = showSaveToast;
window.isSignificantBlocklyEvent = isSignificantBlocklyEvent;

// ── Block save/load ─────────────────────────────────────────────

/**
 * Persist World viewer robot base poses into world.json.
 * Skips writing if the World scene was never opened this session so we
 * do not wipe poses when the user only edits blocks and hits Save.
 */
function saveWorldScene() {
  if (!_currentWorkspacePath) return;

  var WV = window.WorldViewer;
  if (!WV || typeof WV.isInitialized !== 'function' || !WV.isInitialized()) {
    return;
  }
  if (typeof WV.getAllRobotPoses !== 'function') return;

  var robots = WV.getAllRobotPoses() || {};
  var data = {
    version: 1,
    robots: robots
  };

  try {
    _ensureDir(_currentWorkspacePath);
    _fs.writeFileSync(
      _getWorldFile(_currentWorkspacePath),
      JSON.stringify(data, null, 2),
      'utf8'
    );
    console.log('[WorkspaceManager] Saved world poses to:', _currentWorkspacePath,
      '(' + Object.keys(robots).length + ' robot(s))');
  } catch (e) {
    console.error('[WorkspaceManager] Failed to save world.json:', e);
  }
}

/**
 * Load world.json poses into WorldViewer (pending until robots are added).
 * Missing file → clear saved poses and use defaults.
 */
function loadWorldScene() {
  var WV = window.WorldViewer;

  if (!_currentWorkspacePath) {
    if (WV && typeof WV.clearSavedPoses === 'function') WV.clearSavedPoses();
    return;
  }

  var filePath = _getWorldFile(_currentWorkspacePath);
  if (!_fs.existsSync(filePath)) {
    if (WV && typeof WV.clearSavedPoses === 'function') WV.clearSavedPoses();
    console.log('[WorkspaceManager] No world.json in:', _currentWorkspacePath);
    return;
  }

  try {
    var raw = _fs.readFileSync(filePath, 'utf8');
    var data = JSON.parse(raw);
    var robots = (data && data.robots && typeof data.robots === 'object')
      ? data.robots
      : {};
    if (WV && typeof WV.applySavedPoses === 'function') {
      WV.applySavedPoses(robots);
    }
    console.log('[WorkspaceManager] Loaded world poses from:', _currentWorkspacePath,
      '(' + Object.keys(robots).length + ' robot(s))');
  } catch (e) {
    console.error('[WorkspaceManager] Failed to load world.json:', e);
    if (WV && typeof WV.clearSavedPoses === 'function') WV.clearSavedPoses();
  }
}

function saveWorkspaceBlocks(opts) {
  opts = opts || {};
  var ws = getWorkspace ? getWorkspace() : null;
  if (!ws || !_currentWorkspacePath) return false;

  try {
    var xml = Blockly.Xml.workspaceToDom(ws);
    var xmlText = Blockly.Xml.domToText(xml);

    _ensureDir(_currentWorkspacePath);
    _fs.writeFileSync(_getBlocksFile(_currentWorkspacePath), xmlText, 'utf8');
    console.log('[WorkspaceManager] Saved blocks to:', _currentWorkspacePath);

    // Also snapshot World base poses when the scene has been used
    saveWorldScene();
    _setWorkspaceDirty(false);
    if (!opts.silent) {
      showSaveToast(opts.auto ? 'Workspace auto-saved' : 'Workspace saved');
    }
    return true;
  } catch (e) {
    console.error('[WorkspaceManager] Failed to save blocks:', e);
    if (!opts.silent) showSaveToast('Save failed', 'error');
    return false;
  }
}

function loadWorkspaceBlocks() {
  var ws = getWorkspace ? getWorkspace() : null;
  if (!ws || !_currentWorkspacePath) return;

  withWorkspaceLoad(function() {
    var filePath = _getBlocksFile(_currentWorkspacePath);
    if (!_fs.existsSync(filePath)) {
      console.log('[WorkspaceManager] No blocks file in:', _currentWorkspacePath);
      // Still try world.json / clear poses for this workspace
      loadWorldScene();
      return;
    }

    try {
      var xmlText = _fs.readFileSync(filePath, 'utf8');
      var xmlDom = Blockly.utils.xml.textToDom(xmlText);
      ws.clear();
      Blockly.Xml.domToWorkspace(xmlDom, ws);
      if (typeof updateCodePreview === 'function') updateCodePreview();
      console.log('[WorkspaceManager] Loaded blocks from:', _currentWorkspacePath);
    } catch (e) {
      console.error('[WorkspaceManager] Failed to load blocks:', e);
    }

    // Restore World poses (applied when robots are synced into the scene)
    loadWorldScene();
  });
}

// ── Saved functions (per-workspace, on disk) ────────────────────

/**
 * Save a function to a workspace's functions folder.
 * @param {string} wsPath - workspace folder path (or name for display grouping)
 * @param {object} entry - { name, params, xml }
 */
function saveFunctionToWorkspace(wsPath, entry) {
  _ensureDir(_getFunctionsDir(wsPath));
  var filePath = _getFunctionFile(wsPath, entry.name);
  var data = {
    name: entry.name,
    params: entry.params || [],
    xml: entry.xml,
    timestamp: Date.now()
  };
  _fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function deleteFunctionFromWorkspace(wsPath, funcName) {
  var filePath = _getFunctionFile(wsPath, funcName);
  if (_fs.existsSync(filePath)) {
    _fs.unlinkSync(filePath);
  }
}

function listFunctionsInWorkspace(wsPath) {
  var dir = _getFunctionsDir(wsPath);
  if (!_fs.existsSync(dir)) return [];

  var files = _fs.readdirSync(dir).filter(function(f) {
    return f.endsWith('.json');
  });

  var results = [];
  for (var i = 0; i < files.length; i++) {
    try {
      var raw = _fs.readFileSync(_path.join(dir, files[i]), 'utf8');
      var data = JSON.parse(raw);
      results.push(data);
    } catch (e) {
      console.warn('[WorkspaceManager] Bad function file:', files[i], e);
    }
  }
  return results.sort(function(a, b) { return a.name.localeCompare(b.name); });
}

/**
 * List all saved functions across ALL known workspaces, grouped by workspace name.
 * Scans every workspace ever opened (not just the 10 most recent).
 * @returns {object} { wsDisplayName: { path: wsPath, funcs: [entries] }, ... }
 */
function listAllSavedFunctions() {
  var all = _getAllWorkspaces();
  var result = {};
  for (var i = 0; i < all.length; i++) {
    var wsPath = all[i];
    if (!_fs.existsSync(wsPath)) continue;
    var funcs = listFunctionsInWorkspace(wsPath);
    if (funcs.length > 0) {
      var displayName = _path.basename(wsPath);
      // If two folders have the same basename, use full path to disambiguate
      if (result[displayName]) {
        // Rename the existing entry to include its full path
        var existingPath = result[displayName].path;
        var renamedKey = _path.basename(existingPath) + ' (' + existingPath + ')';
        result[renamedKey] = result[displayName];
        delete result[displayName];
        // Use full path for the new entry too
        displayName = displayName + ' (' + wsPath + ')';
      }
      result[displayName] = { path: wsPath, funcs: funcs };
    }
  }
  return result;
}

// ── Native OS folder picker ─────────────────────────────────────

/**
 * Open the native OS folder picker dialog.
 * Returns a Promise that resolves with the selected folder path, or null if cancelled.
 */
function showNativeFolderPicker() {
  return _ipcRenderer.invoke('dialog:openFolder');
}

/**
 * Show the workspace selection dialog on app startup.
 * Shows recent workspaces + buttons for Open/New using native OS dialogs.
 * Returns a Promise that resolves with the chosen folder path.
 */
function showWorkspaceDialog() {
  return new Promise(function(resolve) {
    var recents = _getRecentWorkspaces();

    // Build modal overlay (theme via CSS variables / dark mode)
    var overlay = document.createElement('div');
    overlay.id = 'workspace-dialog-overlay';

    var dialog = document.createElement('div');
    dialog.className = 'ws-dialog';

    // Title
    var title = document.createElement('h2');
    title.className = 'ws-dialog-title';
    title.textContent = 'Open Workspace';
    dialog.appendChild(title);

    var subtitle = document.createElement('div');
    subtitle.className = 'ws-dialog-subtitle';
    subtitle.textContent = 'Choose a folder for your project. All blocks and saved functions will be stored there.';
    dialog.appendChild(subtitle);

    // Action buttons: Open Folder / New Folder
    var btnRow = document.createElement('div');
    btnRow.className = 'ws-dialog-actions';

    var openBtn = document.createElement('button');
    openBtn.className = 'ws-dialog-btn ws-dialog-btn-open';
    openBtn.textContent = '\uD83D\uDCC2 Open Existing Folder';
    openBtn.onclick = async function() {
      var folderPath = await showNativeFolderPicker();
      if (folderPath) {
        document.body.removeChild(overlay);
        resolve(folderPath);
      }
    };
    btnRow.appendChild(openBtn);

    var newBtn = document.createElement('button');
    newBtn.className = 'ws-dialog-btn ws-dialog-btn-new';
    newBtn.textContent = '\u2795 Create New Folder';
    newBtn.onclick = async function() {
      var folderPath = await _ipcRenderer.invoke('dialog:createFolder');
      if (folderPath) {
        document.body.removeChild(overlay);
        resolve(folderPath);
      }
    };
    btnRow.appendChild(newBtn);

    dialog.appendChild(btnRow);

    // Recent workspaces list
    // Filter to only existing folders
    var validRecents = recents.filter(function(r) {
      return _fs.existsSync(r);
    });

    if (validRecents.length > 0) {
      var recentLabel = document.createElement('div');
      recentLabel.className = 'ws-dialog-recent-label';
      recentLabel.textContent = 'Recent workspaces:';
      dialog.appendChild(recentLabel);

      var listDiv = document.createElement('div');
      listDiv.className = 'ws-dialog-recent-list';

      for (var i = 0; i < validRecents.length; i++) {
        (function(wsPath) {
          var wsName = _path.basename(wsPath);
          var wsDir = _path.dirname(wsPath);

          var item = document.createElement('div');
          item.className = 'ws-dialog-recent-item';

          var nameSpan = document.createElement('span');
          nameSpan.className = 'ws-dialog-recent-name';
          nameSpan.textContent = wsName;
          item.appendChild(nameSpan);

          var pathSpan = document.createElement('span');
          pathSpan.className = 'ws-dialog-recent-path';
          pathSpan.textContent = wsDir;
          item.appendChild(pathSpan);

          item.onclick = function() {
            document.body.removeChild(overlay);
            resolve(wsPath);
          };
          listDiv.appendChild(item);
        })(validRecents[i]);
      }
      dialog.appendChild(listDiv);
    }

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

/**
 * Switch to a different workspace (save current, show dialog, reload).
 */
async function switchWorkspace() {
  // Save current workspace first (no toast — switching is not an explicit Save)
  saveWorkspaceBlocks({ silent: true });

  // Show dialog
  var wsPath = await showWorkspaceDialog();
  if (wsPath === _currentWorkspacePath) return; // same workspace, no-op

  setCurrentWorkspace(wsPath);

  // Stop world animation and drop all 3D robots from the previous workspace
  // (async URDF loads from the old set must not reappear after switch).
  try {
    if (window.WorldAnimation && typeof window.WorldAnimation.stop === 'function') {
      window.WorldAnimation.stop();
    }
  } catch (eStop) { /* ignore */ }
  try {
    if (window.WorldViewer && typeof window.WorldViewer.clearAllRobots === 'function') {
      window.WorldViewer.clearAllRobots();
    }
  } catch (eClear) { /* ignore */ }
  try {
    if (window.WorldViewer && typeof window.WorldViewer.clearSavedPoses === 'function') {
      window.WorldViewer.clearSavedPoses();
    }
  } catch (ePoses) { /* ignore */ }

  // Clear and reload (blocks + world.json poses)
  var ws = getWorkspace ? getWorkspace() : null;
  if (ws) {
    ws.clear();
    loadWorkspaceBlocks();
  } else {
    loadWorldScene();
  }

  // Rebuild robot tabs / world membership for the new workspace code
  // (addRobot will pick up pending poses from world.json)
  if (typeof updateCodePreview === 'function') {
    updateCodePreview();
  }
  if (typeof window.updateRobotTabs === 'function') {
    window.updateRobotTabs();
  }

  // Refresh saved functions panel
  if (typeof renderSavedFunctionsList === 'function') {
    renderSavedFunctionsList();
  }
}
