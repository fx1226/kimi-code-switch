import { describe, expect, it } from "vitest";

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  extractAccountId,
  generatePkce,
  parseJwtClaims,
  refreshTokens,
  toTokenSet,
} from "../src/pkce";

describe("pkce", () => {
  it("generates a verifier and S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{40,64}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]{40,64}$/);
    expect(challenge).not.toBe(verifier);
  });

  it("builds the authorize URL with required params", () => {
    const url = new URL(
      buildAuthorizeUrl({
        redirectUri: "http://localhost:1455/auth/callback",
        pkce: { verifier: "v", challenge: "c" },
        state: "st",
      }),
    );
    expect(url.origin).toBe("https://auth.openai.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
    expect(url.searchParams.get("scope")).toContain("offline_access");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe("c");
    expect(url.searchParams.get("state")).toBe("st");
  });

  it("exchanges an authorization code via form POST", async () => {
    const calls: string[] = [];
    const fakeFetch = async (_input: unknown, init?: RequestInit) => {
      calls.push(String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "at",
          refresh_token: "rt",
          id_token:
            "eyJhbGciOiJub25lIn0.eyJjaGF0Z3B0X2FjY291bnRfaWQiOiJhY2N0XzEyMyJ9.",
          expires_in: 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const tokens = await exchangeCodeForTokens({
      code: "code1",
       redirectUri: "http://localhost:1455/auth/callback",
      pkce: { verifier: "verifier123", challenge: "challenge123" },
      tokenEndpoint: "https://example.invalid/oauth/token",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(tokens.access_token).toBe("at");
    expect(tokens.account_id).toBe("acct_123");
    const body = calls[0] ?? "";
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code_verifier=verifier123");
    expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
  });

  it("refreshes with refresh_token grant", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ access_token: "at2", refresh_token: "rt2", expires_in: 3600 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const tokens = await refreshTokens({
      refreshToken: "rt1",
      tokenEndpoint: "https://example.invalid/oauth/token",
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    expect(tokens.access_token).toBe("at2");
    expect(tokens.refresh_token).toBe("rt2");
  });

  it("extracts account id from jwt claims", () => {
    const token =
      "eyJhbGciOiJub25lIn0." +
      Buffer.from(JSON.stringify({ chatgpt_account_id: "acct_x" })).toString("base64url") +
      ".";
    expect(extractAccountId({ id_token: token })).toBe("acct_x");
    expect(parseJwtClaims("bad")).toBeUndefined();
  });

  it("rejects token responses without access_token", () => {
    expect(() => toTokenSet({ refresh_token: "x" })).toThrow(/missing access_token/);
  });
});
