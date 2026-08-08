// Dependency-free stdio <-> Streamable-HTTP MCP proxy for the Pen Editor
// plugin. Node built-ins only (Node 22).
//
// Why this exists: the Agent Plugins 1.0.0 spec only expands
// ${PLUGIN_ROOT}/${PLUGIN_DATA} in stdio args/env/cwd, not in a
// streamable-http entry's url/headers. A plain `type: "streamable-http"`
// mcp.json entry would therefore require hardcoding the user's backend URL
// and bearer token into the checked-in manifest. Launching this stdio
// proxy instead keeps the secret out of the manifest: the token is read at
// runtime from <PLUGIN_DATA>/config.json (the portable primary channel -
// see resolveConfig below), an ambient env var (documented as a
// non-portable power-user override - the spec permits a conformant client
// to sanitize ambient env entirely), or a local zero-config handshake file
// pen-editor-backend writes for itself. The `configure_pen_editor_connection`
// tool this proxy also serves lets an agent write <PLUGIN_DATA>/config.json
// on the user's behalf, since the user never sees that path themselves.
//
// Everything printed to stdout MUST be exactly one JSON-RPC message per
// line (NDJSON) - the MCP stdio framing. All logging goes to stderr.

import {
  readFileSync as nodeReadFileSync,
  writeFileSync as nodeWriteFileSync,
  mkdirSync as nodeMkdirSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_URL = "http://localhost:3001/api/mcp";

// Name of the locally-handled MCP tool this proxy injects into tools/list
// and intercepts in tools/call (see configure_pen_editor_connection docs
// below). Exported so tests can reference it without hardcoding the string.
export const CONFIGURE_TOOL_NAME = "configure_pen_editor_connection";

// Advertised in every tools/list response (appended to whatever the
// upstream backend returns, or standing alone if the upstream call failed -
// see wrapWriteForToolsList). Handled entirely locally by this proxy; never
// forwarded upstream.
export const CONFIGURE_TOOL_DEFINITION = Object.freeze({
  name: CONFIGURE_TOOL_NAME,
  description:
    "Configure the Pen Editor MCP connection: writes the given backend URL and auth token to this plugin's persistent config file (<PLUGIN_DATA>/config.json) and applies them immediately, no restart required. Use this when the user supplies a Pen Editor backend URL and token (e.g. pasted into chat) and the connection isn't already working - most commonly for a remote/non-default backend. Local development normally needs no configuration at all: the plugin auto-discovers a locally running pen-editor-backend via its handshake file.",
  inputSchema: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: 'The Pen Editor backend\'s MCP endpoint URL, e.g. "https://my-backend.example.com/api/mcp".',
      },
      token: {
        type: "string",
        description: "The bearer token matching the backend's MCP_AUTH_TOKEN.",
      },
    },
    required: ["url", "token"],
    additionalProperties: false,
  },
});

// Server identity/capabilities this proxy advertises when it synthesizes an
// `initialize` result locally (see wrapWriteForInitialize below) instead of
// forwarding the backend's real negotiated one. Deliberately minimal:
// `tools: { listChanged: true }` is the only capability claimed, because
// it's the only one this proxy can actually honour on its own (it emits
// `notifications/tools/list_changed` itself - see CONFIGURE_TOOL_NAME's
// handler and the tools/list degradation-recovery logic). No
// resources/prompts/sampling/etc are claimed, since this proxy cannot
// honour those regardless of what the real backend supports.
export const PROXY_SERVER_INFO = Object.freeze({ name: "pen-editor-mcp-proxy", version: "0.1.0" });
export const PROXY_CAPABILITIES = Object.freeze({ tools: { listChanged: true } });

