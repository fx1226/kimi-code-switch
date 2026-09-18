// Open Kimi through the macOS terminal using authorized server commands.
import { join } from "node:path";
import { invokeCommand as invoke } from "../native";
import { getAppPaths } from "../native/paths";

import {
  applyProfile,
  cloneState,
  DEFAULT_CONFIG_PATH,
  getActiveKimiCodeEnvironment,
} from "@shared/configStore";
import type { OpenKimiTerminalRequest, PanelSettings, TerminalApp } from "@shared/types";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(program: string, args: string[]): Promise<ExecResult> {
  return invoke<ExecResult>("exec_command", { program, args, timeoutMs: null });
}

function resolveHome(p: string): string {
  return p;
}

function dirname(p: string): string {
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? p : p.slice(0, i);
}

const TERMINAL_APP_NAMES: Record<TerminalApp, string> = { "system-terminal": "Terminal", iterm2: "iTerm" };
const TERMINAL_APP_LABELS: Record<TerminalApp, string> = { "system-terminal": "Terminal.app", iterm2: "iTerm2" };

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
function quotePathForShell(value: string): string {
  if (value === "~") {
    return "$HOME";
  }
  if (value.startsWith("~/")) {
    return `$HOME/${quoteForShell(value.slice(2))}`;
  }
  return quoteForShell(value);
}
function escapeForAppleScript(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function buildKimiShellCommand(workingDirectory: string, homePath: string, args: string[] = []): string {
  // The native command executor supplies PATH.
  const kimiArgs = args.length ? ` ${args.map(quoteForShell).join(" ")}` : "";
  return `export KIMI_CODE_HOME=${quotePathForShell(homePath)}; cd ${quotePathForShell(workingDirectory)}; kimi${kimiArgs}`;
}

function buildAppleScriptLines(app: TerminalApp, shellCommand: string, scriptPath?: string): string[] {
  const escaped = escapeForAppleScript(shellCommand);
  if (app === "system-terminal") {
    return ['tell application "Terminal"', "activate", `do script "${escaped}"`, "end tell"];
  }
  const textToWrite = scriptPath ? escapeForAppleScript(`source ${quoteForShell(scriptPath)}`) : escaped;
  return [
    'tell application "iTerm"', "activate",
    "if (count of windows) = 0 then", "create window with default profile",
    "else", "tell current window", "create tab with default profile", "end tell", "end if",
    "tell current session of current window", `write text "${textToWrite}"`, "end tell", "end tell",
  ];
}

function appleScriptArgs(lines: string[]): string[] {
  return lines.flatMap((line) => ["-e", line]);
}

function buildProfileKimiArgs(request: OpenKimiTerminalRequest, profileName: string): string[] {
  if (!request.state) throw new Error("Profile launch requires the current app state.");
  if (!request.state.profiles[profileName]) throw new Error(`Profile not found: ${profileName}`);
  const draft = cloneState(request.state);
  applyProfile(draft, profileName);
  const args: string[] = [];
  if (draft.mainConfig.default_model.trim()) {
    args.push("-m", draft.mainConfig.default_model.trim());
  }
  // 0.38.0 权限模式：yolo -> --yolo，auto -> --auto，manual 不传
  const mode = draft.mainConfig.default_permission_mode || "manual";
  if (mode === "yolo") {
    args.push("--yolo");
  } else if (mode === "auto") {
    args.push("--auto");
  }
  if (draft.mainConfig.default_plan_mode) {
    args.push("--plan");
  }
  return args;
}

export async function openKimiInTerminal(
  request: Pick<PanelSettings, "config_path" | "terminal_app" | "kimi_code_environments" | "active_kimi_code_environment_id"> | OpenKimiTerminalRequest,
): Promise<{ ok: true }> {
  const settings = "settings" in request ? request.settings : request;
  const targetProfileName = "settings" in request ? request.profileName?.trim() : "";
  const activeEnvironment = getActiveKimiCodeEnvironment(settings);
  const homePath = activeEnvironment.homePath.trim() || dirname(resolveHome(settings.config_path.trim() || DEFAULT_CONFIG_PATH));
  const workingDirectory = activeEnvironment.workingDirectory?.trim() || homePath;
  const kimiArgs = targetProfileName ? buildProfileKimiArgs(request as OpenKimiTerminalRequest, targetProfileName) : [];
  const shellCommand = buildKimiShellCommand(workingDirectory, homePath, kimiArgs);

  await launchShellCommandInTerminal(settings.terminal_app, shellCommand);
  return { ok: true };
}

async function launchShellCommandInTerminal(
  terminalApp: TerminalApp,
  shellCommand: string,
): Promise<void> {
  const appName = TERMINAL_APP_NAMES[terminalApp];
  const appLabel = TERMINAL_APP_LABELS[terminalApp];
  const probe = await exec("open", ["-Ra", appName]);
  if (probe.code !== 0) throw new Error(`Configured terminal app is not installed: ${appLabel}`);

  let scriptPath: string | undefined;
  if (terminalApp === "iterm2") {
    scriptPath = join(getAppPaths().tmpDir, "terminal", "kimi-launch.sh");
    await invoke("write_executable", { path: scriptPath, content: `#!/bin/sh\n${shellCommand}\n` });
  }

  const lines = buildAppleScriptLines(terminalApp, shellCommand, scriptPath);
  const r = await exec("osascript", appleScriptArgs(lines));
  if (r.code !== 0) throw new Error(`Failed to launch terminal app: ${r.stderr}`);
}

export async function openKimiMcpLoginInTerminal(
  serverName: string,
  settings: PanelSettings,
): Promise<{ ok: true }> {
  // Kimi 0.38 exposes MCP OAuth through a structured SDK RPC, not a CLI
  // subcommand. Until that RPC is supported here, open an interactive Kimi
  // session and never interpolate the untrusted server name into a `kimi -p`
  // model turn.
  void serverName;
  const activeEnvironment = getActiveKimiCodeEnvironment(settings);
  const homePath = activeEnvironment.homePath.trim() || dirname(resolveHome(settings.config_path.trim() || DEFAULT_CONFIG_PATH));
  const workingDirectory = activeEnvironment.workingDirectory?.trim() || homePath;
  const shellCommand = buildKimiShellCommand(workingDirectory, homePath, []);
  await launchShellCommandInTerminal(settings.terminal_app, shellCommand);
  return { ok: true };
}

/** Kimi Code 2.0 registers `login` as an official CLI subcommand. */
export async function openKimiLoginInTerminal(settings: PanelSettings): Promise<{ ok: true }> {
  const activeEnvironment = getActiveKimiCodeEnvironment(settings);
  const homePath = activeEnvironment.homePath.trim() || dirname(settings.config_path.trim() || DEFAULT_CONFIG_PATH);
  const workingDirectory = activeEnvironment.workingDirectory?.trim() || homePath;
  await launchShellCommandInTerminal(settings.terminal_app, buildKimiShellCommand(workingDirectory, homePath, ["login"]));
  return { ok: true };
}
