/**
 * Extension Loader (Renderer)
 *
 * Receives extension manifests from the Electron main process and injects
 * their frontend assets (CSS, JS, HTML sidebar tabs) into the running page.
 *
 * Extension manifest format (extension.json):
 * {
 *   "name": "my-extension",
 *   "displayName": "My Extension",
 *   "version": "1.0.0",
 *   "contributes": {
 *     "sidebarTab": { "id", "label", "icon", "html", "js", "css" },
 *     "backend": { "main": "backend/main.py" },
 *     "workflows": [ "workflows/my_pipeline.json" ]
 *   }
 * }
 *
 * Workflow templates are registered with WorkflowRegistry as soon as the
 * extension is discovered (not lazy on tab click), so they appear in the
 * Blockly Workflows toolbox without opening the extension tab.
 *
 * Saved functions: if the extension has a functions/ folder with *.json
 * files (same schema as workspace libraries), they are auto-scanned and
 * shown in the Saved Functions panel. Missing or empty functions/ is fine.
 */

var _loadedExtensions = new Map();

// Extension-bundled function libraries (auto-scanned from functions/*.json)
// Map: extensionName -> { displayName, basePath, funcs: [entries] }
var _extensionFunctionLibs = new Map();

var _extFs = null;
var _extPath = null;
try {
  _extFs = require('fs');
  _extPath = require('path');
} catch (eFs) {
  console.warn('[Extensions] Node fs not available; extension function scan disabled');
}

/**
 * Called by main process via executeJavaScript after extensions are discovered.
 * @param {Array} extensions - Array of { manifest, basePath }
 */
async function loadExtensions(extensions) {
  for (var i = 0; i < extensions.length; i++) {
    var ext = extensions[i];
    try {
      await _loadSingleExtension(ext.manifest, ext.basePath);
      console.log('[Extensions] Loaded: ' + (ext.manifest.displayName || ext.manifest.name));
    } catch (err) {
      console.error('[Extensions] Failed to load ' + ext.manifest.name + ':', err);
    }
  }

  // Refresh Saved Functions panel if Blockly UI is already up
  if (typeof renderSavedFunctionsList === 'function') {
    try { renderSavedFunctionsList(); } catch (eR) { /* ignore */ }
  }
}

/**
 * Load a single extension's frontend assets.
 */
async function _loadSingleExtension(manifest, basePath) {
  var name = manifest.name;
  var contributes = manifest.contributes || {};

  _loadedExtensions.set(name, { manifest: manifest, basePath: basePath, status: 'loading' });

  // 1. Inject CSS
  if (contributes.sidebarTab && contributes.sidebarTab.css) {
    await _injectExtCSS(basePath, contributes.sidebarTab.css, name);
  }

  // 2. Inject sidebar tab (HTML + button)
  if (contributes.sidebarTab) {
    await _injectSidebarTab(manifest, basePath, contributes.sidebarTab);
  }

  // 3. Store JS path for lazy loading (injected on first tab click)
  if (contributes.sidebarTab && contributes.sidebarTab.js) {
    _loadedExtensions.get(name).pendingJS = contributes.sidebarTab.js;
  }

  // 4. Register Blockly workflow templates (eager — available in toolbox)
  if (contributes.workflows) {
    await _loadExtensionWorkflows(manifest, basePath, contributes.workflows);
  }

  // 5. Auto-scan functions/ for default saved-function JSON (optional)
  _scanExtensionFunctions(manifest, basePath);

  _loadedExtensions.get(name).status = 'ready';
}

/**
 * Auto-scan <extension>/functions/*.json for default procedure libraries.
 * No-op if the folder is missing, unreadable, or has no valid JSON.
 * Does not require a contributes.functions entry in the manifest.
 */
