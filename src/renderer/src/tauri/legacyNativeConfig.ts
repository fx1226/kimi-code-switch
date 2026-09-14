import { invoke } from "@tauri-apps/api/core";

export interface LegacyNativeEnvironmentConfig {
  providers: Record<string, unknown>;
  models: Record<string, unknown>;
  mcpServers: Record<string, unknown>;
}

export interface LegacyNativeConfigExport {
  environments: Record<string, LegacyNativeEnvironmentConfig>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Reads deprecated SQLite mirrors for one-time recovery; it never mutates them. */
export async function exportLegacyNativeConfig(): Promise<LegacyNativeConfigExport> {
  const document = await invoke<string>("export_legacy_native_config");
  const parsed = JSON.parse(document) as unknown;
  const rawEnvironments = asRecord(asRecord(parsed).environments);
  return {
    environments: Object.fromEntries(Object.entries(rawEnvironments).map(([environmentId, raw]) => {
      const entry = asRecord(raw);
      return [environmentId, {
        providers: asRecord(entry.providers),
        models: asRecord(entry.models),
        mcpServers: asRecord(entry.mcpServers),
      }];
    })),
  };
}

export async function clearRecoveredLegacyNativeConfig(environmentIds: string[]): Promise<void> {
  await invoke("clear_recovered_legacy_native_config", { environmentIds });
}
