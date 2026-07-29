# Workflow Templates

Workflow templates let **library and core maintainers** ship a fixed task pipeline
while users plug in the middle algorithms as Blockly functions.

Generated code is real Python (function calls and loops), not extension HTTP APIs.

## Quick start (users)

1. Open the **Workflows** toolbox category and drop **Scan and Act**.

2. Select your robot variable.

3. For each step, either:
   - Click the green **+** next to `fn` (or right‑click the workflow block →
     **Create function for «…»**) to insert a matching function stub with the
     right parameters and a unique name; then edit the body; or
   - Choose an existing function from the `fn` dropdown.

4. Press **Run**. Example generated code (natural names, no `__wf_` temps):

```python
items = get_targets()
for item in items:
  handle_target(arm, item)
```

Step signatures (shown on the block):

| Step | Function shape | `+` creates |
|------|----------------|-------------|
| Collect items | `() → List` | `collect()` with **no** params |
| For each item → act | `(robot, item)` | `act(robot, item)` with **2** params |

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

`blockly: "robot_var"` uses the same robot-variable dropdown as move blocks.

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

Ship that as a code-first extension with `python/` on `sys.path` and
`contributes.workflows` (see product plan). Do **not** generate HTTP calls to
the interactive `cv-pick` tab.

## Files

| Path | Role |
|------|------|
| `workflows/index.json` | Lists core templates |
| `workflows/*.json` | Template definitions |
| `js/workflows/schema.js` | Validation |
| `js/workflows/registry.js` | Load / register |
| `js/workflows/slots.js` | Procedure matching |
| `js/workflows/blocks.js` | `workflow_run` block |
| `js/generators/python.js` | Codegen |
