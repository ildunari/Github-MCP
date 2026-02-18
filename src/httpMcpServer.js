import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

function normalizeCommaList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw))
    return raw
      .map(String)
      .map((s) => s.trim())
      .filter(Boolean);
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function headerValue(req, name) {
  const v = req.headers?.[name.toLowerCase()];
  if (Array.isArray(v)) return v.join(",");
  return v;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

async function readJsonBody(req, { maxBytes }) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      const text = Buffer.concat(chunks).toString("utf-8");
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function isAllowed(value, allowlist) {
  if (!allowlist || allowlist.length === 0) return true;
  if (!value) return false;
  const v = String(value).toLowerCase();
  return allowlist.some((a) => a.toLowerCase() === v);
}

function isLocalBindHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export async function startHttpMcpServer({
  host = "127.0.0.1",
  port = 3000,
  path = "/mcp",
  tlsKeyPath,
  tlsCertPath,
  authToken,
  allowedOrigins = [],
  allowedHosts = [],
  maxSessions = 50,
  idleTimeoutMs = 0,
  requireAuthOnPublicBind = false,
  oauthResourceMetadataUrl = "",
  oauthProtectedResourcePath = "",
  oauthAuthorizationServerIssuer = "",
  oauthScopes = [],
  oauthCutoverPath = "",
  oauthCutoverToken = "",
  createServerForSession,
} = {}) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error("Parameter 'path' must start with '/'.");
  }
  const cutoverPath =
    typeof oauthCutoverPath === "string" ? oauthCutoverPath.trim() : "";
  if (cutoverPath && !cutoverPath.startsWith("/")) {
    throw new Error("Parameter 'oauthCutoverPath' must start with '/'.");
  }
  if (cutoverPath && cutoverPath === path) {
    throw new Error(
      "Parameter 'oauthCutoverPath' must be different from 'path'.",
    );
  }
  if (typeof createServerForSession !== "function") {
    throw new Error("Parameter 'createServerForSession' must be a function.");
  }

  const allowedOriginsList = normalizeCommaList(allowedOrigins);
  const allowedHostsList = normalizeCommaList(allowedHosts);
  const oauthScopesList = normalizeCommaList(oauthScopes);
  const oauthProtectedResourcePathValue =
    typeof oauthProtectedResourcePath === "string"
      ? oauthProtectedResourcePath.trim()
      : "";
  if (
    oauthProtectedResourcePathValue &&
    !oauthProtectedResourcePathValue.startsWith("/")
  ) {
    throw new Error(
      "Parameter 'oauthProtectedResourcePath' must start with '/'.",
    );
  }
  if (oauthResourceMetadataUrl) {
    let parsed;
    try {
      parsed = new URL(oauthResourceMetadataUrl);
    } catch {
      throw new Error(
        "Parameter 'oauthResourceMetadataUrl' must be a valid URL.",
      );
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(
        "Parameter 'oauthResourceMetadataUrl' must use http or https.",
      );
    }
  }
  const isPublicBind = !isLocalBindHost(host);
  const cutoverAuthToken = oauthCutoverToken || authToken || "";
  if (cutoverPath && !cutoverAuthToken) {
    throw new Error(
      "Parameter 'oauthCutoverToken' (or --http-auth-token) is required when oauthCutoverPath is set.",
    );
  }

  if (isPublicBind && requireAuthOnPublicBind && !authToken) {
    throw new Error(
      "Refusing to start: HTTP endpoint is bound off-localhost but no auth token is configured. Set --http-auth-token or disable --http-require-auth-on-public-bind.",
    );
  }
  if (isPublicBind && !authToken) {
    try {
      console.error(
        "WARNING: HTTP endpoint is bound to " +
          host +
          " without --http-auth-token. " +
          "This is INSECURE for non-localhost binds. Use --http-require-auth-on-public-bind to enforce auth.",
      );
    } catch {
      // ignore
    }
  }

  const sessions = new Map();

  async function cleanupSession(sessionId, reason) {
    const ctx = sessions.get(sessionId);
    if (!ctx) return;
    sessions.delete(sessionId);

    try {
      await ctx.transport.close?.();
    } catch {
      // ignore
    }
    try {
      await ctx.shutdown?.();
    } catch {
      // ignore
    }

    try {
      if (reason)
        console.error(`MCP HTTP session closed (${sessionId}): ${reason}`);
    } catch {
      // ignore
    }
  }

  function unauthorizedChallenge(req, res, token) {
    if (!token) return false;
    const auth = headerValue(req, "authorization");
    const expected = `Bearer ${token}`;
    if (auth !== expected) {
      const challenge = oauthResourceMetadataUrl
        ? `Bearer resource_metadata="${oauthResourceMetadataUrl}"`
        : "Bearer";
      res.setHeader("WWW-Authenticate", challenge);
      sendText(res, 401, "Unauthorized");
      return true;
    }
    return false;
  }

  function authTokenForEndpoint(endpointKind) {
    if (endpointKind === "cutover") return cutoverAuthToken;
    return authToken || "";
  }

  function rejectIfOriginNotAllowed(req, res) {
    const origin = headerValue(req, "origin");
    if (!origin) return false;
    if (allowedOriginsList.length === 0) return false;
    if (!isAllowed(origin, allowedOriginsList)) {
      sendText(res, 403, "Forbidden (Origin not allowed)");
      return true;
    }
    return false;
  }

  function rejectIfHostNotAllowed(req, res) {
    if (allowedHostsList.length === 0) return false;
    const hostHeader = headerValue(req, "host");
    if (!isAllowed(hostHeader, allowedHostsList)) {
      sendText(res, 403, "Forbidden (Host not allowed)");
      return true;
    }
    return false;
  }

  const server =
    tlsKeyPath && tlsCertPath
      ? https.createServer(
          { key: readFileSync(tlsKeyPath), cert: readFileSync(tlsCertPath) },
          handler,
        )
      : http.createServer(handler);

  server.on("error", (err) => {
    try {
      console.error("HTTP server error:", err.message || err);
    } catch {
      // ignore
    }
  });

  async function handler(req, res) {
    try {
      const url = new URL(req.url || "/", `http://${host}`);
      if (
        oauthProtectedResourcePathValue &&
        url.pathname === oauthProtectedResourcePathValue
      ) {
        if ((req.method || "GET").toUpperCase() !== "GET") {
          sendText(res, 405, "Method Not Allowed");
          return;
        }
        const scheme = tlsKeyPath && tlsCertPath ? "https" : "http";
        const hostHeader = headerValue(req, "host");
        const addr = server.address();
        const fallbackHost = `${host}:${typeof addr === "object" && addr ? addr.port : port}`;
        const origin = `${scheme}://${hostHeader || fallbackHost}`;
        const payload = {
          resource: `${origin}${path}`,
        };
        if (oauthAuthorizationServerIssuer) {
          payload.authorization_servers = [oauthAuthorizationServerIssuer];
        }
        if (oauthScopesList.length > 0) {
          payload.scopes_supported = oauthScopesList;
        }
        sendJson(res, 200, payload);
        return;
      }
      let endpointKind = null;
      if (url.pathname === path) endpointKind = "primary";
      else if (cutoverPath && url.pathname === cutoverPath)
        endpointKind = "cutover";
      if (!endpointKind) {
        sendText(res, 404, "Not Found");
        return;
      }

      if (rejectIfOriginNotAllowed(req, res)) return;
      if (rejectIfHostNotAllowed(req, res)) return;

      const method = (req.method || "GET").toUpperCase();
      const sessionId = headerValue(req, "mcp-session-id");
      const endpointAuthToken = authTokenForEndpoint(endpointKind);

      if (!sessionId && unauthorizedChallenge(req, res, endpointAuthToken))
        return;

      let parsedBody;
      if (method === "POST") {
        try {
          parsedBody = await readJsonBody(req, { maxBytes: 5 * 1024 * 1024 });
        } catch (e) {
          sendText(res, 400, e.message || "Bad Request");
          return;
        }
      }

      if (sessionId) {
        const ctx = sessions.get(sessionId);
        if (!ctx) {
          sendText(res, 404, "Unknown MCP session");
          return;
        }
        if (ctx.endpointKind !== endpointKind) {
          sendText(res, 404, "Unknown MCP session");
          return;
        }
        if (unauthorizedChallenge(req, res, ctx.authToken)) return;
        ctx.lastActivityAt = Date.now();
        res.on("close", () => {
          if (!res.writableFinished) {
            // Client disconnected before response fully sent — mark activity to prevent premature idle timeout
            ctx.lastActivityAt = Date.now();
          }
        });
        await ctx.transport.handleRequest(req, res, parsedBody);
        return;
      }

      // No session header: only allow initialize POST.
      if (method !== "POST" || !isInitializeRequest(parsedBody)) {
        sendText(
          res,
          400,
          "No valid Mcp-Session-Id provided (initialize required).",
        );
        return;
      }

      if (sessions.size >= maxSessions) {
        sendText(res, 503, "Too many MCP sessions.");
        return;
      }

      const ctx = {
        transport: undefined,
        server: undefined,
        shutdown: undefined,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        endpointKind,
        authToken: endpointAuthToken,
      };

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, ctx);
        },
        onsessionclosed: async (sid) => {
          await cleanupSession(sid, "DELETE");
        },
      });
      ctx.transport = transport;
      transport.onclose = async () => {
        // Best-effort: find and cleanup whatever session ID we have.
        const sid = transport.sessionId;
        if (!sid) return;
        await cleanupSession(sid, "transport closed");
      };

      try {
        const { server: mcpServer, shutdown } = createServerForSession({
          onActivity: () => {
            ctx.lastActivityAt = Date.now();
          },
        });
        ctx.server = mcpServer;
        ctx.shutdown = shutdown;
        await mcpServer.connect(transport);

        await transport.handleRequest(req, res, parsedBody);
      } catch (e) {
        const sid = transport.sessionId;
        if (sid) await cleanupSession(sid, "initialize failed");
        else {
          try {
            await transport.close?.();
          } catch {
            // ignore
          }
          try {
            await ctx.shutdown?.();
          } catch {
            // ignore
          }
        }
        throw e;
      }
    } catch (e) {
      if (res.headersSent) return;
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }

  // Periodic idle GC for sessions.
  let gcInterval;
  if (idleTimeoutMs > 0) {
    const tickMs = Math.min(
      Math.max(1000, Math.floor(idleTimeoutMs / 5)),
      30_000,
    );
    gcInterval = setInterval(() => {
      const now = Date.now();
      for (const [sid, ctx] of sessions.entries()) {
        if (now - ctx.lastActivityAt >= idleTimeoutMs) {
          cleanupSession(sid, "idle timeout").catch(() => {
            /* ignore */
          });
        }
      }
    }, tickMs);
    gcInterval.unref?.();
  }

  await new Promise((resolve, reject) => {
    server.listen(port, host, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;
  const scheme = tlsKeyPath && tlsCertPath ? "https" : "http";
  console.error(
    `MCP HTTP listening on ${scheme}://${host}:${actualPort}${path}`,
  );

  return {
    server,
    close: async () => {
      try {
        if (gcInterval) clearInterval(gcInterval);
      } catch {
        // ignore
      }
      for (const sid of Array.from(sessions.keys())) {
        await cleanupSession(sid, "server shutdown");
      }
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
