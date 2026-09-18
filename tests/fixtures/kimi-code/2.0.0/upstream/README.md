# Official consumer sources for isolated verification

These unmodified files come from Moonshot AI's `kimi-code` repository at commit
`1b89e4b039f052d10f258464413b2047acca12ba` (CLI release `2.0.0`).
`sources.json` records each original repository path and SHA-256. The original
MIT license and copyright notice are preserved in `LICENSE`.

They are test fixtures only. Production code and packaging do not import this
directory. Run `node scripts/verify-kimi-native-consumption.mjs` from the project
root to verify their hashes, write isolated native files through this project's
configuration transaction service, and consume those files with the upstream
MCP loader, skill discovery/parser, and plugin manager/manifest parser.

The harness installs pinned `pathe`, `zod`, and `js-yaml` dependencies into a
temporary directory with lifecycle scripts disabled. It never installs them in
this project's `package.json` or `node_modules`. The temporary directory is
removed after success or failure.

The harness extracts the unchanged declarations for `resolveKimiHome`,
`resolvePath`, `isWindowsAbsolutePath`, `HookDefSchema`, and
`CONFIG_INVALID_ERROR_CODE`, omitting unrelated application startup and section
registration. It uses a no-op DI log decorator because only the standalone
skill discovery function is called. Its reduced error barrel uses the original
error classes and domains. Plugin archive/download/GitHub lookup functions
throw if called; only the original offline load/manifest/source/skill paths
are exercised. No MCP schema, skill parser, plugin manifest rule, or plugin
manager load/filter logic is replaced.

These checks establish the tested source functions' consumption of this
project's written files. They do not establish full CLI startup, live account
authentication, running MCP transports, plugin execution, or Desktop behavior.
