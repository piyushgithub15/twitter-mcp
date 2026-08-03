import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { accessTokenStore, extractAccessToken } from "./auth.js";
import { createTwitterMcpServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = express();
app.use(express.json({ limit: "4mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    name: "twitter-mcp",
    transport: "streamable-http",
    mode: "stateless",
  });
});

/**
 * Stateless Streamable HTTP:
 * - Fresh McpServer + StreamableHTTPServerTransport per request
 * - sessionIdGenerator: undefined (no session affinity)
 * - access-token is optional for protocol methods (initialize, tools/list, …)
 *   and enforced only when a tool invokes the Twitter API
 */
app.post("/mcp", async (req: Request, res: Response) => {
  // May be undefined — list/initialize still work; tools fail without it
  const accessToken = extractAccessToken(req);

  await accessTokenStore.run(accessToken, async () => {
    const server = createTwitterMcpServer();
    const transport = new StreamableHTTPServerTransport({
      // Stateless: no session IDs, no in-memory session map
      sessionIdGenerator: undefined,
    });

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      void transport.close();
      void server.close();
    };

    res.on("close", cleanup);

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      cleanup();
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Internal server error",
          },
          id: null,
        });
      }
    }
  });
});

// Stateless servers typically do not support long-lived GET SSE or session DELETE
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This server is stateless Streamable HTTP (POST only).",
    },
    id: null,
  });
});

app.delete("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed. This server is stateless (no sessions to delete).",
    },
    id: null,
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, HOST, () => {
  console.log(
    `twitter-mcp (stateless Streamable HTTP) listening on http://${HOST}:${PORT}/mcp`,
  );
  console.log(`health check: http://${HOST}:${PORT}/health`);
  console.log(
    "Auth: send OAuth access token in header `access-token: <token>` for tool calls (not required for tools/list)",
  );
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
