import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN_PATH = path.join(HERE, "..", "bin", "pen-editor-mcp.mjs");

// Every spawned proxy gets its own throwaway HOME by default (below), so
// os.homedir() inside the proxy process never resolves to this machine's
// real home directory - the proxy must never read or write the real
// ~/.pen-editor/mcp.json during tests.
function freshHomeDir() {
  return mkdtempSync(path.join(tmpdir(), "pen-editor-fake-home-"));
}

/** Write a handshake file at <homeDir>/.pen-editor/mcp.json, like pen-editor-backend does. */
function writeHandshakeFile(homeDir, { url, token, port, raw }) {
  const dir = path.join(homeDir, ".pen-editor");
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "mcp.json");
  writeFileSync(filePath, raw ?? JSON.stringify({ url, token, port }), { mode: 0o600 });
  return filePath;
}

const TIMEOUT = 20_000;

let children = [];
let servers = [];

afterEach(async () => {
  for (const child of children) {
    if (!child.killed) child.kill("SIGKILL");
  }
  children = [];
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(() => resolve());
          // In case it's already not listening.
          setTimeout(resolve, 500);
        }),
    ),
  );
  servers = [];
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

/**
 * Spawn the proxy binary with the given env, returning helpers to talk
 * NDJSON over its stdio. Unless `env.HOME` (or `env.USERPROFILE`) is
 * explicitly supplied, defaults both to a fresh empty temp directory so
 * os.homedir() inside the spawned process can never resolve to this
 * machine's real home directory - the proxy must never touch the real
 * ~/.pen-editor/mcp.json during tests.
 */
