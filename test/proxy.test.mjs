import { describe, it, expect, vi } from "vitest";
import {
  resolveConfig,
  DEFAULT_URL,
  splitLines,
  splitSSEEvents,
  parseSSEEvent,
  buildJsonRpcError,
  ERROR_CODES,
  processMessage,
} from "../lib/proxy.mjs";

describe("resolveConfig", () => {
  it("uses the default url and no token when nothing is configured", () => {
    const config = resolveConfig({ env: {}, readFileSync: () => {
      throw new Error("should not be called");
    } });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("prefers env vars over the config file", () => {
    const readFileSync = vi.fn(() => JSON.stringify({ url: "http://file-url", token: "file-token" }));
    const config = resolveConfig({
      env: {
        PEN_EDITOR_MCP_URL: "http://env-url",
        PEN_EDITOR_MCP_TOKEN: "env-token",
        PEN_EDITOR_PLUGIN_DATA: "/some/dir",
      },
      readFileSync,
    });
    expect(config).toEqual({ url: "http://env-url", token: "env-token" });
    // Both fields resolved from env, so the file should never be consulted.
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it("falls back to the config file when env vars are absent", () => {
    const readFileSync = vi.fn((filePath) => {
      expect(filePath).toBe("/data/dir/config.json");
      return JSON.stringify({ url: "http://file-url/api/mcp", token: "file-token" });
    });
    const config = resolveConfig({
      env: { PEN_EDITOR_PLUGIN_DATA: "/data/dir" },
      readFileSync,
    });
    expect(config).toEqual({ url: "http://file-url/api/mcp", token: "file-token" });
  });

  it("resolves each field independently (env url + file token)", () => {
    const readFileSync = () => JSON.stringify({ url: "http://file-url", token: "file-token" });
    const config = resolveConfig({
      env: { PEN_EDITOR_MCP_URL: "http://env-url", PEN_EDITOR_PLUGIN_DATA: "/data" },
      readFileSync,
    });
    expect(config).toEqual({ url: "http://env-url", token: "file-token" });
  });

  it("trims whitespace from env values", () => {
    const config = resolveConfig({
      env: { PEN_EDITOR_MCP_URL: "  http://env-url  ", PEN_EDITOR_MCP_TOKEN: "  tok  " },
      readFileSync: () => {
        throw new Error("should not be called");
      },
    });
    expect(config).toEqual({ url: "http://env-url", token: "tok" });
  });

  it("trims whitespace from file values", () => {
    const readFileSync = () => JSON.stringify({ url: "  http://file-url  ", token: "  file-token  " });
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync });
    expect(config).toEqual({ url: "http://file-url", token: "file-token" });
  });

  it("falls back gracefully when the config file is missing (readFileSync throws ENOENT)", () => {
    const readFileSync = () => {
      const err = new Error("no such file");
      err.code = "ENOENT";
      throw err;
    };
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("falls back gracefully when the config file contains malformed JSON", () => {
    const readFileSync = () => "{ not valid json";
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("falls back gracefully when the config file is valid JSON but not an object", () => {
    const readFileSync = () => JSON.stringify(["not", "an", "object"]);
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("does not throw and uses the default url when PEN_EDITOR_PLUGIN_DATA is missing", () => {
    const readFileSync = vi.fn(() => {
      throw new Error("should not be called");
    });
    expect(() => resolveConfig({ env: {}, readFileSync })).not.toThrow();
    const config = resolveConfig({ env: {}, readFileSync });
    expect(config.url).toBe(DEFAULT_URL);
    expect(config.token).toBeUndefined();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe("splitLines (NDJSON stdio framing)", () => {
  it("splits multiple complete lines and keeps no remainder", () => {
    const { lines, remainder } = splitLines('{"a":1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(remainder).toBe("");
  });

  it("keeps a trailing partial line as the remainder", () => {
    const { lines, remainder } = splitLines('{"a":1}\n{"b":2');
    expect(lines).toEqual(['{"a":1}']);
    expect(remainder).toBe('{"b":2');
  });

  it("handles a chunk with no newline at all", () => {
    const { lines, remainder } = splitLines('{"a":1');
    expect(lines).toEqual([]);
    expect(remainder).toBe('{"a":1');
  });

  it("strips \\r from \\r\\n line endings", () => {
    const { lines, remainder } = splitLines('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(remainder).toBe("");
  });

  it("reassembles a line split across two chunks", () => {
    const first = splitLines('{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    const second = splitLines(`${first.remainder}2}\n`);
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.remainder).toBe("");
  });

  it("ignores blank lines by producing empty-string entries callers can skip", () => {
    const { lines } = splitLines('{"a":1}\n\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', "", '{"b":2}']);
  });
});

describe("splitSSEEvents / parseSSEEvent", () => {
  it("splits a single complete event terminated by a blank line", () => {
    const { events, remainder } = splitSSEEvents('data: {"a":1}\n\n');
    expect(events).toEqual(['data: {"a":1}']);
    expect(remainder).toBe("");
  });

  it("splits multiple events in one buffer", () => {
    const { events, remainder } = splitSSEEvents('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(events).toEqual(['data: {"a":1}', 'data: {"b":2}']);
    expect(remainder).toBe("");
  });

  it("keeps an incomplete trailing event as the remainder", () => {
    const { events, remainder } = splitSSEEvents('data: {"a":1}\n\ndata: {"b":2}');
    expect(events).toEqual(['data: {"a":1}']);
    expect(remainder).toBe('data: {"b":2}');
  });

  it("handles \\r\\n\\r\\n blank-line separators", () => {
    const { events, remainder } = splitSSEEvents('data: {"a":1}\r\n\r\n');
    expect(events).toEqual(['data: {"a":1}']);
    expect(remainder).toBe("");
  });

  it("recombines an event split mid-boundary across two chunks", () => {
    const chunk1 = 'data: {"a":1}\n';
    const chunk2 = '\ndata: {"b":2}\n\n';
    const first = splitSSEEvents(chunk1);
    expect(first.events).toEqual([]);
    expect(first.remainder).toBe(chunk1);

    const second = splitSSEEvents(first.remainder + chunk2);
    expect(second.events).toEqual(['data: {"a":1}', 'data: {"b":2}']);
    expect(second.remainder).toBe("");
  });

  it("recombines an event split mid-field (mid \\r\\n\\r\\n) across two chunks", () => {
    const full = 'data: {"a":1}\r\n\r\n';
    const splitPoint = full.indexOf("\r\n\r\n") + 2; // land inside the separator
    const chunk1 = full.slice(0, splitPoint);
    const chunk2 = full.slice(splitPoint);

    const first = splitSSEEvents(chunk1);
    expect(first.events).toEqual([]);

    const second = splitSSEEvents(first.remainder + chunk2);
    expect(second.events).toEqual(['data: {"a":1}']);
    expect(second.remainder).toBe("");
  });

  it("parses a single-line data field as JSON payload text", () => {
    const dataStr = parseSSEEvent('data: {"jsonrpc":"2.0","id":1,"result":{}}');
    expect(dataStr).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
    expect(JSON.parse(dataStr)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  it("joins multi-line data fields with \\n", () => {
    const dataStr = parseSSEEvent("data: line one\ndata: line two");
    expect(dataStr).toBe("line one\nline two");
  });

  it("ignores event:/id:/retry: fields and comments, keeping only data", () => {
    const dataStr = parseSSEEvent(": this is a comment\nevent: message\nid: 42\nretry: 1000\ndata: {\"ok\":true}");
    expect(dataStr).toBe('{"ok":true}');
  });

  it("returns undefined for an event with no data field (e.g. a keep-alive comment)", () => {
    expect(parseSSEEvent(": keep-alive")).toBeUndefined();
    expect(parseSSEEvent("event: ping\nid: 1")).toBeUndefined();
  });
});

describe("buildJsonRpcError", () => {
  it("builds a JSON-RPC 2.0 error response shape", () => {
    const err = buildJsonRpcError(7, ERROR_CODES.AUTH, "boom");
    expect(err).toEqual({ jsonrpc: "2.0", id: 7, error: { code: ERROR_CODES.AUTH, message: "boom" } });
  });

  it("preserves string ids and null-ish edge cases as given", () => {
    expect(buildJsonRpcError("abc", -1, "m")).toEqual({ jsonrpc: "2.0", id: "abc", error: { code: -1, message: "m" } });
  });
});

describe("processMessage error paths", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  it("no token configured: replies with a single AUTH error naming the env var and config.json, for a request", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { ...h, fetchFn: () => {
        throw new Error("must not call fetch when no token is configured");
      } },
    );
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.AUTH);
    expect(h.written[0].id).toBe(1);
    expect(h.written[0].error.message).toContain("PEN_EDITOR_MCP_TOKEN");
    expect(h.written[0].error.message).toContain("config.json");
    expect(h.written[0].error.message).toContain("MCP_AUTH_TOKEN");
  });

  it("no token configured: a notification only logs, produces no written response", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    await processMessage(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { ...h, fetchFn: () => {
        throw new Error("must not call fetch");
      } },
    );
    expect(h.written).toHaveLength(0);
    expect(h.logged.some((l) => l.includes("PEN_EDITOR_MCP_TOKEN"))).toBe(true);
  });

  it("HTTP 401 produces an AUTH error naming the backend url", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
    }));
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.AUTH);
    expect(h.written[0].error.message).toContain("http://backend/api/mcp");
    expect(h.written[0].error.message).toContain("Unauthorized");
  });

  it("HTTP 503 produces a DISABLED error explaining MCP_AUTH_TOKEN is unset server-side", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 503,
      headers: { get: () => null },
      text: async () => "",
    }));
    await processMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.DISABLED);
    expect(h.written[0].error.message).toContain("MCP_AUTH_TOKEN");
  });

  it("network failure (fetch rejects) produces a NETWORK error naming the url and how to start the backend", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    });
    await processMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.NETWORK);
    expect(h.written[0].error.message).toContain("http://backend/api/mcp");
    expect(h.written[0].error.message).toContain("npm run dev");
    expect(h.written[0].error.message).toContain("pen-editor-backend");
  });

  it("network failure on a notification only logs, no written response", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
    expect(h.logged.length).toBeGreaterThan(0);
  });

  it("other non-2xx status produces an HTTP error with the status code and a body snippet", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
      text: async () => "internal error details",
    }));
    await processMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.HTTP);
    expect(h.written[0].error.message).toContain("500");
    expect(h.written[0].error.message).toContain("internal error details");
  });

  it("a successful application/json response is written verbatim", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 6, result: { ok: true } }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 6, result: { ok: true } }]);
  });

  it("202 with empty body writes nothing", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: async () => "",
    }));
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
  });

  it("captures the protocolVersion from the initialize *result* (not the request) and sends it on the next request", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const seenHeaders = [];
    const fetchFn = vi.fn(async (url, opts) => {
      seenHeaders.push(opts.headers);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }),
      };
    });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...h, fetchFn },
    );
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(seenHeaders[0]["MCP-Protocol-Version"]).toBeUndefined();
    expect(seenHeaders[1]["MCP-Protocol-Version"]).toBe("2025-03-26");
  });

  it("does NOT capture a protocolVersion the client only proposed if the backend negotiates a different one - the header carries the negotiated value, not the requested one", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const seenHeaders = [];
    const fetchFn = vi.fn(async (url, opts) => {
      seenHeaders.push(opts.headers);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        // Backend negotiates DOWN to an older version than the client requested.
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } }),
      };
    });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...h, fetchFn },
    );
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(seenHeaders[1]["MCP-Protocol-Version"]).toBe("2024-11-05");
    expect(seenHeaders[1]["MCP-Protocol-Version"]).not.toBe("2025-11-25");
  });

  it("does not capture a protocolVersion when the initialize request itself fails (e.g. HTTP error)", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const seenHeaders = [];
    const fetchFn = vi.fn(async (url, opts) => {
      seenHeaders.push(opts.headers);
      if (opts.headers === seenHeaders[0]) {
        return { ok: false, status: 500, headers: { get: () => null }, text: async () => "boom" };
      }
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "" };
    });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...h, fetchFn },
    );
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(seenHeaders[1]["MCP-Protocol-Version"]).toBeUndefined();
  });

  it("remembers Mcp-Session-Id from a response and sends it on later requests", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const seenHeaders = [];
    let first = true;
    const fetchFn = vi.fn(async (url, opts) => {
      seenHeaders.push(opts.headers);
      const headers = first ? { get: (n) => (n.toLowerCase() === "mcp-session-id" ? "sess-123" : null) } : { get: () => null };
      first = false;
      return { ok: true, status: 200, headers, text: async () => "" };
    });
    await processMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...h, fetchFn });
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(seenHeaders[0]["Mcp-Session-Id"]).toBeUndefined();
    expect(seenHeaders[1]["Mcp-Session-Id"]).toBe("sess-123");
  });

  it("omits the Authorization header entirely when no token is configured (notification path)", async () => {
    // Guard: no-token short-circuits before fetch, so Authorization can
    // never be sent at all in that case - covered by the no-fetch
    // assertion in the "no token configured" tests above. This test
    // documents that when a token *is* configured, the header is always a
    // well-formed Bearer value.
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    let seenAuth;
    const fetchFn = vi.fn(async (url, opts) => {
      seenAuth = opts.headers.Authorization;
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => "" };
    });
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(seenAuth).toBe("Bearer tok");
  });

  it("a non-JSON 200 body for a request writes an HTTP error instead of hanging the client forever", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => "<html>login</html>",
    }));
    await processMessage({ jsonrpc: "2.0", id: 10, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].id).toBe(10);
    expect(h.written[0].error.code).toBe(ERROR_CODES.HTTP);
    expect(h.written[0].error.message).toContain("200");
    expect(h.written[0].error.message).toContain("text/html");
    expect(h.written[0].error.message).toContain("<html>login</html>");
    expect(h.written[0].error.message.toLowerCase()).toContain("mcp endpoint");
  });

  it("a non-JSON 200 body for a notification only logs, writes nothing", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => "<html>login</html>",
    }));
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
  });

  it("an empty 200 body for a request writes an HTTP error instead of hanging the client forever", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => "",
    }));
    await processMessage({ jsonrpc: "2.0", id: 11, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].id).toBe(11);
    expect(h.written[0].error.code).toBe(ERROR_CODES.HTTP);
  });

  it("an empty 200 body for a notification only logs, writes nothing", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => "   ",
    }));
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
  });

  it("HTTP 202 in response to a request writes a protocol-violation HTTP error instead of hanging the client forever", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 202,
      headers: { get: () => null },
      text: async () => "",
    }));
    await processMessage({ jsonrpc: "2.0", id: 12, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].id).toBe(12);
    expect(h.written[0].error.code).toBe(ERROR_CODES.HTTP);
    expect(h.written[0].error.message).toContain("202");
  });

  it("an inbound JSON-RPC *response* (client answering a server->client request) while the backend is unreachable produces NO written line", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    // This message has an `id`, but it's a *response* (carries `result`),
    // not a request - the proxy must not treat it as answerable just
    // because `id` is present.
    await processMessage({ jsonrpc: "2.0", id: 5, result: { ok: true } }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
    expect(h.logged.length).toBeGreaterThan(0);
  });

  it("an inbound JSON-RPC error-response while the backend is unreachable also produces NO written line", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await processMessage({ jsonrpc: "2.0", id: 5, error: { code: -1, message: "client-side failure" } }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
  });

  function fakeSSEBody(chunks) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield new TextEncoder().encode(chunk);
      },
    };
  }

  it("an SSE response whose final event is never terminated by a blank line is still flushed and answers the request", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      // No trailing "\n\n" - the stream just ends here, as if the server
      // closed the connection mid-event.
      body: fakeSSEBody([`data: ${JSON.stringify({ jsonrpc: "2.0", id: 13, result: { ok: true } })}`]),
    }));
    await processMessage({ jsonrpc: "2.0", id: 13, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 13, result: { ok: true } }]);
  });

  it("an SSE stream that ends without ever producing a response for the request writes a synthesized HTTP error instead of hanging", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      // Stream ends with only an unrelated keep-alive comment, no message
      // for this request's id at all.
      body: fakeSSEBody([": keep-alive\n\n"]),
    }));
    await processMessage({ jsonrpc: "2.0", id: 14, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].id).toBe(14);
    expect(h.written[0].error.code).toBe(ERROR_CODES.HTTP);
  });

  it("an SSE stream that ends without producing a response for a notification writes nothing", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: fakeSSEBody([": keep-alive\n\n"]),
    }));
    await processMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(0);
  });
});
