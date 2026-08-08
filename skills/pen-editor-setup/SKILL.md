---
name: pen-editor-setup
description: Diagnoses and fixes a broken or unconfigured Pen Editor MCP connection, and covers first-time plugin setup — maps error strings (401, 503, connection refused, no tab connected, timeout) to their exact fix. Use when Pen Editor tool calls fail or error, or when installing/configuring this plugin.
---

# Pen Editor setup

This plugin ships a dependency-free stdio proxy (`bin/pen-editor-mcp.mjs`) that forwards MCP calls to the `pen-editor-backend` server's `/api/mcp` endpoint. It reads its target URL and auth token from environment variables or a config file. Diagnose failures by matching the exact symptom below — don't guess.

## Diagnostic table

| Symptom | Cause | Fix |
|---|---|---|
| MCP tool error mentioning no configured token | The proxy has no token to authenticate with the backend | Set `PEN_EDITOR_MCP_TOKEN`, or write `<PLUGIN_DATA>/config.json` with `{"url": "...", "token": "..."}` |
| `401 Unauthorized` | The plugin's token doesn't match the backend's `MCP_AUTH_TOKEN` | Get the correct token from whoever runs the backend and update `PEN_EDITOR_MCP_TOKEN` / `config.json` |
| `503` / "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)" | The backend has `MCP_AUTH_TOKEN` unset, so the whole `/api/mcp*` surface is disabled | Set `MCP_AUTH_TOKEN` in the backend's environment (must be **at least 16 characters**) and restart it |
| Connection refused | The backend isn't running, or the URL is wrong | Start it: `npm run dev` in `pen-editor-backend` (default `http://localhost:3001/api/mcp`). Override the target with `PEN_EDITOR_MCP_URL` if it runs elsewhere |
| "No Pen Editor tab is connected. Open the editor in a browser with MCP enabled (VITE_MCP_WS_TOKEN set)." | No browser tab is currently connected over the WebSocket bridge, or the tab was closed | Open the Pen Editor app in a browser with `VITE_MCP_WS_TOKEN` set to match the backend's `MCP_AUTH_TOKEN`, and keep that tab open |
| A bridged tool call times out (after 30s) | The connected tab is open but unresponsive (e.g. a stuck render, or the page lost focus mid-heavy-operation) | Check the tab is alive and interactive; reload it if not, then retry the call |

## Which tools need what

- **Bridged tools** (`get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables`) all require a live, connected editor tab. Every symptom above involving "no tab connected" or a 30s timeout applies only to these.
- **Static tools** (`get_guidelines`, `get_style_guide_tags`, `get_style_guide`) run entirely on the backend and work as soon as the backend is reachable and authenticated — no browser tab needed. If these work but the bridged tools don't, the problem is specifically the tab connection, not auth or the backend process.

## Multi-tab behavior

If more than one browser tab is connected at once, the backend routes every call to the **most-recently-active** tab (the one that sent a message or user activity most recently) — not necessarily the one the user thinks is "the" tab. If calls seem to be landing on the wrong document, check which tab was interacted with last, or close the tabs you don't want targeted.

## First-time install

Set `PEN_EDITOR_MCP_TOKEN` (matching the backend's `MCP_AUTH_TOKEN`) and, if the backend isn't on the default `http://localhost:3001/api/mcp`, `PEN_EDITOR_MCP_URL`. Alternatively write `<PLUGIN_DATA>/config.json` as `{"url": "...", "token": "..."}`. Then open Pen Editor in a browser with `VITE_MCP_WS_TOKEN` set to the same token, and leave that tab open while using the plugin.
