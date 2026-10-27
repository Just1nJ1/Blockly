# StudioX extension host API version 1

The host API version is `1`. An extension sets `extensionApiVersion` in `extension.json`. A higher number is rejected and the extension does not load. Omitting the field means version 1.

Core decides how an extension is discovered, how its blocks generate Python, and when a run is cleaned up. The extension decides which blocks, devices, and Python objects it provides.

## What an extension can contribute

| Contribution | Required | What it does |
| --- | --- | --- |
| `backend.main` | No | Flask process started on the first request to `/ext/<name>/`. |
| `blocks` | No | Toolbox category and block definitions. |
| `dynamicFields` | No | Dropdown values fetched from that extension's backend. |
| `runtime.python` | No | `create_session(ctx)` loaded into the Blockly process for each run. |
| `window` | No | A separate Electron window, such as the Camera viewer. |
| `sidebarTab` | No | A tab inside StudioX. |
| `workflows`, `functions` | No | Existing workflow and saved-function contributions. |

An extension may register blocks, a runtime, or both, without a backend. A backend is only required when the extension serves HTTP.

## Identity

`name` is the extension id. It is not the same as `displayName`. The id is used in `/ext/<name>/`, in `__studiox_extensions['<name>']`, and in workspace metadata. `displayName` is the label people see.

## Trust

A runtime adapter is ordinary Python running inside the StudioX server process. `permissions` is a declaration (`camera`, `microphone`). It is not a sandbox. Installing an extension lets it run local code. A future project can separate untrusted extensions; that work is not part of this API.

## Restart

Install, enable, disable, and uninstall take effect on the next launch of StudioX. The running process keeps the extensions it discovered at startup.
