# StudioX Extension Development Guide

Build custom extensions for WLKATA StudioX. Extensions can add new backend
endpoints (Python/Flask), new frontend tabs (HTML/JS/CSS), or both.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Extension Structure](#extension-structure)
3. [The Manifest File](#the-manifest-file)
4. [Frontend Development](#frontend-development)
5. [Backend Development](#backend-development)
6. [Available APIs for Extensions](#available-apis-for-extensions)
7. [Robot Interaction](#robot-interaction)
8. [Example: Webcam Extension](#example-webcam-extension)
9. [Example: Drawing Extension](#example-drawing-extension)
10. [Extension Ideas](#extension-ideas)
11. [Installation](#installation)
12. [Tips & Limitations](#tips--limitations)

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

A minimal extension only needs `extension.json` and at least one of a frontend
or backend contribution. Here is the full layout:

```
my-extension/
├── extension.json          # Required. Manifest describing the extension.
├── frontend/               # Optional. Frontend assets for a sidebar tab.
│   ├── index.html          #   Tab content (injected into the app).
│   ├── main.js             #   Tab logic (runs after HTML is in the DOM).
│   ├── styles.css          #   Tab styles (scoped by convention, not enforced).
│   └── icon.svg            #   Sidebar icon (22x22, stroke-based recommended).
└── backend/                # Optional. Python backend with Flask routes.
    └── main.py             #   Must export a `blueprint` variable.
```

You can include **only a frontend** (UI-only extension), **only a backend**
(headless service), or **both**.

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

```js
// Send a raw GCode command to the connected robot
await ExtensionAPI.sendCommand('G1 X100 Y0 Z0 F2000');

// Send to a specific port (if multiple robots are connected)
await ExtensionAPI.sendCommand('$H', '/dev/ttyUSB0');

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
//     { port: '/dev/ttyUSB0', model: 'Mirobot', connected: true },
//     { port: '/dev/ttyUSB1', model: 'MT4',     connected: true }
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

### Backend: Relevant Server Endpoints

Your backend code can also make internal HTTP requests to the existing server
endpoints, but in most cases using `SerialManager` directly is simpler. For
reference, these are the endpoints relevant to extensions:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/cmd/status` | GET | Connection status (port, model, connected, busy) |
| `/cmd/send` | POST | Send a raw GCode command `{ command, port? }` |
| `/cmd/query` | POST | Send command and wait for response `{ command, port?, timeout? }` |
| `/cmd/get-status` | POST | Query robot position/state `{ port?, silent? }` |
| `/cmd/last-status` | POST | Get cached auto-reported status (no serial query) |
| `/detect-devices` | GET | Scan for connected robotic arms |
| `/cmd/home` | POST | Home the robot `{ port? }` |
| `/cmd/zero` | POST | Move to zero position `{ port? }` |
| `/cmd/pump` | POST | Control suction cup `{ mode, port? }` |
| `/cmd/gripper` | POST | Control gripper `{ mode, port? }` |
| `/cmd/jog` | POST | Jog robot axes `{ axis, step, mode, port? }` |
| `/cmd/stop-all` | POST | Emergency stop all connected robots |

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

Use `ExtensionAPI` methods — they talk to the existing server endpoints:

```js
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

// Move the robot with GCode
await ExtensionAPI.sendCommand('G1 X150 Y0 Z200 F2000');

// Control end effectors
await ExtensionAPI.sendCommand('M3S1000');  // pump on
await ExtensionAPI.sendCommand('M3S0');     // pump off
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
    conn.robot.writeCoordinate(0, 0, x=150, y=0, z=200)
    conn.robot.homing()
    conn.robot.pump(1)   # suction on
    conn.robot.pump(0)   # suction off
    conn.robot.gripper(1)

    # Or send raw GCode
    conn.send_raw('G1 X150 Y0 Z200 F2000')

    # Send and wait for a response
    result = conn.send_and_wait('?', timeout=1.5)

# List all connected ports
for c in mgr.all_connected():
    print(f'{c.port}: {c.model}, connected={c.connected}')
```

---

## Example: Webcam Extension

A computer vision extension that captures webcam frames and detects objects.

### File Structure

```
webcam-cv/
├── extension.json
├── requirements.txt
├── frontend/
│   ├── index.html
│   ├── main.js
│   ├── styles.css
│   └── icon.svg
└── backend/
    └── main.py
```

### extension.json

```json
{
  "name": "webcam-cv",
  "displayName": "Webcam CV",
  "version": "1.0.0",
  "description": "Computer vision with webcam for pick-and-place tasks.",
  "contributes": {
    "sidebarTab": {
      "id": "webcam-cv",
      "label": "Camera",
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

### backend/main.py

```python
import cv2
import base64
import numpy as np
from flask import Blueprint, request, jsonify

blueprint = Blueprint('webcam_cv', __name__)

_cap = None


def _get_camera(index=0):
    global _cap
    if _cap is None or not _cap.isOpened():
        _cap = cv2.VideoCapture(index)
    return _cap


@blueprint.route('/capture', methods=['POST'])
def capture():
    """Capture a single frame and return it as a base64 JPEG."""
    data = request.get_json() or {}
    cam_index = data.get('camera', 0)

    cap = _get_camera(cam_index)
    if not cap.isOpened():
        return jsonify({'success': False, 'error': 'Cannot open camera'})

    ret, frame = cap.read()
    if not ret:
        return jsonify({'success': False, 'error': 'Failed to capture frame'})

    _, buf = cv2.imencode('.jpg', frame)
    b64 = base64.b64encode(buf).decode('utf-8')
    return jsonify({'success': True, 'image': b64,
                    'width': frame.shape[1], 'height': frame.shape[0]})


@blueprint.route('/detect-color', methods=['POST'])
def detect_color():
    """Detect objects of a given HSV color range and return centers."""
    data = request.get_json() or {}
    lower = np.array(data.get('lower_hsv', [0, 100, 100]))
    upper = np.array(data.get('upper_hsv', [10, 255, 255]))

    cap = _get_camera()
    ret, frame = cap.read()
    if not ret:
        return jsonify({'success': False, 'error': 'Failed to capture frame'})

    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, lower, upper)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                   cv2.CHAIN_APPROX_SIMPLE)

    objects = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area > 500:
            M = cv2.moments(cnt)
            cx = int(M['m10'] / M['m00']) if M['m00'] else 0
            cy = int(M['m01'] / M['m00']) if M['m00'] else 0
            objects.append({'x': cx, 'y': cy, 'area': area})

    return jsonify({'success': True, 'objects': objects})


@blueprint.route('/release', methods=['POST'])
def release():
    """Release the camera resource."""
    global _cap
    if _cap and _cap.isOpened():
        _cap.release()
        _cap = None
    return jsonify({'success': True})
```

### frontend/index.html

```html
<div class="webcam-container">
  <div class="webcam-toolbar">
    <button id="webcam-capture-btn">Capture</button>
    <button id="webcam-detect-btn">Detect Objects</button>
    <button id="webcam-pick-btn" disabled>Pick Nearest</button>
  </div>
  <div class="webcam-preview">
    <img id="webcam-image" alt="No image captured yet" />
  </div>
  <div id="webcam-results"></div>
</div>
```

### frontend/main.js

```js
(function() {
  var captureBtn = document.getElementById('webcam-capture-btn');
  var detectBtn  = document.getElementById('webcam-detect-btn');
  var pickBtn    = document.getElementById('webcam-pick-btn');
  var image      = document.getElementById('webcam-image');
  var results    = document.getElementById('webcam-results');
  var lastObjects = [];

  captureBtn.addEventListener('click', async function() {
    var data = await ExtensionAPI.fetch('webcam-cv', '/capture', {
      method: 'POST',
      body: JSON.stringify({ camera: 0 })
    });
    if (data.success) {
      image.src = 'data:image/jpeg;base64,' + data.image;
    } else {
      ExtensionAPI.showNotification(data.error, 'error');
    }
  });

  detectBtn.addEventListener('click', async function() {
    var data = await ExtensionAPI.fetch('webcam-cv', '/detect-color', {
      method: 'POST',
      body: JSON.stringify({
        lower_hsv: [0, 100, 100],
        upper_hsv: [10, 255, 255]
      })
    });
    if (data.success) {
      lastObjects = data.objects;
      results.textContent = 'Found ' + data.objects.length + ' object(s)';
      pickBtn.disabled = data.objects.length === 0;
    }
  });

  pickBtn.addEventListener('click', async function() {
    if (lastObjects.length === 0) return;
    // Example: move robot to first detected object's mapped coordinates
    // (you would add your own pixel-to-world calibration here)
    var obj = lastObjects[0];
    ExtensionAPI.showNotification(
      'Moving to object at pixel (' + obj.x + ', ' + obj.y + ')', 'info'
    );
    await ExtensionAPI.sendCommand('G1 X150 Y0 Z100 F2000');
  });
})();
```

---

## Example: Drawing Extension

A simple extension that lets users draw paths on a 2D canvas and converts them
to robot movement commands.

### extension.json

```json
{
  "name": "drawing",
  "displayName": "Drawing",
  "version": "1.0.0",
  "description": "Draw paths on a canvas and replay them on the robot.",
  "contributes": {
    "sidebarTab": {
      "id": "drawing",
      "label": "Drawing",
      "icon": "frontend/icon.svg",
      "html": "frontend/index.html",
      "js": "frontend/main.js",
      "css": "frontend/styles.css"
    }
  }
}
```

### frontend/main.js (sketch)

```js
(function() {
  var canvas = document.getElementById('draw-canvas');
  var ctx = canvas.getContext('2d');
  var points = [];
  var drawing = false;

  canvas.addEventListener('mousedown', function(e) {
    drawing = true;
    points = [];
    ctx.beginPath();
    ctx.moveTo(e.offsetX, e.offsetY);
    points.push({ x: e.offsetX, y: e.offsetY });
  });

  canvas.addEventListener('mousemove', function(e) {
    if (!drawing) return;
    ctx.lineTo(e.offsetX, e.offsetY);
    ctx.stroke();
    points.push({ x: e.offsetX, y: e.offsetY });
  });

  canvas.addEventListener('mouseup', function() { drawing = false; });

  document.getElementById('draw-send-btn').addEventListener('click', async function() {
    // Convert canvas pixels to robot workspace coordinates
    // This is a simplified linear mapping — adjust for your setup
    var scaleX = 200 / canvas.width;
    var scaleY = 200 / canvas.height;
    var zDraw = 150;  // drawing height
    var zLift = 200;  // travel height

    // Lift to safe height first
    await ExtensionAPI.sendCommand('G1 Z' + zLift + ' F2000');

    for (var i = 0; i < points.length; i++) {
      var rx = (points[i].x * scaleX) + 100;  // offset to robot workspace
      var ry = (points[i].y * scaleY) - 100;

      if (i === 0) {
        // Move to start position above the surface
        await ExtensionAPI.sendCommand('G1 X' + rx + ' Y' + ry + ' Z' + zLift + ' F2000');
        // Lower pen to drawing height
        await ExtensionAPI.sendCommand('G1 Z' + zDraw + ' F1000');
      } else {
        await ExtensionAPI.sendCommand('G1 X' + rx + ' Y' + ry + ' F1000');
      }
    }

    // Lift pen when done
    await ExtensionAPI.sendCommand('G1 Z' + zLift + ' F2000');
    ExtensionAPI.showNotification('Drawing complete!', 'info');
  });
})();
```

---

## Extension Ideas

Here are some extensions that would work well with the current system:

| Extension | Description | Backend? |
|-----------|-------------|----------|
| **Webcam CV** | Camera capture, color/object detection, pick-and-place with calibration | Yes (OpenCV) |
| **Drawing Pad** | Draw paths on a canvas and replay them as robot movements | No (frontend only) |
| **Conveyor Belt** | Control a conveyor belt via serial, coordinate with the arm for sorting | Yes (serial I/O) |
| **Keyboard Jog** | WASD/arrow-key jogging with adjustable speed and axis lock | No (frontend only) |
| **Gamepad Control** | Map a USB gamepad's axes and buttons to robot axes and end effectors | No (Gamepad API) |
| **G-Code Sender** | Load and stream `.gcode` / `.nc` files line by line with progress tracking | No (frontend only) |
| **Data Logger** | Record robot position over time, export as CSV, plot charts | Yes (data storage) |
| **REST API Bridge** | Expose robot control as a REST API for external programs to call | Yes (Flask routes) |
| **Voice Control** | Use the Web Speech API to control the robot with voice commands | No (frontend only) |
| **Coordinate Calibration** | Teach a pixel-to-world mapping between a camera and the robot workspace | Yes (OpenCV + math) |
| **Multi-Robot Sync** | Coordinate movements across multiple connected arms | Yes (SerialManager) |
| **3D Print Slicer** | Import STL files, slice into layers, generate toolpaths | Yes (slicer logic) |

---

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
  directly. Use `ExtensionAPI.sendCommand()` / `ExtensionAPI.getRobotStatus()`
  from the frontend, or `SerialManager.get_instance()` from the backend.
- **Blueprint name uniqueness.** Your Flask Blueprint's first argument must be
  unique across all extensions. Use your extension name as the Blueprint name.
- **Error handling.** Always return `{ success: false, error: "..." }` from
  your backend endpoints so the frontend can display meaningful messages.
- **The `extension.json` `name` field is your identity.** It determines your
  backend URL prefix (`/ext/<name>/`), your settings namespace, and the
  deduplication key. Choose it carefully and do not change it after release.