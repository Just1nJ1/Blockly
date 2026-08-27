# WLKATA StudioX Extension Development Guide

Build custom extensions for WLKATA StudioX. Extensions can add new backend
endpoints (Python/Flask), new frontend tabs (HTML/JS/CSS), Blockly workflow
templates, and default saved functions.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Extension Structure](#extension-structure)
3. [The Manifest File](#the-manifest-file)
4. [Frontend Development](#frontend-development)
5. [Backend Development](#backend-development)
6. [Blockly Workflow Templates](#blockly-workflow-templates)
7. [Default Saved Functions](#default-saved-functions-functions)
8. [Available APIs for Extensions](#available-apis-for-extensions)
9. [Robot Interaction](#robot-interaction)
10. [Installation](#installation)
11. [Tips & Limitations](#tips--limitations)

---

## Quick Start

1. Create a folder in `~/.wlkata-studiox/extensions/` (or in this `extensions/`
   directory during development):

```
my-extension/
  extension.json
  frontend/
    index.html
    main.js
    styles.css
    icon.svg
  backend/
    main.py
```

2. Define `extension.json`:

```json
{
  "name": "my-extension",
  "displayName": "My Extension",
  "version": "1.0.0",
  "description": "A short description of what this extension does.",
  "contributes": {
    "sidebarTab": {
      "id": "my-extension",
      "label": "My Extension",
      "icon": "frontend/icon.svg",
      "html": "frontend/index.html",
      "js": "frontend/main.js",
      "css": "frontend/styles.css"
    },
    "backend": {
      "main": "backend/main.py"
    }
  }
}
```

3. Restart StudioX. Your extension appears as a new sidebar tab.

---

## Extension Structure

A minimal extension only needs `extension.json` and at least one contribution
(frontend tab, backend, Blockly workflows, and/or default functions). Here is
the full layout:

```
my-extension/
├── extension.json          # Required. Manifest describing the extension.
├── frontend/               # Optional. Frontend assets for a sidebar tab.
│   ├── index.html          #   Tab content (injected into the app).
│   ├── main.js             #   Tab logic (runs after HTML is in the DOM).
│   ├── styles.css          #   Tab styles (scoped by convention, not enforced).
│   └── icon.svg            #   Sidebar icon (22x22, stroke-based recommended).
├── backend/                # Optional. Python backend with Flask routes.
│   └── main.py             #   Must export a `blueprint` variable.
├── workflows/              # Optional. Blockly workflow template JSON files.
│   └── my_pipeline.json    #   Listed under contributes.workflows
└── functions/              # Optional. Default saved-function JSON (auto-scanned).
    └── my_helper.json      #   Same schema as workspace functions/*.json
```

You can include **only a frontend** (UI-only), **only a backend** (headless
service), **only workflows**, **only functions**, or any combination. Omitting
`functions/` entirely is fine — StudioX simply loads nothing from that
extension into the Saved Functions panel.

---

## The Manifest File

`extension.json` is the entry point. StudioX reads this to discover what the
extension provides.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | Yes | Unique identifier. Use lowercase with hyphens (e.g. `webcam-cv`). |
| `displayName` | string | No | Human-readable name shown in the UI. Falls back to `name`. |
| `version` | string | No | Semver version string. |
| `description` | string | No | Short description of the extension. |
| `contributes` | object | Yes | What the extension provides (see below). |

### `contributes.sidebarTab`

Adds a tab to the left sidebar (like Command, Blockly, and Teaching).

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | No | DOM id for the tab view. Defaults to `name`. Must be unique. |
| `label` | string | Yes | Text shown under the sidebar icon. |
| `icon` | string | No | Path to an SVG icon (relative to extension root). Falls back to a default icon. |
| `html` | string | Yes | Path to the HTML file for the tab content. |
| `js` | string | No | Path to a JS file loaded after the HTML is injected. |
| `css` | string | No | Path to a CSS file loaded before the HTML. |

### `contributes.backend`

Registers a Python Flask Blueprint on the server.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `main` | string | Yes | Path to the Python entry file (relative to extension root). |

The Python file **must** export a module-level variable named `blueprint` that
is a `flask.Blueprint` instance. All routes on this blueprint are mounted at
`/ext/<name>/`.

### `contributes.workflows`

Registers **Blockly workflow templates** so they appear under the **Workflows**
toolbox category as `workflow_run` blocks. Users pick slot functions in Blockly;
StudioX generates real Python (not HTTP calls to your extension tab).

| Format | Example |
|--------|---------|
| Array of paths | `"workflows": ["workflows/my_pipeline.json"]` |
| Object form | `"workflows": { "templates": ["workflows/a.json", "workflows/b.json"] }` |

Paths are relative to the extension root. Templates load **eagerly** when the
extension is discovered (not on first sidebar-tab click), so they show up in
Blockly even if the user never opens your tab.

See [Blockly Workflow Templates](#blockly-workflow-templates) for the full
schema and examples. Core docs also live in `workflows/README.md` in the app
repo.

### Default saved functions (`functions/`)

Drop procedure library JSON files under a **`functions/`** folder at the
extension root. StudioX **auto-scans** that directory when the extension loads
— you do **not** list files in `extension.json`.

| Behavior | Detail |
|----------|--------|
| Discovery | Every `functions/*.json` file is read on extension load |
| Optional | Missing `functions/`, empty folder, or zero valid files → no-op |
| UI | Appears in the **Saved Functions** panel under the extension’s `displayName`, with an **extension** badge |
| Insert | Users can **+ Add**, double-click, or drag onto the Blockly workspace (same as workspace libraries) |
| Read-only | Extension-bundled functions cannot be deleted from the panel; ship updates by changing the extension files |
| Schema | Same as user workspace `functions/*.json` (see below) |

**File schema** (one procedure per file):

```json
{
  "name": "my_helper",
  "params": ["robot", "target"],
  "xml": "<xml xmlns=\"https://developers.google.com/blockly/xml\">…</xml>",
  "timestamp": 0
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Procedure name (must match the definition block’s name) |
| `xml` | Yes | Blockly XML of the `procedures_defreturn` / `procedures_defnoreturn` tree |
| `params` | No | Parameter names for display in the Saved Functions card |
| `timestamp` | No | Optional metadata |

Files that are not valid JSON, or that lack `name` / `xml`, are skipped with a
console warning; other files in the same folder still load.

**Authoring tip:** In StudioX, build the function with blocks, right-click the
definition → **Save to Library**, then copy the generated
`<workspace>/functions/<name>.json` into your extension’s `functions/` folder.

Example layout for a vision pick extension:

```
cv-pick/
├── extension.json
├── functions/
│   ├── detect_pick_point.json
│   └── grasp_and_place.json
└── workflows/
    └── cv_pick.json
```

---

## Frontend Development

### HTML

Your `index.html` is injected as the inner HTML of a `<div>` inside
`#app-content`. It is **not** a full HTML document — do not include `<html>`,
`<head>`, or `<body>` tags. Write it as a fragment:

```html
<div class="my-ext-container">
  <h2>My Extension</h2>
  <button id="my-ext-btn">Do Something</button>
  <div id="my-ext-output"></div>
</div>
```

### JavaScript

Your `main.js` runs after the HTML is in the DOM. You have access to the full
page and the global `ExtensionAPI` object:

```js
(function() {
  var btn = document.getElementById('my-ext-btn');
  var output = document.getElementById('my-ext-output');

  btn.addEventListener('click', async function() {
    // Call your own backend
    var result = await ExtensionAPI.fetch('my-extension', '/do-something', {
      method: 'POST',
      body: JSON.stringify({ param: 'value' })
    });
    output.textContent = JSON.stringify(result, null, 2);
  });
})();
```

### CSS

Your `styles.css` is injected as a global stylesheet. To avoid conflicts with
the app or other extensions, **scope all selectors** using a unique prefix:

```css
.my-ext-container {
  padding: 20px;
  height: 100%;
  overflow-y: auto;
}

.my-ext-container h2 {
  margin-top: 0;
  color: var(--text-primary);
}

.my-ext-container button {
  background: var(--accent);
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}
```

Use the app's CSS custom properties (e.g. `var(--text-primary)`,
`var(--bg-primary)`, `var(--accent)`, `var(--border-primary)`) to match the
current theme and support dark mode automatically.

### Sidebar Icon

Provide a 22x22 SVG using `stroke="currentColor"` so it adapts to the theme:

```svg
<svg width="22" height="22" viewBox="0 0 24 24" fill="none"
     stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="10"/>
  <line x1="12" y1="8" x2="12" y2="16"/>
  <line x1="8" y1="12" x2="16" y2="12"/>
</svg>
```

If no icon is provided, a default puzzle-piece icon is used.

---

## Backend Development

Your backend is a standard Flask Blueprint. StudioX registers it at
`/ext/<name>/`, so if your extension is named `webcam`, a route
`@bp.route('/capture')` becomes accessible at `/ext/webcam/capture`.

### Minimal backend/main.py

```python
from flask import Blueprint, request, jsonify

blueprint = Blueprint('my_extension', __name__)


@blueprint.route('/hello', methods=['GET'])
def hello():
    return jsonify({'success': True, 'message': 'Hello from my extension!'})


@blueprint.route('/process', methods=['POST'])
def process():
    data = request.get_json() or {}
    value = data.get('input', '')
    # Do your processing here
    return jsonify({'success': True, 'result': value.upper()})
```

### Accessing the Robot from Backend Code

If your backend needs to send commands to the robot (e.g. for automation),
import the SerialManager:

```python
from server.serial_manager import SerialManager

def get_robot_connection(port=None):
    """Get the active robot connection (or a specific port)."""
    mgr = SerialManager.get_instance()
    if port and port in mgr._ports:
        return mgr._ports[port]
    return mgr.active_connection

@blueprint.route('/move-home', methods=['POST'])
def move_home():
    conn = get_robot_connection()
    if not conn or not conn.connected or not conn.robot:
        return jsonify({'success': False, 'error': 'No robot connected'})
    conn.robot.homing()
    return jsonify({'success': True})
```

### Python Dependencies

If your extension requires additional Python packages (e.g. `opencv-python`),
list them in a `requirements.txt` inside your extension folder:

```
# my-extension/requirements.txt
opencv-python>=4.8
numpy
```

When a user installs the extension via **Settings > Extensions**, StudioX
automatically detects `requirements.txt`, creates a virtual environment named
after the extension (powered by `uv`), and installs all listed packages. Users
can also manage environments and packages manually via **Settings >
Environments**.

---

## Blockly Workflow Templates

**Yes — extensions can ship workflows.** A workflow is a fixed multi-step
pipeline (JSON) where some steps are **slots** filled by the user’s Blockly
functions. Codegen emits a **callback-style runner**: slot algorithms are
parameters of a `def` pipeline, then the runner is invoked with the selected
functions and context values (not hard-coded direct calls only).

### When to use a workflow

| Use a **workflow** when… | Use a **sidebar tab** when… |
|--------------------------|-----------------------------|
| The task is “run this pipeline in Blockly / Run” | The user needs an interactive UI (camera, teach, calibration) |
| Algorithms in the middle should be swappable as functions | You need live feedback, canvas, or continuous polling |
| Output should be clean generated Python | Logic should live on your Flask routes |

Do **not** generate HTTP calls from workflow codegen to an interactive tab.
Put library/helper Python on `sys.path` via `imports` if needed, or document
that users call your backend from a custom function body.

### Manifest example

```json
{
  "name": "coin-pick",
  "displayName": "Coin Pick",
  "version": "1.0.0",
  "description": "Detect and pick coins with swappable vision algorithms.",
  "contributes": {
    "workflows": [
      "workflows/detect_and_pick.json"
    ],
    "sidebarTab": {
      "id": "coin-pick",
      "label": "Coin Pick",
      "icon": "frontend/icon.svg",
      "html": "frontend/index.html",
      "js": "frontend/main.js",
      "css": "frontend/styles.css"
    }
  }
}
```

Workflows-only extensions are valid: omit `sidebarTab` / `backend` if you only
need toolbox templates.

### Template JSON (v1)

```json
{
  "id": "coin_pick_pipeline",
  "name": "Detect and Pick",
  "description": "Capture → detect poses → pick each pose with the robot.",
  "version": "1.0.0",
  "imports": [],
  "context": [
    {
      "name": "robot",
      "type": "Robot",
      "blockly": "robot_var",
      "required": true
    }
  ],
  "steps": [
    {
      "id": "detect",
      "label": "Detect poses",
      "pattern": "single",
      "inputs": [],
      "output": { "name": "poses", "type": "Any" },
      "slot": {
        "required": true,
        "signature": {
          "params": [],
          "returns": "Any"
        },
        "placeholderLabel": "Choose detect function…"
      }
    },
    {
      "id": "pick_each",
      "label": "Pick each pose",
      "pattern": "list_iter",
      "iterOver": "poses",
      "itemName": "pose",
      "inputs": [
        { "name": "robot", "from": "context.robot" },
        { "name": "pose", "from": "iter.pose" }
      ],
      "slot": {
        "required": true,
        "signature": {
          "params": [
            { "name": "robot", "type": "Robot" },
            { "name": "pose", "type": "Any" }
          ],
          "returns": "void"
        },
        "placeholderLabel": "Choose pick function…"
      }
    }
  ]
}
```

#### Required fields

| Field | Description |
|-------|-------------|
| `id` | Stable id (mutation + codegen). Prefer `extensionname_pipeline`. |
| `name` | Label in the Workflows toolbox / block header. |
| `steps` | Non-empty ordered pipeline. |

#### Context (`context[]`)

Inputs fixed on the workflow block:

| `blockly` | UI |
|-----------|-----|
| `robot_var` | Robot variable dropdown (same as move blocks) |
| `number` / `value` / `any` | Value socket with default number shadow (`default` sets NUM) |
| other / omitted | Plain text field |

#### Step patterns

| Pattern | Behavior |
|---------|----------|
| `single` | Call once; optional `output` binding |
| `list_iter` | `for item in <list>: call(...)` — needs `iterOver` + `itemName` |
| `pass_through` | Bind a value without a slot |

#### Slots vs fixed calls

- **`slot`** — user picks (or creates with **+**) a workspace procedure whose
  parameter count matches `signature.params`.
- **`call`** — fixed callable name (e.g. `"print"`) with no dropdown.

#### Wiring `inputs[].from`

- `context.<name>` — block context field  
- `iter.<itemName>` — loop variable inside `list_iter`  
- bare name — prior step’s `output.name`

Full schema notes and the built-in **Process and Combine** example:
`workflows/README.md` and `workflows/process_and_combine.json` in the app tree.

### Register from JavaScript (optional)

Prefer `contributes.workflows` for static JSON. If you build a template at
runtime (e.g. after loading config), register it yourself:

```js
(function () {
  var tpl = {
    id: 'my_ext_dynamic',
    name: 'Dynamic Pipeline',
    description: 'Registered from extension JS',
    context: [],
    steps: [
      {
        id: 'run',
        label: 'Run',
        pattern: 'single',
        call: 'print',
        inputs: [{ name: 'value', from: 'context.msg' }],
        // …or use a slot instead of call
      }
    ]
  };

  // If you still use context, declare it on the template; this sketch is illustrative.
  if (window.WorkflowRegistry && WorkflowRegistry.register(tpl, 'extension:my-extension')) {
    if (typeof refreshWorkflowsToolbox === 'function') refreshWorkflowsToolbox();
    if (typeof refreshWorkflowBlocks === 'function' && typeof getWorkspace === 'function') {
      var ws = getWorkspace();
      if (ws) refreshWorkflowBlocks(ws);
    }
  }
})();
```

> **Note:** Sidebar `frontend/main.js` is **lazy** (runs on first tab open).
> Templates listed in `contributes.workflows` are **not** lazy — use the
> manifest for anything that must appear in Blockly immediately.

### Validation

Invalid templates are rejected with console errors from `WorkflowSchema`
(missing `id` / `name` / `steps`, bad patterns, bad `iterOver` refs, etc.).
Check the DevTools console if a workflow does not show up after install.

### User experience

1. User opens **Blockly** → **Workflows** category.  
2. Drops your template block.  
3. Fills context + slot functions (**+** creates a matching stub).  
4. **Run** → generated Python looks like:

```python
def my_pipeline(detect, pick_each, robot):
  poses = detect()
  for pose in poses:
    pick_each(robot, pose)

my_pipeline(user_detect, user_pick, robot)
```

(`detect` / `pick_each` are parameters; `user_detect` / `user_pick` are the
workspace functions chosen on the block.)

---

## Available APIs for Extensions

### Frontend: `ExtensionAPI` (JavaScript)

The global `window.ExtensionAPI` object is available to all extension scripts.

#### Calling Your Own Backend

```js
// GET request
var data = await ExtensionAPI.fetch('my-extension', '/status');

// POST request with JSON body
var data = await ExtensionAPI.fetch('my-extension', '/process', {
  method: 'POST',
  body: JSON.stringify({ input: 'hello' })
});
```

This calls `http://127.0.0.1:<port>/ext/my-extension/status` (or `/process`)
with the correct headers.

#### Robot Control

Use `fetch()` to call the server's robot-control endpoints directly.
`ExtensionAPI.getServerUrl()` returns the base URL (e.g. `http://127.0.0.1:5080`).

```js
var serverUrl = ExtensionAPI.getServerUrl();

// Absolute move (multi-axis) — motion: 0=Fast, 1=Linear
fetch(serverUrl + '/cmd/jog', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'coord', motion: 1, values: { x: 150, y: 0, z: 200 }, isAbsolute: true })
});

// Absolute move (single-axis)
fetch(serverUrl + '/cmd/jog', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'coord', axis: 'X', step: 150, isAbsolute: true })
});

// Incremental jog (e.g. +5 mm on X)
fetch(serverUrl + '/cmd/jog', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'coord', axis: 'X', step: 5 })
});

// Suction cup on / off
fetch(serverUrl + '/cmd/pump', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 1 })   // 1 = on, 0 = off
});

// Get the robot's current status (joint angles, coordinates, state)
var status = await ExtensionAPI.getRobotStatus();
// status = {
//   success: true,
//   state: 'Idle',
//   model: 'Mirobot',
//   angles:      { A: 0, B: 0, C: 0, D: 0, X: 0, Y: 0, Z: 0 },
//   coordinates: { X: 200, Y: 0, Z: 230, Rx: 0, Ry: 0, Rz: 0 },
//   pump: 0, valve: 0, mode: 0
// }

// List all detected/connected robotic arms
var devices = await ExtensionAPI.getDevices();
// devices = {
//   success: true,
//   ports: [
//     { port: '/dev/ttyUSB0', model: 'Mirobot', connected: true, manual: false },
//     { port: 'COM7',         model: 'MT4',     connected: true, manual: true  }
//   ]
// }
```

#### UI Helpers

```js
// Show a notification in the command output area
ExtensionAPI.showNotification('Operation complete!', 'info');
ExtensionAPI.showNotification('Something went wrong', 'error');
```

#### Persistent Settings (localStorage)

```js
// Store and retrieve extension-specific settings (survives app restarts)
ExtensionAPI.setData('my-extension', 'lastCalibration', { x: 10, y: 20 });
var cal = ExtensionAPI.getData('my-extension', 'lastCalibration');
```

#### Tab Lifecycle Hooks

Extensions can register callbacks that fire when the user switches tabs.
This is ideal for pausing expensive work (camera streams, polling loops)
when the extension is not visible.

```js
// Called every time the user switches TO your tab
ExtensionAPI.onActivate('my-extension', function () {
  startCamera();
});

// Called when the user switches AWAY from your tab
ExtensionAPI.onDeactivate('my-extension', function () {
  stopCamera();
});

// Check visibility at any time
if (ExtensionAPI.isActive('my-extension')) {
  // tab is currently showing
}
```

**Typical pattern** — the IIFE handles first-time setup, lifecycle hooks
handle pause/resume:

```js
(function () {
  var polling = false;

  function start() { /* open camera, set polling = true, begin loop */ }
  function stop()  { polling = false; /* release resources */ }

  ExtensionAPI.onActivate('my-extension', start);
  ExtensionAPI.onDeactivate('my-extension', stop);

  // First activation (script is lazy-loaded on first tab click)
  start();
})();
```

### Backend: Relevant Server Endpoints

Your backend code can also make internal HTTP requests to the existing server
endpoints, but in most cases using `SerialManager` directly is simpler.

> **Note:** All `port` parameters are optional. When omitted the server uses
> the currently active connection. Pass `port` only when targeting a specific
> robot among multiple connected devices.

---

#### `GET /cmd/status`

Connection status. No parameters.

**Response:** `{ success, port, model, connected, busy }`

---

#### `GET /detect-devices`

Scan serial ports for connected robotic arms. No parameters.

**Response:** `{ success, ports: [{ port, model, connected, manual }, ...] }`

- `connected` — `true` if the serial connection is open, `false` if still detecting
- `manual` — `true` if the port was added via "Connect manually…"

---

#### `POST /cmd/get-status`

Query the robot's current position and state via the SDK. Sends a serial
query and waits for a response.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | string | — | Serial port to query |
| `silent` | bool | `false` | If `true`, suppresses adding the query to the command history |

**Response:**
```json
{
  "success": true,
  "state": "Idle",
  "model": "Mirobot",
  "angles":      { "A": 0, "B": 0, "C": 0, "D": 0, "X": 0, "Y": 0, "Z": 0 },
  "coordinates": { "X": 200, "Y": 0, "Z": 230, "Rx": 0, "Ry": 0, "Rz": 0 },
  "pump": 0, "valve": 0, "mode": 0
}
```

---

#### `POST /cmd/last-status`

Return the cached auto-reported status (from `$40=1`). Unlike
`/cmd/get-status`, this does **not** send a serial query — it returns the
last value received from the robot's auto-report stream.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | string | — | Serial port to query |

**Response:** Same shape as `/cmd/get-status`, plus a `ts` (timestamp) field.

---

#### `POST /cmd/send`

Send a raw command string to the robot over serial.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | string | *(required)* | The raw command to send |
| `port` | string | — | Target port |

**Response:** `{ success }`

---

#### `POST /cmd/query`

Send a command and block until the first response line is received.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `command` | string | *(required)* | The raw command to send |
| `port` | string | — | Target port |
| `timeout` | number | `1.5` | Seconds to wait for a response |

**Response:** `{ success, response }`

---

#### `POST /cmd/jog`

Move the robot. Supports single-axis and multi-axis moves, both incremental
and absolute.

**Common parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | string | `"joint"` | `"coord"` for Cartesian (X/Y/Z), `"joint"` for joint angles (A/B/C/…) |
| `isAbsolute` | bool | `false` | `true` = move to this position, `false` = move by this amount |
| `motion` | int | `0` | Motion type when `isAbsolute` is `true`. `0` = Fast, `1` = Linear |
| `port` | string | — | Target port |

**Single-axis** — provide `axis` + `step`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `axis` | string | Axis letter: `"X"`, `"Y"`, `"Z"`, `"A"`, `"B"`, `"C"` |
| `step` | number | Distance to move (mm for coord, degrees for joint) |

**Multi-axis** — provide `values`:

| Parameter | Type | Description |
|-----------|------|-------------|
| `values` | object | `{ x, y, z, a, b, c }` — include only the axes you want to move |

**Examples:**
```js
// Incremental: jog X by +5 mm
{ mode: "coord", axis: "X", step: 5 }

// Absolute: move to (150, 0, 200) with linear motion
{ mode: "coord", values: { x: 150, y: 0, z: 200 }, isAbsolute: true, motion: 1 }

// Incremental multi-axis
{ mode: "coord", values: { x: 10, z: -5 } }
```

---

#### `POST /cmd/home`

Run the homing sequence.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | string | — | Target port |

---

#### `POST /cmd/zero`

Move to the zero (origin) position.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `port` | string | — | Target port |

---

#### `POST /cmd/pump`

Control the suction cup.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | int | `0` | `1` = turn on, `0` = turn off |
| `port` | string | — | Target port |

---

#### `POST /cmd/gripper`

Control the gripper.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `mode` | int | `0` | `1` = close / grip, `0` = open / release |
| `port` | string | — | Target port |

---

#### `POST /cmd/stop-all`

Emergency stop. Sends `cancellation()` to **all** connected robots. No
parameters.

**Response:** `{ success, stopped: [port, ...], errors: [...] }`

---

**Endpoints NOT intended for extensions** (internal to the app):
`/execute`, `/execute/abort`, `/debug/*`, `/inspect*`, `/import`, `/functions`,
`/cmd/flash-*`, `/cmd/firmware-*`, `/cmd/download-firmware`,
`/cmd/check-firmware-update`, `/cmd/list-firmware-versions`, `/cmd/connect`,
`/cmd/disconnect`, `/cmd/probe-port`.

---

## Robot Interaction

Extensions do **not** need to manage serial connections themselves. The app
handles connection/disconnection, device detection, and port management. Your
extension simply uses the robots that are already connected.

### From Frontend JS

Use `ExtensionAPI` methods and direct `fetch()` calls to server endpoints:

```js
var serverUrl = ExtensionAPI.getServerUrl();

// Check what robots are available
var devices = await ExtensionAPI.getDevices();
if (devices.ports && devices.ports.length > 0) {
  var robot = devices.ports[0];
  console.log('Connected to', robot.model, 'on', robot.port);
}

// Read current position
var status = await ExtensionAPI.getRobotStatus();
var x = status.coordinates.X;
var y = status.coordinates.Y;
var z = status.coordinates.Z;

// Absolute move via /cmd/jog
fetch(serverUrl + '/cmd/jog', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'coord', motion: 1, values: { x: 150, y: 0, z: 200 }, isAbsolute: true })
});

// Control end effectors via /cmd/pump
fetch(serverUrl + '/cmd/pump', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 1 })   // 1 = on, 0 = off
});
```

### From Backend Python

Import and use the SerialManager singleton:

```python
from server.serial_manager import SerialManager

mgr = SerialManager.get_instance()

# Get the active connection
conn = mgr.active_connection
if conn and conn.connected:
    # Use the SDK robot object for high-level control
    conn.robot.writeCoordinate(0, 0, x=150, y=0, z=200)  # motion=0 (Fast), mode=0 (Absolute)
    conn.robot.writeCoordinate(0, 1, x=10)                # mode=1 (Incremental)
    conn.robot.homing()
    conn.robot.pump(1)   # suction on
    conn.robot.pump(0)   # suction off
    conn.robot.gripper(1)

# List all connected ports
for c in mgr.all_connected():
    print(f'{c.port}: {c.model}, connected={c.connected}')
```

## Installation

### For Users

1. Download or clone the extension folder.
2. Open **Settings > Extensions** and click **Install from Folder** or
   **Install from Zip**. Alternatively, place the folder manually:
   ```
   ~/.wlkata-studiox/extensions/          (macOS / Linux)
   C:\Users\<you>\.wlkata-studiox\extensions\   (Windows)
     webcam-cv/
       extension.json
       frontend/
       backend/
   ```
3. If the extension includes a `requirements.txt`, the app will offer to
   create a virtual environment and install the dependencies automatically
   (requires `uv`, which is bundled with StudioX).
4. Restart StudioX. The extension tab appears in the sidebar.

### For Developers

During development, place your extension in this `extensions/` directory (the
project root). Changes to HTML/CSS/JS take effect on app reload (`Cmd+R` /
`Ctrl+R`). Backend changes require a full app restart.

### Priority Order

Extensions are loaded from these directories (first match wins):

1. **User directory** (highest priority):
   - macOS / Linux: `~/.wlkata-studiox/extensions/`
   - Windows: `C:\Users\<you>\.wlkata-studiox\extensions\`
2. **Project directory**: `<app>/extensions/` (development)
3. **Bundled**: `<app>/resources/extensions/` (packaged app)

If two extensions share the same `name`, the one found first wins. This lets
users override bundled extensions with their own version.

---

## Tips & Limitations

- **Scope your CSS.** All extension stylesheets are global. Prefix your
  selectors (e.g. `.my-ext-container .btn`) to avoid conflicts.
- **Scope your JS.** Wrap your code in an IIFE `(function() { ... })();` to
  avoid polluting the global namespace.
- **Use theme variables.** The app provides CSS custom properties like
  `--bg-primary`, `--text-primary`, `--accent`, `--border-primary`. Use them
  so your extension looks correct in both light and dark themes.
- **No hot-reload.** Backend changes require a full app restart. Frontend
  changes (HTML/CSS/JS) take effect on window reload.
- **One sidebar tab per extension.** Each extension can contribute a single
  sidebar tab. If you need multiple views, use sub-tabs within your tab.
- **Connection management is handled by the app.** Do not open serial ports
  directly. Use `/cmd/jog`, `/cmd/pump`, `ExtensionAPI.getRobotStatus()`
  from the frontend, or `SerialManager.get_instance()` from the backend.
- **Blueprint name uniqueness.** Your Flask Blueprint's first argument must be
  unique across all extensions. Use your extension name as the Blueprint name.
- **Error handling.** Always return `{ success: false, error: "..." }` from
  your backend endpoints so the frontend can display meaningful messages.
- **The `extension.json` `name` field is your identity.** It determines your
  backend URL prefix (`/ext/<name>/`), your settings namespace, and the
  deduplication key. Choose it carefully and do not change it after release.
- **Lazy startup (tabs / backend).** Sidebar frontend JS and the backend
  subprocess are **lazy** — they start when the user first opens the
  extension tab (and the first API call starts the backend). Write tab JS
  as an IIFE that initializes on load. **Workflow JSON** from
  `contributes.workflows` is an exception: it is registered at extension
  discovery so Blockly can list templates without opening the tab.
- **Workflows emit Python, not extension HTTP.** Use slots/functions and
  optional `imports`; do not treat workflow codegen as a substitute for
  `ExtensionAPI.fetch` interactive UIs.