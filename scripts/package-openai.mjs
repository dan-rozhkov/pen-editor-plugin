#!/usr/bin/env node
// Builds dist/sideform-openai.zip for the OpenAI plugin directory.
// Stages openai/ with the version from package.json, then zips it with the system `zip` CLI.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "openai");
const STAGE = path.join(ROOT, "dist", "openai-stage");
const OUT = path.join(ROOT, "dist", "sideform-openai.zip");
const ENTRIES = ["plugin.json", "mcp.json", "skills", "assets"];

const { version } = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));

rmSync(STAGE, { recursive: true, force: true });
rmSync(OUT, { force: true });
mkdirSync(STAGE, { recursive: true });
for (const entry of ENTRIES) cpSync(path.join(SRC, entry), path.join(STAGE, entry), { recursive: true });

const manifestPath = path.join(STAGE, "plugin.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.version = version;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

execFileSync("zip", ["-X", "-r", OUT, ...ENTRIES, "-x", "*.DS_Store"], { cwd: STAGE, stdio: "inherit" });
rmSync(STAGE, { recursive: true, force: true });
console.log(`Wrote ${path.relative(ROOT, OUT)} (version ${version})`);