function _scanExtensionFunctions(manifest, basePath) {
  if (!_extFs || !_extPath || !basePath || !manifest || !manifest.name) return;

  var dir = _extPath.join(basePath, 'functions');
  if (!_extFs.existsSync(dir)) {
    return; // optional — totally fine without functions/
  }

  var stat;
  try {
    stat = _extFs.statSync(dir);
  } catch (e) {
    return;
  }
  if (!stat.isDirectory()) return;

  var files;
  try {
    files = _extFs.readdirSync(dir).filter(function(f) {
      return f && f.toLowerCase().endsWith('.json');
    });
  } catch (eRead) {
    console.warn('[Extensions] Cannot read functions/ for', manifest.name, eRead);
    return;
  }

  if (!files.length) {
    console.log('[Extensions] functions/ empty for', manifest.name);
    return;
  }

  var funcs = [];
  for (var i = 0; i < files.length; i++) {
    var filePath = _extPath.join(dir, files[i]);
    try {
      var raw = _extFs.readFileSync(filePath, 'utf8');
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') continue;
      if (!data.name || !data.xml) {
        console.warn(
          '[Extensions] Skip function file (need name + xml):',
          files[i], 'from', manifest.name
        );
        continue;
      }
      funcs.push({
        name: data.name,
        params: Array.isArray(data.params) ? data.params : [],
        xml: data.xml,
        timestamp: data.timestamp || 0,
        _file: files[i]
      });
    } catch (eParse) {
      console.warn(
        '[Extensions] Bad function JSON', files[i], 'from', manifest.name, ':', eParse
      );
    }
  }

  if (!funcs.length) return;

  funcs.sort(function(a, b) { return a.name.localeCompare(b.name); });

  var displayName = manifest.displayName || manifest.name;
  _extensionFunctionLibs.set(manifest.name, {
    displayName: displayName,
    basePath: basePath,
    funcs: funcs
  });

  console.log(
    '[Extensions] Loaded', funcs.length,
    'saved function(s) from', manifest.name
  );
}

/**
 * List extension-bundled functions in the same shape as listAllSavedFunctions:
 * { groupDisplayName: { path, funcs, readOnly, isExtension }, ... }
 *
 * path is "extension:<name>" so load/delete can tell sources apart.
 */
function listExtensionSavedFunctions() {
  var result = {};
  _extensionFunctionLibs.forEach(function(lib, extName) {
    if (!lib || !lib.funcs || !lib.funcs.length) return;
    var displayName = lib.displayName || extName;
    // Disambiguate if a workspace folder already uses this display name
    if (result[displayName]) {
      displayName = displayName + ' (' + extName + ')';
    }
    result[displayName] = {
      path: 'extension:' + extName,
      funcs: lib.funcs.slice(),
      readOnly: true,
      isExtension: true,
      extensionName: extName
    };
  });
  return result;
}

/**
 * Look up one function entry from an extension source key.
 * @param {string} sourceKey - "extension:<name>"
 * @param {string} funcName
 * @returns {object|null} { name, params, xml, ... }
 */
function getExtensionSavedFunction(sourceKey, funcName) {
  if (!sourceKey || String(sourceKey).indexOf('extension:') !== 0) return null;
  var extName = String(sourceKey).slice('extension:'.length);
  var lib = _extensionFunctionLibs.get(extName);
  if (!lib || !lib.funcs) return null;
  for (var i = 0; i < lib.funcs.length; i++) {
    if (lib.funcs[i].name === funcName) return lib.funcs[i];
  }
  return null;
}

function isExtensionFunctionSource(sourceKey) {
  return !!(sourceKey && String(sourceKey).indexOf('extension:') === 0);
}

// Expose for Saved Functions UI
window.listExtensionSavedFunctions = listExtensionSavedFunctions;
window.getExtensionSavedFunction = getExtensionSavedFunction;
window.isExtensionFunctionSource = isExtensionFunctionSource;

/**
 * Normalize contributes.workflows into a list of relative JSON paths.
 * Accepts:
 *   ["workflows/foo.json"]
 *   { "templates": ["workflows/foo.json"] }
 */
function _normalizeWorkflowPaths(workflowsContrib) {
  if (!workflowsContrib) return [];
  if (Array.isArray(workflowsContrib)) return workflowsContrib.slice();
  if (typeof workflowsContrib === 'object' && Array.isArray(workflowsContrib.templates)) {
    return workflowsContrib.templates.slice();
  }
  if (typeof workflowsContrib === 'string') return [workflowsContrib];
  return [];
}

/**
 * Fetch and register workflow JSON templates from an extension.
 * Templates are validated by WorkflowRegistry / WorkflowSchema.
 */
