# Workflow Templates

Workflow templates let **library and core maintainers** ship a fixed task pipeline
while users plug in the middle algorithms as Blockly functions.

Generated code is real Python (function calls and loops), not extension HTTP APIs.

## Quick start (users)

1. Open the **Workflows** toolbox category and drop **Process and Combine**.

2. Set context values **a** and **b** on the value sockets (default number
   shadows are editable; drag in a variable or expression to replace them).

3. For the process and combine steps, either:
   - Click the green **+** next to `fn` (or right‑click the workflow block →
     **Create function for «…»**) to insert a matching function stub with the
     right parameters and a unique name; then edit the body; or
   - Choose an existing function from the `fn` dropdown.

4. Press **Run**. Generated code uses **callbacks**: slot functions are
   parameters of a pipeline runner, then the runner is called with your
   selected functions:

```python
def process_and_combine(process, combine, a, b):
  processed = process(a)
  result = combine(processed, b)
  print(result)

process_and_combine(my_process, my_combine, 1, 2)
```

So `my_process` / `my_combine` are passed as **function objects** (not hard-wired
into the pipeline body). Fixed steps (e.g. `print`) stay as direct names
inside the runner.

Step signatures (shown on the block):

| Step | Function shape | `+` creates |
|------|----------------|-------------|
| Process first value | `(a) → Any` | `process(a)` |
| Combine both | `(processed, b) → Any` | `combine(processed, b)` |
| Print result | fixed `print(...)` | (no slot) |

## Authoring a template

Add a JSON file under `workflows/` and list it in `workflows/index.json`.

### Schema (v1)

| Field | Description |
|-------|-------------|
| `id` | Stable id (mutation + codegen) |
| `name` | Display name in toolbox / block header |
| `description` | Tooltip |
| `imports` | Optional list of import lines or module names |
| `context` | Inputs fixed on the block (e.g. robot variable) |
| `steps` | Ordered pipeline steps |

### Context entry

```json
{ "name": "robot", "type": "Robot", "blockly": "robot_var", "required": true }
```

| `blockly` | UI |
|-----------|-----|
| `robot_var` | Robot-variable dropdown (same as move blocks) |
| `number` / `value` / `any` | Value socket with default `math_number` shadow (`default` sets NUM) |
| other / omitted | Plain text field (free string / name) |

### Step patterns

| Pattern | Behavior |
|---------|----------|
| `single` | Call once; optional `output` binding |
| `list_iter` | `for item in <prior list>: call(...)` |
| `pass_through` | Bind a value without a slot |

### Slots (swappable algorithms)

```json
"slot": {
  "required": true,
  "signature": {
    "params": [
      { "name": "robot", "type": "Robot" },
      { "name": "item", "type": "Any" }
    ],
    "returns": "void"
  },
  "placeholderLabel": "Choose act function…"
}
```

Users fill slots with **workspace procedures** whose parameter **count** matches.
Return type is soft: non-`void` prefers procedures that return a value.

### Wiring inputs

Step inputs use `from`:

- `context.<name>` — block context field (e.g. robot)
- `iter.<itemName>` — loop variable inside `list_iter`
- bare name — prior step `output.name`

### Example: future CV coin pick (sketch)

```text
1. capture  (library call)     → Image
2. detect   (SLOT: image→PoseList)   ← user Blockly function or default
3. pick     (list_iter poses)  → pick_at(robot, pose)
```

Ship that as an extension with JSON under the extension folder and:

```json
"contributes": {
  "workflows": ["workflows/detect_and_pick.json"]
}
```

StudioX loads those templates eagerly via `WorkflowRegistry` (see
`extensions/README.md` → **Blockly Workflow Templates**). Do **not** generate
HTTP calls to an interactive tab (e.g. `cv-pick`); use slots + optional
`imports` for library helpers.

### Registering from extension JS

```js
WorkflowRegistry.register(templateObject, 'extension:my-ext');
refreshWorkflowsToolbox();
```

Prefer `contributes.workflows` for static files so templates appear without
opening the extension sidebar tab.

## Codegen model (callbacks)

For each template, Blockly emits:

1. **`def <template_id>(<slot_fns…>, <context…>):`** — pipeline body that
   *calls* the slot parameters (e.g. `process(a)` where `process` is a formal).
2. **`<template_id>(selected_fn, …, context_values…)`** — one call site per
   `workflow_run` block, passing the user-chosen procedures and context.

Parameter order: **all slot callbacks (step order)**, then **context** fields.
The `def` is hoisted once per template id (shared if you drop the block twice
with different functions).

## Files

| Path | Role |
|------|------|
| `workflows/index.json` | Lists core templates |
| `workflows/*.json` | Template definitions |
| `js/workflows/schema.js` | Validation |
| `js/workflows/registry.js` | Load / register |
| `js/workflows/slots.js` | Procedure matching |
| `js/workflows/blocks.js` | `workflow_run` block |
| `js/generators/python.js` | Codegen (callback-style runner) |
