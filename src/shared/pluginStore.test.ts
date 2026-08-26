import { describe, expect, it } from "vitest";

import { remapInstalledPluginRoots, scanKimiPlugins, type PluginFileAccess } from "./pluginStore";

function memoryPluginFs(files: Record<string, string>): PluginFileAccess {
  const documents = new Map(Object.entries(files));
  const directories = new Set<string>();
  for (const path of documents.keys()) {
    let current = path.replace(/\/[^/]+$/, "");
    while (current && !directories.has(current)) {
      directories.add(current);
      const parent = current.replace(/\/[^/]+$/, "");
      if (parent === current) break;
      current = parent;
    }
  }
  return {
    async readText(path) {
      return documents.get(path) ?? null;
    },
    async pathExists(path) {
      return documents.has(path) || directories.has(path);
    },
  };
}

describe("pluginStore", () => {
  it("materializes official installed.json, manifest Skills, and runtime MCP names", async () => {
    const home = "/kimi-home";
    const root = "/kimi-home/plugins/managed/demo";
    const files = memoryPluginFs({
      [`${home}/plugins/installed.json`]: JSON.stringify({
        version: 1,
        plugins: [{
          id: "demo",
          root,
          source: "github",
          enabled: true,
          installedAt: "2026-01-01T00:00:00Z",
          capabilities: { mcpServers: { search: { enabled: false } } },
        }],
      }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({
        name: "demo",
        version: "1.2.3",
        description: "Demo plugin",
        skills: "./skills",
        hooks: [{ event: "beforeTool", command: "./check.sh" }],
        interface: { displayName: "Demo Plugin" },
        mcpServers: {
          search: { command: "./server.js", args: [], env: { MODE: "plugin" } },
        },
      }),
      [`${root}/skills/review/SKILL.md`]: "---\nname: review\ndescription: Review\n---\n",
      [`${root}/server.js`]: "console.log('mcp')",
    });

    const report = await scanKimiPlugins(files, home);

    expect(report.plugins).toHaveLength(1);
    expect(report.plugins[0]).toMatchObject({
      id: "demo",
      displayName: "Demo Plugin",
      version: "1.2.3",
      state: "ok",
      hookCount: 1,
    });
    expect(report.skillRoots).toEqual([{ pluginId: "demo", path: `${root}/skills` }]);
    expect(report.mcpServers["plugin-demo:search"]).toMatchObject({
      enabled: false,
      command: `${root}/server.js`,
      env: {
        MODE: "plugin",
        KIMI_CODE_HOME: home,
        KIMI_PLUGIN_ROOT: root,
      },
      extra: { cwd: root },
    });
  });

  it("uses root SKILL.md fallback and keeps disabled plugins out of effective Skills", async () => {
    const root = "/plugins/disabled";
    const files = memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({
        version: 1,
        plugins: [{ id: "disabled", root, source: "local-path", enabled: false, installedAt: "now" }],
      }),
      [`${root}/.kimi-plugin/plugin.json`]: JSON.stringify({ name: "disabled" }),
      [`${root}/SKILL.md`]: "---\nname: disabled\ndescription: Disabled\n---\n",
    });

    const report = await scanKimiPlugins(files, "/home");

    expect(report.plugins[0].skillRoots).toEqual([{ pluginId: "disabled", path: root, rootSkillOnly: true }]);
    expect(report.skillRoots).toEqual([]);
  });

  it("reports corrupt inventory and path-escaping manifest entries", async () => {
    const corrupt = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": "{not-json",
    }), "/home");
    expect(corrupt.diagnostics[0].severity).toBe("error");

    const root = "/plugins/bad";
    const unsafe = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({
        version: 1,
        plugins: [{ id: "bad", root, source: "local-path", enabled: true, installedAt: "now" }],
      }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({ name: "bad", skills: "../escape" }),
    }), "/home");
    expect(unsafe.plugins[0].state).toBe("error");
    expect(unsafe.diagnostics.some((diagnostic) => diagnostic.message.includes("stay inside root"))).toBe(true);
  });

  it("rejects plugin paths whose realpath escapes through a symlink", async () => {
    const root = "/plugins/demo";
    const base = memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({
        plugins: [{ id: "demo", root, enabled: true }],
      }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({ name: "demo", skills: "./skills" }),
      [`${root}/skills/review/SKILL.md`]: "---\nname: review\ndescription: Review\n---\n",
    });
    const files: PluginFileAccess = {
      ...base,
      async realPath(path) {
        if (path === `${root}/skills`) return "/outside/skills";
        return path;
      },
    };

    const report = await scanKimiPlugins(files, "/home");

    expect(report.plugins[0].state).toBe("error");
    expect(report.skillRoots).toEqual([]);
  });

  it("reports malformed inventory records and duplicate plugin ids without hiding the valid entry", async () => {
    const root = "/plugins/demo";
    const report = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({
        version: 1,
        plugins: [42, { id: "demo", root }, { id: "demo", root }],
      }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({ name: "demo" }),
    }), "/home");

    expect(report.plugins).toHaveLength(1);
    expect(report.diagnostics.map((diagnostic) => diagnostic.message)).toEqual(expect.arrayContaining([
      "installed.json contains a non-object plugin record",
      "Duplicate installed plugin id: demo",
    ]));

    const missingArray = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({ version: 1 }),
    }), "/home");
    expect(missingArray.diagnostics[0].message).toContain("plugins array");
  });

  it("keeps manifest precedence diagnostics and rejects unsafe MCP paths and malformed capabilities", async () => {
    const root = "/plugins/broken";
    const report = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({
        version: 1,
        plugins: [{ id: "broken", root, capabilities: { mcpServers: { remote: { enabled: false } } } }],
      }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({
        name: "different",
        skills: ["./missing"],
        mcpServers: {
          absolute: { command: "/usr/bin/node" },
          missing: { command: "./missing.js" },
          cwd: { command: "node", cwd: "../outside" },
          remote: { url: "https://example.test/mcp", headers: { X_PLUGIN: "1" } },
        },
      }),
      [`${root}/.kimi-plugin/plugin.json`]: JSON.stringify({ name: "shadowed" }),
    }), "/home");

    expect(report.plugins[0].state).toBe("ok");
    expect(report.mcpServers["plugin-broken:remote"]).toMatchObject({
      enabled: false,
      transport: "streamable-http",
      headers: { X_PLUGIN: "1" },
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.message).join("\n")).toMatch(
      /shadowed|differs|does not exist|must be a PATH command|outside root or missing/,
    );
    expect(report.mcpServers["plugin-broken:absolute"]).toBeUndefined();
    expect(report.mcpServers["plugin-broken:missing"]).toBeUndefined();
    expect(report.mcpServers["plugin-broken:cwd"]).toBeUndefined();
  });

  it("marks invalid manifest shapes as errors", async () => {
    const root = "/plugins/invalid";
    const report = await scanKimiPlugins(memoryPluginFs({
      "/home/plugins/installed.json": JSON.stringify({ plugins: [{ id: "Invalid Id", root }] }),
      [`${root}/kimi.plugin.json`]: JSON.stringify({
        name: "Invalid Id",
        skills: 42,
        mcpServers: { remote: { url: "https://example.test/mcp" } },
      }),
    }), "/home");

    expect(report.plugins[0].state).toBe("error");
    expect(report.skillRoots).toEqual([]);
    expect(report.mcpServers).toEqual({});
    expect(report.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length).toBeGreaterThanOrEqual(3);
  });

  it("remaps managed roots when a KIMI_CODE_HOME is cloned", () => {
    const result = JSON.parse(remapInstalledPluginRoots(JSON.stringify({
      version: 1,
      plugins: [
        { id: "managed", root: "/old/plugins/managed/managed" },
        { id: "external", root: "/external/plugin" },
      ],
    }), "/old", "/new"));
    expect(result.plugins[0].root).toBe("/new/plugins/managed/managed");
    expect(result.plugins[1].root).toBe("/external/plugin");
    expect(() => remapInstalledPluginRoots("{}", "/old", "/new")).toThrow(/plugins array/);
  });

  it("remaps an absolute managed root even when the recorded source home uses tilde", () => {
    const result = JSON.parse(remapInstalledPluginRoots(JSON.stringify({
      version: 1,
      plugins: [{
        id: "demo",
        root: "/Users/alice/.kimi-code/plugins/managed/demo",
        source: "https://github.com/example/demo",
      }],
    }), "~/.kimi-code", "/new/home"));

    expect(result.plugins[0].root).toBe("/new/home/plugins/managed/demo");
  });
});
