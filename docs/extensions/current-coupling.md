# Current Camera coupling (Phase 0 baseline)

Recorded before the extension-architecture migration. This is documentation only.

## Git

| Repo | Branch | Commit | Notes |
| --- | --- | --- | --- |
| Blockly (`/Users/justin/WLKATA/blockly`) | `feature-ext-blocks-deps` | `521a6358b00541b40d72295076afdb2ab04c1226` | Do not use `main`. |
| Camera (`/Users/justin/WLKATA/WLKATA-StudioX-camera`) | `main` | `9c5ba2a3f788e2970bf25d978414474da003be6c` | Only local branch. Remote `origin` is `wlkata/WLKATA-StudioX-camera`. |

Unrelated dirty Blockly files left untouched: `extensions/cv-pick`, `extensions/drawing`, `datasets/`, the `extensions/camera` symlink, `scripts/check-studiox-windows.bat`.

## What StudioX actually loads

Search order is **user directory, then this repo's `extensions/`, then the packaged `Resources/extensions`**. The first directory that contains a given extension name wins.

The running app therefore loads **`~/.wlkata-studiox/extensions/camera`**, a copy, not the git checkout. That copy's manifest is still Camera v1 (`name: camera`, `version: 1.0.0`, no `manifestVersion`). The project path `extensions/camera` is a symlink to the git repo at `9c5ba2a`.

## Call chains that are Camera-specific inside Core

- `js/extensions/extensionBlocks.js` — `_wireCameraDropdown` / `_registerCameraDropdown` turn `source: "cameras"` into a Blockly extension that fetches `/ext/camera/cameras`. `camera_convert` with `MODE === 'BGR'` is rewritten to `{IMAGE}`. Import definition keys use the prefix `camdef_`.
- `server/executor.py` — `_prepare_cv_proxy()` replaces `cv2.VideoCapture` with `ManagedCapture` for every program that imports `cv2`. Interactive, batch, and debug runs call `bind_capture_session` / `release_program_captures`.
- `server/camera_client.py` — `ManagedCapture` POSTs `/ext/camera/connect` and `/disconnect`, GETs `/ext/camera/frame`, and decodes JPEG in the Blockly process. Holders are `program-<session>-<id>`.
- `server/preview_hub.py` — `__studiox_preview` is generic, but `_import_cv2()` looks in the `camera` environment before `blockly` when the server process has no OpenCV.
- Camera `blocks/blocks.json` — `camera_setup` generates `{CAP} = cv2.VideoCapture({CAMERA})`. Sharing works only because Core intercepts that constructor.

The Camera backend (`CameraManager`) owns the device. Listing cameras does not open a capture unless `refresh=1` asks macOS for names. The Camera window and the Blockly dropdown no longer poll on a timer. There is no Electron focus handler that acquires a camera.

## Protected baseline

`WLKATA-StudioX-camera/tests/test_camera_lifecycle.py` — 8 tests, all passed on this baseline with the camera environment's Python (mocked capture, not a physical camera).

## Planned difference

`camera_setup` will later generate `__studiox_extensions['camera'].open_camera(...)`. Golden strings for the templates **before** that change are in `tests/extension_contract/golden/camera_python_v1.json`.

## Discrepancies vs `plan.md`

- Camera development happens on `main`, not a feature branch.
- The installed copy under `~/.wlkata-studiox/extensions/camera` can lag the git repo. Precedence means a new manifest in git is invisible until that user copy is updated or removed.
- Dropdown wiring already refreshes on first menu open (`?refresh=1`) rather than every 4 seconds. The plan's description of a 4-second poll matches the code from before commit `521a635`.
