---
name: sideform-design
description: Creates or modifies a design in Sideform over MCP — every new screen is one self-contained HTML embed built by following the in-app prototype skill; existing screens are edited with the embed tools. Use whenever asked to build, edit, restyle, or add to a Sideform canvas or document.
---

# Sideform design

You are driving a live Sideform document through the `sideform` MCP server. Design tools run against the user's editor. Start with **`open_canvas`** when your client supports MCP Apps: it shows the live canvas in the chat and connects the design tools to it. In clients without MCP Apps, the user must have https://app.sideform.pro/app open and signed in in a browser tab. If a call errors because no editor is open, stop and use the `sideform-connect` skill instead of retrying blindly. Calls time out after 30s if the editor is unresponsive.

## Decision procedure

0. **`open_canvas`** first in apps-capable clients (once per conversation).
1. **New screen, page, app or deck: `load_skill("prototype")`** (or `load_skill("slides")` for a presentation) and follow it. It holds the full rules for fonts, icons, photos, sizing and taste. Do not rebuild those rules from memory. Load the skill before the first `batch_design` call.
2. **`get_editor_state`** — active file, selection, top-level nodes, variables.
3. **`find_empty_space_on_canvas`** for the first screen's position, then place each next screen at `x = previous x + previous width + ~120`.
4. **`batch_design`** — one screen per call. Then verify (see bottom).

## New screens are ONE top-level `embed`

The server rejects top-level native creates (`frame`, `rect`, `text`, ...) on `/mcp`. Every NEW screen or page is exactly one top-level `embed` node whose `htmlContent` is a complete, self-contained HTML document:

- Sizes: mobile 390×844, tablet 768×1024, desktop 1440×1024 (slides: see the `slides` skill).
- Fonts through `@import` in `<style>`. Icons: Phosphor through `@import` from unpkg. Photos: picsum.photos URLs. No JavaScript.
- Fit to canvas: all content must fit the declared width and height. The embed does not scroll.
- One screen per `batch_design` call. Several screens: one call each, in order.

Example (the HTML is shortened here; write the full markup as one string):

```
screen=I(document, {type:"embed", name:"Login", x:0, y:0, width:390, height:844, htmlContent:"<!doctype html><html>…</html>"})
```

`htmlContent` must be one continuous string. Do not join pieces with `+`. Escape inner double quotes, or use single quotes in the HTML.

The `prototype` skill mentions some steps that do not exist over MCP: `ask_user`, `generate_image` and research tools. Skip them and choose sensible defaults yourself (audience, style, palette, copy). Use picsum photos for imagery.

## Editing existing screens

- **`read_embed_html`** to get the current HTML of a screen, then **`edit_embed_html`** to change it. Prefer a small targeted edit to a full rewrite.
- Use **native nodes only to edit an existing native design** (`batch_get`, then `U`/`I` inside existing frames). Never create a new top-level native node.
- `get_variables` before you use a `$--var` token on a native node. Names must match exactly, including the leading `--`.

## `batch_design` DSL — rules you will otherwise get wrong

These rules apply to native-node edits. For embeds, `I(document, {...})` with `type:"embed"` is the only create you need. `batch_design` takes one `operations` string: a mini-script of `I`/`C`/`U`/`R`/`M`/`D`/`G` statements, one per line.

- **`I(parent, nodeData)`** inserts a new node — this is the **only** way to add a child to an existing node. `U()` can update properties but cannot add, remove, or reorder children.
- **Bindings** (`name=I(...)` or `name=R(...)`) let you reference a just-created/replaced node later in the *same call* (e.g. `card=I(...)` then `U(card+"/title", {...})`). Only `I` and `R` can bind — `C`/`U`/`M`/`D`/`G` never produce a binding. Bindings do **not** survive across separate `batch_design` calls, and an `id`/`name` field you put inside `nodeData` is cosmetic only — never usable as a binding reference.
- Use `+` to build child paths off a binding or a real id: `U(card+"/title", {content: "Hello"})`.
- **No `image` node type.** To apply an image, use `G(nodeId, "ai"|"stock", prompt)` on a frame/rectangle to generate or find an image and apply it as a fill.
- There is a cap on operations per call. If you send more than the cap, the call still succeeds but only the first N run — the result reports `truncated: true` with the skipped operations. On `truncated: true`, your **next** `batch_design` call must contain ONLY the skipped operations (never repeat ones that already ran), and you must replace any binding references from the truncated call with the real node ids from that result's `bindings` field — bindings don't carry over.
- Text nodes have no color by default — always set `fill` (or a `fills` stack) explicitly.
- `width`/`height: "fill_container"` is only valid on a child whose parent has a flexbox `layout` (vertical/horizontal auto-layout) — never on a child of a plain frame.
- `$--var` references inside a `fill`/`fills`/`stroke`/`strokes` color must match `get_variables` output exactly.

Don't try to hold the rest of the DSL (fills/strokes/effects paint stacks, corner radius/smoothing, constraints, masks, lists, component variants, etc.) in your head — the full reference is in `batch_design`'s own tool description; re-read it when you need a shape you're not sure about, rather than guessing syntax.

## Verification

After a `batch_design` call, don't assume it looks right:

- **`get_screenshot`** of the new embed (omit `nodeId` to screenshot the current selection) to visually confirm the result.
- **`snapshot_layout`** to check the *computed* post-layout rectangles for placement, overlap, or clipping problems — especially after adding auto-layout frames or resizing.

If either surfaces a problem, fix it with another `batch_design` call and re-verify — don't report success on the strength of the mutation call alone.
