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

## Setup

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
   and `get_style_guide` work without one.

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

## License

MIT — see [LICENSE](LICENSE).
