import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), "utf8"));
}

function readText(relPath) {
  return readFileSync(path.join(ROOT, relPath), "utf8");
}

let ajv;
let pluginSchema;
let mcpSchema;
let pluginManifest;
let mcpManifest;

beforeAll(() => {
  pluginSchema = readJson("schemas/plugin.schema.json");
  mcpSchema = readJson("schemas/mcp.schema.json");
  pluginManifest = readJson("plugin.json");
  mcpManifest = readJson("mcp.json");

  ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(pluginSchema, "plugin");
  ajv.addSchema(mcpSchema, "mcp");
});

describe("plugin.json", () => {
  it("validates against schemas/plugin.schema.json", () => {
    const validate = ajv.getSchema("plugin");
    const valid = validate(pluginManifest);
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("declares the exact plugin manifest schema $schema", () => {
    expect(pluginManifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });
});

describe("mcp.json", () => {
  it("validates against schemas/mcp.schema.json", () => {
    const validate = ajv.getSchema("mcp");
    const valid = validate(mcpManifest);
    expect(valid, JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it("declares the exact mcp manifest schema $schema, matching version with plugin.schema.json", () => {
    expect(mcpManifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");

    const pluginVersion = pluginManifest.$schema.match(/schemas\/([^/]+)\//)[1];
    const mcpVersion = mcpManifest.$schema.match(/schemas\/([^/]+)\//)[1];
    expect(mcpVersion).toBe(pluginVersion);
    expect(mcpVersion).toBe("1.0.0");
  });
});

describe("negative controls: schemas actually reject invalid input", () => {
  it("rejects an uppercase name in plugin.json", () => {
    const validate = ajv.getSchema("plugin");
    const bad = { ...pluginManifest, name: "Pen-Editor" };
    expect(validate(bad)).toBe(false);
  });

  it("rejects a name containing -- in plugin.json", () => {
    const validate = ajv.getSchema("plugin");
    const bad = { ...pluginManifest, name: "pen--editor" };
    expect(validate(bad)).toBe(false);
  });

  it("rejects a name containing .. in plugin.json", () => {
    const validate = ajv.getSchema("plugin");
    const bad = { ...pluginManifest, name: "pen..editor" };
    expect(validate(bad)).toBe(false);
  });

  it("rejects an unknown top-level root property in plugin.json", () => {
    const validate = ajv.getSchema("plugin");
    const bad = { ...pluginManifest, unknownRootProp: true };
    expect(validate(bad)).toBe(false);
  });

  it("rejects an mcp server entry with both command and url", () => {
    const validate = ajv.getSchema("mcp");
    const bad = {
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        broken: {
          type: "stdio",
          command: "node",
          url: "http://localhost:3001/api/mcp",
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });
});

describe("spec conformance rules not covered by the JSON Schema alone (mcp.json)", () => {
  const PLACEHOLDER_RE = /\$\{([^}]*)\}/g;
  const ALLOWED_PLACEHOLDERS = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

  function collectPlaceholders(str) {
    const out = [];
    let m;
    PLACEHOLDER_RE.lastIndex = 0;
    while ((m = PLACEHOLDER_RE.exec(str)) !== null) {
      out.push(m[1]);
    }
    return out;
  }

  let mcpServersForSpec = {};
  let mcpReadError = null;
  try {
    mcpServersForSpec = readJson("mcp.json").mcpServers ?? {};
  } catch (err) {
    mcpReadError = err;
  }

  if (mcpReadError) {
    it("mcp.json can be read and parsed for spec-conformance checks", () => {
      throw mcpReadError;
    });
  }

  for (const [name, server] of Object.entries(mcpServersForSpec)) {
    if (server.type !== "stdio") continue;

    describe(`server "${name}"`, () => {
      it("command has no ${...} expansion and is a bare executable token or ./-prefixed relative path", () => {
        expect(collectPlaceholders(server.command)).toEqual([]);
        const isBareToken = !server.command.includes("/") && !server.command.includes("\\");
        const isRelativePath = server.command.startsWith("./");
        expect(isBareToken || isRelativePath, `command "${server.command}" is neither a bare token nor ./-relative`).toBe(true);
      });

      it("every ${...} placeholder in args/env/cwd is PLUGIN_ROOT or PLUGIN_DATA", () => {
        const haystacks = [
          ...(server.args ?? []),
          ...Object.values(server.env ?? {}),
          ...(server.cwd !== undefined ? [server.cwd] : []),
        ];
        const found = haystacks.flatMap(collectPlaceholders);
        for (const placeholder of found) {
          expect(ALLOWED_PLACEHOLDERS.has(placeholder), `unexpected placeholder \${${placeholder}}`).toBe(true);
        }
      });

      it("no env key is PLUGIN_ROOT or PLUGIN_DATA", () => {
        const keys = Object.keys(server.env ?? {});
        expect(keys).not.toContain("PLUGIN_ROOT");
        expect(keys).not.toContain("PLUGIN_DATA");
      });

      it("every plugin-relative path referenced from args resolves inside the plugin root and exists on disk", () => {
        const pluginRelativeArgs = (server.args ?? []).filter((arg) => arg.includes("${PLUGIN_ROOT}"));
        expect(pluginRelativeArgs.length, "expected at least one ${PLUGIN_ROOT}-relative arg to check").toBeGreaterThan(0);

        for (const arg of pluginRelativeArgs) {
          const relative = arg.replace("${PLUGIN_ROOT}/", "").replace("${PLUGIN_ROOT}", "");
          const resolved = path.resolve(ROOT, relative);

          // Must resolve inside the plugin root (no path traversal escape).
          const relFromRoot = path.relative(ROOT, resolved);
          expect(
            relFromRoot && !relFromRoot.startsWith("..") && !path.isAbsolute(relFromRoot),
            `"${arg}" resolves outside the plugin root: ${resolved}`,
          ).toBe(true);

          // The referenced file must actually exist on disk.
          expect(existsSync(resolved), `referenced file does not exist: ${resolved}`).toBe(true);
        }
      });
    });
  }
});

describe("skill discovery per spec (skills/)", () => {
  const skillsDir = path.join(ROOT, "skills");
  const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

  function parseFrontmatter(text) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (!match) return null;
    const body = match[1];
    const fields = {};
    for (const line of body.split(/\r?\n/)) {
      const fieldMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (!fieldMatch) continue;
      let [, key, value] = fieldMatch;
      value = value.trim();
      // Strip a single layer of matching quotes, if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      fields[key] = value;
    }
    return fields;
  }

  const skillDirs = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

  it("has a skills/ directory with no stray files directly inside it, and at least one skill", () => {
    expect(existsSync(skillsDir), "skills/ directory does not exist").toBe(true);
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const stray = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
    expect(stray, `stray files directly in skills/: ${stray.join(", ")}`).toEqual([]);
    expect(skillDirs.length, "expected at least one skill directory under skills/").toBeGreaterThan(0);
  });

  for (const dirName of skillDirs) {
    describe(`skill "${dirName}"`, () => {
      const skillMdPath = path.join(skillsDir, dirName, "SKILL.md");

      it("contains a regular file named exactly SKILL.md", () => {
        expect(existsSync(skillMdPath), `${skillMdPath} does not exist`).toBe(true);
        expect(statSync(skillMdPath).isFile()).toBe(true);
      });

      it("has YAML frontmatter with non-empty name and description", () => {
        const text = readFileSync(skillMdPath, "utf8");
        const frontmatter = parseFrontmatter(text);
        expect(frontmatter, "SKILL.md has no --- frontmatter block").not.toBeNull();
        expect(frontmatter.name, "frontmatter.name is missing/empty").toBeTruthy();
        expect(frontmatter.description, "frontmatter.description is missing/empty").toBeTruthy();
      });

      it("frontmatter name matches its containing directory name and the slug pattern", () => {
        const text = readFileSync(skillMdPath, "utf8");
        const frontmatter = parseFrontmatter(text);
        expect(frontmatter.name).toBe(dirName);
        expect(frontmatter.name).toMatch(NAME_RE);
      });
    });
  }
});

describe("vendored schemas match their canonical $id", () => {
  it("plugin.schema.json $id is byte-identical to the canonical URL", () => {
    expect(pluginSchema.$id).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  });

  it("mcp.schema.json $id is byte-identical to the canonical URL", () => {
    expect(mcpSchema.$id).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
  });
});
