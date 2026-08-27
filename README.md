# WLKATA StudioX

A visual programming desktop application for WLKATA robotic arms, built with Electron and Blockly. Features an embedded Python backend for code execution. Supports Windows, macOS, and Linux.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher)

> **Note:** You do **not** need Python installed on your system. The app uses a standalone embedded Python runtime that is downloaded automatically during setup.

## Development Setup

```bash
git clone https://github.com/wlkata/StudioX
cd StudioX
npm install
npm start
```

`npm install` automatically runs `postinstall` which:
1. Installs Electron native dependencies
2. Downloads a standalone Python runtime into `resources/python/`
3. Installs Python packages (`wlkatapython`, `flask`, `flask-cors`) into it

Your system Python is not used or affected.

To re-run the Python setup independently (e.g. after a clean or to update packages):

```bash
npm run setup
```

Use `npm run dev` instead of `npm start` to launch with DevTools enabled.

## Building for Distribution

```bash
# macOS
npm run build:mac

# Windows
npm run build:win

# Both platforms
npm run build:all
```

Built artifacts (`.dmg`, `.exe`) are output to the `dist/` directory.

## Project Structure

```
blockly/
├── main.js                  # Electron main process
├── index.html               # Application window
├── robots.json              # Robot model catalog (single source of truth)
├── server.py                # Python backend entry point
├── server/                  # Flask backend package
│   └── robots.py            # Loads robots.json; helpers + GET /robots
├── js/                      # Frontend modules
│   ├── robotCatalog.js      # Client cache of /robots (offline fallback)
│   ├── blocks/              # Custom Blockly block definitions
│   ├── generators/          # Python code generators
│   ├── ui/                  # Dialogs and toolbox
│   ├── robotViewer/         # 3D viewer + device detector
│   └── workspace/           # Workspace management
├── scripts/
│   └── download-python.js   # Downloads embedded Python runtime
├── resources/
│   ├── python/              # Embedded Python (gitignored, downloaded on demand)
│   ├── wlkata_arm_virtual-reality/  # URDF + meshes for the 3D viewer
│   └── icons/               # App icons
└── package.json
```

## Robot catalog (`robots.json`)

`robots.json` is the **single source of truth** for supported robotic arms. Both the Python backend and the Blockly UI load it (server via `server/robots.py`, frontend via `GET /robots` into `js/robotCatalog.js`). Adding a new arm should mostly mean adding an entry here plus the matching SDK class and viewer assets.

Fields are grouped by concern. On load, both loaders **flatten** nested groups into legacy top-level keys (`blocklyValue`, `sdkClass`, `axisCount`, …) so callers can use either shape. `GET /robots` returns the normalized objects (both nested groups and flat keys).

### How data flows

```
robots.json
    │
    ├─ server/robots.py  ──► serial_manager, detector, virtual_serial,
    │                        move_simulator, app (firmware list/update)
    │                        + GET /robots
    │
    └─ js/robotCatalog.js ◄── GET /robots (fallback copy if offline)
              │
              ├─ setupRobot, moveRobot (blocks)
              ├─ controlPanel, teachingPanel, commandTab
              ├─ deviceDetector, codeAnalysis
              └─ importExport
```

Load the catalog early: `index.html` includes `js/robotCatalog.js`; `js/main.js` calls `RobotCatalog.load()`.

### Top-level fields

| Field | Meaning | Used in |
|--------|---------|---------|
| **`id`** | Stable entry key (usually same as `identity.name`). Useful if display names change later. | Indexed when normalizing entries in `server/robots.py` and `js/robotCatalog.js`. Not widely consumed outside loaders yet. |

---

### `identity` — who this arm is

| Field | Meaning | Used in |
|--------|---------|---------|
| **`name`** | Canonical short model name (`Mirobot`, `MT4`, …). Primary key after normalize. | **Server:** `ROBOTS_BY_NAME`, `normalize_model_name`, `FW_PREFIX_MAP` values, virtual device `model`, serial connection model. **Frontend:** `RobotCatalog.getByName` / `normalizeModelName`; control panel & teaching panel current model; device detector `MODEL_VALUE_MAP` keys; command tab model labels. |
| **`label`** | Human-facing dropdown text (e.g. `"E4 / MT4"`). | **Frontend:** `RobotCatalog.getModelDropdownOptions` / `getSetupModelDropdownOptions` → `js/blocks/setupRobot.js` MODEL field; viewer config `label` via `resolveViewerConfig`. |
| **`aliases`** | Alternate strings that resolve to this robot (class names, nicknames, case variants). | **Server:** `normalize_model_name` in `server/robots.py` (used by `serial_manager` on connect/open). **Frontend:** `RobotCatalog.normalizeModelName`, `nameFromOptionText` → control panel, teaching panel, move blocks, code analysis, command tab, import/export. |

