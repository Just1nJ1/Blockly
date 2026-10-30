# Installing extensions and shipping Camera

StudioX looks for extensions in this order:

1. `~/.wlkata-studiox/extensions/`
2. The project `extensions/` directory (`npm start`) or the packaged resources
3. Packaged `Resources/extensions` when that directory exists

The first directory that contains a given `name` wins. Electron and the Python server receive the same directory list. A duplicate is not loaded twice.

The Camera extension's source of truth is the git checkout `WLKATA-StudioX-camera`. The folder StudioX actually runs is often the user-directory copy, because that copy wins over the project symlink `extensions/camera`.

Sync a tested Camera commit into the user directory with:

```bash
scripts/sync-camera-extension.sh
```

The script copies the checkout, skips `.git` and `tests`, and prints the git SHA. Restart StudioX after it runs. The runtime adapter was added in Camera `ae14b67` (`Open cameras through the StudioX extension runtime`).

`npm run build:mac` was not run for this migration. A packaged app still needs a rebuild before it contains this adapter. Until then, a previously installed app keeps the Camera files that were packaged with it.

Extension Python environments live under `~/.wlkata-studiox/environments/<name>`. The Camera backend uses the `camera` environment. The Blockly program and the Camera runtime adapter use the StudioX process, which can see the `blockly` environment's site-packages. Those are different Pythons. Installing OpenCV into `camera` does not by itself install it for the adapter. An extension that needs a library for its blocks declares it in `pythonDependencies.blockly`. StudioX installs that list into the Blockly environment during extension setup, and does not install it into the bundled application Python.

Changing an extension's files on disk does not reload a backend that is already running. Restart StudioX after install, upgrade, disable, or uninstall.
