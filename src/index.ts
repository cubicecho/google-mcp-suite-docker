/**
 * google-mcp-suite-network
 *
 * Wraps the stdio MCP servers shipped by `google-mcp-suite`
 * (gmail / calendar / sheets / docs / drive) and exposes each one over the
 * network as a Streamable HTTP MCP endpoint at `/<account>/<service>`, where
 * `<account>` is an account authorized via the /admin UI.
 *
 * Each HTTP session spawns its own child stdio server (identity in this suite
 * is bound per-process), and JSON-RPC messages are bridged transparently
 * between the HTTP transport and the child's stdin/stdout.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { mountAdmin, validAccount, accountAuthorized, authorizedAccounts } from "./admin/index.js";

// --- Configuration -----------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "0.0.0.0";
const AUTH_TOKEN = process.env.AUTH_TOKEN?.trim() || undefined;
const BODY_LIMIT = process.env.BODY_LIMIT ?? "50mb";

// Directory holding the `google-mcp-*` bin shims (dist/index.js -> ../node_modules/.bin).
const BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin");

/** Map of URL path segment -> the stdio server binary provided by google-mcp-suite. */
const SERVICES: Record<string, string> = {
  gmail: "google-mcp-gmail",
  calendar: "google-mcp-calendar",
  sheets: "google-mcp-sheets",
  docs: "google-mcp-docs",
  drive: "google-mcp-drive",
};

// --- Session bridging --------------------------------------------------------

interface Session {
  account: string;
  service: string;
  http: StreamableHTTPServerTransport;
  child: StdioClientTransport;
}

const sessions = new Map<string, Session>();

/** Build the environment for a child server, binding it to `account`. */
function childEnv(account: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.PATH = `${BIN_DIR}:${process.env.PATH ?? ""}`;
  // The child reads GOOGLE_MCP_ACCOUNT for its identity; it comes from the URL
  // (/<account>/<service>), never inherited from the proxy environment.
  delete env.GOOGLE_MCP_ACCOUNT;
  env.GOOGLE_MCP_ACCOUNT = account;
  return env;
}

/** Spawn a child stdio server bound to `account` and wire it to a fresh Streamable HTTP transport. */
async function createSession(account: string, service: string): Promise<Session> {
  const label = `${account}/${service}`;
  const child = new StdioClientTransport({
    command: SERVICES[service],
    env: childEnv(account),
    stderr: "inherit", // surface auth / google-mcp diagnostics in our logs
  });

  const http = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      console.log(`[${label}] session opened: ${sessionId}`);
    },
  });

  const session: Session = { account, service, http, child };

  // Transparent JSON-RPC bridge in both directions.
  http.onmessage = (msg) => {
    child.send(msg).catch((err) => console.error(`[${label}] -> child send failed`, err));
  };
  child.onmessage = (msg) => {
    http.send(msg).catch((err) => console.error(`[${label}] -> http send failed`, err));
  };

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    if (http.sessionId) sessions.delete(http.sessionId);
    void child.close().catch(() => {});
    void http.close().catch(() => {});
    console.log(`[${label}] session closed: ${http.sessionId ?? "(uninitialized)"}`);
  };

  http.onclose = cleanup;
  child.onclose = cleanup;
  http.onerror = (err) => console.error(`[${label}] http transport error`, err);
  child.onerror = (err) => console.error(`[${label}] child transport error`, err);

  await child.start();
  await http.start();
  return session;
}

// --- HTTP server -------------------------------------------------------------

const app = express();
app.use(express.json({ limit: BODY_LIMIT }));

// Credential-management web UI at /admin (client secret + per-account OAuth).
mountAdmin(app);

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!AUTH_TOKEN) return next();
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, services: Object.keys(SERVICES), sessions: sessions.size });
});

app.get("/", (_req, res) => {
  res.json({
    name: "google-mcp-suite-network",
    transport: "streamable-http",
    route: "/{account}/{service}",
    services: Object.keys(SERVICES),
    accounts: authorizedAccounts(),
    admin: "/admin",
  });
});

function jsonRpcError(res: Response, status: number, message: string) {
  res.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function getSession(req: Request): Session | undefined {
  const id = req.headers["mcp-session-id"];
  const sessionId = Array.isArray(id) ? id[0] : id;
  if (!sessionId) return undefined;
  const session = sessions.get(sessionId);
  if (!session || session.account !== req.params.account || session.service !== req.params.service) {
    return undefined;
  }
  return session;
}

// Client -> server requests (initialize + tool calls), addressed as /<account>/<service>.
app.post("/:account/:service", requireAuth, async (req, res) => {
  const { account, service } = req.params;
  if (!validAccount(account)) return jsonRpcError(res, 400, `invalid account: ${account}`);
  if (!SERVICES[service]) return jsonRpcError(res, 404, `unknown service: ${service}`);
  if (!accountAuthorized(account)) {
    return jsonRpcError(res, 404, `account not authorized: ${account} (authorize it at /admin)`);
  }

  try {
    let session = getSession(req);
    if (!session) {
      if (req.headers["mcp-session-id"] || !isInitializeRequest(req.body)) {
        return jsonRpcError(res, 400, "no valid session for the given Mcp-Session-Id");
      }
      session = await createSession(account, service);
    }
    await session.http.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(`[${account}/${service}] request failed`, err);
    if (!res.headersSent) jsonRpcError(res, 500, "internal error");
  }
});

// Server -> client stream (GET, SSE) and session teardown (DELETE).
async function handleSessionRequest(req: Request, res: Response) {
  const session = getSession(req);
  if (!session) return jsonRpcError(res, 400, "no valid session for the given Mcp-Session-Id");
  try {
    await session.http.handleRequest(req, res);
  } catch (err) {
    console.error(`[${session.account}/${session.service}] stream request failed`, err);
    if (!res.headersSent) jsonRpcError(res, 500, "internal error");
  }
}

app.get("/:account/:service", requireAuth, handleSessionRequest);
app.delete("/:account/:service", requireAuth, handleSessionRequest);

const server = app.listen(PORT, HOST, () => {
  console.log(`google-mcp-suite-network listening on http://${HOST}:${PORT}`);
  console.log(`services: ${Object.keys(SERVICES).join(", ")}`);
  if (!AUTH_TOKEN) console.warn("AUTH_TOKEN is not set — endpoints are unauthenticated.");
  if (!process.env.ADMIN_PASSWORD?.trim())
    console.warn("ADMIN_PASSWORD is not set — the /admin credential UI is disabled (returns 503).");
});

// --- Graceful shutdown -------------------------------------------------------

function shutdown(signal: string) {
  console.log(`received ${signal}, shutting down...`);
  server.close();
  for (const session of sessions.values()) {
    void session.child.close().catch(() => {});
    void session.http.close().catch(() => {});
  }
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
