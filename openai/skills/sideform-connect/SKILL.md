---
name: sideform-connect
description: Connects to Sideform and fixes a failing connection — sign-in, API keys, open_canvas, and the no-editor-open error. Use when Sideform tool calls fail, ask for authentication, or report that no editor is open.
---

# Sideform connect

The `sideform` MCP server is hosted at https://api.sideform.pro/mcp. Match the symptom below.

## Sign-in

- The client signs in with OAuth when you connect. The user needs a Sideform account.
- Without OAuth, the user can create an API key at https://app.sideform.pro/account and send it as `Authorization: Bearer sf_...`.
- A 401 error means the sign-in or key is missing, expired or revoked. Ask the user to sign in again or create a new key. Do not retry.

## Reaching the editor

Design tools (`get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables`, comments, `read_embed_html`, `edit_embed_html`, `rename_layers`, `find_empty_space_on_canvas`) need an editor.

1. In a client that supports MCP Apps, call `open_canvas`. It shows the live canvas in the chat and connects the tools to it.
2. Otherwise, ask the user to open https://app.sideform.pro/app in a browser tab, signed in to the same account, and keep it open.

If a tool reports that no editor is open, do step 1 or 2, then call the tool again once. Do not loop.

## Tools that need no editor

`list_skills`, `load_skill`, `get_guidelines`, `get_style_guide_tags` and `get_style_guide` run on the server and work without an editor.

## Next step

When connected, use `sideform-design` to build or edit a design (new screens are HTML embeds, built with `load_skill("prototype")`), or `sideform-dev-mode` to implement a design as code.