---

### `library` — SDK / simulator (wlkatapython)

| Field | Meaning | Used in |
|--------|---------|---------|
| **`sdkClass`** | Python class on `wlkatapython` (e.g. `Mirobot_UART`). | **Server:** `get_sdk_class_name` → `server/serial_manager.py` (`getattr(wlkatapython, class_name)` when opening a connection). `get_sdk_class_names` → `server/move_simulator.py` (dry-run injection of all UART classes). |
| **`simKey`** | Key passed to `wlkatapython.simulator.create_simulator(...)`. | **Server:** `get_sim_key` → `server/virtual_serial.py` when creating a virtual port’s mock serial. |

Flattened API names: `sdkClass`, `simKey`.

---

### `firmware` — detect and flash

| Field | Meaning | Used in |
|--------|---------|---------|
| **`fwPrefix`** | Prefixes matched on the `$V` / version probe line. Empty array = not discovered by FW string alone. | **Server:** Built into `FW_PREFIX_MAP` in `server/robots.py` → `server/detector.py` maps probe response → `identity.name`. |
| **`assetPrefix`** | Substring matched in GitHub release `.hex` filenames (E4/Miromax may share MT4 firmware files). | **Server:** `get_firmware_asset_prefix` → `server/app.py` firmware list/update endpoints filter assets by this prefix. |

Flattened API names: `fwPrefix`, `firmwareAssetPrefix` (from `assetPrefix`).

---

### `blockly` — blocks and ports UI

| Field | Meaning | Used in |
|--------|---------|---------|
| **`value`** | Value stored in setup_robot **MODEL** and related Blockly/code paths (often same as `sdkClass`). | **Both:** Flattened as `blocklyValue`. **Server:** `normalize_model_name`, `model_to_blockly_value`. **Frontend:** setup MODEL dropdown values; `modelToBlocklyValue` (teaching panel → setup block); device detector `MODEL_VALUE_MAP`; virtual port → model map in import/export. |
| **`virtualPort`** | Logical offline simulator port name (`VirtualMirobot`). `null` = no virtual device for this entry. | **Server:** `get_virtual_devices` / `get_virtual_port_set` → `server/virtual_serial.py`. **Frontend:** `getVirtualPortOptions` → setup_robot PORT offline defaults; `isVirtualPort` → control panel (skip real serial/FW update); `getVirtualDeviceEntries` → import/export & device detector seeds. |
| **`virtualDescription`** | Description/tooltip for that virtual port. | **Server/Frontend:** Attached on virtual device entries from `get_virtual_devices` / `getVirtualDeviceEntries` (detector UI copy). |

Flattened API names: `blocklyValue`, `virtualPort`, `virtualDescription`.

---

### `kinematics` — axes / joint & cartesian layout

Not a full IK solver table; it defines which DOFs exist and how UI labels, status keys, and SDK parameter names line up for jog/teach/move UIs.

| Field | Meaning | Used in |
|--------|---------|---------|
| **`axisCount`** | Number of controllable axes (e.g. 6 vs 4). | **Server:** `get_axis_count` (available for backend consumers). **Frontend:** `RobotCatalog.getAxisCount` → `js/blocks/moveRobot.js` (which axes to show on move blocks); teaching panel `isFourAxis` (hide B/C); control layout sizing. |
| **`joints`** | Joint-mode rows: `label`, `statusKey`, `sdkParam`. | **Frontend:** `getControlLayout` → `js/ui/controlPanel.js`, `js/ui/teachingPanel.js` (build jog rows, read status, call jog/move APIs with `sdkParam`). |
| **`coords`** | Cartesian-mode rows: same shape as `joints`. | Same as `joints`, when mode is coordinate/Cartesian. |

#### Axis row object

