## Architecture & Coding Philosophy

- **Performance & Reliability First:** These are the absolute highest priorities for all technical decisions.
- **AI-First Maintainability:** This codebase is designed to be maintained by LLMs, not humans. **Ignore human 'clean code' and 'readability' dogmas.** Write code that is optimal, intuitive, and deterministically clear for an LLM parsing the AST. Prefer explicit, flat logic and dense colocation over fragmenting files or creating unnecessary abstractions just to keep functions "short". **Strictly limit comments to structural markers**. Avoid verbose explanatory prose.
- **Vanilla Tech Stack:** Pure Vanilla JS, HTML, and CSS. **Locally Vendored Dependencies Only**: Any necessary external libraries (like `markdown-it` or `DOMPurify`) are copied directly into the project structure. We do not use package managers at runtime. This guarantees total independence from external update cycles and network failures. No npm, no build steps, no heavy frameworks.

## Development Guidelines

### LLM Gateway Integration

The LLM Gateway backend that this chat application interfaces with is also our own proprietary project. Although its code is not included in this repository, **do not build complex frontend workarounds for backend limitations.** If a feature requires changes, enhancements, or new API capabilities on the server side, proactively point them out and suggest the necessary backend modifications so the user can implement them in the LLM Gateway project.

### NUI Components

This project uses the **NUI Web Components** library (`nui_wc2`). Note that `nui_wc2` is a proprietary Git submodule. Since it is our own library, we can and should modify it directly if any underlying changes or new components are needed.

**📘 IMPORTANT:** For proper usage of the NUI library components, always reference the official quickstart guide:
`nui_wc2/docs/playground-component-quickstart.md`

When adding UI elements:
- **Use NUI components** whenever possible (`<nui-input>`, `<nui-select>`, `<nui-button>`, etc.)
- **Avoid custom HTML elements** like native `<input>` or `<select>` without the NUI wrapper
- **Don't add custom CSS** for basic styling - NUI handles it through the theme system
- **Use NUI theme variables** for colors (e.g., `--nui-shade2`, `--nui-accent`, `--nui-bg`, `--color-shade3`, `--border-shade1`)

Example - Correct:
```html
<nui-input id="temperature">
    <input type="number" min="0" max="2" step="0.1">
</nui-input>
```

Example - Avoid:
```html
<input type="number" id="temperature" class="custom-styled-input">
```

### NUI Theme Variables

Leverage NUI's CSS custom properties for consistent theming:

```css
/* Use NUI theme variables */
.my-element {
    background: var(--nui-bg); /* Or var(--color-base) / var(--color-shade2) */
    color: var(--nui-fg); /* Or var(--color-text) */
    border: 1px solid var(--nui-shade3); /* Or var(--border-shade1) */
}
```

Common theme variables:
- `--nui-bg` / `--nui-fg` / `--color-base` / `--color-text` - Background and foreground colors
- `--nui-shade2` through `--nui-shade7` and `--color-shade1` through `--color-shade9` - Shade variations
- `--nui-accent` / `--color-highlight` - Primary accent color
- `--border-shade1` through `--border-shade4` - Border shades
- `--nui-space`, `--nui-space-half`, `--border-radius1`, `--border-radius2` - Spacing and layout

The theme automatically supports light/dark modes based on system preferences.
