const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');

// Collect startup logs before the window is created so we can replay them.
// Only forward to renderer after did-finish-load to avoid stacking
// executeJavaScript listeners (which causes MaxListenersExceededWarning).
const startupLogs = [];
let _rendererReady = false;

function log(msg) {
  const line = `[Main] ${msg}`;
  console.log(line);
  startupLogs.push({ level: 'log', message: line });
  // Forward to renderer only after page has finished loading
  if (_rendererReady && mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `console.log(${JSON.stringify(line)})`
    ).catch(() => {});
  }
}

function logError(msg) {
  const line = `[Main] ${msg}`;
  console.error(line);
  startupLogs.push({ level: 'error', message: line });
  if (_rendererReady && mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `console.error(${JSON.stringify(line)})`
    ).catch(() => {});
  }
}

/**
 * Determine whether we are running inside a packaged (asar) app.
 */
function isPackaged() {
  return app.isPackaged;
}

/**
 * Find the embedded Python binary.
 * On macOS/Linux the layout is python/bin/python3.12
 * On Windows the layout is python/python.exe
 */
function findPython() {
  const isWin = process.platform === 'win32';
  const relativePath = isWin
    ? path.join('python', 'python.exe')
    : path.join('python', 'bin', 'python3.12');

  const possibilities = [
    // In packaged app – extraResources land under process.resourcesPath
    path.join(process.resourcesPath, relativePath),
    // In development – resources/python (downloaded via scripts/download-python.js)
    path.join(__dirname, 'resources', relativePath),
  ];
  for (const p of possibilities) {
    log(`Checking for Python at: ${p}`);
    if (fs.existsSync(p)) {
      log(`Found Python at: ${p}`);
      return p;
    }
  }
  logError(`Could not find embedded Python, checked: ${possibilities.join(', ')}`);
  return null;
}

/**
 * Find server.py – in a packaged app it lives in extraResources,
 * in development it is next to main.js.
 */
function findServerScript() {
  const possibilities = [
    // Packaged: extraResources copies server.py to resources/server.py
    path.join(process.resourcesPath, 'server.py'),
    // Development
    path.join(__dirname, 'server.py'),
  ];
  for (const p of possibilities) {
    log(`Checking for server.py at: ${p}`);
    if (fs.existsSync(p)) {
      log(`Found server.py at: ${p}`);
      return p;
    }
  }
  logError(`Could not find server.py, checked: ${possibilities.join(', ')}`);
  return null;
}

/**
 * Find the server/ package directory (needed on PYTHONPATH so
 * "from server.app import create_app" works).
 */
function findServerPackageDir() {
  const possibilities = [
    // Packaged: extraResources
    process.resourcesPath,
    // Development
    __dirname,
  ];
  for (const p of possibilities) {
    const serverInit = path.join(p, 'server', '__init__.py');
    if (fs.existsSync(serverInit)) {
      log(`Found server package in: ${p}`);
      return p;
    }
  }
  logError('Could not find server/ package directory');
  return null;
}

/**
 * Get the path to the user's extensions directory.
 * Creates it if it doesn't exist.
 */
function getExtensionsDir() {
  const dir = path.join(os.homedir(), '.wlkata-studiox', 'extensions');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log('Created extensions directory: ' + dir);
  }
  return dir;
}

/**
 * Discover extensions in the extensions directories.
 * Checks user dir, dev dir, and packaged app resources.
 */
function discoverExtensions() {
  const extensionsDirs = [
    // User extensions (always checked, highest priority)
    getExtensionsDir(),
    // Dev extensions (checked in development)
    path.join(__dirname, 'extensions'),
  ];

  // In packaged app, also check extraResources
  if (isPackaged()) {
    extensionsDirs.push(path.join(process.resourcesPath, 'extensions'));
  }

  const extensions = [];
  const seen = new Set();

  for (const dir of extensionsDirs) {
    if (!fs.existsSync(dir)) continue;

    let entries;
    try { entries = fs.readdirSync(dir); } catch(e) { continue; }

    for (const entry of entries) {
      const extDir = path.join(dir, entry);
      const manifestPath = path.join(extDir, 'extension.json');

      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const name = manifest.name || entry;

        // First one wins (user overrides bundled)
        if (seen.has(name)) continue;
        seen.add(name);

        extensions.push({ manifest: manifest, path: extDir });
        log('Extension found: ' + (manifest.displayName || name) + ' (' + extDir + ')');
      } catch (err) {
        logError('Invalid extension manifest in ' + entry + ': ' + err.message);
      }
    }
  }

  log('Discovered ' + extensions.length + ' extension(s)');
  return extensions;
}