// Error codes used for locally-synthesized JSON-RPC error responses. Chosen
// in the implementation-defined range (below -32000) and kept distinct per
// failure class so a client/log reader can tell them apart at a glance.
export const ERROR_CODES = Object.freeze({
  // No bearer token configured at all (checked before any network call),
  // or the backend rejected the token we did send (HTTP 401). Same code,
  // because both mean "fix your token", just discovered at different
  // points.
  AUTH: -32001,
  // Backend is up but MCP is turned off there (HTTP 503, MCP_AUTH_TOKEN
  // unset server-side).
  DISABLED: -32002,
  // Could not even reach the backend (connection refused, DNS failure,
  // etc).
  NETWORK: -32003,
  // Any other non-2xx HTTP status from the backend.
  HTTP: -32000,
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Best-effort "read a JSON object file" - returns the parsed object, or null
// for any failure (missing file, unreadable, malformed JSON, or valid JSON
// that isn't an object). Never throws. Shared by every config source below
// so each one degrades identically: an absent, unreadable, or malformed
// file is silently equivalent to "this source has nothing to offer".
function readJsonObjectFile(filePath, readFileSync) {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Applies `parsed`'s url/token fields into the {url, token} accumulator,
// but only for fields not already resolved by a higher-precedence source -
// so a config file (or the handshake file) can supply just one of the two
// fields without clobbering the other.
function applyParsedFields(parsed, current) {
  const next = { ...current };
  if (next.url === undefined && parsed && isNonEmptyString(parsed.url)) next.url = parsed.url.trim();
  if (next.token === undefined && parsed && isNonEmptyString(parsed.token)) next.token = parsed.token.trim();
  return next;
}

/**
 * Resolve { url, token }, in this order (explicit beats implicit; portable
 * beats ambient; auto-discovery last):
 *
 *   1. <PEN_EDITOR_PLUGIN_DATA>/config.json - the portable, primary
 *      channel. PEN_EDITOR_PLUGIN_DATA is injected by the client per
 *      mcp.json's env block (${PLUGIN_DATA}) and is guaranteed present,
 *      writable, and preserved across plugin updates. This is the only
 *      channel the `configure_pen_editor_connection` tool writes to.
 *   2. env PEN_EDITOR_MCP_URL / PEN_EDITOR_MCP_TOKEN - a power-user
 *      override. Per the Agent Plugins 1.0.0 spec, a conformant client MAY
 *      sanitize ambient environment variables, and env values are "visible
 *      package data, not a portable secret mechanism" - so this channel is
 *      documented as non-portable and MUST NOT be the only way to
 *      configure the plugin.
 *   3. <os.homedir()>/.pen-editor/mcp.json - the local zero-config
 *      handshake file written by pen-editor-backend when it auto-generates
 *      a token (MCP_AUTH_TOKEN unset) and serves MCP loopback-only. May be
 *      absent, stale (backend since stopped - degrades to a NETWORK error
 *      at request time, not here), unreadable, or malformed; all of those
 *      are silently equivalent to "no handshake file".
 *   4. default url "http://localhost:3001/api/mcp"; token has no default.
 *
 * url and token from config.json/env are resolved independently per field
 * (e.g. url can come from config.json while token comes from env) - both
 * are explicit, portable-or-documented-ambient values the user/operator
 * controls, so mixing them carries no special risk.
 *
 * The handshake file is different: it's a *secret* generated by, and
 * meaningful only to, the one backend instance that wrote it, bound to
 * that instance's own loopback url. INVARIANT: the handshake file's token
 * must only ever be paired with the handshake file's own url - never with
 * a url resolved from a higher-precedence source. So the handshake file is
 * only consulted (for either field) when `url` is *still* unresolved when
 * we reach it; if config.json or env already pinned `url` to something
 * else, the handshake file is skipped entirely and `token` is left
 * unresolved (a clean "no token configured" error) rather than silently
 * sending that loopback-only secret to a url the backend never intended it
 * for. This is what closes the "remote url + local handshake token" leak:
 * before this invariant, a remote `url` from config.json/env could still
 * pick up the handshake file's token whenever config.json/env didn't also
 * supply a token.
 *
 * Values are trimmed. This function never throws.
 *
 * `readFileSync` and `homedir` are injectable so config resolution is
 * unit-testable without touching the real filesystem or the real home
 * directory.
 */
export function resolveConfig({ env, readFileSync = nodeReadFileSync, homedir = os.homedir } = {}) {
  env = env ?? {};
  let resolved = {};

  // 1. Portable primary channel: <PLUGIN_DATA>/config.json.
  if (isNonEmptyString(env.PEN_EDITOR_PLUGIN_DATA)) {
    const filePath = path.join(env.PEN_EDITOR_PLUGIN_DATA, "config.json");
    resolved = applyParsedFields(readJsonObjectFile(filePath, readFileSync), resolved);
  }

  // 2. Ambient env override.
  if (resolved.url === undefined && isNonEmptyString(env.PEN_EDITOR_MCP_URL)) {
    resolved.url = env.PEN_EDITOR_MCP_URL.trim();
  }
  if (resolved.token === undefined && isNonEmptyString(env.PEN_EDITOR_MCP_TOKEN)) {
    resolved.token = env.PEN_EDITOR_MCP_TOKEN.trim();
  }

  // 3. Local zero-config handshake file - only when `url` is still
  // unresolved (see the loopback-secret invariant above). If url is
  // already set, whatever this file's token is meant for is not the url
  // we're about to use, so don't touch the file at all.
  if (resolved.url === undefined) {
    let home;
    try {
      home = homedir();
    } catch {
      home = undefined;
    }
    if (isNonEmptyString(home)) {
      const filePath = path.join(home, ".pen-editor", "mcp.json");
      resolved = applyParsedFields(readJsonObjectFile(filePath, readFileSync), resolved);
    }
  }

  // 4. Defaults.
  if (resolved.url === undefined) resolved.url = DEFAULT_URL;

  return { url: resolved.url, token: resolved.token };
}

/**
 * Split accumulated text into complete NDJSON lines plus a leftover
 * partial-line remainder. Handles `\r\n` line endings. Does not filter
 * blank lines - callers should skip empty/whitespace-only lines.
 */
export function splitLines(buffer) {
  const lines = [];
  let start = 0;
  for (;;) {
    const idx = buffer.indexOf("\n", start);
    if (idx === -1) break;
    let line = buffer.slice(start, idx);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    start = idx + 1;
  }
  return { lines, remainder: buffer.slice(start) };
}

// Find the earliest blank-line event boundary ("\n\n" or "\r\n\r\n") in
// `buf`. Returns null if none is present yet (i.e. the current event is
// still incomplete and more chunks are needed).
function findEventBoundary(buf) {
  const i1 = buf.indexOf("\n\n");
  const i2 = buf.indexOf("\r\n\r\n");
  if (i1 === -1 && i2 === -1) return null;
  if (i2 !== -1 && (i1 === -1 || i2 <= i1)) return { start: i2, end: i2 + 4 };
  return { start: i1, end: i1 + 2 };
}

/**
 * Split accumulated SSE text into complete raw event blocks plus a
 * leftover remainder still awaiting its terminating blank line. Safe to
 * call repeatedly as more chunks arrive; a chunk boundary splitting an
 * event (even mid-field, mid-"\r\n\r\n") is handled correctly because it
 * simply comes back as part of the remainder next time.
 */
export function splitSSEEvents(buffer) {
  const events = [];
  let rest = buffer;
  for (;;) {
    const boundary = findEventBoundary(rest);
    if (!boundary) break;
    events.push(rest.slice(0, boundary.start));
    rest = rest.slice(boundary.end);
  }
  return { events, remainder: rest };
}

/**
 * Parse one raw SSE event block into its concatenated `data:` payload.
 * Multi-line `data:` fields are joined with "\n" per the SSE spec.
 * `event:`/`id:`/`retry:` fields and `:`-comments are ignored (this proxy
 * only cares about message payloads). Returns undefined if the event has
 * no data field at all (e.g. a bare comment or keep-alive).
 */
export function parseSSEEvent(raw) {
  const lines = raw.split(/\r\n|\n/);
  const dataLines = [];
  for (const line of lines) {
    if (line === "" || line.startsWith(":")) continue;
    if (line.startsWith("event:") || line.startsWith("id:") || line.startsWith("retry:")) continue;
    if (line.startsWith("data:")) {
      let value = line.slice(5);
      if (value.startsWith(" ")) value = value.slice(1);
      dataLines.push(value);
    }
  }
  if (dataLines.length === 0) return undefined;
  return dataLines.join("\n");
}

/** Build a JSON-RPC 2.0 error response object for a request with this id. */
export function buildJsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// A message is answerable (i.e. the proxy owes it exactly one JSON-RPC
// reply line) only if it's a *request*: it carries a non-undefined `id`
// and does NOT already carry a `result` or `error`. A message with `id`
// plus `result`/`error` is itself a *response* the client is sending
// upstream (e.g. answering a server->client sampling/createMessage sent
// over SSE) and must never be replied to, even though it has an `id`.
function isAnswerable(msg) {
  if (!(msg && typeof msg === "object")) return false;
  if (!("id" in msg) || msg.id === undefined) return false;
  if ("result" in msg || "error" in msg) return false;
  return true;
}

// Returns `result` with CONFIGURE_TOOL_DEFINITION appended to its `tools`
// array (creating the array if the upstream result didn't have one, e.g. a
// non-object/malformed result).
function withConfigureTool(result) {
  const base = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const tools = Array.isArray(base.tools) ? base.tools : [];
  return { ...base, tools: [...tools, CONFIGURE_TOOL_DEFINITION] };
}

/**
 * Wraps `write` so that, for the single reply matching `msg.id`, a
 * tools/list result gets CONFIGURE_TOOL_DEFINITION appended - and a
 * tools/list *failure* (any of: no token configured, network error, HTTP
 * error, malformed/empty body, a stalled SSE stream) is converted into a
 * *successful* result exposing just that one tool, instead of being
 * propagated as an error.
 *
 * Why: this proxy's whole raison d'etre is that a client's ambient env can
 * be sanitized away, leaving the primary token/URL unconfigured. If a
 * failed tools/list simply surfaced the usual error, the one tool that
 * lets an agent fix the connection (`configure_pen_editor_connection`)
 * would be invisible exactly when it's needed most. So tools/list is
 * special-cased to always succeed for the client, even when nothing could
 * be reached upstream - the underlying failure is still logged to stderr
 * for diagnostics.
 *
 * Every other message the wrapped write sees (unrelated SSE events, other
 * ids in a batch array response, etc.) passes through unchanged. This
 * covers both the plain-JSON and the SSE response paths, since both
 * ultimately call this same `write` function.
 *
 * `state.toolsListDegraded` is set true whenever this degrades to the
 * one-tool fallback, and cleared whenever a tools/list call here succeeds
 * for real. This is tracked (rather than left implicit) so a later
 * successful upstream call elsewhere in processMessage can notice "we were
 * degraded and now the backend answered" and proactively emit
 * `notifications/tools/list_changed` - see the recovery check in
 * processMessage. Without that, a transient blip on the client's one-time
 * startup tools/list call would leave the one-tool fallback visible for
 * the rest of the session: nothing would ever prompt the client to ask
 * again.
 */
function wrapWriteForToolsList(write, log, msg, state) {
  return (obj) => {
    if (!(obj && typeof obj === "object" && "id" in obj && obj.id === msg.id)) {
      write(obj);
      return;
    }
    if ("error" in obj) {
      log(
        `tools/list failed upstream (${obj.error && obj.error.message ? obj.error.message : "unknown error"}); ` +
          `responding with the locally-handled tool list only so ${CONFIGURE_TOOL_NAME} stays reachable.`,
      );
      if (state) state.toolsListDegraded = true;
      write({ jsonrpc: "2.0", id: msg.id, result: { tools: [CONFIGURE_TOOL_DEFINITION] } });
      return;
    }
    if ("result" in obj) {
      if (state) state.toolsListDegraded = false;
      write({ jsonrpc: "2.0", id: msg.id, result: withConfigureTool(obj.result) });
      return;
    }
    write(obj);
  };
}

/**
 * Build the `initialize` result this proxy synthesizes locally when the
 * real upstream `initialize` fails (no token configured, network error,
 * HTTP error, etc) - see wrapWriteForInitialize. Echoes back whatever
 * protocolVersion the client proposed (we have no real negotiation to
 * report), and advertises only PROXY_CAPABILITIES/PROXY_SERVER_INFO - see
 * their docs for why those are the only capabilities claimed.
 */
function synthesizedInitializeResult(msg) {
  const requestedVersion =
    msg && msg.params && typeof msg.params === "object" && typeof msg.params.protocolVersion === "string"
      ? msg.params.protocolVersion
      : "2025-03-26";
  return {
    protocolVersion: requestedVersion,
    serverInfo: PROXY_SERVER_INFO,
    capabilities: PROXY_CAPABILITIES,
  };
}

/**
 * Wraps `write` so that, for the single reply matching `msg.id`, an
 * `initialize` *failure* is converted into a locally-synthesized
 * *successful* result instead of being propagated as an error. A
 * successful upstream `initialize` passes through completely unmodified -
 * the real negotiated result (protocol version, the backend's own
 * capabilities/serverInfo) is what the client should see whenever the
 * backend is actually configured and reachable.
 *
 * Why this matters (finding 1): an MCP client that gets an `initialize`
 * *error* marks the server connection failed and never sends `tools/list`
 * at all - so without this, an unconfigured proxy (no token yet) could
 * never even offer `configure_pen_editor_connection`, the one tool that
 * lets an agent fix that. Synthesizing a minimal-but-honest local
 * `initialize` result keeps the connection alive long enough for
 * `tools/list` (wrapped above) to run and surface the escape hatch.
 */
function wrapWriteForInitialize(write, log, msg) {
  return (obj) => {
    if (!(obj && typeof obj === "object" && "id" in obj && obj.id === msg.id)) {
      write(obj);
      return;
    }
    if ("error" in obj) {
      log(
        `initialize failed upstream (${obj.error && obj.error.message ? obj.error.message : "unknown error"}); ` +
          `responding with a locally-synthesized initialize result so tools/list (and ${CONFIGURE_TOOL_NAME}) stay reachable.`,
      );
      write({ jsonrpc: "2.0", id: msg.id, result: synthesizedInitializeResult(msg) });
      return;
    }
    write(obj);
  };
}

function toolCallResult(text, { isError = false } = {}) {
  return { content: [{ type: "text", text }], isError };
}

// Atomically writes `data` as JSON to <dir>/config.json: write to a
// sibling temp file first (mode 0600 from creation), then rename over the
// final path. Rename is atomic on the same filesystem, so a concurrent
// reader (another in-flight processMessage's resolveConfig call) never
// observes a partially-written file. Creates `dir` if it doesn't exist.
//
// If renameSync throws (e.g. cross-device, or the target became a
// directory), the tmp file - which already contains the bearer token in
// plaintext - would otherwise be left behind on disk indefinitely. Best-
// effort unlink it in that case; the unlink's own failure is swallowed
// (already handling one error, and there is no more-specific cleanup
// possible) so the original renameSync error is what propagates to the
// caller.
function writeConfigFileAtomic(dir, data, { writeFileSync, mkdirSync, renameSync, unlinkSync }) {
  mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, "config.json");
  const tmpPath = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort only - see comment above.
    }
    throw err;
  }
  return finalPath;
}

