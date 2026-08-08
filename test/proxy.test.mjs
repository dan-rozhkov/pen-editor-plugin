import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync as fsReadFileSync, renameSync as fsRenameSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveConfig,
  DEFAULT_URL,
  splitLines,
  splitSSEEvents,
  parseSSEEvent,
  buildJsonRpcError,
  ERROR_CODES,
  processMessage,
  CONFIGURE_TOOL_NAME,
  CONFIGURE_TOOL_DEFINITION,
  PROXY_SERVER_INFO,
  PROXY_CAPABILITIES,
} from "../lib/proxy.mjs";

// Every test below must pass an explicit `homedir` - the real default would
// touch the developer's actual ~/.pen-editor/mcp.json, which the task
// explicitly forbids. This fake homedir has nothing at it unless a test's
// readFileSync stub says otherwise.
const FAKE_HOME = "/fake/home";
const fakeHomedir = () => FAKE_HOME;
const HANDSHAKE_PATH = "/fake/home/.pen-editor/mcp.json";

function enoent() {
  const err = new Error("no such file");
  err.code = "ENOENT";
  throw err;
}

describe("resolveConfig", () => {
  it("uses the default url and no token when nothing is configured", () => {
    const config = resolveConfig({ env: {}, readFileSync: enoent, homedir: fakeHomedir });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("precedence: PLUGIN_DATA/config.json beats env vars beats the handshake file beats the default", () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath === "/some/dir/config.json") {
        return JSON.stringify({ url: "http://config-file-url", token: "config-file-token" });
      }
      if (filePath === HANDSHAKE_PATH) {
        return JSON.stringify({ url: "http://handshake-url", token: "handshake-token", port: 3001 });
      }
      throw new Error(`unexpected path: ${filePath}`);
    });
    const config = resolveConfig({
      env: {
        PEN_EDITOR_MCP_URL: "http://env-url",
        PEN_EDITOR_MCP_TOKEN: "env-token",
        PEN_EDITOR_PLUGIN_DATA: "/some/dir",
      },
      readFileSync,
      homedir: fakeHomedir,
    });
    // <PLUGIN_DATA>/config.json wins for both fields - env and the
    // handshake file are never even needed once both fields are resolved,
    // so the handshake file is never read.
    expect(config).toEqual({ url: "http://config-file-url", token: "config-file-token" });
    expect(readFileSync).toHaveBeenCalledTimes(1);
    expect(readFileSync).toHaveBeenCalledWith("/some/dir/config.json", "utf8");
  });

  it("env vars win over the handshake file when config.json supplies neither field", () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath === "/some/dir/config.json") enoent();
      if (filePath === HANDSHAKE_PATH) {
        return JSON.stringify({ url: "http://handshake-url", token: "handshake-token" });
      }
      throw new Error(`unexpected path: ${filePath}`);
    });
    const config = resolveConfig({
      env: {
        PEN_EDITOR_MCP_URL: "http://env-url",
        PEN_EDITOR_MCP_TOKEN: "env-token",
        PEN_EDITOR_PLUGIN_DATA: "/some/dir",
      },
      readFileSync,
      homedir: fakeHomedir,
    });
    expect(config).toEqual({ url: "http://env-url", token: "env-token" });
    // Both fields resolved from env once config.json came back empty, so
    // the handshake file is never consulted either.
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to the config file when env vars and the handshake file are absent", () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath === "/data/dir/config.json") {
        return JSON.stringify({ url: "http://file-url/api/mcp", token: "file-token" });
      }
      throw new Error(`unexpected path: ${filePath}`);
    });
    const config = resolveConfig({
      env: { PEN_EDITOR_PLUGIN_DATA: "/data/dir" },
      readFileSync,
      homedir: fakeHomedir,
    });
    expect(config).toEqual({ url: "http://file-url/api/mcp", token: "file-token" });
  });

  it("falls back to the handshake file when neither config.json nor env vars supply anything", () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath === "/data/dir/config.json") enoent();
      if (filePath === HANDSHAKE_PATH) {
        return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", token: "a".repeat(64), port: 3001 });
      }
      throw new Error(`unexpected path: ${filePath}`);
    });
    const config = resolveConfig({
      env: { PEN_EDITOR_PLUGIN_DATA: "/data/dir" },
      readFileSync,
      homedir: fakeHomedir,
    });
    expect(config).toEqual({ url: "http://127.0.0.1:3001/api/mcp", token: "a".repeat(64) });
  });

  it("resolves each field independently across all three file/env sources", () => {
    const readFileSync = vi.fn((filePath) => {
      if (filePath === "/data/config.json") return JSON.stringify({ token: "config-file-token" });
      if (filePath === HANDSHAKE_PATH) return JSON.stringify({ url: "http://handshake-url", token: "handshake-token" });
      throw new Error(`unexpected path: ${filePath}`);
    });
    const config = resolveConfig({
      env: { PEN_EDITOR_PLUGIN_DATA: "/data" },
      readFileSync,
      homedir: fakeHomedir,
    });
    // token resolved by config.json (highest precedence); url has to fall
    // all the way through to the handshake file since neither config.json
    // nor env supplied it.
    expect(config).toEqual({ url: "http://handshake-url", token: "config-file-token" });
  });

  describe("loopback-secret invariant: the handshake token must only ever pair with the handshake file's own url (finding 3)", () => {
    it("a remote url from config.json is never paired with the handshake file's token - token stays unresolved instead", () => {
      const readFileSync = vi.fn((filePath) => {
        if (filePath === "/data/config.json") return JSON.stringify({ url: "https://remote.example.com/api/mcp" });
        if (filePath === HANDSHAKE_PATH) {
          return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", token: "loopback-secret-token", port: 3001 });
        }
        throw new Error(`unexpected path: ${filePath}`);
      });
      const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync, homedir: fakeHomedir });
      // Before the fix, this configuration paired the remote config.json
      // url with the handshake file's loopback-only token - a leak. Now it
      // degrades to a clean "no token" outcome instead, and the handshake
      // file is never even read once url is already resolved.
      expect(config).toEqual({ url: "https://remote.example.com/api/mcp", token: undefined });
      expect(readFileSync).toHaveBeenCalledTimes(1);
      expect(readFileSync).toHaveBeenCalledWith("/data/config.json", "utf8");
    });

    it("a remote url from an env var is never paired with the handshake file's token", () => {
      const readFileSync = vi.fn((filePath) => {
        if (filePath === HANDSHAKE_PATH) {
          return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", token: "loopback-secret-token", port: 3001 });
        }
        throw new Error(`unexpected path: ${filePath}`);
      });
      const config = resolveConfig({
        env: { PEN_EDITOR_MCP_URL: "https://remote.example.com/api/mcp" },
        readFileSync,
        homedir: fakeHomedir,
      });
      expect(config).toEqual({ url: "https://remote.example.com/api/mcp", token: undefined });
      expect(readFileSync).not.toHaveBeenCalled();
    });

    it("still adopts both url and token from the handshake file together when neither config.json nor env resolved url first", () => {
      const readFileSync = vi.fn((filePath) => {
        if (filePath === HANDSHAKE_PATH) {
          return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", token: "loopback-secret-token", port: 3001 });
        }
        throw new Error(`unexpected path: ${filePath}`);
      });
      const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
      expect(config).toEqual({ url: "http://127.0.0.1:3001/api/mcp", token: "loopback-secret-token" });
    });

    it("an explicit token from config.json may still pair with a url that falls back to the handshake file (token side is not loopback-bound, only the handshake file's own token is)", () => {
      const readFileSync = vi.fn((filePath) => {
        if (filePath === "/data/config.json") return JSON.stringify({ token: "operator-supplied-token" });
        if (filePath === HANDSHAKE_PATH) return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", port: 3001 });
        throw new Error(`unexpected path: ${filePath}`);
      });
      const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync, homedir: fakeHomedir });
      expect(config).toEqual({ url: "http://127.0.0.1:3001/api/mcp", token: "operator-supplied-token" });
    });
  });

  it("trims whitespace from env values", () => {
    const config = resolveConfig({
      env: { PEN_EDITOR_MCP_URL: "  http://env-url  ", PEN_EDITOR_MCP_TOKEN: "  tok  " },
      readFileSync: enoent,
      homedir: fakeHomedir,
    });
    expect(config).toEqual({ url: "http://env-url", token: "tok" });
  });

  it("trims whitespace from config.json values", () => {
    const readFileSync = () => JSON.stringify({ url: "  http://file-url  ", token: "  file-token  " });
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync, homedir: fakeHomedir });
    expect(config).toEqual({ url: "http://file-url", token: "file-token" });
  });

  it("trims whitespace from handshake file values", () => {
    const readFileSync = (filePath) => {
      if (filePath === HANDSHAKE_PATH) return JSON.stringify({ url: "  http://handshake-url  ", token: "  handshake-token  " });
      enoent();
    };
    const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
    expect(config).toEqual({ url: "http://handshake-url", token: "handshake-token" });
  });

  it("falls back gracefully when the config file is missing (readFileSync throws ENOENT)", () => {
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync: enoent, homedir: fakeHomedir });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("falls back gracefully when the config file contains malformed JSON", () => {
    const readFileSync = (filePath) => (filePath === "/data/config.json" ? "{ not valid json" : enoent());
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync, homedir: fakeHomedir });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("falls back gracefully when the config file is valid JSON but not an object", () => {
    const readFileSync = (filePath) => (filePath === "/data/config.json" ? JSON.stringify(["not", "an", "object"]) : enoent());
    const config = resolveConfig({ env: { PEN_EDITOR_PLUGIN_DATA: "/data" }, readFileSync, homedir: fakeHomedir });
    expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("does not throw and uses the default url when PEN_EDITOR_PLUGIN_DATA is missing and there is no handshake file", () => {
    const readFileSync = vi.fn(enoent);
    expect(() => resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir })).not.toThrow();
    const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
    expect(config.url).toBe(DEFAULT_URL);
    expect(config.token).toBeUndefined();
    // No PLUGIN_DATA, so only the handshake file path should ever be read.
    for (const [filePath] of readFileSync.mock.calls) {
      expect(filePath).toBe(HANDSHAKE_PATH);
    }
  });

  describe("handshake file degradation (<os.homedir()>/.pen-editor/mcp.json)", () => {
    it("is absent: falls back to the default, never throws", () => {
      const config = resolveConfig({ env: {}, readFileSync: enoent, homedir: fakeHomedir });
      expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
    });

    it("is malformed JSON: falls back to the default, never throws", () => {
      const readFileSync = (filePath) => (filePath === HANDSHAKE_PATH ? "{ not valid json" : enoent());
      const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
      expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
    });

    it("is unreadable (e.g. EACCES): falls back to the default, never throws", () => {
      const readFileSync = (filePath) => {
        if (filePath !== HANDSHAKE_PATH) enoent();
        const err = new Error("permission denied");
        err.code = "EACCES";
        throw err;
      };
      expect(() => resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir })).not.toThrow();
      const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
      expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
    });

    it("is stale (valid JSON pointing at a backend that's since stopped): resolveConfig still returns it - staleness is a request-time NETWORK error, not a config-resolution concern", () => {
      const readFileSync = (filePath) => {
        if (filePath === HANDSHAKE_PATH) {
          return JSON.stringify({ url: "http://127.0.0.1:3001/api/mcp", token: "b".repeat(64), port: 3001 });
        }
        enoent();
      };
      const config = resolveConfig({ env: {}, readFileSync, homedir: fakeHomedir });
      expect(config).toEqual({ url: "http://127.0.0.1:3001/api/mcp", token: "b".repeat(64) });
    });

    it("os.homedir() itself throwing is swallowed, never propagates", () => {
      const readFileSync = vi.fn(enoent);
      const throwingHomedir = () => {
        throw new Error("no home directory");
      };
      expect(() => resolveConfig({ env: {}, readFileSync, homedir: throwingHomedir })).not.toThrow();
      const config = resolveConfig({ env: {}, readFileSync, homedir: throwingHomedir });
      expect(config).toEqual({ url: DEFAULT_URL, token: undefined });
      expect(readFileSync).not.toHaveBeenCalled();
    });
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
      { jsonrpc: "2.0", id: 1, method: "resources/list" },
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
    await processMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error.code).toBe(ERROR_CODES.DISABLED);
    expect(h.written[0].error.message).toContain("MCP_AUTH_TOKEN");
  });

  it("network failure (fetch rejects) produces a NETWORK error naming the url and how to start the backend", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    });
    await processMessage({ jsonrpc: "2.0", id: 4, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 5, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 6, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 10, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 11, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 12, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 13, method: "resources/list" }, { ...h, fetchFn });
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
    await processMessage({ jsonrpc: "2.0", id: 14, method: "resources/list" }, { ...h, fetchFn });
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