let mainWindow;
let pythonProcess;
let serverPort = 5080; // Will be updated to an available port

/**
 * Kill the main Python server and all its child processes (extension subprocesses).
 */
function killPythonTree() {
  if (!pythonProcess) return;
  const pid = pythonProcess.pid;
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the entire process tree on Windows
      require('child_process').execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      // Send SIGTERM to the entire process group (negative PID)
      process.kill(-pid, 'SIGTERM');
    }
  } catch (_) {
    // Fallback: kill just the main process
    try { pythonProcess.kill(); } catch (_) {}
  }
  pythonProcess = null;
}
let _discoveredExtensions = [];

const DEFAULT_PORT = 5080;

/**
 * Check if a port is available by attempting to create a server on it.
 * @param {number} port - The port to check
 * @returns {Promise<boolean>} True if the port is available
 */
function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Find an available port starting from the given port.
 * Increments by 1 until an available port is found.
 * @param {number} startPort - The port to start checking from
 * @returns {Promise<number>} The first available port
 */
async function findAvailablePort(startPort) {
  let port = startPort;
  while (port < startPort + 100) { // Check up to 100 ports
    if (await isPortAvailable(port)) {
      return port;
    }
    log(`Port ${port} is in use, trying ${port + 1}...`);
    port++;
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + 99}`);
}

function buildAppMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    // App menu (macOS only)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        {
          label: 'Settings...',
          accelerator: 'Cmd+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(
                'if (typeof openSettings === "function") openSettings();'
              ).catch(() => {});
            }
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    // File menu
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Workspace...',
          accelerator: isMac ? 'Cmd+O' : 'Ctrl+O',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(
                'if (typeof switchWorkspace === "function") switchWorkspace();'
              ).catch(() => {});
            }
          }
        },
        {
          label: 'Save',
          accelerator: isMac ? 'Cmd+S' : 'Ctrl+S',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(
                'if (typeof saveWorkspaceBlocks === "function") saveWorkspaceBlocks();'
              ).catch(() => {});
            }
          }
        },
        { type: 'separator' },
        ...(!isMac ? [{
          label: 'Settings...',
          accelerator: 'Ctrl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.executeJavaScript(
                'if (typeof openSettings === "function") openSettings();'
              ).catch(() => {});
            }
          }
        }] : []),
        ...(!isMac ? [{ type: 'separator' }] : []),
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    // Edit menu
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    // View menu
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    // Window menu
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [
          { type: 'separator' },
          { role: 'front' }
        ] : [
          { role: 'close' }
        ])
      ]
    },
    // Help menu
    {
      label: 'Help',
      submenu: [
        {
          label: 'WLKATA Website',
          click: () => { shell.openExternal('https://www.wlkata.com'); }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'resources', 'icons', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  buildAppMenu();
  mainWindow.loadFile('index.html');

  // Open DevTools to see errors (remove this line for production)
  // mainWindow.webContents.openDevTools();

  // Replay any startup logs that were collected before the window opened,
  // and communicate the server port to the renderer.
  mainWindow.webContents.on('did-finish-load', () => {
    // Set the dynamic server port in the renderer
    mainWindow.webContents.executeJavaScript(
      `if (typeof setServerPort === 'function') { setServerPort(${serverPort}); }`
    ).catch(() => {});

    // Log the localStorage file path so users can find it
    const userDataPath = app.getPath('userData');
    const localStoragePath = path.join(userDataPath, 'Local Storage', 'leveldb');
    mainWindow.webContents.executeJavaScript(
      `console.log('[Main] Electron userData path: ${userDataPath.replace(/\\/g, '\\\\')}');` +
      `console.log('[Main] localStorage stored in: ${localStoragePath.replace(/\\/g, '\\\\')}');`
    ).catch(() => {});

    for (const entry of startupLogs) {
      const fn = entry.level === 'error' ? 'console.error' : 'console.log';
      mainWindow.webContents.executeJavaScript(
        `${fn}(${JSON.stringify(entry.message)})`
      ).catch(() => {});
    }

    // Load extensions into renderer
    if (_discoveredExtensions.length > 0) {
      const extData = _discoveredExtensions.map(e => ({
        manifest: e.manifest,
        basePath: e.path
      }));
      mainWindow.webContents.executeJavaScript(
        `if (typeof loadExtensions === 'function') loadExtensions(${JSON.stringify(extData)});`
      ).catch(() => {});
    }

    _rendererReady = true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    killPythonTree();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function startPythonServer() {
  return new Promise((resolve, reject) => {
    const pythonCmd = findPython();
    if (!pythonCmd) {
      return reject(new Error('Python binary not found'));
    }

    const serverPath = findServerScript();
    if (!serverPath) {
      return reject(new Error('server.py not found'));
    }

    const serverPkgDir = findServerPackageDir();

    // Build the Python environment so the embedded interpreter can find
    // its own standard library, site-packages, and the server/ package.
    // On macOS/Linux the binary is at python/bin/python3.12 → pythonDir = python/
    // On Windows the binary is at python/python.exe       → pythonDir = python/
    const isWin = process.platform === 'win32';
    const pythonDir = isWin
      ? path.dirname(pythonCmd)            // …/python
      : path.dirname(path.dirname(pythonCmd)); // …/python
    const pythonLibDir = isWin
      ? path.join(pythonDir, 'Lib')        // Windows: python/Lib
      : path.join(pythonDir, 'lib', 'python3.12'); // macOS/Linux: python/lib/python3.12
    const sitePackagesDir = path.join(pythonLibDir, 'site-packages');

    const env = Object.assign({}, process.env);

    // PYTHONHOME tells the embedded Python where its prefix is
    env.PYTHONHOME = pythonDir;

    // PYTHONPATH: include site-packages + the directory containing server/
    const pythonPathParts = [sitePackagesDir];
    if (serverPkgDir) {
      pythonPathParts.push(serverPkgDir);
    }
    env.PYTHONPATH = pythonPathParts.join(path.delimiter);

    // Prevent Python from trying to write .pyc files (may fail in read-only locations)
    env.PYTHONDONTWRITEBYTECODE = '1';

    log(`Starting Python server: ${pythonCmd} ${serverPath}`);
    log(`PYTHONHOME=${env.PYTHONHOME}`);
    log(`PYTHONPATH=${env.PYTHONPATH}`);
    log(`CWD for server: ${serverPkgDir || __dirname}`);

    const serverArgs = ['-u', serverPath, '--port', String(serverPort)];

    // Pass all extensions directories to the Flask server
    const extDirs = [getExtensionsDir()];
    const devExtDir = path.join(__dirname, 'extensions');
    if (fs.existsSync(devExtDir)) extDirs.push(devExtDir);
    if (isPackaged()) {
      const bundledExtDir = path.join(process.resourcesPath, 'extensions');
      if (fs.existsSync(bundledExtDir)) extDirs.push(bundledExtDir);
    }
    for (const d of extDirs) {
      serverArgs.push('--extensions-dir', d);
    }

    pythonProcess = spawn(pythonCmd, serverArgs, {
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: serverPkgDir || __dirname,
      env: env,
    });

    let resolved = false;

    pythonProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        log(`[Python stdout] ${output}`);
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        logError(`[Python stderr] ${output}`);
      }
    });

    pythonProcess.on('error', (error) => {
      logError(`Failed to start Python process: ${error.message}`);
      if (!resolved) {
        resolved = true;
        reject(error);
      }
    });

    pythonProcess.on('close', (code) => {
      log(`Python server exited with code ${code}`);
    });

    // Resolve immediately – we poll for readiness separately
    resolve();
  });
}

// Check if server is ready
function waitForServer(maxAttempts = 50) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    const checkServer = () => {
      attempts++;

      const req = http.get(`http://127.0.0.1:${serverPort}/health`, (res) => {
        if (res.statusCode === 200) {
          log('Python server is ready!');
          resolve();
        } else {
          log(`Health check attempt ${attempts}: status ${res.statusCode}`);
          if (attempts < maxAttempts) {
            setTimeout(checkServer, 200);
          } else {
            reject(new Error(`Server returned status ${res.statusCode}`));
          }
        }
      });

      req.on('error', (err) => {
        if (attempts < maxAttempts) {
          setTimeout(checkServer, 200);
        } else {
          reject(new Error(`Failed to connect to server after ${maxAttempts} attempts: ${err.message}`));
        }
      });

      req.setTimeout(1000, () => {
        req.destroy();
        if (attempts < maxAttempts) {
          setTimeout(checkServer, 200);
        } else {
          reject(new Error('Connection timeout'));
        }
      });
    };

    // Give the server a moment to start before checking
    setTimeout(checkServer, 500);
  });
}

