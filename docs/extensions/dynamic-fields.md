# Dynamic dropdowns

Declare providers on the extension, then point a dropdown field at one with `source`.

```json
{ "type": "field_dropdown", "name": "PORT", "options": [["Choose port", ""]], "source": "ports" }
```

`source` without a dot means `<this extension>.<provider>`. `source: "devices"` on the Camera extension reads `camera.devices`. A dotted source is accepted only when the owner is the extension that defined the block. One extension cannot read another's devices unless it declares that extension in `depends` and Core grows an explicit cross-extension rule. There is no such rule today.

## HTTP shape

`kind` is `httpOptions`. `path` and `refreshPath` start with `/` and stay inside `/ext/<extension id>/`. The response is a JSON object. `itemsKey` selects the array. Each item's `labelKey` is the menu label and `valueKey` is the value stored on the block.

Camera's device list:

- `path`: `/cameras` (cached names, no device open)
- `refreshPath`: `/cameras?refresh=1` (ask the operating system for names; still does not open a capture)

## When a refresh happens

Blockly's menu generator is synchronous. The menu shows the cache immediately, then a refresh may update it.

`refresh: "onOpen"` plus `cacheMs` refreshes when the menu opens and the cache is older than `cacheMs`. It does not start a timer. The first fetch, when there is no cache, uses `refreshPath`. Later fetches inside `cacheMs` do not touch the network. One provider has at most one request in flight. A failed request keeps the previous cache.

Empty values and duplicate values are dropped. A selected value that disappears from the new list stays selected and is labeled `<value> unavailable`. An empty string is not rewritten to `0`. An empty list shows `No devices`.

Opening the menu does not connect to the device. Connect remains an explicit action.