describe("tools/list interception (configure_pen_editor_connection discovery)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  function fakeSSEBody(chunks) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield new TextEncoder().encode(chunk);
      },
    };
  }

  it("appends CONFIGURE_TOOL_DEFINITION to an upstream JSON tools/list result", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "get_editor_state" }] } }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.tools).toEqual([{ name: "get_editor_state" }, CONFIGURE_TOOL_DEFINITION]);
  });

  it("appends CONFIGURE_TOOL_DEFINITION to an upstream SSE tools/list result", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: fakeSSEBody([
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "get_variables" }] } })}\n\n`,
      ]),
    }));
    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.tools).toEqual([{ name: "get_variables" }, CONFIGURE_TOOL_DEFINITION]);
  });

  it("an unrelated SSE event (different id) passes through unmodified alongside the augmented tools/list answer", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: fakeSSEBody([
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 3, result: { tools: [] } })}\n\n`,
      ]),
    }));
    await processMessage({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(2);
    expect(h.written[0]).toEqual({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
    expect(h.written[1].result.tools).toEqual([CONFIGURE_TOOL_DEFINITION]);
  });

  it("builds a tools array containing only CONFIGURE_TOOL_DEFINITION when the upstream result had no tools field at all", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 4, result: {} }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 4, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
  });

  it("no token configured: tools/list still succeeds, exposing only CONFIGURE_TOOL_DEFINITION, instead of an AUTH error - this is the escape hatch that lets an agent fix its own connection", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch when no token is configured");
    });
    await processMessage({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 5, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
    expect(h.logged.some((l) => l.includes(CONFIGURE_TOOL_NAME))).toBe(true);
  });

  it("HTTP 401 on tools/list still succeeds, exposing only CONFIGURE_TOOL_DEFINITION, instead of an AUTH error", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "wrong" });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
    }));
    await processMessage({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 6, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
  });

  it("a network failure on tools/list still succeeds, exposing only CONFIGURE_TOOL_DEFINITION, instead of a NETWORK error", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await processMessage({ jsonrpc: "2.0", id: 7, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 7, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
  });

  it("a stalled SSE stream (never answers) on tools/list still succeeds, exposing only CONFIGURE_TOOL_DEFINITION, instead of a synthesized HTTP error", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: fakeSSEBody([": keep-alive\n\n"]),
    }));
    await processMessage({ jsonrpc: "2.0", id: 8, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 8, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
  });

  it("a non-tools/list method is never intercepted (regression guard)", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 9, result: { protocolVersion: "2025-03-26" } }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 9, method: "initialize" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 9, result: { protocolVersion: "2025-03-26" } }]);
  });

  it("tools/call for a real (non-configure) tool name still forwards upstream unmodified (regression guard)", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async (url, opts) => {
      expect(JSON.parse(opts.body).method).toBe("tools/call");
      return {
        ok: true,
        status: 200,
        headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "ok" }] } }),
      };
    });
    await processMessage(
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "get_editor_state", arguments: {} } },
      { ...h, fetchFn },
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 10, result: { content: [{ type: "text", text: "ok" }] } }]);
  });
});

