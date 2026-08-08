---
name: pen-editor-design
description: Creates or modifies a design in Pen Editor over MCP — reads editor state, variables, and structure first, then applies changes with the batch_design mini-script DSL, and verifies the result visually. Use whenever asked to build, edit, restyle, or add to a Pen Editor canvas or document.
---

# Pen Editor design

You are an external MCP client driving a live Pen Editor document. All of these tools are **bridged**: they require a connected browser tab and time out after 30s if the tab is unresponsive. If a call errors with "No Pen Editor tab is connected", stop and see the `pen-editor-setup` skill instead of retrying blindly.

## Decision procedure

1. **`get_editor_state`** first, always. This is Figma's metadata-first pattern — it gives you the active file, selection, top-level nodes, and available components before you read or write anything else. Pass `include_schema: true` only if you need the raw node-format schema.
2. **`get_variables`** before using any `$--var` token. Variable references must use the *exact* names this returns, including the leading `--` and dashes (e.g. `"$--ck-blue-500"`). Never guess a token name.
3. **`batch_get`** to inspect the structure you're about to touch — search by `type`/`name` pattern or read specific `nodeIds`, with `readDepth`/`searchDepth` control. Do this before mutating existing nodes, not after.
4. **`get_guidelines(topic: "design-system")`** before any non-trivial layout work (new frames, auto-layout, component reuse). It has the sizing/auto-layout rules and component/variant conventions — don't restate them from memory, call it. `get_style_guide_tags` then `get_style_guide` are available if you need visual-direction inspiration/tokens for a from-scratch design.
5. **`batch_design`** to make the actual changes.
6. Verify (see bottom).

## `batch_design` DSL — rules you will otherwise get wrong

`batch_design` takes one `operations` string: a mini-script of `I`/`C`/`U`/`R`/`M`/`D`/`G` statements, one per line.

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

- **`get_screenshot`** (omit `nodeId` to screenshot the current selection) to visually confirm the result.
- **`snapshot_layout`** to check the *computed* post-layout rectangles for placement, overlap, or clipping problems — especially after adding auto-layout frames or resizing.

If either surfaces a problem, fix it with another `batch_design` call and re-verify — don't report success on the strength of the mutation call alone.
