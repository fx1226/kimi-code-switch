/**
 * 桥接类型：OAuth 凭据、模型目录与本地服务配置的数据契约。
 * 纯 Node 侧类型，不依赖 renderer/shared，保持可被 pkg 独立打包。
 */

/** 一次完整登录后持有的凭据集合。 */
export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  /** 秒级过期时间（Unix epoch）；无则依赖 access_token JWT exp。 */
  expires_in?: number;
  /** 从 id_token/access_token 提取的 ChatGPT account id（请求头用）。 */
  account_id?: string;
  /** 令牌签发/刷新时间（ISO）。 */
  issued_at?: string;
}

export interface AuthState {
  status: "signed-out" | "signed-in";
  tokens?: TokenSet;
  /** 登录模式：仅 OAuth（ChatGPT 订阅）；不支持 API key 模式。 */
  mode?: "oauth";
  error?: string;
}

/** 桥接进程的持久化配置（由宿主写入，进程只读）。 */
export interface BridgeInstanceConfig {
  port: number;
  secret: string;
  stateDir: string;
  logPath: string;
  upstreamBase: string;
  upstreamResponses: string;
  tokenEndpoint: string;
  issuer: string;
  clientId: string;
  modelsEndpoint: string;
}

/** 模型目录中的单条记录（上游 /codex/models 规范化结果）。 */
export interface ModelInfo {
  slug: string;
  display_name?: string;
  context_window?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: Array<{ effort?: string }>;
  visibility?: string;
  supported_in_api?: boolean;
  available_in_plans?: string[];
}

export interface ModelCatalog {
  models: ModelInfo[];
  /** true = 目录来自账号实时返回；false = 使用静态 fallback（不可当作权限证明）。 */
  live: boolean;
  fetched_at: number;
}

/** 上游错误经归一化后的形状，供宿主/UI 展示。 */
export interface UpstreamErrorInfo {
  status: number;
  message: string;
  type?: string;
  code?: string;
  /** 额度类错误的恢复时间（epoch 秒），有则给出。 */
  resetsAt?: number;
  planType?: string;
}

/** 控制通道（host ↔ bridge，JSONL over stdio）请求。 */
export type ControlRequest =
  | { id: number; type: "start"; config: BridgeInstanceConfig; auth?: TokenSet }
  | { id: number; type: "login"; redirectPort: number }
  | { id: number; type: "logout" }
  | { id: number; type: "status" }
  | { id: number; type: "refresh-models" }
  | { id: number; type: "shutdown" };

/** 控制通道响应/事件。id 仅在“对请求的应答”上出现；事件不带 id。 */
export type ControlResponse =
  | { id?: number; type: "ready"; port: number; pid: number }
  | { id?: number; type: "login-url"; url: string }
  | { id?: number; type: "login-result"; ok: boolean; error?: string; tokens?: TokenSet }
  | { id?: number; type: "tokens"; tokens: TokenSet }
  | { id?: number; type: "status"; port: number; auth: AuthState; catalog: ModelCatalog | null; ok: boolean }
  | { id?: number; type: "models"; catalog: ModelCatalog }
  | { id?: number; type: "logout-result"; ok: boolean }
  | { id?: number; type: "shutdown-ok" }
  | { id?: number; type: "error"; message: string };