describe("tools/call configure_pen_editor_connection (handled locally, never forwarded)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  function configureCall(id, args) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name: CONFIGURE_TOOL_NAME, arguments: args } };
  }

  it("never calls fetch - the call is handled entirely locally", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch for configure_pen_editor_connection");
    });
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "new-token" }), {
      ...h,
      fetchFn,
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
    });
    expect(fetchFn).not.toHaveBeenCalled();
    // The tool-call reply, plus a notifications/tools/list_changed
    // notification prompting the client to re-fetch tools/list now that
    // the connection changed (finding 2) - see the dedicated describe
    // block below for focused coverage of that notification.
    expect(h.written).toHaveLength(2);
    expect(h.written[0].result.isError).toBeFalsy();
    expect(h.written[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  it("writes {url, token} to <PLUGIN_DATA>/config.json with mode 0600, atomically (via temp file + rename)", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    const renameSyncCalls = [];
    const renameSync = (from, to) => {
      renameSyncCalls.push({ from, to });
      return fsRenameSync(from, to);
    };
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "new-token-123" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
      renameSync,
    });

    const configPath = path.join(dir, "config.json");
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(fsReadFileSync(configPath, "utf8"))).toEqual({
      url: "https://example.test/api/mcp",
      token: "new-token-123",
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    // Atomic: written via a temp file in the same directory, then renamed
    // over the final path - never written directly to config.json.
    expect(renameSyncCalls).toHaveLength(1);
    expect(renameSyncCalls[0].to).toBe(configPath);
    expect(renameSyncCalls[0].from).not.toBe(configPath);
    expect(path.dirname(renameSyncCalls[0].from)).toBe(dir);
  });

  it("creates the PLUGIN_DATA directory if it doesn't exist yet", async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-")), "nested", "deeper");
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
    });
    expect(existsSync(path.join(dir, "config.json"))).toBe(true);
  });

  it("takes effect on the very next request without a restart - mutates `config` in place", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "new-token" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch for the configure call itself");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
    });
    expect(h.config.url).toBe("https://example.test/api/mcp");
    expect(h.config.token).toBe("new-token");

    // The very next request (same `config` object, as runProxy would reuse
    // it) picks up the new values with no other change.
    let seenUrl;
    let seenAuth;
    const fetchFn = vi.fn(async (url, opts) => {
      seenUrl = url;
      seenAuth = opts.headers.Authorization;
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }),
      };
    });
    await processMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, { ...h, fetchFn, env: { PEN_EDITOR_PLUGIN_DATA: dir } });
    expect(seenUrl).toBe("https://example.test/api/mcp");
    expect(seenAuth).toBe("Bearer new-token");
  });

  it("rejects missing/empty arguments with a tool-level error (isError: true), not a JSON-RPC protocol error", async () => {
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(configureCall(1, { url: "", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: "/should-not-be-touched" },
    });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error).toBeUndefined();
    expect(h.written[0].result.isError).toBe(true);
    expect(h.written[0].result.content[0].text).toContain("url");
  });

  it("fails gracefully with isError: true when PEN_EDITOR_PLUGIN_DATA is not set", async () => {
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: {},
    });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.isError).toBe(true);
    expect(h.written[0].result.content[0].text).toContain("PEN_EDITOR_PLUGIN_DATA");
    // config must be left untouched on failure.
    expect(h.config).toEqual({ url: DEFAULT_URL, token: undefined });
  });

  it("fails gracefully with isError: true when writing the file throws", async () => {
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: "/some/dir" },
      mkdirSync: () => {
        throw new Error("disk full");
      },
    });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.isError).toBe(true);
    expect(h.written[0].result.content[0].text).toContain("disk full");
    expect(h.config).toEqual({ url: DEFAULT_URL, token: undefined });
  });
});

