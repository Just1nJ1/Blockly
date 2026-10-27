# Python runtime adapters

`contributes.runtime.python` is a file inside the extension, for example `runtime/adapter.py`. It must define `create_session(ctx)`. StudioX loads it in the Blockly server process once per run and calls `close()` when the run finishes, including after an error or Stop. The adapter session is not reused for the next run.

Loading the module and calling `create_session` must not open hardware. Open a device only when the generated program calls a method such as `open_camera` or `open`.

## Context

```text
ctx.extension_id     This extension's id. Read-only.
ctx.session_id       This run's id. Core assigns it. The client cannot.
ctx.check_aborted()  Raises if this run was stopped.
ctx.request(method, relative_path, json=None, timeout=None, ignore_abort=False)
ctx.report_error(message)
ctx.add_cleanup(fn)  Idempotent callback, run LIFO after close().
```

`request` sends only to `/ext/<this extension>/<relative path>`. `/frame?id=0` is allowed. Absolute URLs, `//host`, and `..` are rejected. The result is `ExtensionResponse`: `status`, `headers`, and `body` bytes. Call `.json()` only when the body is JSON. JPEG frames stay bytes.

HTTP 4xx and 5xx raise `ExtensionHttpError`. That error's `.response` is still an `ExtensionResponse`, so a caller can treat 404 as "no frame yet".

`request` checks Stop before and after the HTTP call. Pass `ignore_abort=True` only for an idempotent disconnect during cleanup. Stop must still be able to drop a holder that was already registered. A cancellation exception is not reported as an ordinary device error.

## What the program sees

Run and Debug send `extension_ids` collected from the blocks on the workspace, including blocks nested in statements and procedures. Disabled blocks are skipped. The server checks each id: installed, enabled, dependencies present, and the runtime file inside the extension directory. A client-supplied id that is not installed fails the run before user code, with `Missing extension: <id>`.

```python
device = __studiox_extensions['test-device'].open('A')
```

The map is read-only. An extension with no `runtime.python` is omitted. Camera's setup block generates:

```python
cap = __studiox_extensions['camera'].open_camera(0)
frame = cap.read()[1]
```

`close()` on the adapter, and `release()` on each object it returned, must be safe to call twice and must not release another run's holders.

## Modes that do not start adapters

Simulation, G-code export, and function inspection set `__studiox_extensions` to a map that raises `Extension runtime is unavailable in <mode>`. Debug uses the same adapter path as Run.

`close_all()` finishes before the run is marked done, so the next Run cannot start while holders are still being released. One adapter's cleanup error is logged and does not skip the other adapters or the serial cleanup.

## Dependencies of the adapter

The adapter runs in the Blockly process, not in the extension's backend environment. Import the Python standard library at module level. Import OpenCV inside the function that decodes an image, and fail with a message that names the StudioX Python environment when it is missing. Do not assume packages from the Camera backend environment can be imported here. Do not run `pip` during a program.