function spawnProxy(env) {
  const home = env && (env.HOME ?? env.USERPROFILE) !== undefined ? undefined : freshHomeDir();
  const child = spawn(process.execPath, [BIN_PATH], {
    env: { ...process.env, ...(home ? { HOME: home, USERPROFILE: home } : {}), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);

  let outBuffer = "";
  const outLines = [];
  const waiters = [];
  const stderrChunks = [];

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    outBuffer += chunk;
    let idx;
    while ((idx = outBuffer.indexOf("\n")) !== -1) {
      const line = outBuffer.slice(0, idx);
      outBuffer = outBuffer.slice(idx + 1);
      if (!line.trim()) continue;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(line);
      } else {
        outLines.push(line);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

  function send(msg) {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  function nextLine(timeoutMs = TIMEOUT) {
    if (outLines.length > 0) return Promise.resolve(outLines.shift());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for a stdout line. stderr so far:\n${stderrChunks.join("")}`));
      }, timeoutMs);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  function stderrText() {
    return stderrChunks.join("");
  }

  return { child, send, nextLine, stderrText };
}

describe("pen-editor-mcp proxy (e2e over real stdio + real http)", () => {
  it(
    "initialize round-trip: server replies application/json",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          expect(req.headers["content-type"]).toContain("application/json");
          expect(req.headers.accept).toContain("application/json");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-03-26" } }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } });
    },
    TIMEOUT,
  );

  it(
    "SSE-replying request round-trips through the proxy",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "sse" } })}\n\n`);
          res.end();
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 2, method: "resources/list" });
      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 2, result: { via: "sse" } });
    },
    TIMEOUT,
  );

  it(
    "a notification produces no stdout line",
    async () => {
      let sawNotification = false;
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          if (msg.method === "notifications/initialized") {
            sawNotification = true;
            res.writeHead(202);
            res.end();
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      // Follow it with a real request so we have a deterministic point to
      // assert "nothing showed up before this" - the notification must
      // not have produced a stdout line ahead of this response.
      proxy.send({ jsonrpc: "2.0", id: 99, method: "resources/list" });

      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      // The only line we got corresponds to the *second* message (id 99),
      // not the notification, and the server did see the notification
      // land as an HTTP request before that.
      expect(parsed.id).toBe(99);
      expect(sawNotification).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "HTTP 401 produces a JSON-RPC AUTH error",
    async () => {
      const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("Unauthorized");
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "wrong-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 3, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(3);
      expect(parsed.error.code).toBe(-32001);
      expect(parsed.error.message).toContain(`127.0.0.1:${port}`);
    },
    TIMEOUT,
  );

  it(
    "HTTP 503 produces a JSON-RPC DISABLED error",
    async () => {
      const server = http.createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "MCP is not enabled on this server (MCP_AUTH_TOKEN unset)." }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "any-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 4, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(4);
      expect(parsed.error.code).toBe(-32002);
      expect(parsed.error.message).toContain("MCP_AUTH_TOKEN");
    },
    TIMEOUT,
  );

  it(
    "no token configured produces a JSON-RPC AUTH error without contacting the server",
    async () => {
      let hitServer = false;
      const server = http.createServer((req, res) => {
        hitServer = true;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        // Deliberately no PEN_EDITOR_MCP_TOKEN and no PEN_EDITOR_PLUGIN_DATA.
      });

      proxy.send({ jsonrpc: "2.0", id: 5, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(5);
      expect(parsed.error.code).toBe(-32001);
      expect(parsed.error.message).toContain("PEN_EDITOR_MCP_TOKEN");
      expect(parsed.error.message).toContain("config.json");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(hitServer).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "unreachable url (server closed) produces a JSON-RPC NETWORK error",
    async () => {
      const server = http.createServer((req, res) => {
        res.writeHead(200);
        res.end("{}");
      });
      servers.push(server);
      const port = await listen(server);
      await new Promise((resolve) => server.close(resolve));
      servers = servers.filter((s) => s !== server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "tok",
      });

      proxy.send({ jsonrpc: "2.0", id: 6, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(6);
      expect(parsed.error.code).toBe(-32003);
      expect(parsed.error.message).toContain(`127.0.0.1:${port}`);
      expect(parsed.error.message).toContain("npm run dev");
    },
    TIMEOUT,
  );

  it(
    "the Authorization header actually received by the server matches the configured token",
    async () => {
      let receivedAuth;
      const server = http.createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "super-secret-token-123",
      });

      proxy.send({ jsonrpc: "2.0", id: 7, method: "resources/list" });
      await proxy.nextLine();
      expect(receivedAuth).toBe("Bearer super-secret-token-123");
    },
    TIMEOUT,
  );

  it(
    "reads config from PEN_EDITOR_PLUGIN_DATA/config.json when env vars are absent",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          expect(req.headers.authorization).toBe("Bearer file-token");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { fromFile: true } }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const os = await import("node:os");
      const dir = mkdtempSync(path.join(os.tmpdir(), "pen-editor-plugin-data-"));
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ url: `http://127.0.0.1:${port}/api/mcp`, token: "file-token" }),
      );

      const proxy = spawnProxy({
        PEN_EDITOR_PLUGIN_DATA: dir,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 8, method: "resources/list" });
      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 8, result: { fromFile: true } });
    },
    TIMEOUT,
  );

  it(
    "exits cleanly when stdin closes",
    async () => {
      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: "http://127.0.0.1:1/api/mcp",
        PEN_EDITOR_MCP_TOKEN: "tok",
      });
      const exitCode = await new Promise((resolve) => {
        proxy.child.on("exit", (code) => resolve(code));
        proxy.child.stdin.end();
      });
      expect(exitCode).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "an SSE response ending without a trailing blank line still answers the request",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "text/event-stream" });
          // Deliberately write the event WITHOUT the terminating blank
          // line and end the response right there, simulating a server
          // that closes the connection mid-event.
          res.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "sse-no-terminator" } })}`);
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 10, method: "resources/list" });
      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 10, result: { via: "sse-no-terminator" } });
    },
    TIMEOUT,
  );

  it(
    "closing stdin while a request is still in flight does not lose the response - it is written before the process exits",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          // Slow backend: reply after a delay so the request is still
          // in flight when we close stdin below.
          setTimeout(() => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { slow: true } }));
          }, 300);
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 11, method: "resources/list" });
      // Close stdin immediately, well before the backend's 300ms reply.
      proxy.child.stdin.end();

      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 11, result: { slow: true } });

      const exitCode = await new Promise((resolve) => {
        if (proxy.child.exitCode !== null) {
          resolve(proxy.child.exitCode);
          return;
        }
        proxy.child.on("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "reads config from the <HOME>/.pen-editor/mcp.json handshake file when no env vars or PLUGIN_DATA config.json supply anything",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          expect(req.headers.authorization).toBe("Bearer handshake-token-1234567890");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { fromHandshake: true } }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const home = freshHomeDir();
      writeHandshakeFile(home, { url: `http://127.0.0.1:${port}/api/mcp`, token: "handshake-token-1234567890", port });

      const proxy = spawnProxy({
        HOME: home,
        USERPROFILE: home,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 20, method: "resources/list" });
      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 20, result: { fromHandshake: true } });
    },
    TIMEOUT,
  );

  it(
    "PLUGIN_DATA/config.json wins over the handshake file",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          expect(req.headers.authorization).toBe("Bearer config-file-token");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { via: "config-file" } }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const home = freshHomeDir();
      // Handshake file points at a URL that would fail if ever used.
      writeHandshakeFile(home, { url: "http://127.0.0.1:1/api/mcp", token: "handshake-token", port: 1 });

      const { mkdtempSync: mkdtemp, writeFileSync: writeFile } = await import("node:fs");
      const os = await import("node:os");
      const pluginDataDir = mkdtemp(path.join(os.tmpdir(), "pen-editor-plugin-data-"));
      writeFile(
        path.join(pluginDataDir, "config.json"),
        JSON.stringify({ url: `http://127.0.0.1:${port}/api/mcp`, token: "config-file-token" }),
      );

      const proxy = spawnProxy({
        HOME: home,
        USERPROFILE: home,
        PEN_EDITOR_PLUGIN_DATA: pluginDataDir,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 21, method: "resources/list" });
      const line = await proxy.nextLine();
      expect(JSON.parse(line)).toEqual({ jsonrpc: "2.0", id: 21, result: { via: "config-file" } });
    },
    TIMEOUT,
  );

  it(
    "a stale handshake file (backend since stopped) degrades to a NETWORK error, not a crash",
    async () => {
      const home = freshHomeDir();
      writeHandshakeFile(home, { url: "http://127.0.0.1:1/api/mcp", token: "stale-token-1234567890", port: 1 });

      const proxy = spawnProxy({
        HOME: home,
        USERPROFILE: home,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 22, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(22);
      expect(parsed.error.code).toBe(-32003);
    },
    TIMEOUT,
  );

  it(
    "a malformed handshake file is ignored, falling back to the default url with no token",
    async () => {
      const home = freshHomeDir();
      writeHandshakeFile(home, { raw: "{ not valid json" });

      const proxy = spawnProxy({
        HOME: home,
        USERPROFILE: home,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 23, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(23);
      expect(parsed.error.code).toBe(-32001); // AUTH: no token configured at all.
    },
    TIMEOUT,
  );

  it(
    "an absent handshake file (fresh HOME, nothing written) falls back to the default with no token, never throws",
    async () => {
      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 24, method: "resources/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(24);
      expect(parsed.error.code).toBe(-32001);
      expect(parsed.error.message).toContain("PEN_EDITOR_MCP_TOKEN");
    },
    TIMEOUT,
  );

  it(
    "tools/list is augmented with configure_pen_editor_connection on top of the real upstream tool list",
    async () => {
      const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "get_editor_state" }] } }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: `http://127.0.0.1:${port}/api/mcp`,
        PEN_EDITOR_MCP_TOKEN: "secret-token",
      });

      proxy.send({ jsonrpc: "2.0", id: 25, method: "tools/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      const names = parsed.result.tools.map((t) => t.name);
      expect(names).toEqual(["get_editor_state", "configure_pen_editor_connection"]);
    },
    TIMEOUT,
  );

  it(
    "tools/list still succeeds with just configure_pen_editor_connection when the upstream backend is entirely unreachable (the escape hatch stays reachable even when nothing else is configured)",
    async () => {
      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 26, method: "tools/list" });
      const line = await proxy.nextLine();
      const parsed = JSON.parse(line);
      expect(parsed.id).toBe(26);
      expect(parsed.error).toBeUndefined();
      expect(parsed.result.tools.map((t) => t.name)).toEqual(["configure_pen_editor_connection"]);
    },
    TIMEOUT,
  );

  it(
    "an unconfigured proxy still completes initialize locally, and the client can then discover configure_pen_editor_connection via tools/list (finding 1's full escape-hatch flow)",
    async () => {
      const proxy = spawnProxy({
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
        PEN_EDITOR_PLUGIN_DATA: undefined,
      });

      proxy.send({ jsonrpc: "2.0", id: 29, method: "initialize", params: { protocolVersion: "2025-03-26" } });
      const initLine = await proxy.nextLine();
      const initParsed = JSON.parse(initLine);
      expect(initParsed.id).toBe(29);
      // No error - a real client would treat an initialize error as a
      // failed server and never send tools/list at all.
      expect(initParsed.error).toBeUndefined();
      expect(initParsed.result.protocolVersion).toBe("2025-03-26");
      expect(initParsed.result.capabilities).toEqual({ tools: { listChanged: true } });

      proxy.send({ jsonrpc: "2.0", id: 30, method: "tools/list" });
      const listLine = await proxy.nextLine();
      const listParsed = JSON.parse(listLine);
      expect(listParsed.result.tools.map((t) => t.name)).toEqual(["configure_pen_editor_connection"]);
    },
    TIMEOUT,
  );

  it(
    "configure_pen_editor_connection writes PLUGIN_DATA/config.json and the very next call uses it - no restart",
    async () => {
      let receivedAuth;
      const server = http.createServer((req, res) => {
        receivedAuth = req.headers.authorization;
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const msg = JSON.parse(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: {} }));
        });
      });
      servers.push(server);
      const port = await listen(server);

      const { mkdtempSync: mkdtemp } = await import("node:fs");
      const os = await import("node:os");
      const pluginDataDir = mkdtemp(path.join(os.tmpdir(), "pen-editor-plugin-data-"));

      const proxy = spawnProxy({
        PEN_EDITOR_PLUGIN_DATA: pluginDataDir,
        PEN_EDITOR_MCP_URL: undefined,
        PEN_EDITOR_MCP_TOKEN: undefined,
      });

      proxy.send({
        jsonrpc: "2.0",
        id: 27,
        method: "tools/call",
        params: {
          name: "configure_pen_editor_connection",
          arguments: { url: `http://127.0.0.1:${port}/api/mcp`, token: "freshly-configured-token" },
        },
      });
      const configureLine = await proxy.nextLine();
      const configureResult = JSON.parse(configureLine);
      expect(configureResult.id).toBe(27);
      expect(configureResult.result.isError).toBeFalsy();

      // A notifications/tools/list_changed notification follows the reply
      // (finding 2), telling the client its connection just changed and it
      // should re-fetch tools/list rather than only picking up the new
      // tools after a restart.
      const notificationLine = await proxy.nextLine();
      expect(JSON.parse(notificationLine)).toEqual({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

      const { readFileSync: readFile, statSync: stat } = await import("node:fs");
      const configPath = path.join(pluginDataDir, "config.json");
      expect(JSON.parse(readFile(configPath, "utf8"))).toEqual({
        url: `http://127.0.0.1:${port}/api/mcp`,
        token: "freshly-configured-token",
      });
      expect(stat(configPath).mode & 0o777).toBe(0o600);

      proxy.send({ jsonrpc: "2.0", id: 28, method: "resources/list" });
      const nextLine = await proxy.nextLine();
      const nextParsed = JSON.parse(nextLine);
      expect(nextParsed).toEqual({ jsonrpc: "2.0", id: 28, result: {} });
      expect(receivedAuth).toBe("Bearer freshly-configured-token");
    },
    TIMEOUT,
  );
});