describe("initialize interception: the escape hatch stays reachable even before configuration (finding 1)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined, toolsListDegraded: false };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  it("no token configured: initialize succeeds locally instead of an AUTH error, advertising tools + listChanged", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch when no token is configured");
    });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { ...h, fetchFn },
    );
    expect(h.written).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-03-26", serverInfo: PROXY_SERVER_INFO, capabilities: PROXY_CAPABILITIES },
      },
    ]);
    // Doesn't fabricate capabilities it can't honour: no resources/prompts/sampling.
    expect(h.written[0].result.capabilities).toEqual({ tools: { listChanged: true } });
  });

  it("full escape-hatch flow: an unconfigured proxy's initialize succeeds, and the subsequent tools/list offers configure_pen_editor_connection", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch when no token is configured");
    });
    await processMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { ...h, fetchFn });
    expect(h.written[0].error).toBeUndefined();

    await processMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written[1]).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [CONFIGURE_TOOL_DEFINITION] } });
  });

  it("a network failure at initialize (token configured, backend unreachable) also synthesizes a local success", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    await processMessage(
      { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { ...h, fetchFn },
    );
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error).toBeUndefined();
    expect(h.written[0].result.protocolVersion).toBe("2025-11-25");
    expect(h.written[0].result.serverInfo).toEqual(PROXY_SERVER_INFO);
  });

  it("falls back to a default protocolVersion when the client's initialize request didn't propose one", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch");
    });
    await processMessage({ jsonrpc: "2.0", id: 4, method: "initialize" }, { ...h, fetchFn });
    expect(typeof h.written[0].result.protocolVersion).toBe("string");
    expect(h.written[0].result.protocolVersion.length).toBeGreaterThan(0);
  });

  it("a configured-and-reachable backend's real initialize result passes through unmodified - not overwritten by the synthesized one", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const realResult = { protocolVersion: "2025-03-26", serverInfo: { name: "real-pen-editor-backend", version: "9.9.9" }, capabilities: { resources: {}, tools: {} } };
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : null) },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 5, result: realResult }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 5, method: "initialize" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 5, result: realResult }]);
  });

  it("HTTP 401 at initialize (wrong token) also synthesizes a local success rather than failing the connection", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "wrong" });
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => "Unauthorized",
    }));
    await processMessage({ jsonrpc: "2.0", id: 6, method: "initialize" }, { ...h, fetchFn });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].error).toBeUndefined();
  });

  it("a non-initialize method is never intercepted by the initialize wrapper (regression guard)", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: undefined });
    const fetchFn = vi.fn(() => {
      throw new Error("must not call fetch");
    });
    await processMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 7, error: { code: ERROR_CODES.AUTH, message: expect.any(String) } }]);
  });
});