app.whenReady().then(async () => {
  try {
    log(`App is packaged: ${isPackaged()}`);
    log(`__dirname: ${__dirname}`);
    log(`resourcesPath: ${process.resourcesPath}`);

    // Discover extensions before starting the server
    _discoveredExtensions = discoverExtensions();

    // Find an available port starting from the default
    serverPort = await findAvailablePort(DEFAULT_PORT);
    log(`Using port ${serverPort} for Python server`);

    // Start Python server (non-blocking)
    await startPythonServer();

    // Wait for server to be ready
    await waitForServer();

    // Now create the window
    createWindow();
    log('Application started successfully!');
  } catch (error) {
    logError(`Failed to start application: ${error.message}`);
    // Create window anyway to show error
    createWindow();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  killPythonTree();
  app.quit();
});

// Handle IPC messages from renderer
ipcMain.handle('execute-code', async (event, code) => {
  // The frontend will directly communicate with the Python server via HTTP
  // This is just a placeholder for any Electron-native operations if needed
  return { success: true };
});

// ── Workspace folder dialogs (native OS) ────────────────────────

/**
 * Open an existing folder using the native OS file picker.
 * Returns the selected folder path, or null if cancelled.
 */
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Workspace Folder',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Open',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * Create a new folder using the native OS save dialog.
 * The user picks a location and types a folder name.
 * Returns the created folder path, or null if cancelled.
 */
ipcMain.handle('dialog:createFolder', async () => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Create New Workspace Folder',
    buttonLabel: 'Create',
    nameFieldLabel: 'Workspace Name',
    showsTagField: false,
  });
  if (result.canceled || !result.filePath) return null;

  // Create the folder if it doesn't exist
  const folderPath = result.filePath;
  if (!fs.existsSync(folderPath)) {
    fs.mkdirSync(folderPath, { recursive: true });
    log(`Created workspace folder: ${folderPath}`);
  }
  return folderPath;
});

