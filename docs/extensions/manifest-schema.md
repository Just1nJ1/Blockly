# extension.json

Version 1 manifests stay valid when `manifestVersion` is omitted. Version 2 is required for dynamic fields and a runtime adapter. The same rules are enforced in `server/manifest_schema.py` and `js/extensions/manifestValidator.js`.

## Required and checked fields

| Field | Rule |
| --- | --- |
| `name` | `^[a-z][a-z0-9_-]{1,63}$`. `blockly` and `core` are reserved. |
| `version` | SemVer (`1.2.3`) is required on manifest version 2. Version 1 warns and still loads. |
| `manifestVersion` | `1` or `2`. Missing means `1`. |
| `extensionApiVersion` | Integer from 1 through the host version (currently 1). |
| Directory name | Must equal `name` on version 2. Version 1 warns. |
| `permissions` | Only `camera` and `microphone`. Anything else is rejected. |
| Paths | Relative to the extension directory. `..`, absolute paths, and `://` are rejected. |

The first discovered directory wins when two copies share a `name`. Search order is the user directory, then the project `extensions/` directory, then packaged resources.

## Example

```json
{
  "manifestVersion": 2,
  "extensionApiVersion": 1,
  "name": "test-device",
  "displayName": "Test Device",
  "version": "1.0.0",
  "contributes": {
    "blocks": { "files": ["blocks/blocks.json"], "category": "Test Device" },
    "dynamicFields": {
      "ports": {
        "kind": "httpOptions",
        "path": "/ports",
        "refreshPath": "/ports?refresh=1",
        "itemsKey": "ports",
        "labelKey": "name",
        "valueKey": "id",
        "refresh": "onOpen",
        "cacheMs": 20000
      }
    },
    "runtime": { "python": "runtime/adapter.py" }
  }
}
```

`depends` lists other extension ids. It is not a pip requirement list. Pip dependencies belong in `requirements.txt` and are installed into that extension's own environment, separate from the Blockly process.

A rejected manifest is logged and skipped. Other extensions still load.