// Hostnames/addresses treated as loopback for the purposes of the http-vs-
// https requirement below. Deliberately narrow (mirrors the backend's own
// isLoopbackAddress in pen-editor-backend/src/mcp/autoToken.ts): anything
// not recognizably loopback is treated as remote and must use https.
function isLoopbackHostname(hostname) {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return true;
  // 127.0.0.0/8.
  return /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(h);
}

/**
 * Strictly validate the `url` argument to configure_pen_editor_connection
 * before it's ever persisted (finding 4): this value is written to
 * <PLUGIN_DATA>/config.json and used for every subsequent MCP call,
 * including the bearer token in an Authorization header - and the plugin
 * itself later reads it back verbatim as an agent tool argument, so
 * content an agent read from elsewhere (e.g. get_editor_state on a
 * document containing attacker-supplied text) could name this tool with a
 * malicious url as a prompt-injection payload. Requiring an absolute
 * http(s) url with no embedded credentials, and https for any non-loopback
 * host, doesn't stop a determined attacker who already controls an https
 * host, but it closes the cheap/accidental paths: non-http(s) schemes
 * (`file:`, `javascript:`, `data:`, ...), credentials smuggled into the
 * URL itself, and - the one this proxy can enforce for free - ever sending
 * the bearer token in the clear to a remote host. Returns { ok: true } or
 * { ok: false, message }.
 */
function validateConfigureUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      ok: false,
      message: `"url" must be an absolute http:// or https:// URL (e.g. "https://my-backend.example.com/api/mcp"); could not parse "${rawUrl}".`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, message: `"url" must use the http or https scheme, got "${parsed.protocol}" (from "${rawUrl}").` };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: `"url" must not embed credentials (a "user:pass@host" prefix); got "${rawUrl}".` };
  }
  if (parsed.protocol === "http:" && !isLoopbackHostname(parsed.hostname)) {
    return {
      ok: false,
      message: `Refusing to configure a plain-http url for the non-loopback host "${parsed.hostname}" - this would send the bearer token in the clear. Use https for any backend that isn't on localhost/127.0.0.1.`,
    };
  }
  return { ok: true };
}

/**
 * Handles a tools/call for CONFIGURE_TOOL_NAME entirely locally: never
 * forwarded upstream. Validates { url, token } arguments (including
 * validateConfigureUrl's strict URL shape check - finding 4), writes them
 * to <PLUGIN_DATA>/config.json (mode 0600, atomic), and - so the new
 * connection takes effect without a restart - mutates `config` in place by
 * re-resolving it from the same sources resolveConfig itself uses (which
 * will now find the file we just wrote, since it's the highest-precedence
 * source).
 *
 * On success this also (finding 5) resets `state.sessionId` /
 * `state.protocolVersion` - a session id or negotiated protocol version
 * from the *previous* backend must never be replayed against whatever
 * backend the connection now points at - and (finding 2) emits
 * `notifications/tools/list_changed` so a client that already cached an
 * earlier tools/list (degraded or not) knows to re-fetch it instead of
 * only picking up the new tools after a restart.
 *
 * Reports failure as a tool-level error (`isError: true` in the result),
 * not a JSON-RPC protocol error - a bad tool call is not a transport
 * failure - mirroring how a real MCP server reports tool execution errors.
 */