/**
 * Open a firmware file using the native OS file picker.
 * Defaults to the resources/firmware folder in the app.
 * Returns { path, name } or null if cancelled.
 */
ipcMain.handle('dialog:selectFirmware', async (event, fileType) => {
  // Determine the default path (resources folder)
  let defaultPath;
  if (isPackaged()) {
    // In packaged app, resources are in the app's resources directory
    defaultPath = path.join(process.resourcesPath, 'firmware');
  } else {
    // In development, use the resources folder in the project
    defaultPath = path.join(__dirname, 'resources', 'firmware');
  }

  // Fall back to resources folder if firmware subfolder doesn't exist
  if (!fs.existsSync(defaultPath)) {
    defaultPath = isPackaged()
      ? process.resourcesPath
      : path.join(__dirname, 'resources');
  }

  // Set file filters based on type
  const filters = fileType === 'extender'
    ? [{ name: 'ESP32 Firmware', extensions: ['bin'] }]
    : [{ name: 'AVR Firmware', extensions: ['hex'] }];

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Firmware File',
    defaultPath: defaultPath,
    properties: ['openFile'],
    filters: filters,
    buttonLabel: 'Select',
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  
  const filePath = result.filePaths[0];
  return {
    path: filePath,
    name: path.basename(filePath)
  };
});

// ── Extension management (native OS) ────────────────────────────

/**
 * Return the user extensions directory path.
 */
ipcMain.handle('extensions:getDir', () => {
  return getExtensionsDir();
});

/**
 * List installed extensions from the user extensions directory.
 * Returns array of { name, displayName, version, description, path }.
 */
