# astro-icon-sprite

Build-time SVG compilation into a runtime sprite sheet, powered by [astro-stacks](../astro-stacks). Icons are compiled into `<symbol>` elements at build time, deduplicated per page at render time, and emitted as a single inline SVG sprite sheet.

Each icon in the HTML is just an `<svg><use href="#id" /></svg>` reference -- zero runtime JavaScript, no icon fonts, no duplicate SVG markup.

## Architecture

The package has three parts:

1. **Vite plugin** (`iconSprite`) -- Scans SVG files at build time, sanitizes them, and compiles them into a virtual module (`virtual:icon-registry`) that maps icon names to their `<symbol>` markup.

2. **`Icon.astro` component** -- Imports the registry, looks up an icon by name, and uses `stacks.pushOnce()` to add its `<symbol>` to the `iconSprite` stack. Renders an `<svg><use href="#id" /></svg>` reference in place.

3. **`IconSprite.astro` component** -- Reads the `iconSprite` stack and emits all collected symbols inside a hidden SVG element. Only symbols for icons actually used on the page are included.

## How It Works End-to-End

```
build time                              render time (per request)
-----------                             -------------------------
SVG files on disk                       <Icon name="search" />
       |                                         |
  Vite plugin scans & compiles             imports registry,
       |                                  calls pushOnce("iconSprite", ...)
  virtual:icon-registry                          |
  (JSON of all compiled symbols)         <IconSprite />
                                                 |
                                          reads stacks.get("iconSprite"),
                                          emits collected <symbol> elements
```

At build time, the Vite plugin reads SVG files from configured directories, strips unsafe content, extracts `viewBox` and inner markup, and wraps each in a `<symbol>` element. The result is a virtual module that the `Icon` component imports.

At render time, when `<Icon name="search" />` is encountered, the component looks up `"search"` in the registry and calls `stacks.pushOnce("iconSprite", "icon-search", symbolMarkup)`. The `pushOnce` deduplication ensures each symbol appears only once, even if the same icon is used twenty times on a page.

After `<slot />` renders, `<IconSprite />` reads the stack and emits all symbols inside a hidden `<svg>` element.

## Installation

```bash
npx astro add astro-icon-sprite
```

Or manually:

```bash
bun add astro-icon-sprite
```

Requires `astro-stacks` as a peer dependency. The stacks middleware must be configured (see [astro-stacks README](../astro-stacks/README.md)).

## Setup

### 1. Astro Config

Add the `astroIconSprite` integration to your Astro config:

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import astroIconSprite from "astro-icon-sprite";

export default defineConfig({
  output: "server",
  integrations: [
    astroIconSprite({
      local: "src/icons",
      resolve: {
        lu: "lucide-static/icons",
      },
    }),
  ],
});
```

### 2. Layout

Place `<IconSprite />` after `<slot />` in your layout:

```astro
---
import Stack from "astro-stacks/stack.astro";
import IconSprite from "astro-icon-sprite/icon-sprite.astro";
---

<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width" />
    <title>My Site</title>
    <Stack name="head" />
  </head>
  <body>
    <slot />

    <IconSprite />
    <Stack name="beforeBodyEnd" />
  </body>
</html>
```

`IconSprite` must come after `<slot />` because it relies on the stacks store being populated by `Icon` components that rendered inside the slot.

### 3. Use Icons

```astro
---
import Icon from "astro-icon-sprite/icon.astro";
---

<button>
  <Icon name="search" class="size-5" />
  Search
</button>

<!-- Prefixed icon from a resolved directory -->
<Icon name="lu:house" class="size-6 text-blue-500" />
```

## Configuration

### `local`

Directory for local SVG files. Defaults to `"src/icons"`.

All `.svg` files in this directory are compiled into the registry and available by filename (without the `.svg` extension).

```
src/icons/
  search.svg      -> name="search"
  chevron-down.svg -> name="chevron-down"
  close.svg       -> name="close"