async function handleConfigureToolCall(
  msg,
  { env, write, log, config, state, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync },
) {
  const answerable = isAnswerable(msg);
  const reply = (result) => {
    if (answerable) write({ jsonrpc: "2.0", id: msg.id, result });
  };

  const args = msg.params && typeof msg.params === "object" ? msg.params.arguments : undefined;
  const url = args && typeof args === "object" ? args.url : undefined;
  const token = args && typeof args === "object" ? args.token : undefined;
  if (!isNonEmptyString(url) || !isNonEmptyString(token)) {
    const message = `${CONFIGURE_TOOL_NAME} requires non-empty "url" and "token" string arguments.`;
    log(message);
    reply(toolCallResult(message, { isError: true }));
    return;
  }

  const trimmedUrl = url.trim();
  const validation = validateConfigureUrl(trimmedUrl);
  if (!validation.ok) {
    log(validation.message);
    reply(toolCallResult(validation.message, { isError: true }));
    return;
  }

  if (!isNonEmptyString(env.PEN_EDITOR_PLUGIN_DATA)) {
    const message = `Cannot save the connection: PEN_EDITOR_PLUGIN_DATA is not set in this proxy's environment, so there is no <PLUGIN_DATA>/config.json to write to.`;
    log(message);
    reply(toolCallResult(message, { isError: true }));
    return;
  }

  let finalPath;
  try {
    finalPath = writeConfigFileAtomic(
      env.PEN_EDITOR_PLUGIN_DATA,
      { url: trimmedUrl, token: token.trim() },
      { writeFileSync, mkdirSync, renameSync, unlinkSync },
    );
  } catch (err) {
    const message = `Failed to write connection config: ${err && err.message ? err.message : err}`;
    log(message);
    reply(toolCallResult(message, { isError: true }));
    return;
  }

  // Re-resolve and mutate in place so every closure holding a reference to
  // `config` (i.e. every future processMessage call in this proxy process)
  // sees the new values immediately, without a restart.
  const updated = resolveConfig({ env, readFileSync });
  config.url = updated.url;
  config.token = updated.token;

  // The new connection may be a different backend entirely - a session id
  // or negotiated protocol version from the old one must not be replayed
  // against it (finding 5).
  if (state) {
    state.sessionId = undefined;
    state.protocolVersion = undefined;
    state.toolsListDegraded = false;
  }

  log(`Wrote Pen Editor connection config to ${finalPath}.`);
  reply(toolCallResult(`Saved. Pen Editor MCP calls will now target ${config.url}.`));
  // Tell the client the tool list may have changed - it takes effect
  // immediately (no restart), but a client that already cached a
  // tools/list result (possibly the degraded one-tool fallback) won't
  // otherwise know to re-fetch it (finding 2).
  write({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
}

function truncateSnippet(text, max = 500) {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";
  return trimmed.length > max ? `${trimmed.slice(0, max)}...` : trimmed;
}

/**
 * Read an upstream error response's body (best-effort) and build the
 * actionable JSON-RPC error message for it, per HTTP status.
 */
async function buildHttpErrorMessage(res, url) {
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    // ignore - body may already be consumed/unreadable
  }
  const snippet = truncateSnippet(bodyText);

  let code;
  let message;
  if (res.status === 401) {
    code = ERROR_CODES.AUTH;
    message = `Token rejected by the Pen Editor backend at ${url}. Check that PEN_EDITOR_MCP_TOKEN (or the "token" field in <PLUGIN_DATA>/config.json) matches the backend's MCP_AUTH_TOKEN.`;
  } else if (res.status === 503) {
    code = ERROR_CODES.DISABLED;
    message = `Pen Editor MCP is disabled on the backend at ${url} (its MCP_AUTH_TOKEN environment variable is unset). Set MCP_AUTH_TOKEN in the pen-editor-backend environment to enable MCP there.`;
  } else {
    code = ERROR_CODES.HTTP;
    message = `Pen Editor backend at ${url} returned HTTP ${res.status}.`;
  }
  if (snippet) message += ` Response: ${snippet}`;
  return { code, message };
}

function networkErrorMessage(url, err) {
  const detail = err && err.message ? err.message : String(err);
  return `Could not reach the Pen Editor backend at ${url}. Start it with "npm run dev" in pen-editor-backend, or check the PEN_EDITOR_MCP_URL env var / "url" in <PLUGIN_DATA>/config.json. (${detail})`;
}

function noTokenMessage() {
  return 'No Pen Editor MCP auth token is configured. Set the PEN_EDITOR_MCP_TOKEN environment variable, or write {"token": "..."} to <PLUGIN_DATA>/config.json. The token must match the backend\'s MCP_AUTH_TOKEN.';
}

/**
 * Record the negotiated protocol version from a parsed initialize *result*
 * (never from the request that proposed it) into `state`, so subsequent
 * requests carry what the backend actually agreed to.
 */
function recordNegotiatedProtocolVersion(msg, parsedResponse, state) {
  if (
    msg &&
    msg.method === "initialize" &&
    parsedResponse &&
    typeof parsedResponse === "object" &&
    parsedResponse.id === msg.id &&
    parsedResponse.result &&
    typeof parsedResponse.result === "object" &&
    typeof parsedResponse.result.protocolVersion === "string"
  ) {
    state.protocolVersion = parsedResponse.result.protocolVersion;
  }
}

/**
 * Stream an `text/event-stream` response body, parsing SSE events
 * incrementally and writing each parsed JSON-RPC message as soon as it
 * arrives (rather than buffering the whole response). Keeps the stream
 * open until the server ends it. Guarantees: the trailing buffer (an SSE
 * event never terminated by a blank line) is flushed as a final event
 * once the stream ends, and if `msg` was answerable but the stream ended
 * without ever producing a response for it, a synthesized JSON-RPC error
 * is written so the client is not left hanging.
 */
async function streamSSEResponse(res, write, log, { msg, answerable, state, url }) {
  const nodeStream = res.body;
  let buffer = "";
  const decoder = new TextDecoder("utf-8");
  let answeredThisMessage = false;

  function handleRaw(raw) {
    const dataStr = parseSSEEvent(raw);
    if (dataStr === undefined) return;
    let parsed;
    try {
      parsed = JSON.parse(dataStr);
    } catch (e) {
      log(`Failed to parse SSE data payload as JSON: ${e.message}`);
      return;
    }
    write(parsed);
    if (answerable && parsed && typeof parsed === "object" && "id" in parsed && parsed.id === msg.id) {
      answeredThisMessage = true;
      recordNegotiatedProtocolVersion(msg, parsed, state);
    }
  }

  for await (const chunk of nodeStream) {
    buffer += decoder.decode(chunk, { stream: true });
    const { events, remainder } = splitSSEEvents(buffer);
    buffer = remainder;
    for (const raw of events) handleRaw(raw);
  }
  // The stream ended - flush whatever's left in `buffer` as a final event
  // even though it was never terminated by a blank line, instead of
  // silently discarding it (this is how a request answered by the last
  // event of an SSE stream was getting lost).
  if (buffer.trim()) handleRaw(buffer);

  if (answerable && !answeredThisMessage) {
    write(
      buildJsonRpcError(
        msg.id,
        ERROR_CODES.HTTP,
        `The SSE response stream from the Pen Editor backend at ${url} ended without ever sending a response for this request.`,
      ),
    );
  }
}

/**
 * Handle a 2xx response from the backend. Guarantees exactly one write()
 * for `msg` when `answerable` is true, on every path (202, empty body,
 * non-JSON body, JSON body, SSE stream) - see processMessage's docstring.
 */
async function handleSuccessResponse(res, write, log, { msg, answerable, state, url }) {
  if (res.status === 202) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    if (answerable) {
      const snippet = truncateSnippet(bodyText);
      let message = `Pen Editor backend at ${url} replied HTTP 202 Accepted to a request that requires a response - that's a server-side MCP protocol violation (202 is only valid for messages that don't expect a reply, like notifications). The URL may not be a valid MCP endpoint.`;
      if (snippet) message += ` Response: ${snippet}`;
      write(buildJsonRpcError(msg.id, ERROR_CODES.HTTP, message));
    }
    return;
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("text/event-stream")) {
    await streamSSEResponse(res, write, log, { msg, answerable, state, url });
    return;
  }

  let text = "";
  try {
    text = await res.text();
  } catch {
    // ignore
  }
  if (!text || !text.trim()) {
    if (answerable) {
      write(
        buildJsonRpcError(
          msg.id,
          ERROR_CODES.HTTP,
          `Pen Editor backend at ${url} returned an empty HTTP ${res.status} body (content-type "${contentType || "none"}") for a request that requires a response. The URL may not be a valid MCP endpoint.`,
        ),
      );
    }
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    log(`Failed to parse JSON response from backend: ${e.message}`);
    if (answerable) {
      const snippet = truncateSnippet(text);
      write(
        buildJsonRpcError(
          msg.id,
          ERROR_CODES.HTTP,
          `Pen Editor backend at ${url} returned a non-JSON HTTP ${res.status} body (content-type "${contentType || "none"}") that could not be parsed: ${e.message}. The URL may not be a valid MCP endpoint. Response: ${snippet}`,
        ),
      );
    }
    return;
  }

  if (Array.isArray(parsed)) {
    for (const m of parsed) {
      write(m);
      recordNegotiatedProtocolVersion(msg, m, state);
    }
  } else {
    write(parsed);
    recordNegotiatedProtocolVersion(msg, parsed, state);
  }
}

