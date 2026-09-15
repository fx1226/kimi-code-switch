/**
 * Models：从 ChatGPT Codex 后端获取账号可用模型目录并规范化。
 * `live` 标记区分“账号实时返回”与“静态 fallback”：fallback 不能当作权限证明。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { BridgeInstanceConfig, ModelCatalog, ModelInfo, TokenSet } from "./types";
import { upstreamHeaders } from "./upstream";

export interface ModelsDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  cachePath?: string;
}

const FALLBACK_SLUGS = [
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
];

function readCache(cachePath: string | undefined, now: number): ModelCatalog | null {
  if (!cachePath) return null;
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8")) as ModelCatalog;
    if (Array.isArray(parsed.models) && now - parsed.fetched_at < 5 * 60 * 1000) return parsed;
  } catch {
    // 缓存缺失/损坏按无缓存处理
  }
  return null;
}

function writeCache(cachePath: string | undefined, catalog: ModelCatalog): void {
  if (!cachePath) return;
  try {
    mkdirSync(dirname(cachePath), { recursive: true });
    writeFileSync(cachePath, JSON.stringify(catalog), { mode: 0o600 });
  } catch {
    // 缓存写入失败不影响主流程
  }
}

function normalizeModels(raw: unknown): ModelInfo[] | null {
  const record = (raw ?? {}) as Record<string, unknown>;
  if (!Array.isArray(record.models)) return null;
  const out: ModelInfo[] = [];
  for (const item of record.models) {
    const m = (item ?? {}) as Record<string, unknown>;
    if (typeof m.slug !== "string" || !m.slug) continue;
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as unknown[]).map((l) => {
          const r = (l ?? {}) as Record<string, unknown>;
          return { effort: typeof r.effort === "string" ? r.effort : undefined };
        })
      : undefined;
    out.push({
      slug: m.slug,
      display_name: typeof m.display_name === "string" ? m.display_name : undefined,
      context_window:
        typeof m.context_window === "number" && m.context_window > 0 ? m.context_window : undefined,
      input_modalities: Array.isArray(m.input_modalities)
        ? (m.input_modalities as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
      supported_reasoning_levels: levels,
      visibility: typeof m.visibility === "string" ? m.visibility : undefined,
      supported_in_api:
        typeof m.supported_in_api === "boolean" ? m.supported_in_api : undefined,
      available_in_plans: Array.isArray(m.available_in_plans)
        ? (m.available_in_plans as unknown[]).filter((x): x is string => typeof x === "string")
        : undefined,
    });
  }
  return out.length > 0 ? out : null;
}

function fallbackCatalog(now: number): ModelCatalog {
  return {
    models: FALLBACK_SLUGS.map((slug) => ({ slug })),
    live: false,
    fetched_at: now,
  };
}

/** 拉取目录：内存/文件缓存 → 实时拉取 → 静态 fallback。 */
export async function fetchModelCatalog(
  config: BridgeInstanceConfig,
  tokens: TokenSet,
  deps: ModelsDeps = {},
): Promise<ModelCatalog> {
  const now = deps.now?.() ?? Date.now();
  const cached = readCache(deps.cachePath, now);
  if (cached) return cached;

  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const response = await doFetch(config.modelsEndpoint, {
      headers: upstreamHeaders(config, tokens),
      signal: AbortSignal.timeout(10000),
    });
    if (response.ok) {
      const models = normalizeModels(await response.json());
      if (models) {
        const catalog: ModelCatalog = { models, live: true, fetched_at: now };
        writeCache(deps.cachePath, catalog);
        return catalog;
      }
    }
  } catch {
    // 落入 fallback
  }
  return fallbackCatalog(now);
}
