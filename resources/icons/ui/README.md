# App UI icons

**Source of truth: this folder** (`resources/icons/ui/`).

| File | Purpose |
|------|---------|
| `icons.svg` | Shared sprite with `<symbol id="icon-…">` for every icon |
| `save.svg`, `run.svg`, … | Same icons as standalone files (edit, preview, CSS mask, `<img>`) |

## Use in HTML

After `js/ui/icons.js` loads the sprite:

```html
<svg class="toolbar-btn-icon" viewBox="0 0 24 24" aria-hidden="true">
  <use href="#icon-save"></use>
</svg>
```

Or as an image:

```html
<img class="toolbar-btn-icon" src="resources/icons/ui/save.svg" alt="">
```

## Use in JS

```js
await AppIcons.load();
el.innerHTML = AppIcons.svg('save', 'toolbar-btn-icon');
// or
img.src = AppIcons.fileUrl('save');
```

## Adding an icon

1. Add `resources/icons/ui/my-icon.svg` (24×24, prefer `stroke="currentColor"`).
2. Add a matching `<symbol id="icon-my-icon" …>` inside `icons.svg`.
3. Reference with `<use href="#icon-my-icon">`.
4. Append the name to `AppIcons.NAMES` in `js/ui/icons.js` if you keep that list.

Do **not** redefine path geometry in HTML or in `icons.js` — only reference these files.
