# Compatibility

## Manifests

Camera manifests that omit `manifestVersion` still load. New extensions that declare dynamic fields or a runtime use manifest version 2 and SemVer.

Saved workspaces store block types and field names (`camera_setup`, `CAMERA`, `CAP`). Those names were not changed. Regenerating Python uses the current templates. A workspace file that contains a block type StudioX cannot construct is kept as-is: StudioX shows `Missing extension block: ...` and will not overwrite that file until the extension is installed and StudioX is restarted.

## Camera programs

`camera_setup` now generates:

```python
cap = __studiox_extensions['camera'].open_camera(0)
```

`camera_capture` is still `cap.read()[1]`. Resize and convert still import and call OpenCV. BGR convert generates the input image unchanged. Preview still calls `__studiox_preview` on Run and Debug. The code tab shows `pass  # preview block call` because that block sets `passComment`.

The Camera window and a Blockly program share one device because both are holders in the Camera backend. The window holder is `window`. A program holder is `program-<session>-<id>`. Disconnecting the window does not release the program, and stopping the program does not disconnect the window. The device closes when the last holder leaves, and only after a read that is already in progress returns.

The code panel shows portable Python: `cap = cv2.VideoCapture(0)`. `cap.release()` appears only when the workspace has a Release Camera block. Run and Debug send `open_camera`, and the runtime adapter still releases any camera that block did not release when the program stops. World Preview and G-code export use the StudioX robot program with Camera hardware replaced by the extension's simulation placeholder. They do not read the code panel. Preview blocks run only in Run and Debug.

## Handwritten `cv2.VideoCapture`

`import cv2` is the normal OpenCV module. `cv2.VideoCapture(0)` and `cv2.VideoCapture('video.mp4')` open a device or file in the StudioX Python process. They do not register a holder with the Camera backend, so they do not share the Camera window's device.

Camera blocks use `__studiox_extensions['camera'].open_camera(...)`. That is the call that shares the backend capture.

## Old Camera copies

A Camera folder with no `runtime/adapter.py` does not start an adapter. Blocks from that copy still generate `cv2.VideoCapture(...)`, which now opens OpenCV directly instead of the shared backend. Sync Camera `ae14b67` or later and restart StudioX so block programs use `open_camera`.
