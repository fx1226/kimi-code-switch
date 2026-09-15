// ChatGPT 订阅桥接：Tauri 命令适配器（薄壳，只做类型化 invoke）。
import { invoke } from "@tauri-apps/api/core";

export interface BridgeTokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  account_id?: string;
  issued_at?: string;
}

export interface BridgeAuthState {
  status: "signed-in" | "signed-out";
  tokens?: BridgeTokenSet;
  mode?: string;
  error?: string;
}

export interface BridgeCatalogModel {
  slug: string;
  display_name?: string;
  context_window?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: Array<{ effort?: string }>;
}

export interface BridgeCatalog {
  models: BridgeCatalogModel[];
  live: boolean;
  fetched_at: number;
}

export interface BridgeStatusResult {
  running: boolean;
  port: number;
  auth: BridgeAuthState;
  catalog: BridgeCatalog | null;
  ok: boolean;
}

export function bridgeStart(port: number, secret: string, stateDir?: string): Promise<BridgeStatusResult> {
  return invoke<BridgeStatusResult>("bridge_start", { port, secret, stateDir: stateDir ?? null });
}

export function bridgeStop(): Promise<void> {
  return invoke<void>("bridge_stop");
}

export function bridgeStatus(): Promise<BridgeStatusResult> {
  return invoke<BridgeStatusResult>("bridge_status");
}

export function bridgeLogin(redirectPort: number): Promise<{ url: string; wait: boolean }> {
  return invoke<{ url: string; wait: boolean }>("bridge_login", { redirectPort });
}

export function bridgeWaitLogin(): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>("bridge_wait_login");
}

export function bridgeLogout(): Promise<void> {
  return invoke<void>("bridge_logout");
}

export function bridgeRefreshModels(): Promise<BridgeCatalog> {
  return invoke<BridgeCatalog>("bridge_refresh_models");
}

export interface ProbeResult {
  reachable: boolean;
  authorized: boolean;
  status: number;
  models?: BridgeCatalog;
}

/** 受限连通性探针：仅允许 127.0.0.1 + 显式端口。 */
export function bridgeProbeConnectivity(port: number, secret: string): Promise<ProbeResult> {
  return invoke<ProbeResult>("bridge_probe_connectivity", { port, secret });
}

export const BRIDGE_OAUTH_REDIRECT_PORT = 1455;
