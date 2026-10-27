# Troubleshooting extensions

## The program says the extension is missing

`Missing extension: camera. Install it and restart StudioX.` means the run asked for an id that is not in the server's registry. Confirm the folder name matches `name`, then restart so both Electron and the Python process rediscover it.

`Missing extension block: camera_setup` means a saved workspace contains a block this process cannot construct. The workspace file was not overwritten. Install the extension and restart, then open the workspace again.

## The dropdown stays empty or shows an old camera

The menu does not poll. Open the dropdown to refresh. The first open calls `/cameras?refresh=1`. A later open within 20 seconds reuses the cache. Refresh lists names; it does not light the camera. Connect does.

A value labeled `unavailable` was saved on the block and is no longer in the list. Pick another entry. An empty choice does not become camera `0`.

## Preview and frames

`__studiox_preview` stores frames in the StudioX process. The Camera tab polls `/preview-frames`. A failure to encode is reported on that response. The encoder loads OpenCV from the StudioX process, then from the `blockly` environment. The message is `Preview could not load OpenCV`, not a request to reinstall the Camera extension.

A Camera frame error (`Camera has no frame yet`, a failed `/frame` request) is separate from an encoder failure. The runtime adapter reports the frame error. The preview hub reports the encode error.

## Stop and the camera light

Stop releases only that run's holders, after cleanup, and only then marks the run finished. The Camera window's Connect session stays up until Disconnect. With zero holders the backend closes the device and does not open it again just because StudioX is the foreground app.

Emergency Stop still cancels robot motion and shows its own notice. A normal Stop prints `— Program stopped —` as a system line. A Python exception stays a red error.

## The running app did not pick up a Camera edit

`~/.wlkata-studiox/extensions/camera` wins over the git checkout. Run `scripts/sync-camera-extension.sh` and restart StudioX. The camera backend process keeps the code it imported at startup until that restart.

## Packaged app

This migration was not verified with `npm run build:mac` or with a physical camera left idle for 30 seconds. Mock tests cover the adapter and the Camera manager. A packaged build can still contain an older Camera until it is rebuilt from a tree that includes the runtime adapter.
