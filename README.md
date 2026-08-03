# Twitter MCP Server

TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server for the Twitter/X API v2.

- **Transport:** Streamable HTTP (stateless)
- **Auth:** OAuth user access token via the `access-token` header — required only for **tool calls**, not for list/initialize
- **Runtime:** Node.js 20+, Express, `@modelcontextprotocol/sdk`
- **Docker:** multi-stage production image included

This server does **not** run the OAuth dance itself. Obtain a user access token from your OAuth 2.0 (or OAuth 1.0a user-context) flow and send it when invoking tools.

## Endpoints

| Method | Path      | Description                                      |
|--------|-----------|--------------------------------------------------|
| `POST` | `/mcp`    | MCP Streamable HTTP endpoint (tools)             |
| `GET`  | `/health` | Liveness probe                                   |
| `GET`  | `/mcp`    | `405` — not used in stateless mode               |
| `DELETE` | `/mcp`  | `405` — no sessions to delete                    |

## Authentication

`access-token` is **not** required for protocol/list methods (`initialize`, `tools/list`, `ping`, etc.). It is **required** when calling a tool that hits the Twitter API.

```http
POST /mcp HTTP/1.1
Host: localhost:3000
Content-Type: application/json
Accept: application/json, text/event-stream
access-token: <OAUTH_USER_ACCESS_TOKEN>
```

Fallback (also accepted):

```http
Authorization: Bearer <OAUTH_USER_ACCESS_TOKEN>
```

If a tool is called without a token, the tool returns an error:

```text
Missing access token. Tool calls require an OAuth user access token via the `access-token` header …
```

Suggested OAuth 2.0 scopes for full tool coverage:

```
tweet.read tweet.write users.read follows.read follows.write offline.access
```

## Tools

| Tool | Description |
|------|-------------|
| `get_me` | Authenticated user profile |
| `get_user_by_username` | User lookup by handle |
| `get_user_by_id` | User lookup by ID |
| `get_tweet` | Single tweet by ID |
| `get_user_timeline` | User's recent posts |
| `get_user_mentions` | Mentions timeline |
| `search_recent_tweets` | Recent search (last 7 days) |
| `post_tweet` | Create a post (optional reply / quote) |
| `delete_tweet` | Delete own post |
| `like_tweet` / `unlike_tweet` | Like management |
| `retweet` / `undo_retweet` | Retweet management |
| `follow_user` / `unfollow_user` | Follow management |

## Local development

```bash
npm install
npm run dev
# → http://0.0.0.0:3000/mcp
```

Build & run production:

```bash
npm run build
npm start
```

Environment variables:

| Variable | Default   | Description        |
|----------|-----------|--------------------|
| `PORT`   | `3000`    | HTTP port          |
| `HOST`   | `0.0.0.0` | Bind address       |

## Docker

```bash
# Build
docker build -t twitter-mcp .

# Run
docker run --rm -p 3000:3000 twitter-mcp

# Health check
curl http://localhost:3000/health
```

## Example MCP initialize (curl)

No token needed for initialize / tools/list:

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-03-26",
      "capabilities": {},
      "clientInfo": { "name": "curl", "version": "1.0.0" }
    }
  }'
```

Tool calls need the token:

```bash
curl -sS http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'access-token: YOUR_TOKEN' \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": { "name": "get_me", "arguments": {} }
  }'
```

## Architecture notes

1. **Stateless Streamable HTTP** — each `POST /mcp` creates a new `McpServer` + `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined`, then tears them down when the response finishes. Safe for horizontal scaling and containers.
2. **Per-request token isolation** — `AsyncLocalStorage` holds the optional access token for the duration of the request so concurrent calls never mix credentials. Missing tokens only fail when tools call `getAccessToken()`.
3. **Twitter client** — `twitter-api-v2` is constructed with the user access token and used as OAuth 2.0 user-context (Bearer).

## License

MIT
