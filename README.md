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

### 1. Backend

Run `pen-editor-backend` with `MCP_AUTH_TOKEN` set (at least 16 characters,
otherwise `/api/mcp*` returns 503):

```bash
cd pen-editor-backend
MCP_AUTH_TOKEN=<secret-at-least-16-chars> npm run dev
```

### 2. Editor tab

Most tools operate on a live editor tab. Open the editor with
`VITE_MCP_WS_TOKEN` set to the same value as `MCP_AUTH_TOKEN`:

```bash
cd pen-editor
VITE_MCP_WS_TOKEN=<same-secret> npm run dev
```

Without a connected tab, those tools return an error. `get_guidelines`,
`get_style_guide_tags` and `get_style_guide` work without one.

**Note:** `VITE_MCP_WS_TOKEN` is inlined into the public JS bundle at build
time. Use it only in a local/dev build — never on a publicly deployed
frontend, or any visitor gets the secret.

### 3. Plugin

Point the plugin at the backend, either through environment variables:

```
PEN_EDITOR_MCP_URL=https://my-backend.example.com/api/mcp
PEN_EDITOR_MCP_TOKEN=<secret-at-least-16-chars>
```

or through `config.json` in the plugin's data directory (the client decides
the exact path):

```json
{
  "url": "https://my-backend.example.com/api/mcp",
  "token": "<secret-at-least-16-chars>"
}
```

Environment variables win over the file. The URL defaults to
`http://localhost:3001/api/mcp`, so for local development only the token is
required.

## License

MIT — see [LICENSE](LICENSE).