describe("tools/list degradation is recoverable, not permanent (finding 2)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined, toolsListDegraded: false };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  it("configure_pen_editor_connection emits notifications/tools/list_changed after a successful save", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    await processMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: CONFIGURE_TOOL_NAME, arguments: { url: "https://example.test/api/mcp", token: "tok" } } },
      { ...h, fetchFn: () => { throw new Error("must not call fetch"); }, env: { PEN_EDITOR_PLUGIN_DATA: dir } },
    );
    expect(h.written).toHaveLength(2);
    expect(h.written[0].id).toBe(1);
    expect(h.written[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
  });

  it("a transient upstream blip that degrades tools/list is recoverable: the next successful upstream call emits notifications/tools/list_changed", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    let shouldFail = true;
    const fetchFn = vi.fn(async () => {
      if (shouldFail) throw new Error("connect ECONNREFUSED");
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }),
      };
    });

    // First tools/list degrades (backend unreachable).
    await processMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 1, result: { tools: [CONFIGURE_TOOL_DEFINITION] } }]);
    expect(h.state.toolsListDegraded).toBe(true);

    // Backend comes back; the very next successful upstream call (not even
    // another tools/list) notices the recovery and proactively tells the
    // client to re-fetch tools/list, instead of the one-tool fallback
    // staying stuck for the rest of the session.
    shouldFail = false;
    await processMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, { ...h, fetchFn });
    expect(h.written[1]).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    expect(h.written[2]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect(h.state.toolsListDegraded).toBe(false);
  });

  it("does not emit a spurious recovery notification when tools/list never degraded in the first place", async () => {
    const h = makeHarness({ url: "http://backend/api/mcp", token: "tok" });
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }),
    }));
    await processMessage({ jsonrpc: "2.0", id: 1, method: "resources/list" }, { ...h, fetchFn });
    expect(h.written).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
  });
});

