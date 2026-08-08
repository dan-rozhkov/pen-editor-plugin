// Dependency-free stdio <-> Streamable-HTTP MCP proxy for the Pen Editor
// plugin. Node built-ins only (Node 22).
//
// Why this exists: the Agent Plugins 1.0.0 spec only expands
// ${PLUGIN_ROOT}/${PLUGIN_DATA} in stdio args/env/cwd, not in a
// streamable-http entry's url/headers. A plain `type: "streamable-http"`
// mcp.json entry would therefore require hardcoding the user's backend URL
// and bearer token into the checked-in manifest. Launching this stdio
// proxy instead keeps the secret out of the manifest: the token is read at
// runtime from an env var or from a JSON file under the per-user
// PLUGIN_DATA directory.
//
// Everything printed to stdout MUST be exactly one JSON-RPC message per
// line (NDJSON) - the MCP stdio framing. All logging goes to stderr.

import { readFileSync as nodeReadFileSync } from "node:fs";
import path from "node:path";

export const DEFAULT_URL = "http://localhost:3001/api/mcp";

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

/**
 * Resolve { url, token } from, in order:
 *   1. env PEN_EDITOR_MCP_URL / PEN_EDITOR_MCP_TOKEN
 *   2. JSON file at <PEN_EDITOR_PLUGIN_DATA>/config.json, shape
 *      { "url": "...", "token": "..." } (PEN_EDITOR_PLUGIN_DATA is injected
 *      by the client per mcp.json's env block)
 *   3. default url "http://localhost:3001/api/mcp"; token has no default
 *
 * Each source is consulted independently per field: e.g. the URL can come
 * from the env while the token comes from the config file. Values are
 * trimmed. A missing/unreadable/malformed config.json is swallowed and
 * falls back to the next source - this function never throws.
 *
 * `readFileSync` is injectable so config resolution is unit-testable
 * without touching the real filesystem.
 */
export function resolveConfig({ env, readFileSync = nodeReadFileSync } = {}) {
  env = env ?? {};
  let url;
  let token;

  if (typeof env.PEN_EDITOR_MCP_URL === "string" && env.PEN_EDITOR_MCP_URL.trim()) {
    url = env.PEN_EDITOR_MCP_URL.trim();
  }
  if (typeof env.PEN_EDITOR_MCP_TOKEN === "string" && env.PEN_EDITOR_MCP_TOKEN.trim()) {
    token = env.PEN_EDITOR_MCP_TOKEN.trim();
  }

  if ((url === undefined || token === undefined) && typeof env.PEN_EDITOR_PLUGIN_DATA === "string" && env.PEN_EDITOR_PLUGIN_DATA) {
    try {
      const filePath = path.join(env.PEN_EDITOR_PLUGIN_DATA, "config.json");
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (url === undefined && typeof parsed.url === "string" && parsed.url.trim()) {
          url = parsed.url.trim();
        }
        if (token === undefined && typeof parsed.token === "string" && parsed.token.trim()) {
          token = parsed.token.trim();
        }
      }
    } catch {
      // Missing file, unreadable, or malformed JSON: fall back silently.
    }
  }

  if (url === undefined) url = DEFAULT_URL;

  return { url, token };
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
 */
export async function processMessage(msg, { config, state, write, log, fetchFn = fetch }) {
  const answerable = isAnswerable(msg);

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
} = {}) {
  const config = resolveConfig({ env, readFileSync });
  const state = { protocolVersion: undefined, sessionId: undefined };

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
    const promise = processMessage(msg, { config, state, write, log, fetchFn })
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
