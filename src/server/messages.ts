/** CLI diagnostics never print raw subprocess errors, URLs or user-supplied values. */
export function serverFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("legacy kimi-code-switch-gui is running")) return "legacy kimi-code-switch-gui is running; close it before continuing";
  if (message.startsWith("legacy desktop process is running")) return "legacy desktop process is running; close it before continuing";
  if (message.startsWith("another server instance is running")) return "another server instance is running; use kimi-code-switch open or status";
  if (message.includes("server identity") || message.includes("active lock")) return "server identity could not be verified; no process was stopped";
  if (message.startsWith("server is still shutting down")) return "server is still shutting down; no force signal was sent";
  if (message.startsWith("no available port")) return "no available local port; choose another --port";
  if (message.startsWith("unknown option:") || message.startsWith("missing value for") || message.startsWith("invalid port:") || message.includes("does not take a value")) return "invalid command arguments; run kimi-code-switch --help";
  if (message.startsWith("--data-dir must name")) return "--data-dir must name a private application directory, not a home or system root";
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (code === "EACCES" || code === "EPERM") return "permission denied; check access to the private directory and local networking";
  return "kimi-code-switch could not complete the operation; check the private directory and local service state";
}