async function _loadExtensionWorkflows(manifest, basePath, workflowsContrib) {
  var paths = _normalizeWorkflowPaths(workflowsContrib);
  if (!paths.length) return;

  if (!window.WorkflowRegistry || typeof window.WorkflowRegistry.register !== 'function') {
    console.warn(
      '[Extensions] WorkflowRegistry not available; skipping workflows for',
      manifest.name
    );
    return;
  }

  var source = 'extension:' + (manifest.name || 'unknown');
  var registered = 0;

  for (var i = 0; i < paths.length; i++) {
    var rel = paths[i];
    if (!rel || typeof rel !== 'string') continue;
    var url = basePath + '/' + rel.replace(/^\//, '');
    try {
      var resp = await fetch(url);
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }
      var tpl = await resp.json();
      var ok = window.WorkflowRegistry.register(tpl, source);
      if (ok) {
        registered++;
        console.log(
          '[Extensions] Registered workflow "' + (tpl.id || rel) +
          '" from ' + manifest.name
        );
      } else {
        console.error(
          '[Extensions] Workflow template failed validation:',
          rel, 'from', manifest.name
        );
      }
    } catch (err) {
      console.error(
        '[Extensions] Failed to load workflow', rel, 'from', manifest.name, ':', err
      );
    }
  }

  // Refresh toolbox / existing blocks if Blockly is already up
  if (registered > 0) {
    try {
      if (typeof refreshWorkflowsToolbox === 'function') {
        refreshWorkflowsToolbox();
      }
      if (typeof refreshWorkflowBlocks === 'function' &&
          typeof getWorkspace === 'function') {
        var ws = getWorkspace();
        if (ws) refreshWorkflowBlocks(ws);
      }
    } catch (eRefresh) {
      // Blockly may not be initialized yet; main.js loadCore path will refresh later
      console.log(
        '[Extensions] Workflows registered for',
        manifest.name,
        '(toolbox refresh deferred until Blockly ready)'
      );
    }
  }
}

/**
 * Inject a <link rel="stylesheet"> into <head>.
 */
function _injectExtCSS(basePath, relativePath, extName) {
  return new Promise(function(resolve) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = basePath + '/' + relativePath;
    link.dataset.extension = extName;
    link.onload = resolve;
    link.onerror = resolve;
    document.head.appendChild(link);
  });
}

/**
 * Inject a <script> tag and wait for it to load.
 */
function _injectExtScript(basePath, relativePath, id) {
  return new Promise(function(resolve, reject) {
    if (document.getElementById(id)) { resolve(); return; }

    var script = document.createElement('script');
    script.id = id;
    script.src = basePath + '/' + relativePath;
    script.onload = resolve;
    script.onerror = function() { reject(new Error('Failed to load ' + relativePath)); };
    document.body.appendChild(script);
  });
}

/**
 * Inject a sidebar tab button and its corresponding view div.
 */
async function _injectSidebarTab(manifest, basePath, tabConfig) {
  var tabId = tabConfig.id || manifest.name;

  // ── Create sidebar button ──
  var sidebar = document.getElementById('sidebar');
  var tabBtn = document.createElement('div');
  tabBtn.className = 'sidebar-tab';
  tabBtn.dataset.tab = tabId;
  tabBtn.dataset.extension = manifest.name;
  tabBtn.title = tabConfig.label;

  // Icon: load SVG or use a default puzzle piece
  if (tabConfig.icon) {
    try {
      var resp = await fetch(basePath + '/' + tabConfig.icon);
      var svgText = await resp.text();
      tabBtn.innerHTML = svgText;
    } catch(e) {
      tabBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0l1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>';
    }
  } else {
    tabBtn.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0l1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/></svg>';
  }

  var label = document.createElement('span');
  label.textContent = tabConfig.label;
  tabBtn.appendChild(label);

  // Insert before settings button
  var settingsBtn = document.getElementById('settings-btn');
  if (settingsBtn) {
    sidebar.insertBefore(tabBtn, settingsBtn);
  } else {
    sidebar.appendChild(tabBtn);
  }

  // ── Create view container ──
  var appContent = document.getElementById('app-content');
  var viewDiv = document.createElement('div');
  viewDiv.id = tabId + '-view';
  viewDiv.className = 'app-view';
  viewDiv.dataset.extension = manifest.name;
  appContent.appendChild(viewDiv);

  // ── Load tab HTML content ──
  if (tabConfig.html) {
    try {
      var htmlResp = await fetch(basePath + '/' + tabConfig.html);
      viewDiv.innerHTML = await htmlResp.text();
    } catch (err) {
      viewDiv.innerHTML = '<div style="padding:20px;color:red;">Failed to load extension UI: ' + err.message + '</div>';
    }
  }

  // Click handling is done by sidebar.js event delegation
}

/**
 * Inject the extension's frontend JS on first activation (tab click).
 * No-op if already activated or no JS to load.
 */
async function activateExtensionFrontend(name) {
  var ext = _loadedExtensions.get(name);
  if (!ext || !ext.pendingJS) return;

  var jsPath = ext.pendingJS;
  delete ext.pendingJS;
  ext.status = 'active';

  await _injectExtScript(ext.basePath, jsPath, 'ext-tab-' + name);
  console.log('[Extensions] Activated frontend JS for: ' + name);
}

/**
 * Get all loaded extensions (for settings UI, etc.)
 */
function getLoadedExtensions() {
  return Array.from(_loadedExtensions.values());
}
