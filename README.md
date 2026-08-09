# pen-editor-plugin

[![CI](https://github.com/dan-rozhkov/pen-editor-plugin/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/dan-rozhkov/pen-editor-plugin/actions/workflows/ci.yml)

Pen Editor packaged as an [Agent Plugins 1.0.0](https://agent-plugins.org/)
plugin, installable in any client that supports the specification (VS Code,
Cursor, and others).

Installing it gives the agent:

- the `pen-editor` MCP server — read and edit a live Pen Editor document:
  structure, computed layout, design variables, screenshots, and the
  `batch_design` DSL for creating and modifying designs;
- three skills the client picks up on its own, no prompt wiring needed:
  `pen-editor-design` (build or edit a design), `pen-editor-dev-mode`
  (implement an existing design as code), and `pen-editor-setup`
  (diagnose a broken connection).

This plugin's proxy talks to either of two MCP servers, both named
`pen-editor`, both discovered the same way (see "How the proxy finds the
backend" in the setup skill) — but with different tool behavior. See
"Desktop app vs. backend: what differs" below.

## Setup

### Desktop app (zero-config)

1. Install [`pen-editor-desktop`](../pen-editor-desktop).
2. Install this plugin.
3. Done — the app publishes a loopback MCP endpoint and writes
   `~/.pen-editor/mcp.json` on launch; the plugin discovers it with no
   backend, no env vars, and no manual token. Open a document in the app
   and call any tool — it routes into whichever tab is focused.

### Local development (zero-config)

1. Install the plugin.
2. Run the backend:
   ```bash
   cd pen-editor-backend
   npm run dev
   ```
   With no `MCP_AUTH_TOKEN` set, the backend generates one itself, serves
   MCP loopback-only, and writes it to `~/.pen-editor/mcp.json`.
3. Run the editor:
   ```bash
   cd pen-editor
   npm run dev
   ```
   It picks up the same token automatically.
4. Done — the plugin discovers the backend on its own. Most tools need the
   editor tab open in a browser; `get_guidelines`, `get_style_guide_tags`
   and `get_style_guide` work without one (see the caveat below — this is
   backend-specific).

### Remote backend

For a backend that isn't running on localhost, or one with an explicit
`MCP_AUTH_TOKEN`, point the plugin at it:

```bash
cd pen-editor-backend
MCP_AUTH_TOKEN=<secret-at-least-16-chars> npm run dev
```

```bash
cd pen-editor
VITE_MCP_WS_TOKEN=<same-secret> npm run dev
```

**Note:** `VITE_MCP_WS_TOKEN` is inlined into the public JS bundle at build
time. Use it only in a local/dev build — never on a publicly deployed
frontend, or any visitor gets the secret.

Then tell the plugin the URL and token, either by asking the agent to run
its `configure_pen_editor_connection` tool (paste the URL and token into
chat), or by writing `config.json` into the plugin's data directory (the
client decides the exact path):

```json
{
  "url": "https://my-backend.example.com/api/mcp",
  "token": "<secret-at-least-16-chars>"
}
```

Environment variables `PEN_EDITOR_MCP_URL` / `PEN_EDITOR_MCP_TOKEN` are also
supported as a power-user channel — but it's non-portable (not every client
preserves ambient env vars) and lower precedence than
`<PLUGIN_DATA>/config.json`, so once `configure_pen_editor_connection` has
written that file, these env vars no longer have any effect.

## Desktop app vs. backend: what differs

Both endpoints answer to the name `pen-editor` and share most of the same
tool set, but they are different servers with different tool behavior:

- **`get_guidelines`, `get_style_guide_tags`, `get_style_guide`** run
  server-side against `pen-editor-backend` — no editor tab needed. Against
  the desktop app, every tool, including these three, is executed in an
  editor tab; with no tab open (or none registered), they fail the same way
  any other tool does.
- **`list_editor_tabs`** exists only against the desktop app. It lists open
  tabs, their titles, and whether each is active and ready for MCP calls
  (`mcpReady`). `pen-editor-backend` has no such tool — it has no concept of
  multiple tabs.
- **`tabId`** is an optional argument on every other desktop-app tool (get
  it from `list_editor_tabs`), routing the call to a specific tab instead of
  whichever one is focused. `pen-editor-backend` does not accept this
  argument at all — it always routes to its single connected tab.

An agent author who assumes "the three static tools always work without a
tab" or "there's only one `pen-editor` MCP server" will be surprised by one
of these two endpoints. Which one is running is not something the plugin
exposes directly — infer it from whether `list_editor_tabs` is in
`tools/list`.

## License

MIT — see [LICENSE](LICENSE).
