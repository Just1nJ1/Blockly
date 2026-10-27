# Authoring blocks

Block definitions live in the extension, usually `blocks/blocks.json`. Each object is a Blockly block plus a Python template. Core does not special-case block type names.

## String template

```json
{
  "type": "camera_resize",
  "pythonImports": ["import cv2"],
  "python": "cv2.resize({IMAGE}, ({WIDTH}, {HEIGHT}))"
}
```

## Choosing a template from a field

```json
"python": {
  "select": {
    "field": "MODE",
    "cases": { "BGR": "{IMAGE}" },
    "default": "cv2.cvtColor({IMAGE}, cv2.COLOR_BGR2{MODE})"
  }
}
```

The generator reads the block's field value, picks `cases[value]` or `default`, then fills placeholders. If neither matches, code generation throws and names the block type and field. Templates are not passed to `eval`.

## Placeholder rules

| Input | Generated Python |
| --- | --- |
| `field_number` | A number, clamped to `min` / `max`. A non-numeric value becomes `0`, then the same clamp. |
| `field_checkbox` | `True` or `False`. |
| `field_dropdown` | A quoted string. A value that is only digits is emitted as a number, so camera `0` stays `0` and `""` stays `""`. |
| `unquoted: true` | The raw token, and only when that token is one of the field's declared options. |
| `field_variable` | Blockly's Python variable name. |
| `input_value` | The connected value, or `None`. |
| `input_statement` | The connected statements. |

Imports are deduplicated with the key `extension:<owner>:import:<line>`. The same import from two blocks of one extension appears once.

`"codegen": "debug"` (or the older `pythonHidden: true`) emits the block only for a StudioX Run or Debug. Portable code, World Preview, and G-code export emit `pass` instead, so a loop whose body was only that block stays valid Python. `"codegen": "studiox"` omits the block from portable code and still emits it for Run and for dry-runs. Optional `passComment` is appended when that `pass` is emitted: `pass  # preview block call`. A newline in the comment is turned into a space. Without `passComment`, the statement stays `pass`. Do not filter the finished text for a function name.

`studiox` and `portable` objects replace the shared `python` string when the two targets differ. Each may contain `python`, `imports`, and, for portable code, `cleanup`. Portable cleanups run from a `finally` attached to the scope that created the resource, in reverse order. One cleanup failure does not skip the rest. StudioX Run does not emit those cleanups; the runtime adapter closes the session.

`simulation` is optional. World Preview and G-code export use it instead of the StudioX template so a dry-run does not open hardware. If a block sets `hardware: true` and has no `simulation` template, those dry-runs call `__studiox_simulation_unsupported(...)` and stop at that block. Earlier robot moves are kept.

The fictional `tests/extension_contract/test-device/` extension uses the same `select` and `source` fields. It is a test fixture, not an extension StudioX loads from `extensions/`.
