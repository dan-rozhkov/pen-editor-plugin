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
3. `~/.pen-editor/mcp.json` — a handshake file two different servers can write to the same path/shape (`{"url", "token", "port"}`): `pen-editor-backend`, in local dev when `MCP_AUTH_TOKEN` is left unset (its dev-server counterpart, `pen-editor`, reads the same file to pick up the token); and `pen-editor-desktop`, which writes it on every launch with no configuration at all. Whichever one last published the file is what the proxy connects to — this is what makes both local dev and the desktop app zero-config, no env vars, no manual file editing.
4. Default `http://localhost:3001/api/mcp`, no token.

**Two different servers, same name:** `pen-editor-backend` and `pen-editor-desktop` both publish an MCP server named `pen-editor` through this same handshake file, but their tool sets and tool behavior differ — see "Two `pen-editor` endpoints" below before assuming a symptom or fix that's specific to one applies to the other.

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
| Desktop app: MCP tool error is the exact string "The Pen Editor tab is running an older build that does not support the desktop MCP bridge (needs bridge protocol >= 1, tab reported none). Restart the app to pick up the current deployed editor." | The focused/targeted tab loaded a page old enough that it never calls `registerMcpBridge`, so the desktop app's dispatcher has no registration for it | Restart `pen-editor-desktop` (or open a new tab) so it loads the current deployed editor bundle, which registers the bridge on load |
| Desktop app: no tools work at all, tab strip indicator is amber/hidden, or the File menu's disabled "MCP: …" line reads "Not published (another server is running)" or "Off" | A live `pen-editor-backend` already owns `~/.pen-editor/mcp.json` (the app refuses to clobber a live owner — it stays `not-published`), or the app hasn't published anything yet (`off`) | Either stop the local backend, or use the app's **File → "Use this app for MCP"** menu item to force-publish over it. No action needed to recover the other way: once the backend that was clobbering it exits, the app notices on its own (it watches the handshake file) and republishes automatically |
| Desktop app: File menu's disabled "MCP: …" line reads "Failed to start (see \"Use this app for MCP\")", tab strip indicator is red | The app's local HTTP server failed to bind, or bound but couldn't write the handshake file (e.g. `~/.pen-editor` not writable) | Use **File → "Use this app for MCP"** to retry, or restart the app. Check that `~/.pen-editor` is writable if it keeps failing |
| Desktop app: `list_editor_tabs` isn't in `tools/list`, or a `tabId` argument is rejected/ignored | The plugin is actually connected to `pen-editor-backend`, not `pen-editor-desktop` — `list_editor_tabs` and `tabId` routing exist only on the desktop endpoint | If you expected the desktop app, check which one actually owns `~/.pen-editor/mcp.json` right now (see the coexistence row above) |

## Which tools need what

- **Bridged tools** (`get_editor_state`, `batch_get`, `snapshot_layout`, `get_variables`, `get_screenshot`, `batch_design`, `set_variables`) all require a live, connected editor tab against either endpoint. Every symptom above involving "no tab connected" or a 30s timeout applies to these.
- **`get_guidelines`, `get_style_guide_tags`, `get_style_guide`** behave differently per endpoint — this is not one fixed category:
  - Against `pen-editor-backend`, these run entirely server-side and work as soon as the backend is reachable and authenticated — no browser tab needed. If these work but the bridged tools don't, the problem is specifically the tab connection, not auth or the backend process.
  - Against `pen-editor-desktop`, there is no server-side execution path at all — every tool, these three included, is dispatched into the focused (or `tabId`-selected) editor tab. A tab must be open and registered, or they fail exactly like a bridged tool would (see the "no tab connected" / upgrade-error rows above).
- **`list_editor_tabs`** (desktop only) needs no tab at all — the app answers it itself from tab metadata it already tracks, without a page round-trip. It's the one tool that's always available whenever the desktop app is reachable, regardless of tab state.
- **`configure_pen_editor_connection`** is handled entirely by the proxy itself, locally — it never touches the backend or the editor tab, and works even when nothing else is configured (it's always listed in `tools/list`, even when a real tools/list call to the backend fails). Use it to fix everything above except the tab connection.

## Two `pen-editor` endpoints

The proxy can end up pointed at either of two different MCP servers that both identify themselves as `pen-editor`, with different tool sets:

- **`pen-editor-backend`** — the tools listed in "Which tools need what" above, no `list_editor_tabs`, no `tabId` argument on anything.
- **`pen-editor-desktop`** — the same bridged tools plus `list_editor_tabs`, and every tool (including `get_guidelines`/`get_style_guide_tags`/`get_style_guide`) accepts an optional `tabId` to target a specific open tab instead of whichever one is focused; omit it to target the focused tab.

There's no dedicated "which one am I talking to" tool — check for `list_editor_tabs` in `tools/list` to tell them apart.

## Multi-tab behavior

If more than one browser tab is connected at once, the backend routes every call to the **most-recently-active** tab (the one that sent a message or user activity most recently) — not necessarily the one the user thinks is "the" tab. If calls seem to be landing on the wrong document, check which tab was interacted with last, or close the tabs you don't want targeted.

## First-time install

For local development, install the plugin and run `pen-editor-backend` and `pen-editor` with no extra configuration — see "How the proxy finds the backend" above. For a remote or explicitly-tokened backend, call `configure_pen_editor_connection` with `{url, token}` once the user provides them (or set `PEN_EDITOR_MCP_TOKEN` / `PEN_EDITOR_MCP_URL` / `<PLUGIN_DATA>/config.json` directly). Then open Pen Editor in a browser and leave that tab open while using the plugin.