| Sub-field | Meaning | Used in |
|-----------|---------|---------|
| **`label`** | UI text (`Joint 1`, `X`, `RX`, …). | Control panel & teaching panel row labels. |
| **`statusKey`** | Key in arm status / `?` response (`X`, `Y`, `Rx`, …). | Teaching/control panels map live status into input fields (`row.dataset.statusKey`). |
| **`sdkParam`** | Argument name for SDK / backend jog APIs (`x`…`c`). | Teaching panel jog / absolute move body `axis`; control panel equivalent motion calls. |

Flattened API names: `axisCount`, `joints`, `coords`.

---

### `viewer` — 3D visualizer

| Field | Meaning | Used in |
|--------|---------|---------|
| **`id`** | Viewer asset/profile id (`mirobot`, `haro380`). | **Frontend:** `resolveViewerConfig` → `js/blocks/moveRobot.js` (and related viewer wiring) selects which arm profile to load. |
| **`urdf`** | Path to URDF file. | Passed into the Three.js / URDF loader (`resources/wlkata_arm_virtual-reality/RobotViewer.js` via resolve config). |
| **`meshBasePath`** | Base path prepended to mesh paths from the URDF. | Same viewer pipeline (`RobotViewer` `meshBasePath` option). |
| **`tcpOffset`** | Tool center point `[x,y,z]` in metres relative to the flange/link frame. | Viewer TCP marker / EE offset (`setEeTcpOffsetLocal`). |

Consumed mainly through `RobotCatalog.resolveViewerConfig(model)` (also exposed historically as `resolveRobotViewerConfig`).

---

### Loader helpers (quick reference)

| Layer | Module | Role |
|-------|--------|------|
| Server | `server/robots.py` | Parse/normalize JSON; `normalize_model_name`, `get_sdk_class_name`, `get_sim_key`, `get_axis_count`, `get_firmware_asset_prefix`, `get_virtual_devices`, `get_sdk_class_names`, `FW_PREFIX_MAP` |
| Server | `server/app.py` | `GET /robots`; firmware routes use `get_firmware_asset_prefix` |
| Server | `server/serial_manager.py` | Instantiates `sdkClass` |
| Server | `server/detector.py` | FW probe → model via `FW_PREFIX_MAP` |
| Server | `server/virtual_serial.py` | Virtual ports + `simKey` |
| Server | `server/move_simulator.py` | Injects all `sdkClass` names for dry-run |
| Client | `js/robotCatalog.js` | Fetch `/robots`, offline fallback, all UI helpers |
| Client | `js/blocks/setupRobot.js` | MODEL + virtual PORT dropdowns |
| Client | `js/blocks/moveRobot.js` | Axis count, model normalize, viewer config |
| Client | `js/ui/controlPanel.js` | Layouts, virtual port checks, model resolve |
| Client | `js/ui/teachingPanel.js` | Layouts, axis count, Blockly MODEL value |
| Client | `js/robotViewer/deviceDetector.js` | Seeds ports/models from catalog |
| Client | `js/robotViewer/codeAnalysis.js` | Normalize model from workspace code |
| Client | `js/ui/commandTab.js` | Normalize model for command context |
| Client | `js/workspace/importExport.js` | Virtual devices + model normalize |

### Adding a new robot

1. Add a grouped entry to `robots.json` (copy an existing arm and edit fields).
2. Ensure `library.sdkClass` exists on `wlkatapython` (and `simKey` if you want a virtual port).
3. Add viewer URDF/meshes under `resources/wlkata_arm_virtual-reality/` if needed; point `viewer.urdf` / `meshBasePath` at them.
4. Set `firmware.fwPrefix` / `assetPrefix` if the arm should auto-detect and receive OTA hex matching.
5. Keep `js/robotCatalog.js` **fallback** entries roughly in sync for fully offline startup (optional but recommended).

No new hardcoded lists should be added in `serial_manager`, setup blocks, or control panels — extend the catalog instead.

## CI/CD

The GitHub Actions workflow (`.github/workflow/build.yml`) builds the Electron app for macOS (arm64 + x64) and Windows (x64), then uploads the artifacts to the [SDK repo](https://github.com/wlkata/WLKATA-Python-SDK-wlkatapython) release.

Builds are triggered by:
- **Tag push (`v*`)** on this repo — uploads to the latest SDK release
- **SDK release** — the SDK repo dispatches a `repository_dispatch` event, triggering a rebuild with the latest SDK version
- **Push to `main`** — creates a rolling `dev` pre-release on this repo for internal testing

## License

ISC