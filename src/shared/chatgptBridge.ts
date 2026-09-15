/**
 * ChatGPT 订阅桥接：GUI 侧的绑定数据契约与纯逻辑。
 *
 * 职责边界：
 * - 描述“当前 Kimi 环境 ↔ 本地桥接”的绑定（provider/model/profile 由本功能实际创建的条目）。
 * - 由账号模型目录生成 provider/model 配置（复用 configStore 的 upsert* 写入）。
 * - 解除绑定时按真实引用保留条目，绝不按 `chatgpt/*` 前缀批量接管或删除。
 *
 * OAuth token 不进入本模块任何字段；它们由 Rust 宿主经系统凭据存储管理。
 * 本地桥接 secret（loopback 随机密钥）属于绑定字段，导出/备份时需脱敏。
 */
import type { AppState, ModelConfig, ProviderConfig } from "./types";
import { getModelReferences } from "./configRelations";

export const BRIDGE_PROVIDER_DEFAULT_NAME = "chatgpt-bridge";
export const BRIDGE_MODEL_NAMESPACE = "chatgpt";

export interface ChatgptBridgeBinding {
  /** 绑定的 Kimi Code 环境 id（默认 "default"）。 */
  environmentId: string;
  /** GUI 实际创建的 provider 名（createUniqueName 去重后的精确名）。 */
  providerName: string;
  /** GUI 实际创建的模型键（完整 key，如 "chatgpt/gpt-mock-pro"）。 */
  modelAliases: string[];
  /** GUI 实际创建的 profile 名（可选）。 */
  profileName?: string;
  /** 本地桥接监听端口。 */
  bridgePort: number;
  /** 本地桥接访问密钥（loopback 随机值，非 OpenAI token；导出需脱敏）。 */
  bridgeSecret: string;
  createdAt: string;
  lastVerifiedAt?: string;
  lastVerifiedOk?: boolean;
}

/** 绑定以环境 id 为键存储在 panel settings。 */
export function getBindingForEnvironment(
  state: AppState,
  environmentId: string,
): ChatgptBridgeBinding | undefined {
  return state.panelSettings.chatgpt_bridge_bindings?.[environmentId];
}

export function setBindingForEnvironment(
  state: AppState,
  environmentId: string,
  binding: ChatgptBridgeBinding,
): void {
  const bindings = { ...(state.panelSettings.chatgpt_bridge_bindings ?? {}) };
  bindings[environmentId] = binding;
  state.panelSettings.chatgpt_bridge_bindings = bindings;
}

export function removeBindingForEnvironment(
  state: AppState,
  environmentId: string,
): ChatgptBridgeBinding | undefined {
  const bindings = { ...(state.panelSettings.chatgpt_bridge_bindings ?? {}) };
  const removed = bindings[environmentId];
  if (removed) delete bindings[environmentId];
  state.panelSettings.chatgpt_bridge_bindings = bindings;
  return removed;
}

/** 从账号模型目录生成 provider 配置（openai_responses，指向本地桥接）。 */
export function buildBridgeProviderConfig(binding: {
  bridgePort: number;
  bridgeSecret: string;
}): ProviderConfig {
  return {
    type: "openai_responses",
    base_url: `http://127.0.0.1:${binding.bridgePort}/v1`,
    api_key: binding.bridgeSecret,
    model_source: "oauth-catalog",
  };
}

export function bridgeModelKey(slug: string): string {
  return `${BRIDGE_MODEL_NAMESPACE}/${slug}`;
}

