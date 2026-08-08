#!/usr/bin/env node
// Thin executable entry point launched by mcp.json:
//   { "type": "stdio", "command": "node", "args": ["${PLUGIN_ROOT}/bin/pen-editor-mcp.mjs"] }
// All real logic lives in ../lib/proxy.mjs so it can be unit tested without
// spawning a process.

import { runProxy } from "../lib/proxy.mjs";

// Never let an unhandled rejection or a stray uncaught exception kill the
// process out from under a client that's still waiting on a response -
// log to stderr (stdout is reserved for NDJSON MCP messages) and keep
// serving.
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[pen-editor-mcp] Unhandled rejection: ${reason && reason.stack ? reason.stack : reason}\n`);
});
// Unlike unhandledRejection, an uncaughtException means something threw
// synchronously outside of any promise chain (e.g. the `fetch` global
// being missing on Node <18, which throws a ReferenceError before any
// .catch() can attach). Swallowing that would leave a process alive that
// never reads stdin again while the client sits blocked on initialize -
// exit non-zero instead so the client's spawn fails visibly.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[pen-editor-mcp] Uncaught exception: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});

runProxy()
  .then(() => {
    // Do NOT process.exit(0) here: runProxy() only resolves once every
    // in-flight processMessage() has settled (see its docstring), but
    // process.exit() does not flush asynchronous stdout pipe writes, so
    // exiting explicitly could still truncate an already-issued
    // output.write() into a corrupt NDJSON frame. Let the event loop
    // drain naturally instead - once stdin is closed and there's nothing
    // else pending, the process exits on its own with code 0.
  })
  .catch((err) => {
    process.stderr.write(`[pen-editor-mcp] Fatal error: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