```

### `resolve`

Maps prefixes to directories. Icons from resolved directories use the `prefix:name` naming convention.

```js
astroIconSprite({
  resolve: {
    lu: "lucide-static/icons",       // node_modules path (tree-shaken)
    heroicons: "src/heroicons",      // local path (all included)
  },
})
```

**Local paths** (`src/...`, `./...`, `../...`): All SVGs in the directory are compiled into the registry, just like the `local` option.

**Node modules paths** (everything else): Only icons that are actually referenced in your source code are compiled. This is the tree-shaking behavior described below.

## Naming Conventions

| Source | Icon name | Example |
|--------|-----------|---------|
| Local (`src/icons/search.svg`) | Filename without extension | `name="search"` |
| Resolved (`lu` prefix, `house.svg`) | `prefix:filename` | `name="lu:house"` |

## Tree-Shaking

For `node_modules` icon libraries (non-local paths in `resolve`), the plugin scans your source files to find which `prefix:name` patterns are actually used. Only those icons are compiled and bundled.

This means you can install a library with 1000+ icons and only the ones you reference in your `.astro`, `.tsx`, `.jsx`, `.ts`, `.js`, `.svelte`, `.vue`, `.html`, `.md`, or `.mdx` files will be included in the build.

The scan uses `git ls-files` when available for speed, falling back to a filesystem walk that skips `node_modules`, `dist`, and dotfile directories.

In dev mode, the plugin also discovers new icon references on-the-fly through the Vite transform hook. If you add `<Icon name="lu:bell" />` to a file, the plugin detects the `lu:bell` pattern during transform, compiles the SVG, and triggers a reload.

## SVG Sanitization

All SVGs are sanitized at build time for security. The following are stripped:

- `<script>` elements
- `<style>` elements
- `<foreignObject>` elements
- Animation elements (`<set>`, `<animate>`, `<animateTransform>`, `<animateMotion>`)
- Inline event handlers (`onclick`, `onload`, etc.)
- `javascript:` and `data:` URIs in `href` / `xlink:href` attributes

The `viewBox` attribute is preserved (defaulting to `0 0 24 24` if absent). Attributes like `xmlns`, `xmlns:xlink`, `version`, `width`, `height`, `class`, `style`, `id`, `x`, and `y` are stripped from the root `<svg>` element since the symbol wrapper provides its own.

## HMR (Dev Mode)

In development, the plugin watches SVG directories for changes:

- **Local directories** and **local resolved directories** are watched via the Vite dev server's file watcher.
- Adding, modifying, or deleting an SVG triggers a debounced rebuild (200ms) and a full page reload.
- New `prefix:name` references found in source files during transforms are compiled on-the-fly without a full rebuild.

## Type Safety

The integration uses Astro's `injectTypes()` API to auto-generate type declarations. No manual `env.d.ts` setup is needed — run `astro sync` (or start the dev server) and you get:

- **`virtual:icon-registry`** module declaration
- **`IconNames`** interface augmented with every discovered icon name, giving you autocomplete on the `name` prop
- **`StackNames`** interface augmented with `"iconSprite"` (when `astro-stacks` is present)

In dev mode, the generated types are also kept in sync when SVG files are added or removed.

## Icon Component API

```astro
<Icon name="search" />
<Icon name="lu:house" class="size-6" aria-label="Home" />
```

The `Icon` component accepts all standard SVG attributes in addition to `name`. These are spread onto the rendered `<svg>` element.

| Prop | Type | Description |
|------|------|-------------|
| `name` | `IconName` | Icon name with autocomplete (e.g. `"search"` or `"lu:house"`) |
| `...attrs` | SVG attributes | Any valid SVG attribute (`class`, `style`, `aria-label`, etc.) |

In dev mode, a console warning is emitted if the icon name is not found in the registry.

## IconSprite Component

Renders all collected icon symbols as a hidden inline SVG. Takes no props.

```astro
<IconSprite />
```

The rendered output (when icons have been used on the page):

```html
<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0" aria-hidden="true">
  <symbol id="icon-search" viewBox="0 0 24 24"><!-- paths --></symbol>
  <symbol id="icon-lu--house" viewBox="0 0 24 24"><!-- paths --></symbol>
</svg>
```

If no icons were used on the page, nothing is rendered.

## Sprite ID Format

Icon names are converted to sprite IDs with the prefix `icon-`, colons replaced by `--`, and any remaining characters outside `[a-zA-Z0-9_-]` stripped:

| Icon name | Sprite ID |
|-----------|-----------|
| `search` | `icon-search` |
| `lu:house` | `icon-lu--house` |
| `hero:arrow-left` | `icon-hero--arrow-left` |

## Exports

| Export Path | Contents |
|---|---|
| `astro-icon-sprite` | `astroIconSprite` integration (default), `iconSprite` plugin, `IconPluginOptions`, `IconNames`, `IconName` types |
| `astro-icon-sprite/icon.astro` | `Icon` component |
| `astro-icon-sprite/icon-sprite.astro` | `IconSprite` component |
