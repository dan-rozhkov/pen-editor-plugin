import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const readJson = (p) => JSON.parse(readFileSync(path.join(ROOT, p), "utf8"));

let ajv;
const plugin = readJson("openai/plugin.json");
const mcp = readJson("openai/mcp.json");
const ui = plugin.extensions["com.openai"]?.interface;

beforeAll(() => {
  ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(readJson("schemas/plugin.schema.json"), "plugin");
  ajv.addSchema(readJson("schemas/mcp.schema.json"), "mcp");
});

function pngSize(file) {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(b.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe("openai/plugin.json", () => {
  it("validates against the plugin schema", () => {
    const v = ajv.getSchema("plugin");
    expect(v(plugin), JSON.stringify(v.errors)).toBe(true);
  });
  it("nests the listing as extensions['com.openai'].interface (no flattened dotted keys)", () => {
    expect(Object.keys(plugin.extensions)).toEqual(["com.openai"]);
    expect(Object.keys(plugin.extensions["com.openai"])).toEqual(["interface"]);
    expect(ui.displayName).toBe("Sideform");
  });

  it("is named sideform, no apps/hooks", () => {
    expect(plugin.name).toBe("sideform");
    expect(plugin).not.toHaveProperty("apps");
    expect(plugin).not.toHaveProperty("hooks");
    expect(ui).not.toHaveProperty("apps");
    expect(existsSync(path.join(ROOT, "openai/hooks"))).toBe(false);
  });
  it("respects interface field limits", () => {
    expect(ui.displayName.length).toBeLessThanOrEqual(30);
    expect(ui.shortDescription.length).toBeLessThanOrEqual(30);
    expect(ui.longDescription.length).toBeLessThanOrEqual(4000);
    expect(ui.developerName).toBeTruthy();
    expect(ui.category).toBe("Design");
    expect(ui.brandColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(ui.capabilities.length).toBeLessThanOrEqual(20);
    for (const c of ui.capabilities) expect(c.length).toBeLessThanOrEqual(120);
    expect(ui.defaultPrompt.length).toBeGreaterThanOrEqual(3);
    expect(ui.defaultPrompt.length).toBeLessThanOrEqual(4);
  });
  it("defaultPrompt entries need no pre-existing selection or document", () => {
    for (const q of ui.defaultPrompt) {
      expect(q).not.toMatch(/selected/i);
      expect(q).not.toMatch(/my existing/i);
    }
  });
  it("URLs are https and at most 1024 chars", () => {
    for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
      expect(ui[k], k).toMatch(/^https:\/\//);
      expect(ui[k].length).toBeLessThanOrEqual(1024);
    }
  });
  it("package.json version is what the build script ships", () => {
    expect(plugin.version).toBe(readJson("package.json").version);
  });
});

describe("openai package text", () => {
  it("never mentions Figma", () => {
    const files = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(json|md)$/.test(e.name)) files.push(f); } };
    walk(path.join(ROOT, "openai"));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(/figma/i);
  });
});

describe("openai/mcp.json", () => {
  it("validates and has a single streamable-http server", () => {
    const v = ajv.getSchema("mcp");
    expect(v(mcp), JSON.stringify(v.errors)).toBe(true);
    expect(Object.keys(mcp.mcpServers)).toEqual(["sideform"]);
    expect(mcp.mcpServers.sideform).toEqual({ type: "streamable-http", url: "https://api.sideform.pro/mcp" });
  });
});

describe("openai assets", () => {
  for (const key of ["composerIcon", "logo"]) {
    it(`${key} exists and is a PNG within 48..4096 px`, () => {
      const file = path.join(ROOT, "openai", ui[key]);
      expect(existsSync(file)).toBe(true);
      const { w, h } = pngSize(file);
      for (const n of [w, h]) {
        expect(n).toBeGreaterThanOrEqual(48);
        expect(n).toBeLessThanOrEqual(4096);
      }
    });
  }
});

describe("openai skills", () => {
  const dir = path.join(ROOT, "openai/skills");
  const names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  it("ships the expected skills", () => {
    expect(names.sort()).toEqual(["sideform-connect", "sideform-design", "sideform-dev-mode"]);
  });
  for (const n of names) {
    it(`${n} has valid frontmatter and no local-proxy wording`, () => {
      const text = readFileSync(path.join(dir, n, "SKILL.md"), "utf8");
      const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
      expect(m).not.toBeNull();
      const f = Object.fromEntries(m[1].split(/\r?\n/).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean).map((x) => [x[1], x[2]]));
      expect(f.name).toBe(n);
      expect(n).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(f.description).toBeTruthy();
      expect(text).not.toMatch(/localhost|loopback|pen-editor-setup|~\/\.pen-editor/);
    });
  }
});

describe("sideform-design embed-first guidance", () => {
  const text = readFileSync(path.join(ROOT, "openai/skills/sideform-design/SKILL.md"), "utf8");
  it('tells the agent to load_skill("prototype") and use embed nodes', () => {
    expect(text).toContain('load_skill("prototype")');
    expect(text).toMatch(/embed/);
    expect(text).toContain("read_embed_html");
    expect(text).toContain("edit_embed_html");
  });
  it("does not instruct native frame creation for new screens", () => {
    expect(text).not.toMatch(/I\(document,\s*\{\s*type:\s*"(frame|rect|text|group)"/);
    expect(text).toMatch(/never create a new top-level native node/i);
  });
});

describe("npm run package:openai", () => {
  it("builds a zip with package files at the root", () => {
    execFileSync("node", ["scripts/package-openai.mjs"], { cwd: ROOT, stdio: "pipe" });
    const zip = path.join(ROOT, "dist/sideform-openai.zip");
    expect(existsSync(zip)).toBe(true);
    const listing = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").filter(Boolean);
    for (const f of [
      "plugin.json", "mcp.json", "assets/icon.png", "assets/logo.png",
      "skills/sideform-design/SKILL.md", "skills/sideform-dev-mode/SKILL.md", "skills/sideform-connect/SKILL.md",
    ]) expect(listing).toContain(f);
    expect(listing.some((f) => f.startsWith("openai/") || f.startsWith("dist/"))).toBe(false);
    const manifest = JSON.parse(execFileSync("unzip", ["-p", zip, "plugin.json"], { encoding: "utf8" }));
    expect(manifest.version).toBe(readJson("package.json").version);
  }, 30000);
});