describe("configure_pen_editor_connection url validation (finding 4)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined, toolsListDegraded: false };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  function configureCall(id, args) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name: CONFIGURE_TOOL_NAME, arguments: args } };
  }

  const rejectionCases = [
    ["a non-URL string", "not a url at all"],
    ["a javascript: scheme", "javascript:alert(1)"],
    ["a file: scheme", "file:///etc/passwd"],
    ["a data: scheme", "data:text/plain,hello"],
    ["credentials embedded in the URL", "https://attacker:sneaky@example.test/api/mcp"],
    ["plain http to a non-loopback host", "http://example.test/api/mcp"],
    ["plain http to a public IP", "http://93.184.216.34/api/mcp"],
  ];

  for (const [label, badUrl] of rejectionCases) {
    it(`rejects ${label} with a tool-level error and does not write config.json`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
      const h = makeHarness({ url: DEFAULT_URL, token: undefined });
      const fetchFn = vi.fn(() => {
        throw new Error("must not call fetch");
      });
      await processMessage(configureCall(1, { url: badUrl, token: "some-token" }), {
        ...h,
        fetchFn,
        env: { PEN_EDITOR_PLUGIN_DATA: dir },
      });
      expect(h.written).toHaveLength(1);
      expect(h.written[0].error).toBeUndefined();
      expect(h.written[0].result.isError).toBe(true);
      expect(existsSync(path.join(dir, "config.json"))).toBe(false);
      // config must be left untouched.
      expect(h.config).toEqual({ url: DEFAULT_URL, token: undefined });
    });
  }

  const acceptedCases = [
    ["https to a remote host", "https://my-backend.example.com/api/mcp"],
    ["plain http to localhost", "http://localhost:3001/api/mcp"],
    ["plain http to 127.0.0.1", "http://127.0.0.1:4000/api/mcp"],
  ];

  for (const [label, goodUrl] of acceptedCases) {
    it(`accepts ${label}`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
      const h = makeHarness({ url: DEFAULT_URL, token: undefined });
      await processMessage(configureCall(1, { url: goodUrl, token: "some-token" }), {
        ...h,
        fetchFn: () => {
          throw new Error("must not call fetch");
        },
        env: { PEN_EDITOR_PLUGIN_DATA: dir },
      });
      expect(h.written[0].result.isError).toBeFalsy();
      expect(h.config.url).toBe(goodUrl);
    });
  }
});

