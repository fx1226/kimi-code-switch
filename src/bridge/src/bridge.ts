/**
 * BridgeRuntime：把 TokenManager、OAuth 登录、模型目录与本地服务串起来。
 * 是控制通道（stdio）与独立 serve 模式共用的编排核心。
 */
import type {
  AuthState,
  BridgeInstanceConfig,
  ModelCatalog,
  TokenSet,
} from "./types";
import { TokenManager } from "./token-manager";
import { startLoginFlow, type LoginFlowHandle } from "./oauth-flow";
import { createBridgeServer } from "./server";
import { fetchModelCatalog } from "./models";
import { refreshTokens } from "./pkce";
import { EncryptedFileTokenStore, type TokenStore } from "./token-store";

export interface BridgeRuntimeOptions {
  config: BridgeInstanceConfig;
  initialAuth: TokenSet | null;
  tokenStore?: TokenStore;
  /** 宿主持久化回调（生产走 keyring；原型写私密文件）。 */
  onTokens?: (tokens: TokenSet) => void;
  fetchImpl?: typeof fetch;
  logger?: (line: string) => void;
}

export class BridgeRuntime {
  readonly config: BridgeInstanceConfig;
  private readonly tokenManager: TokenManager;
  private readonly tokenStore?: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: (line: string) => void;
  private server?: ReturnType<typeof createBridgeServer>;
  private actualPort = 0;
  private catalog: ModelCatalog | null = null;
  private pendingLogin: LoginFlowHandle | null = null;

  constructor(options: BridgeRuntimeOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger ?? (() => undefined);
    this.tokenStore = options.tokenStore;
    this.tokenManager = new TokenManager({
      initial: options.initialAuth,
      refreshImpl: (refreshToken) =>
        refreshTokens({
          refreshToken,
          tokenEndpoint: this.config.tokenEndpoint,
          clientId: this.config.clientId,
          fetchImpl: this.fetchImpl,
        }),
      onTokens: (tokens) => {
        options.onTokens?.(tokens);
        void this.tokenStore?.save(tokens).catch(() => undefined);
      },
      now: Date.now,
    });
  }

  get port(): number {
    return this.actualPort || this.config.port;
  }

  getAuthState(): AuthState {
    const tokens = this.tokenManager.getTokens();
    if (!tokens) return { status: "signed-out" };
    return { status: "signed-in", tokens, mode: "oauth" };
  }

  getCatalog(): ModelCatalog | null {
    return this.catalog;
  }

  async start(): Promise<{ port: number }> {
    if (this.server) return { port: this.port };
    this.server = createBridgeServer({
      config: this.config,
      getAuth: (forceRefresh) => this.tokenManager.get(forceRefresh),
      getCatalog: () => this.catalog,
      refreshCatalog: () => this.refreshModels(),
      fetchImpl: this.fetchImpl,
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, "127.0.0.1", () => resolve());
    });
    const address = this.server!.address();
    this.actualPort =
      typeof address === "object" && address && address.port ? address.port : this.config.port;
    this.logger(`bridge listening on 127.0.0.1:${this.actualPort}`);
    return { port: this.actualPort };
  }

  /** 发起登录流程；返回授权地址与完成 promise。同一时间只允许一个流程。 */
  login(redirectPort: number): { url: string; done: Promise<TokenSet> } {
    if (this.pendingLogin) {
      throw new Error("an OAuth login flow is already in progress");
    }
    const handle = startLoginFlow({
      redirectPort,
      clientId: this.config.clientId,
      issuer: this.config.issuer,
      tokenEndpoint: this.config.tokenEndpoint,
      fetchImpl: this.fetchImpl,
    });
    this.pendingLogin = handle;
    handle.done.then(
      (tokens) => {
        this.pendingLogin = null;
        this.tokenManager.setTokens(tokens);
        void this.refreshModels().catch(() => undefined);
        this.logger("OAuth login completed");
      },
      () => {
        this.pendingLogin = null;
      },
    );
    return { url: handle.authorizeUrl, done: handle.done };
  }

  async logout(): Promise<void> {
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    this.tokenManager.clear();
    this.catalog = null;
    await this.tokenStore?.clear().catch(() => undefined);
  }

  async refreshModels(): Promise<ModelCatalog> {
    const tokens = this.tokenManager.getTokens();
    if (!tokens) {
      this.catalog = null;
      throw new Error("not signed in");
    }
    this.catalog = await fetchModelCatalog(this.config, tokens, { fetchImpl: this.fetchImpl });
    return this.catalog;
  }

  async stop(): Promise<void> {
    this.pendingLogin?.cancel();
    this.pendingLogin = null;
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
        this.server!.closeAllConnections();
      });
      this.server = undefined;
    }
  }
}

/** 从 stateDir 恢复 TokenStore（仅原型/开发路径；生产由宿主接管持久化）。 */
export function fileTokenStore(stateDir: string): TokenStore {
  return new EncryptedFileTokenStore(`${stateDir}/tokens.enc`);
}
