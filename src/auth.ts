import { AsyncLocalStorage } from "node:async_hooks";
import type { Request } from "express";

/**
 * Per-request OAuth access token storage.
 * Stateless Streamable HTTP creates a fresh MCP server per request; tools
 * read the token from this store so they never depend on process-wide state.
 *
 * Token is optional for protocol methods (initialize, tools/list, etc.)
 * and required only when a tool actually calls the Twitter API.
 */
export const accessTokenStore = new AsyncLocalStorage<string | undefined>();

/**
 * Extract the OAuth access token from the request.
 *
 * Primary header: `access-token: <token>`
 * Fallback: `Authorization: Bearer <token>`
 */
export function extractAccessToken(req: Request): string | undefined {
  const headerToken = req.header("access-token")?.trim();
  if (headerToken) {
    return headerToken;
  }

  const auth = req.header("authorization")?.trim();
  if (auth?.toLowerCase().startsWith("bearer ")) {
    const token = auth.slice(7).trim();
    return token || undefined;
  }

  return undefined;
}

/**
 * Required by tool handlers / Twitter client.
 * Protocol listing APIs (tools/list, initialize, …) must not call this.
 */
export function getAccessToken(): string {
  const token = accessTokenStore.getStore();
  if (!token) {
    throw new Error(
      "Missing access token. Tool calls require an OAuth user access token via the `access-token` header (or Authorization: Bearer).",
    );
  }
  return token;
}
