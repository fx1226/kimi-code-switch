// Offline native-consumption checks after installing three pinned dependencies
// into a disposable directory. Upstream business logic is source-pinned and
// vendored with its original MIT license; production bundles do not import it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixtures = path.join(repository, "tests/fixtures/kimi-code/2.0.0");
const upstream = path.join(fixtures, "upstream");
const core = path.join(upstream, "packages/agent-core-v2/src");
const commit = "1b89e4b039f052d10f258464413b2047acca12ba";
const dependencies = ["pathe@2.0.3", "zod@4.3.6", "js-yaml@4.1.1"];

function environment(root) {
  const env = {};
  for (const key of ["PATH", "LANG", "LC_ALL", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP"]) {
    env[key] = path.join(root, key.toLowerCase());
  }
  env.KIMI_CODE_HOME = path.join(root, "native");
  env.npm_config_cache = path.join(root, "npm-cache");
  env.npm_config_userconfig = path.join(root, "empty-npmrc");
  env.npm_config_globalconfig = path.join(root, "empty-global-npmrc");
  return env;
}

// Preserve selected upstream declarations byte-for-byte. This removes unused
// bootstrap/DI or TOML-registration wiring, not resolver/schema implementation.
function selectSource(source, names, imports) {
  const tree = ts.createSourceFile("upstream.ts", source, ts.ScriptTarget.Latest, true);
  const found = new Set();
  const statements = tree.statements.filter((node) => {
    if (ts.isImportDeclaration(node)) return imports.includes(node.moduleSpecifier.text);
    const declared = ts.isVariableStatement(node)
      ? node.declarationList.declarations.map((entry) => entry.name.getText(tree))
      : node.name ? [node.name.getText(tree)] : [];
    if (!declared.some((name) => names.includes(name))) return false;
    declared.forEach((name) => found.add(name));
    return true;
  });
  for (const name of names) assert(found.has(name), `Missing upstream declaration: ${name}`);
  return statements.map((node) => node.getFullText(tree)).join("\n");
}

async function runConsumption(api, root, fixtureRoot) {
  const { fs, path, assert, local, official } = api;
  const home = path.join(root, "native");
  const project = path.join(root, "project");
  const cwd = path.join(project, "packages/app");
  const privateDir = path.join(root, "switch");
  await fs.mkdir(path.join(project, ".git"), { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  local.configureAppPaths({ dataDir: privateDir });
  for (const directory of [path.join(project, ".kimi-code"), path.join(cwd, ".kimi-code")]) {
    local.registerDurableGrant(directory, "DirectoryTree", "managed-root");
  }
  local.registerDurableGrant(path.join(project, ".mcp.json"), "File", "managed-root");
  const service = local.createConfigurationService({ dataDir: privateDir });
  const context = { home, projectRoot: project, workingDirectory: cwd };
  let writes = 0;
  async function commitPlan(plan) {
    const operation = await service.commit(plan.id, { expectedRevision: plan.expectedRevision });
    assert.equal(operation.status, "succeeded", JSON.stringify({ resource: plan.resource, diagnostics: operation.diagnostics }));
    writes++;
  }
  async function setMcp(resource, servers) {
    const current = await service.read(context, resource);
    await commitPlan(await service.plan(context, { resource, expectedRevision: current.revision,
      changes: [{ op: "set", path: ["mcpServers"], value: servers }] }));
  }
  const http = (source) => ({ transport: "http", url: `https://${source}.invalid/mcp` });
  await setMcp("mcp", { shared: http("user"), userOnly: http("user-only") });
  await setMcp("mcp-project", { shared: http("project"), rootOnly: { command: "echo", args: ["inert"], cwd: "./tools" } });
  await setMcp("mcp-local", { shared: http("local"), localOnly: http("local-only") });
  const hostFs = {
    readText: (file) => fs.readFile(file, "utf8"),
    stat: async (file) => { const value = await fs.stat(file); return { isDirectory: value.isDirectory(), isFile: value.isFile() }; },
  };
  const mcp = await official.loadMcpServersDetailed({ fs: hostFs, cwd });
  assert.equal(mcp.servers.shared.url, "https://local.invalid/mcp");
  assert.equal(mcp.origins.shared, path.join(cwd, ".kimi-code/mcp.json"));
  assert.equal(mcp.origins.rootOnly, path.join(project, ".mcp.json"));
  assert.equal(mcp.servers.rootOnly.transport, "stdio");
  assert.equal(mcp.servers.rootOnly.cwd, path.join(project, "tools"));
  assert.equal(mcp.origins.userOnly, path.join(home, "mcp.json"));
  const userOnly = await official.loadMcpServersDetailed({ fs: hostFs, cwd, includeProject: false });
  assert.equal(userOnly.servers.shared.url, "https://user.invalid/mcp");
  assert.equal(userOnly.servers.rootOnly, undefined);
  const noGit = path.join(root, "no-git");
  await fs.mkdir(noGit);
  assert.equal((await official.resolveMcpJsonPaths({ fs: hostFs, cwd: noGit })).projectRoot, path.join(noGit, ".mcp.json"));
  assert.throws(() => official.McpServerConfigSchema.parse({ command: "echo", startupTimeoutMs: 0 }));
  assert.throws(() => official.McpServerConfigSchema.parse({ url: "invalid-url" }));

  // Seed existing files directly, then consume only the output of real local
  // transactions. Every fixture has its own native home inside this temp root.
  async function mcpFixture(name, source) {
    const fixtureHome = path.join(root, "mcp-regressions", name);
    await fs.mkdir(fixtureHome, { recursive: true });
    local.registerDurableGrant(fixtureHome, "DirectoryTree", "managed-root");
    const file = path.join(fixtureHome, "mcp.json");
    await fs.writeFile(file, source);
    return { file, context: { home: fixtureHome },
      load: () => official.loadMcpServersDetailed({ fs: hostFs, cwd: noGit, homeDir: fixtureHome, includeProject: false }) };
  }
  const retainedFragments = [
    '"command" : "echo"',
    '"args": ["never-executed"]',
    '"type" : "vendor-extension"',
    '"vendor" : { "scale": 1e+02, "enabled": true }',
  ];
  const switchSource = '{\n  "mcpServers": {\n    "switchable": {\n      '
    + retainedFragments.join(',\n      ') + '\n    }\n  }\n}\n';
  const switchedFixture = await mcpFixture("transport-switch", switchSource);
  assert.equal((await switchedFixture.load()).servers.switchable.transport, "stdio");
  const switchBefore = await service.read(switchedFixture.context, "mcp");
  assert.equal(await fs.readFile(switchedFixture.file, "utf8"), switchSource);
  await commitPlan(await service.plan(switchedFixture.context, { resource: "mcp", expectedRevision: switchBefore.revision,
    changes: [
      { op: "set", path: ["mcpServers", "switchable", "transport"], value: "http" },
      { op: "set", path: ["mcpServers", "switchable", "url"], value: "https://switched.invalid/mcp" },
    ] }));
  const switchAfter = await fs.readFile(switchedFixture.file, "utf8");
  for (const fragment of retainedFragments) assert(switchAfter.includes(fragment), `Existing MCP field was rewritten: ${fragment}`);
  assert.deepEqual(JSON.parse(switchAfter).mcpServers.switchable, {
    ...JSON.parse(switchSource).mcpServers.switchable, transport: "http", url: "https://switched.invalid/mcp",
  });
  const switched = await switchedFixture.load();
  assert.equal(switched.origins.switchable, switchedFixture.file);
  assert.deepEqual(switched.servers.switchable, { transport: "http", url: "https://switched.invalid/mcp" });

  for (const [name, source] of [["empty", ""], ["whitespace", " \n\t\r\n"]]) {
    const blankFixture = await mcpFixture(name, source);
    assert.deepEqual((await blankFixture.load()).servers, {});
    const current = await service.read(blankFixture.context, "mcp");
    assert.equal(await fs.readFile(blankFixture.file, "utf8"), source);
    await commitPlan(await service.plan(blankFixture.context, { resource: "mcp", expectedRevision: current.revision,
      changes: [{ op: "set", path: ["mcpServers", "added"], value: http(name) }] }));
    const added = await blankFixture.load();
    assert.equal(added.origins.added, blankFixture.file);
    assert.deepEqual(added.servers.added, http(name));
  }

  function directoryContent(files) {
    const directories = new Set();
    for (const filename of Object.keys(files)) {
      const parts = filename.split("/");
      for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
    }
    return local.portableContent(JSON.stringify({ exists: true, directories: [...directories],
      files: Object.entries(files).map(([relativePath, content]) => ({ relativePath, contentBase64: Buffer.from(content).toString("base64"), executable: false })) }));
  }
  async function restoreDirectory(ctx, resource, files) {
    const current = await service.read(ctx, resource);
    await commitPlan(await service.planRestore(ctx, [{ resource, expectedRevision: current.revision, content: directoryContent(files) }]));
  }
  const review = await fs.readFile(path.join(fixtureRoot, "skills/review-pr/SKILL.md"), "utf8");
  const flat = await fs.readFile(path.join(fixtureRoot, "skills/commit.md"), "utf8");
  await restoreDirectory(context, "skills-directory", { "review-pr/SKILL.md": review, "commit.md": flat,
    "shared.md": "User scope body.\n" });
  const projectHome = path.join(project, ".kimi-code");
  await restoreDirectory({ home: projectHome }, "skills-directory", { "shared.md": "Project scope body.\n" });
  const discovered = await official.discoverFileSkills([
    { path: path.join(projectHome, "skills"), source: "project" },
    { path: path.join(home, "skills"), source: "user" },
  ]);
  assert(discovered.skills.some((skill) => skill.name === "review-pr" && skill.source === "user"));
  assert(discovered.skills.some((skill) => skill.name === "commit" && skill.source === "user"));
  const shared = discovered.skills.filter((skill) => skill.name === "shared");
  assert.equal(shared.length, 1);
  assert.equal(shared[0].source, "project");
  assert.equal(shared[0].content, "Project scope body.");
  assert.throws(() => official.parseSkillText({ skillMdPath: path.join(root, "bad/SKILL.md"), skillDirName: "bad", source: "user", text: "No frontmatter" }));

  const pluginRoot = path.join(home, "plugins/managed/consumption-plugin");
  const disabledRoot = path.join(home, "plugins/managed/disabled-plugin");
  const record = { id: "consumption-plugin", root: pluginRoot, source: "github", enabled: true,
    installedAt: "2026-09-18T00:00:00.000Z", originalSource: "https://github.com/example/fixture",
    github: { owner: "example", repo: "fixture", ref: { kind: "sha", value: "1111111111111111111111111111111111111111" }, installedSha: "1111111111111111111111111111111111111111" } };
  const installed = local.applyDocumentPatch("json", "{}\n", [
    { op: "set", path: ["version"], value: 1 },
    { op: "set", path: ["plugins"], value: [record, { ...record, id: "disabled-plugin", root: disabledRoot, source: "local-path", enabled: false, originalSource: disabledRoot, github: undefined }] },
  ].map((edit) => JSON.parse(JSON.stringify(edit)))).content;
  const manifest = local.applyDocumentPatch("json", "{}\n", [
    { op: "set", path: ["name"], value: "consumption-plugin" },
    { op: "set", path: ["skills"], value: ["./skills"] },
    { op: "set", path: ["mcpServers"], value: { inert: { transport: "stdio", command: "echo", args: ["never-executed"] } } },
  ]).content;
  const disabledManifest = local.applyDocumentPatch("json", manifest, [{ op: "set", path: ["name"], value: "disabled-plugin" }]).content;
  await restoreDirectory(context, "plugins-directory", {
    "installed.json": installed,
    "managed/consumption-plugin/kimi.plugin.json": manifest,
    "managed/consumption-plugin/skills/check.md": "Plugin fixture skill.\n",
    "managed/disabled-plugin/kimi.plugin.json": disabledManifest,
    "managed/disabled-plugin/skills/check.md": "Disabled fixture skill.\n",
  });
  const manager = new official.PluginManager({ kimiHomeDir: home });
  await manager.load();
  const info = manager.info("consumption-plugin");
  assert.equal(info.state, "ok");
  assert.equal(info.root, pluginRoot);
  assert.equal(info.source, "github");
  assert.equal(info.originalSource, record.originalSource);
  assert.deepEqual(info.github, record.github);
  assert.equal(info.skillCount, 1);
  assert.equal(info.manifestPath, path.join(pluginRoot, "kimi.plugin.json"));
  assert.equal(manager.info("disabled-plugin").enabled, false);
  assert.deepEqual(manager.pluginSkillRoots().map((entry) => entry.plugin.id), ["consumption-plugin"]);
  const pluginMcp = manager.enabledMcpServers();
  assert.deepEqual(Object.keys(pluginMcp), ["plugin-consumption-plugin:inert"]);
  assert.equal(pluginMcp["plugin-consumption-plugin:inert"].env.KIMI_PLUGIN_ROOT, pluginRoot);
  assert.equal(pluginMcp["plugin-consumption-plugin:inert"].env.KIMI_CODE_HOME, home);
  assert.equal(pluginMcp["plugin-consumption-plugin:inert"].cwd, pluginRoot);
  const pluginSkills = await official.discoverFileSkills(manager.pluginSkillRoots());
  assert.equal(pluginSkills.skills[0].plugin.id, "consumption-plugin");

  // Negative samples are separate temporary files; the manager never installs,
  // executes a command, contacts GitHub, or invokes an MCP transport.
  const outside = path.join(root, "outside");
  const badRoot = path.join(root, "invalid-plugin");
  await fs.mkdir(outside);
  await fs.mkdir(badRoot);
  await fs.symlink(outside, path.join(badRoot, "escape"), "dir");
  await fs.writeFile(path.join(badRoot, "kimi.plugin.json"), JSON.stringify({ name: "bad-plugin", skills: ["./escape"] }));
  const bad = await official.parseManifest(badRoot);
  assert(bad.diagnostics.some((item) => item.severity === "error" && item.message.includes("outside")));
  assert.deepEqual(bad.manifest.skills, []);
  const fallback = path.join(root, "fallback-plugin");
  await fs.mkdir(path.join(fallback, ".kimi-plugin"), { recursive: true });
  await fs.writeFile(path.join(fallback, ".kimi-plugin/plugin.json"), '{"name":"fallback-plugin"}');
  assert.equal((await official.parseManifest(fallback)).manifestKind, "kimi-plugin-dir");
  await fs.writeFile(path.join(fallback, "kimi.plugin.json"), '{"name":"root-plugin"}');
  const shadowed = await official.parseManifest(fallback);
  assert.equal(shadowed.manifest.name, "root-plugin");
  assert.equal(shadowed.shadowedManifestPath, path.join(fallback, ".kimi-plugin/plugin.json"));
  assert.deepEqual(official.resolveInstallSource(record.originalSource), { kind: "github", owner: "example", repo: "fixture" });
  assert.throws(() => official.resolveInstallSource("relative/plugin"));
  return { result: "passed", nativeTransactions: writes,
    mcp: { layeredOrigins: true, projectRootCwd: true, userOnly: true, invalidSchemaRejected: true,
      implicitStdioToHttp: true, inactiveAndUnknownFieldsPreserved: true, emptyFileAddition: true, whitespaceFileAddition: true },
    skills: { directoryAndFlat: true, projectPriority: true, malformedRejected: true },
    plugins: { managerLoad: true, sourceMetadata: true, manifestPaths: true, disabledFiltering: true, symlinkEscapeRejected: true },
    limitations: ["Official source consumer functions, not full CLI/Desktop startup.", "Dependency injection adapters and disabled install/update network paths are described in the contract document.", "No model request, MCP process, plugin code, or account data was used."] };
}

async function main() {
  const inventory = JSON.parse(await fs.readFile(path.join(upstream, "sources.json"), "utf8"));
  assert.equal(inventory.commit, commit);
  for (const entry of inventory.files) {
    assert.equal(createHash("sha256").update(await fs.readFile(path.join(upstream, entry.path))).digest("hex"), entry.sha256, `Upstream source changed: ${entry.path}`);
  }
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "kimi-consumption-")));
  const env = environment(root);
  let result;
  try {
    for (const [key, value] of Object.entries(env)) {
      if (["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "KIMI_CODE_HOME"].includes(key)) await fs.mkdir(value, { recursive: true });
    }
    await fs.writeFile(env.npm_config_userconfig, "");
    await fs.writeFile(env.npm_config_globalconfig, "");
    const dependencyDir = path.join(root, "dependencies");
    await fs.mkdir(dependencyDir);
    await fs.writeFile(path.join(dependencyDir, "package.json"), '{"private":true}');
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--prefix", dependencyDir, "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...dependencies],
      { cwd: root, env, timeout: 120_000, stdio: "pipe" });
    const outfile = path.join(root, "verify.mjs");
    const entry = `import fs from 'node:fs/promises'; import path from 'node:path'; import assert from 'node:assert/strict';
      import * as official from 'official-entry'; import * as local from 'local-entry';
      const result = await (${runConsumption.toString()})({fs,path,assert,official,local}, ${JSON.stringify(root)}, ${JSON.stringify(fixtures)});
      console.log(JSON.stringify(result));`;
    const adapters = {
      "official-entry": `export * from '#/app/mcpConfig/configLoader'; export * from '#/mcpCore/config-schema'; export * from '#/features/skill/catalog/fileSkillDiscovery'; export * from '#/features/skill/catalog/parser'; export * from '#/app/plugin/manager'; export * from '#/app/plugin/manifest'; export * from '#/app/plugin/source';`,
      "local-entry": `export * from ${JSON.stringify(path.join(repository, "src/server/configuration/index.ts"))}; export * from ${JSON.stringify(path.join(repository, "src/server/configuration/portable.ts"))}; export * from ${JSON.stringify(path.join(repository, "src/server/native/paths.ts"))}; export {registerDurableGrant} from ${JSON.stringify(path.join(repository, "src/server/native/fs.ts"))}; export {applyDocumentPatch} from ${JSON.stringify(path.join(repository, "src/shared/documentPatch.ts"))};`,
      "errors": `export * from '#/_base/errors/errors'; export {PluginErrors} from '#/app/plugin/errors'; import {CoreErrors} from '#/_base/errors/codes'; import {ConfigErrors} from '#/app/config/errors'; import {PluginErrors} from '#/app/plugin/errors'; export const ErrorCodes = {...CoreErrors.codes,...ConfigErrors.codes,...PluginErrors.codes};`,
      "log": "export const ILogService = () => {};",
      "network-disabled": "const unavailable = () => { throw new Error('Install/update network path is disabled by the isolated harness'); }; export const downloadZip=unavailable, extractZip=unavailable, resolveGithubCommitSha=unavailable, resolveGithubSource=unavailable;",
    };
    await build({ stdin: { contents: entry, resolveDir: repository, sourcefile: "native-consumption.ts" }, bundle: true,
      platform: "node", format: "esm", target: "node22", outfile, nodePaths: [path.join(dependencyDir, "node_modules")],
      banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
      tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
      plugins: [{ name: "pinned-official-consumers", setup(builder) {
        builder.onResolve({ filter: /^(official-entry|local-entry)$/ }, (args) => ({ path: args.path, namespace: "harness" }));
        builder.onResolve({ filter: /^#\// }, (args) => {
          if (args.path === "#/errors") return { path: "errors", namespace: "harness" };
          if (args.path === "#/_base/log/log") return { path: "log", namespace: "harness" };
          return { path: path.join(core, args.path.slice(2) + ".ts") };
        });
        builder.onResolve({ filter: /^\.\/(archive|github-resolver)$/ }, (args) => args.importer.startsWith(core) ? { path: "network-disabled", namespace: "harness" } : undefined);
        builder.onResolve({ filter: /^@shared\// }, (args) => ({ path: path.join(repository, "src/shared", args.path.slice(8) + ".ts") }));
        builder.onLoad({ filter: /.*/, namespace: "harness" }, (args) => ({ contents: adapters[args.path], loader: "ts", resolveDir: core }));
        builder.onLoad({ filter: /\.ts$/ }, async (args) => {
          if (!args.path.startsWith(core)) return undefined;
          const source = await fs.readFile(args.path, "utf8");
          const rel = path.relative(core, args.path).replaceAll(path.sep, "/");
          let contents = source;
          if (rel === "app/bootstrap/bootstrap.ts") contents = selectSource(source, ["resolveKimiHome"], ["node:os", "pathe"]);
          if (rel === "_base/utils/paths.ts") contents = selectSource(source, ["isWindowsAbsolutePath", "resolvePath"], ["node:path", "pathe"]);
          if (rel === "features/externalHooks/configSection.ts") contents = selectSource(source, ["HookDefSchema"], ["zod", "./internal/types"]);
          if (rel === "llm-adapter/contract/errors.ts") contents = selectSource(source, ["CONFIG_INVALID_ERROR_CODE"], []);
          return { contents, loader: "ts", resolveDir: path.dirname(args.path) };
        });
      } }],
    });
    const output = execFileSync(process.execPath, [outfile], { cwd: root, env, encoding: "utf8", timeout: 30_000, maxBuffer: 1_000_000 });
    result = { ...JSON.parse(output.trim()), releaseCommit: commit, verifiedSourceFiles: inventory.files.length, dependencies };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ ...result, temporaryFilesRemoved: true }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