/**
 * Forward one inbound JSON-RPC message to the upstream backend and handle
 * its response, writing to `write` (only for requests that need a reply)
 * and logging diagnostics via `log`. Never throws: every failure path
 * either writes exactly one JSON-RPC error response (for requests) or logs
 * to stderr (for notifications), so a request is always answered exactly
 * once.
 *
 * Three methods are intercepted and handled locally instead of being
 * forwarded verbatim (see wrapWriteForToolsList / wrapWriteForInitialize /
 * handleConfigureToolCall above):
 *   - `tools/call` naming CONFIGURE_TOOL_NAME: never forwarded, writes
 *     <PLUGIN_DATA>/config.json.
 *   - `tools/list`: still forwarded (so real upstream tools are still
 *     listed), but its response - success or failure - is post-processed
 *     to guarantee CONFIGURE_TOOL_DEFINITION is always present.
 *   - `initialize`: still forwarded, but a *failure* is replaced with a
 *     locally-synthesized success (see wrapWriteForInitialize) so the
 *     client doesn't give up on the connection before ever sending
 *     tools/list.
 */
export async function processMessage(
  msg,
  {
    config,
    state,
    write: rawWrite,
    log,
    fetchFn = fetch,
    env = {},
    readFileSync = nodeReadFileSync,
    writeFileSync = nodeWriteFileSync,
    mkdirSync = nodeMkdirSync,
    renameSync = nodeRenameSync,
    unlinkSync = nodeUnlinkSync,
  },
) {
  const answerable = isAnswerable(msg);

  if (answerable && msg.method === "tools/call" && msg.params && msg.params.name === CONFIGURE_TOOL_NAME) {
    await handleConfigureToolCall(msg, {
      env,
      write: rawWrite,
      log,
      config,
      state,
      readFileSync,
      writeFileSync,
      mkdirSync,
      renameSync,
      unlinkSync,
    });
    return;
  }

  let write = rawWrite;
  if (answerable && msg.method === "tools/list") write = wrapWriteForToolsList(rawWrite, log, msg, state);
  else if (answerable && msg.method === "initialize") write = wrapWriteForInitialize(rawWrite, log, msg);

  if (!config.token) {
    const message = noTokenMessage();
    if (!answerable) {
      log(message);
      return;
    }
    write(buildJsonRpcError(msg.id, ERROR_CODES.AUTH, message));
    return;
  }

  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${config.token}`,
  };
  if (state.protocolVersion) headers["MCP-Protocol-Version"] = state.protocolVersion;
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;

  let res;
  try {
    res = await fetchFn(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(msg),
    });
  } catch (err) {
    const message = networkErrorMessage(config.url, err);
    if (!answerable) {
      log(message);
      return;
    }
    write(buildJsonRpcError(msg.id, ERROR_CODES.NETWORK, message));
    return;
  }

  const sessionId = res.headers.get("mcp-session-id");
  if (sessionId) state.sessionId = sessionId;

  if (!res.ok) {
    const { code, message } = await buildHttpErrorMessage(res, config.url);
    if (!answerable) {
      log(message);
      return;
    }
    write(buildJsonRpcError(msg.id, code, message));
    return;
  }

  // The backend just answered with a 2xx - it's reachable right now. If an
  // earlier tools/list degraded to the one-tool fallback (finding 2), that
  // fallback may be stuck in a client's cache with nothing left to prompt
  // a re-fetch; this transition (degraded -> backend reachable again) is
  // exactly that prompt. Uses rawWrite (a notification, not a reply to
  // `msg`) so it's never swallowed by the tools/list/initialize wrappers
  // above, which only look at replies matching `msg.id`.
  if (state.toolsListDegraded) {
    state.toolsListDegraded = false;
    rawWrite({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  }

  try {
    await handleSuccessResponse(res, write, log, { msg, answerable, state, url: config.url });
  } catch (err) {
    // Failure while streaming/parsing a successful response. The request
    // already got a 2xx, so there's no clean HTTP-error mapping - just
    // make sure a request still gets *some* answer instead of hanging.
    const message = `Error reading response from Pen Editor backend at ${config.url}: ${err && err.message ? err.message : err}`;
    log(message);
    if (answerable) {
      write(buildJsonRpcError(msg.id, ERROR_CODES.HTTP, message));
    }
  }
}

/**
 * Run the proxy: read newline-delimited JSON-RPC messages from `input`,
 * forward each to the configured Streamable-HTTP backend, and write
 * newline-delimited JSON-RPC responses to `output`. Resolves when `input`
 * ends (e.g. stdin closed by the client) AND every in-flight
 * `processMessage` call has settled, so a client that signals shutdown by
 * closing stdin (rather than waiting for its outstanding calls to
 * complete) never loses a response that was already on its way. Never
 * rejects for per-message failures - those are turned into JSON-RPC error
 * responses or stderr logs by processMessage.
 */
export function runProxy({
  input = process.stdin,
  output = process.stdout,
  errOutput = process.stderr,
  env = process.env,
  fetchFn = fetch,
  readFileSync = nodeReadFileSync,
  writeFileSync = nodeWriteFileSync,
  mkdirSync = nodeMkdirSync,
  renameSync = nodeRenameSync,
  unlinkSync = nodeUnlinkSync,
} = {}) {
  const config = resolveConfig({ env, readFileSync });
  const state = { protocolVersion: undefined, sessionId: undefined, toolsListDegraded: false };

  const log = (line) => {
    errOutput.write(`[pen-editor-mcp] ${line}\n`);
  };
  const write = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`);
  };

  log(`Proxying MCP over stdio to ${config.url}${config.token ? "" : " (no auth token configured)"}`);

  let buffer = "";
  // Every processMessage() call currently in flight. Tracked so runProxy
  // can wait for all of them to settle before resolving, instead of
  // treating "stdin closed" as "safe to stop" - those are different
  // events, and a slow in-flight request must still get its answer
  // written before the process is allowed to exit.
  const pending = new Set();

  function handleLine(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log(`Ignoring non-JSON line from client: ${truncateSnippet(line, 200)} (${e.message})`);
      return;
    }
    const promise = processMessage(msg, {
      config,
      state,
      write,
      log,
      fetchFn,
      env,
      readFileSync,
      writeFileSync,
      mkdirSync,
      renameSync,
      unlinkSync,
    })
      .catch((err) => {
        log(`Unexpected error while processing message: ${err && err.stack ? err.stack : err}`);
      })
      .finally(() => {
        pending.delete(promise);
      });
    pending.add(promise);
  }

  return new Promise((resolve) => {
    input.setEncoding("utf8");
    input.on("data", (chunk) => {
      const { lines, remainder } = splitLines(buffer + chunk);
      buffer = remainder;
      for (const line of lines) handleLine(line);
    });
    input.on("end", () => {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
      Promise.allSettled(pending).then(() => resolve());
    });
    input.on("error", (err) => {
      log(`stdin error: ${err && err.stack ? err.stack : err}`);
      Promise.allSettled(pending).then(() => resolve());
    });
  });
}
