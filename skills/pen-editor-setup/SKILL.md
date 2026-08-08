---
name: pen-editor-setup
description: Diagnoses and fixes a broken or unconfigured Pen Editor MCP connection, and covers first-time plugin setup — maps error strings (401, 503, connection refused, no tab connected, timeout) to their exact fix. Use when Pen Editor tool calls fail or error, or when installing/configuring this plugin.
---

# Pen Editor setup

This plugin ships a dependency-free stdio proxy (`bin/pen-editor-mcp.mjs`) that forwards MCP calls to the `pen-editor-backend` server's `/api/mcp` endpoint. Diagnose failures by matching the exact symptom below — don't guess.

## How the proxy finds the backend

In this order:

1. `<PLUGIN_DATA>/config.json` — the portable config file; this is what `configure_pen_editor_connection` (below) writes. **Highest precedence: once this file has both a url and a token, nothing below it has any effect.**
2. `PEN_EDITOR_MCP_URL` / `PEN_EDITOR_MCP_TOKEN` env vars — a power-user channel, not guaranteed to survive in every client.
3. `~/.pen-editor/mcp.json` — a handshake file `pen-editor-backend` writes for itself in local dev when `MCP_AUTH_TOKEN` is left unset: it generates a token, serves MCP loopback-only, and writes `{"url", "token", "port"}` there. `pen-editor`'s dev server reads the same file to pick up the token. This is what makes local dev zero-config — no env vars, no manual file editing.
4. Default `http://localhost:3001/api/mcp`, no token.

`url` and `token` are resolved independently across steps 1–2 (e.g. url from `config.json`, token from an env var is fine). Step 3 is the one exception: its token is a loopback-only secret bound to *its own* url, so it's only ever consulted while `url` is still unresolved — if `config.json` or an env var already pinned `url` to something else, the handshake file is skipped entirely rather than pairing its token with a foreign url. If you see a clean "no token configured" error even though `~/.pen-editor/mcp.json` clearly has one, this is almost always why: something upstream already resolved `url`.

Even fully unconfigured, `initialize` still completes locally (rather than failing the connection outright) so the client always gets far enough to call `tools/list` and discover `configure_pen_editor_connection` — see "Which tools need what" below.

## Diagnostic table

| Symptom | Cause | Fix |
|---|---|---|
| MCP tool error mentioning no configured token | None of the four sources above resolved a token | Start `pen-editor-backend` locally with no `MCP_AUTH_TOKEN` set (writes the handshake file automatically), or call `configure_pen_editor_connection` with a URL and token. Setting `PEN_EDITOR_MCP_TOKEN` also works, but only as long as no `configure_pen_editor_connection` call has ever run in this `<PLUGIN_DATA>` — `<PLUGIN_DATA>/config.json` outranks it (see precedence above), so once that file exists, editing the env var silently does nothing until `config.json` is fixed or removed |
| `401 Unauthorized` | The plugin's token doesn't match the backend's `MCP_AUTH_TOKEN` | If pointed at a remote/explicit backend, get the correct token from whoever runs it and call `configure_pen_editor_connection` — this is the fix that always takes effect, since `config.json` is the highest-precedence source. Editing `PEN_EDITOR_MCP_TOKEN` only helps if `<PLUGIN_DATA>/config.json` doesn't already have a (wrong) token in it. If pointed at a local backend, the handshake file is likely stale from a previous run — restart the backend |
| `503` / "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)" | The connected backend is running with `NODE_ENV=production` and no `MCP_AUTH_TOKEN` set — production never auto-generates a token, unlike local dev | Set `MCP_AUTH_TOKEN` on that backend, or run it without `NODE_ENV=production` for local-dev auto-token mode. (In local dev - `NODE_ENV` unset/anything but `production` - the backend auto-generates a token and writes the handshake file instead of ever returning 503 for a merely-unset `MCP_AUTH_TOKEN`; if you're on a dev backend and still see this, the URL is probably hitting the wrong server entirely) |
| `403 Forbidden` mentioning "auto-generated local-dev token" | The backend is in local-dev auto-token mode (no `MCP_AUTH_TOKEN` set, `NODE_ENV` not `production`) and only accepts loopback (127.0.0.1) callers, but the plugin's configured URL isn't loopback | Either point the plugin back at `127.0.0.1`/`localhost`, or set an explicit `MCP_AUTH_TOKEN` on the backend to allow non-loopback access |
| Connection refused | The backend isn't running, or the URL is stale/wrong | Start it: `npm run dev` in `pen-editor-backend`. For local dev this needs no other setup. For a remote backend, fix the URL with `configure_pen_editor_connection` |
| The user pasted a remote backend URL and token into chat, but tools still fail | The plugin doesn't know about it yet — pasting text into chat doesn't configure anything by itself | Call the `configure_pen_editor_connection` tool with `{url, token}`. It writes `<PLUGIN_DATA>/config.json` and takes effect on the very next tool call, no restart needed. Don't ask the user to find or edit a config file themselves — they don't know its path |
| "No Pen Editor tab is connected. Open the editor in a browser with MCP enabled (VITE_MCP_WS_TOKEN set)." | No browser tab is currently connected over the WebSocket bridge, or the tab was closed | Open the Pen Editor app in a browser. In local zero-config mode it picks up the handshake token itself; otherwise set `VITE_MCP_WS_TOKEN` to match the backend's `MCP_AUTH_TOKEN`. Keep that tab open |
| A bridged tool call times out (after 30s) | The connected tab is open but unresponsive (e.g. a stuck render, or the page lost focus mid-heavy-operation) | Check the tab is alive and interactive; reload it if not, then retry the call |

## Which tools need what

- **Bridged tools** (`get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables`) all require a live, connected editor tab. Every symptom above involving "no tab connected" or a 30s timeout applies only to these.
- **Static tools** (`get_guidelines`, `get_style_guide_tags`, `get_style_guide`) run entirely on the backend and work as soon as the backend is reachable and authenticated — no browser tab needed. If these work but the bridged tools don't, the problem is specifically the tab connection, not auth or the backend process.
- **`configure_pen_editor_connection`** is handled entirely by the proxy itself, locally — it never touches the backend or the editor tab, and works even when nothing else is configured (it's always listed in `tools/list`, even when a real tools/list call to the backend fails). Use it to fix everything above except the tab connection.

## Multi-tab behavior

If more than one browser tab is connected at once, the backend routes every call to the **most-recently-active** tab (the one that sent a message or user activity most recently) — not necessarily the one the user thinks is "the" tab. If calls seem to be landing on the wrong document, check which tab was interacted with last, or close the tabs you don't want targeted.

## First-time install

For local development, install the plugin and run `pen-editor-backend` and `pen-editor` with no extra configuration — see "How the proxy finds the backend" above. For a remote or explicitly-tokened backend, call `configure_pen_editor_connection` with `{url, token}` once the user provides them (or set `PEN_EDITOR_MCP_TOKEN` / `PEN_EDITOR_MCP_URL` / `<PLUGIN_DATA>/config.json` directly). Then open Pen Editor in a browser and leave that tab open while using the plugin.
