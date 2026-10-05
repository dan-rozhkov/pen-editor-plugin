---
name: sideform-dev-mode
description: Implements an existing Sideform design as frontend code — a read-only MCP workflow that reads structure, computed layout, tokens, and a screenshot to translate the node tree into matching markup/CSS. Use when asked to build or implement a component or screen FROM a Sideform design; never to edit the design itself.
---

# Sideform dev mode

You are translating a live Sideform design into code. This is a **read-only** task against the design: gather everything you need, then write code in the target codebase. Do **not** call `batch_design` or `set_variables` — reading a design in order to implement it is not a license to edit it. If the user actually wants the design itself changed, that's the `sideform-design` skill, not this one.

All Sideform tools below run against the user's editor. In clients that support MCP Apps, call **`open_canvas`** first; otherwise the user needs https://app.sideform.pro/app open and signed in in a browser tab. If a call errors because no editor is open, see `sideform-connect` (30s timeout).

## Workflow

1. **`get_editor_state`** — active file, selection, top-level nodes, available components. Establishes what you're implementing and its scope.
2. **`batch_get`** — pull the actual subtree you're implementing (by `nodeIds` or a search `patterns` match), with enough `readDepth`/`searchDepth` to see every descendant that matters. This is the node model: types, `layout`/`fills`/`strokes`/`effects`/`cornerRadius`, text content, etc.
3. **`snapshot_layout`** — the fidelity-critical step. This returns *computed* rectangles (positions/sizes) after Sideform's layout engine has run — not the raw authored properties. Use these numbers, not eyeballed guesses, for spacing, sizing, and any absolutely-positioned children. `problemsOnly: true` surfaces clipping/overflow you should account for in the implementation.
4. **`get_variables`** — read the design's tokens and map them onto the *codebase's own* design tokens (CSS variables, Tailwind theme values, etc.) rather than hardcoding hex values pulled off a node. If a fill/stroke references `$--some-token`, your code should reference the codebase's equivalent token, not a literal color.
5. **`get_screenshot`** — visual reference while translating, and again afterward to compare your built component against the design.

## Translating the node model to code

- An **auto-layout frame** (`layout: "vertical"` or `"horizontal"`) → a flex container in that direction; its `gap`/`padding` → `gap`/`padding` in CSS.
- `width`/`height: "fill_container"` → flex-grow / stretch sizing; `"fit_content"` → hug/auto sizing (e.g. `width: fit-content` or an unset flex-basis).
- `constraints: {horizontal, vertical}` on a node **without** auto-layout → non-flex positioning (`absolute`/pinned edges) — `min`/`max`/`center`/`stretch`/`scale` map to how that node should reposition/resize as its container resizes.
- `cornerRadius` — either a single number (uniform) or a 4-entry array `[topLeft, topRight, bottomRight, bottomLeft]` — maps directly to `border-radius` (shorthand or per-corner).
- The `fills`/`strokes`/`effects` arrays are paint/effect **stacks**, bottom-to-top (last entry renders on top): solid → background-color/border-color, gradient → CSS gradient, image → background-image/`<img>`, shadow (`outer`/`inner`) → `box-shadow`, blur → `filter: blur()`, background-blur → `backdrop-filter: blur()`. Reproduce stack order and blend modes if the design uses more than one layer.

## Boundaries

- Read tools only: `get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`.
- Never call `batch_design`, `set_variables`, or any other mutating tool from this skill.
- If the implementation reveals the design itself has a problem (e.g. it only holds together with a hack `snapshot_layout` exposes), report that to the user instead of silently fixing the design.