/** 从账号模型目录生成模型配置；只声明已确认的能力。 */
export function buildBridgeModelConfig(
  providerName: string,
  slug: string,
  catalogModel: {
    display_name?: string;
    context_window?: number;
    input_modalities?: string[];
    supported_reasoning_levels?: Array<{ effort?: string }>;
  },
): ModelConfig {
  const capabilities = ["tool_use"];
  if (catalogModel.supported_reasoning_levels?.length) capabilities.push("thinking");
  if (catalogModel.input_modalities?.includes("image")) capabilities.push("image_in");
  const efforts = (catalogModel.supported_reasoning_levels ?? [])
    .map((level) => level.effort)
    .filter((effort): effort is string => typeof effort === "string");
  const config: ModelConfig = {
    provider: providerName,
    model: slug,
    max_context_size: catalogModel.context_window && catalogModel.context_window > 0 ? catalogModel.context_window : 128000,
    capabilities,
  };
  if (catalogModel.display_name) config.display_name = catalogModel.display_name;
  if (efforts.length > 0) {
    config.support_efforts = efforts;
    config.default_effort = efforts[efforts.length - 1];
  }
  return config;
}

export interface BridgeDiff {
  /** 需要新增的 (alias, ModelConfig) 列表。 */
  add: Array<{ alias: string; model: ModelConfig }>;
  /** 目录中已不存在、但尚未被引用，可安全移除的别名。 */
  staleUnreferenced: string[];
  /** 目录中已不存在、但仍被 profile 引用的别名（保留并提醒）。 */
  staleReferenced: string[];
}

/** 计算把账号目录应用到当前状态时需要的增删；不做实际写入。 */
export function diffCatalog(
  state: AppState,
  binding: Pick<ChatgptBridgeBinding, "providerName" | "modelAliases">,
  catalog: { models: Array<{ slug: string } & Parameters<typeof buildBridgeModelConfig>[2]> },
): BridgeDiff {
  const add: BridgeDiff["add"] = [];
  const existing = new Set(Object.keys(state.mainConfig.models));
  for (const entry of catalog.models) {
    const alias = bridgeModelKey(entry.slug);
    if (existing.has(alias)) continue;
    add.push({ alias, model: buildBridgeModelConfig(binding.providerName, entry.slug, entry) });
  }

  const knownSlugs = new Set(catalog.models.map((entry) => entry.slug));
  const staleUnreferenced: string[] = [];
  const staleReferenced: string[] = [];
  for (const alias of binding.modelAliases) {
    const slug = alias.startsWith(`${BRIDGE_MODEL_NAMESPACE}/`)
      ? alias.slice(BRIDGE_MODEL_NAMESPACE.length + 1)
      : alias;
    if (knownSlugs.has(slug)) continue;
    const references = getModelReferences(state, alias);
    if (references.length > 0) staleReferenced.push(alias);
    else staleUnreferenced.push(alias);
  }
  return { add, staleUnreferenced, staleReferenced };
}

export interface UnbindPlan {
  modelsToRemove: string[];
  modelsRetained: Array<{ alias: string; referencedBy: string[] }>;
  providerRemovable: boolean;
  profileRemovable: boolean;
}

/** 计算解除绑定的删除计划（保留仍被引用的条目）。 */
export function planUnbind(
  state: AppState,
  binding: Pick<ChatgptBridgeBinding, "providerName" | "modelAliases" | "profileName">,
): UnbindPlan {
  const modelsToRemove: string[] = [];
  const modelsRetained: Array<{ alias: string; referencedBy: string[] }> = [];
  for (const alias of binding.modelAliases) {
    const references = getModelReferences(state, alias);
    if (references.length === 0) modelsToRemove.push(alias);
    else modelsRetained.push({ alias, referencedBy: references.map((profile) => profile.name) });
  }

  const remainingModelAliases = new Set(modelsToRemove);
  const modelsStillPresent = Object.entries(state.mainConfig.models)
    .filter(([name]) => !remainingModelAliases.has(name))
    .map(([, model]) => model);
  const providerRemovable = !modelsStillPresent.some((model) => model.provider === binding.providerName);

  const profileRemovable =
    binding.profileName !== undefined &&
    state.profiles[binding.profileName] !== undefined &&
    state.activeProfile !== binding.profileName;

  return { modelsToRemove, modelsRetained, providerRemovable, profileRemovable };
}

/** 面板设置导出/备份时脱敏绑定的本地 secret（保持结构，替换为占位）。 */
export function redactBindingSecret(binding: ChatgptBridgeBinding): ChatgptBridgeBinding {
  return { ...binding, bridgeSecret: "[redacted]" };
}