describe("configure_pen_editor_connection resets per-connection session state (finding 5)", () => {
  function makeHarness(config, state) {
    const written = [];
    const logged = [];
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  function configureCall(id, args) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name: CONFIGURE_TOOL_NAME, arguments: args } };
  }

  it("clears state.sessionId and state.protocolVersion so a stale session from the old backend is never replayed against the new one", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness(
      { url: "http://old-backend/api/mcp", token: "old-token" },
      { sessionId: "stale-session-id", protocolVersion: "2024-11-05", toolsListDegraded: true },
    );
    await processMessage(configureCall(1, { url: "https://new-backend.example.com/api/mcp", token: "new-token" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch for the configure call itself");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
    });
    expect(h.state.sessionId).toBeUndefined();
    expect(h.state.protocolVersion).toBeUndefined();
    expect(h.state.toolsListDegraded).toBe(false);

    // The very next forwarded request must not carry the old session id or
    // protocol version header.
    let seenHeaders;
    const fetchFn = vi.fn(async (url, opts) => {
      seenHeaders = opts.headers;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) };
    });
    await processMessage({ jsonrpc: "2.0", id: 2, method: "resources/list" }, { ...h, fetchFn, env: { PEN_EDITOR_PLUGIN_DATA: dir } });
    expect(seenHeaders["Mcp-Session-Id"]).toBeUndefined();
    expect(seenHeaders["MCP-Protocol-Version"]).toBeUndefined();
  });

  it("leaves session state untouched when the configure call fails validation", async () => {
    const h = makeHarness(
      { url: "http://old-backend/api/mcp", token: "old-token" },
      { sessionId: "stale-session-id", protocolVersion: "2024-11-05", toolsListDegraded: false },
    );
    await processMessage(configureCall(1, { url: "not-a-url", token: "new-token" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: "/should-not-be-touched" },
    });
    expect(h.state.sessionId).toBe("stale-session-id");
    expect(h.state.protocolVersion).toBe("2024-11-05");
  });
});

