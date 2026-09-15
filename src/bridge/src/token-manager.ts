/**
 * TokenManager：持有当前凭据，负责单飞刷新与持久化回调。
 * - 预判过期（expires_in 或 JWT exp）提前刷新；forceRefresh 用于 401 后强制刷新。
 * - 所有并发刷新共享同一个 promise（single-flight）。
 * - 刷新成功通过 onTokens 通知宿主持久化。
 */
import type { TokenSet } from "./types";
import { parseJwtClaims } from "./pkce";

export interface TokenManagerOptions {
  initial: TokenSet | null;
  refreshImpl: (refreshToken: string) => Promise<TokenSet>;
  onTokens?: (tokens: TokenSet) => void;
  now?: () => number;
  /** 提前刷新窗口，默认 5 分钟。 */
  leewayMs?: number;
}

export class TokenManager {
  private current: TokenSet | null;
  private refreshPromise: Promise<TokenSet> | null = null;
  private readonly refreshImpl: (refreshToken: string) => Promise<TokenSet>;
  private readonly onTokens?: (tokens: TokenSet) => void;
  private readonly now: () => number;
  private readonly leewayMs: number;

  constructor(options: TokenManagerOptions) {
    this.current = options.initial;
    this.refreshImpl = options.refreshImpl;
    this.onTokens = options.onTokens;
    this.now = options.now ?? Date.now;
    this.leewayMs = options.leewayMs ?? 5 * 60 * 1000;
  }

  getTokens(): TokenSet | null {
    return this.current;
  }

  setTokens(tokens: TokenSet): void {
    this.current = tokens;
    this.onTokens?.(tokens);
  }

  clear(): void {
    this.current = null;
    this.refreshPromise = null;
  }

  /** 返回有效凭据；按需或强制刷新。失败抛出（401 场景由上层转为错误响应）。 */
  async get(forceRefresh = false): Promise<TokenSet | null> {
    const current = this.current;
    if (!current) return null;
    if (!forceRefresh && !this.isExpiring(current)) return current;
    if (!current.refresh_token) {
      throw new Error("access token expired and no refresh token available; sign in again");
    }
    if (!this.refreshPromise) {
      this.refreshPromise = this.doRefresh(current.refresh_token)
        .catch((error) => {
          // 刷新失败后清空单飞态，允许下一次显式重试。
          this.refreshPromise = null;
          throw error;
        })
        .then((tokens) => {
          this.refreshPromise = null;
          this.current = tokens;
          this.onTokens?.(tokens);
          return tokens;
        });
    }
    return this.refreshPromise;
  }

  private isExpiring(tokens: TokenSet): boolean {
    if (!tokens.expires_in && !tokens.issued_at) {
      // 无显式有效期：尝试从 access_token JWT exp 判断。
      const claims = parseJwtClaims(tokens.access_token);
      if (claims?.exp) {
        return claims.exp * 1000 - this.now() < this.leewayMs;
      }
      return false;
    }
    const issued = tokens.issued_at ? new Date(tokens.issued_at).getTime() : this.now();
    const ttlMs = (tokens.expires_in ?? 3600) * 1000;
    return issued + ttlMs - this.now() < this.leewayMs;
  }

  private doRefresh(refreshToken: string): Promise<TokenSet> {
    return this.refreshImpl(refreshToken);
  }
}
