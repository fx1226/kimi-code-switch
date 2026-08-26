import parseToml from "@iarna/toml/parse-string.js";
import stringifyToml from "@iarna/toml/stringify.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCredentialFields(entry: Record<string, unknown>): Record<string, unknown> {
  const next = { ...entry };
  for (const key of ["api_key", "oauth", "env", "custom_headers"]) delete next[key];
  return next;
}

export function sanitizeConfigForEnvironmentClone(document: string): string {
  const parsed = parseToml(document) as Record<string, unknown>;
  const next = { ...parsed };
  if (isRecord(parsed.providers)) {
    next.providers = Object.fromEntries(
      Object.entries(parsed.providers).map(([name, value]) => [
        name,
        isRecord(value) ? stripCredentialFields(value) : value,
      ]),
    );
  }
  if (isRecord(parsed.models)) {
    next.models = Object.fromEntries(
      Object.entries(parsed.models).map(([name, value]) => [
        name,
        isRecord(value) ? stripCredentialFields(value) : value,
      ]),
    );
  }
  if (isRecord(parsed.services)) {
    next.services = Object.fromEntries(
      Object.entries(parsed.services).map(([name, value]) => [
        name,
        isRecord(value) ? stripCredentialFields(value) : value,
      ]),
    );
  }
  return stringifyToml(next);
}

export function sanitizeMcpForEnvironmentClone(document: string): string {
  const parsed = JSON.parse(document) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
    throw new Error("Invalid MCP config: expected an object with mcpServers.");
  }
  const servers = Object.fromEntries(
    Object.entries(parsed.mcpServers).map(([name, value]) => {
      if (!isRecord(value)) return [name, value];
      const next = { ...value };
      for (const key of ["headers", "env", "bearerTokenEnvVar"]) delete next[key];
      return [name, next];
    }),
  );
  return `${JSON.stringify({ ...parsed, mcpServers: servers }, null, 2)}\n`;
}