describe("writeConfigFileAtomic cleans up the temp file if renameSync throws (finding 7)", () => {
  function makeHarness(config) {
    const written = [];
    const logged = [];
    const state = { protocolVersion: undefined, sessionId: undefined, toolsListDegraded: false };
    const write = (obj) => written.push(obj);
    const log = (line) => logged.push(line);
    return { config, state, write, log, written, logged };
  }

  function configureCall(id, args) {
    return { jsonrpc: "2.0", id, method: "tools/call", params: { name: CONFIGURE_TOOL_NAME, arguments: args } };
  }

  it("unlinks the temp file when renameSync throws, and surfaces the original rename error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    let tmpPathSeen;
    const unlinkSync = vi.fn((p) => {
      tmpPathSeen = p;
    });
    const renameSync = () => {
      throw new Error("EXDEV: cross-device link not permitted");
    };
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
      renameSync,
      unlinkSync,
    });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.isError).toBe(true);
    expect(h.written[0].result.content[0].text).toContain("cross-device link not permitted");
    expect(unlinkSync).toHaveBeenCalledTimes(1);
    expect(path.dirname(tmpPathSeen)).toBe(dir);
    // config.json itself must never have been created.
    expect(existsSync(path.join(dir, "config.json"))).toBe(false);
  });

  it("does not let a failing unlinkSync mask the original renameSync error", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pen-editor-plugin-data-"));
    const h = makeHarness({ url: DEFAULT_URL, token: undefined });
    const renameSync = () => {
      throw new Error("disk full during rename");
    };
    const unlinkSync = () => {
      throw new Error("unlink also failed");
    };
    await processMessage(configureCall(1, { url: "https://example.test/api/mcp", token: "tok" }), {
      ...h,
      fetchFn: () => {
        throw new Error("must not call fetch");
      },
      env: { PEN_EDITOR_PLUGIN_DATA: dir },
      renameSync,
      unlinkSync,
    });
    expect(h.written).toHaveLength(1);
    expect(h.written[0].result.isError).toBe(true);
    expect(h.written[0].result.content[0].text).toContain("disk full during rename");
  });
});
