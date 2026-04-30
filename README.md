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
├── server.py                # Python backend entry point
├── server/                  # Flask backend package
├── js/                      # Frontend modules
│   ├── blocks/              # Custom Blockly block definitions
│   ├── generators/          # Python code generators
│   ├── ui/                  # Dialogs and toolbox
│   └── workspace/           # Workspace management
├── scripts/
│   └── download-python.js   # Downloads embedded Python runtime
├── resources/
│   ├── python/              # Embedded Python (gitignored, downloaded on demand)
│   └── icons/               # App icons
└── package.json
```

## CI/CD

The GitHub Actions workflow (`.github/workflow/build.yml`) builds the Electron app for macOS (arm64 + x64) and Windows (x64), then uploads the artifacts to the [SDK repo](https://github.com/wlkata/WLKATA-Python-SDK-wlkatapython) release.

Builds are triggered by:
- **Tag push (`v*`)** on this repo — uploads to the latest SDK release
- **SDK release** — the SDK repo dispatches a `repository_dispatch` event, triggering a rebuild with the latest SDK version
- **Push to `main`** — creates a rolling `dev` pre-release on this repo for internal testing

## License

ISC