ipcMain.handle('extensions:list', () => {
  const dir = getExtensionsDir();
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { return results; }
  for (const entry of entries) {
    const extDir = path.join(dir, entry);
    const manifestPath = path.join(extDir, 'extension.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      results.push({
        name: manifest.name || entry,
        displayName: manifest.displayName || manifest.name || entry,
        version: manifest.version || '',
        description: manifest.description || '',
        path: extDir,
      });
    } catch (e) {
      results.push({ name: entry, displayName: entry, version: '', description: 'Invalid manifest', path: extDir });
    }
  }
  return results;
});

/**
 * Install an extension from a folder (copies into user extensions dir).
 * Returns { success, name } or { success: false, error }.
 */
ipcMain.handle('extensions:installFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Extension Folder',
    properties: ['openDirectory'],
    buttonLabel: 'Install',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const srcDir = result.filePaths[0];
  const manifestPath = path.join(srcDir, 'extension.json');
  if (!fs.existsSync(manifestPath)) {
    return { success: false, error: 'Selected folder has no extension.json manifest.' };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (e) {
    return { success: false, error: 'Invalid extension.json: ' + e.message };
  }

  const name = manifest.name || path.basename(srcDir);
  const dest = path.join(getExtensionsDir(), name);

  try {
    _copyDirSync(srcDir, dest);
    log('Extension installed from folder: ' + name);
    const reqPath = path.join(dest, 'requirements.txt');
    const requirements = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : null;
    return { success: true, name: name, requirements: requirements };
  } catch (e) {
    return { success: false, error: 'Copy failed: ' + e.message };
  }
});

/**
 * Install an extension from a .zip file (extracts into user extensions dir).
 * Returns { success, name } or { success: false, error }.
 */
ipcMain.handle('extensions:installZip', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Extension Zip',
    properties: ['openFile'],
    filters: [{ name: 'Zip Archives', extensions: ['zip'] }],
    buttonLabel: 'Install',
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const zipPath = result.filePaths[0];
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    // Find extension.json to detect root folder inside zip
    let manifestEntry = null;
    for (const entry of entries) {
      const parts = entry.entryName.replace(/\\/g, '/').split('/').filter(Boolean);
      if (parts[parts.length - 1] === 'extension.json') {
        if (!manifestEntry || parts.length < manifestEntry.depth) {
          manifestEntry = { entry, depth: parts.length, prefix: parts.slice(0, -1).join('/') };
        }
      }
    }
    if (!manifestEntry) {
      return { success: false, error: 'Zip does not contain an extension.json manifest.' };
    }

    const manifest = JSON.parse(manifestEntry.entry.getData().toString('utf-8'));
    const name = manifest.name || path.basename(zipPath, '.zip');
    const dest = path.join(getExtensionsDir(), name);
    const prefix = manifestEntry.prefix ? manifestEntry.prefix + '/' : '';

    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.mkdirSync(dest, { recursive: true });

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const entryPath = entry.entryName.replace(/\\/g, '/');
      if (prefix && !entryPath.startsWith(prefix)) continue;
      const relative = prefix ? entryPath.slice(prefix.length) : entryPath;
      if (!relative) continue;
      const destFile = path.join(dest, relative);
      fs.mkdirSync(path.dirname(destFile), { recursive: true });
      fs.writeFileSync(destFile, entry.getData());
    }

    log('Extension installed from zip: ' + name);
    const reqPath = path.join(dest, 'requirements.txt');
    const requirements = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf-8') : null;
    return { success: true, name: name, requirements: requirements };
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      return { success: false, error: 'Zip support requires the adm-zip package. Install it with: npm install adm-zip' };
    }
    return { success: false, error: 'Zip extraction failed: ' + e.message };
  }
});

/**
 * Remove an extension by deleting its folder from the user extensions dir.
 */
ipcMain.handle('extensions:remove', async (event, name) => {
  const extDir = path.join(getExtensionsDir(), name);
  if (!fs.existsSync(extDir)) {
    return { success: false, error: 'Extension folder not found.' };
  }
  try {
    fs.rmSync(extDir, { recursive: true, force: true });
    log('Extension removed: ' + name);
    return { success: true };
  } catch (e) {
    return { success: false, error: 'Delete failed: ' + e.message };
  }
});

/**
 * Recursively copy a directory.
 */
function _copyDirSync(src, dest) {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}