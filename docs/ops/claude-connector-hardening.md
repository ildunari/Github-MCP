# Claude Connector Hardening (Phase 1)

This runbook hardens a public Claude.ai connector path **without** requiring immediate OAuth rollout.

## Topology
`Claude.ai -> Cloudflare -> supergateway -> github-mcp-server (stdio local)`

## 1) supergateway baseline flags
Use explicit transport/session/protocol settings:

```bash
supergateway \
  --stdio 'npx github-mcp-server-kosta -t "$GITHUB_TOKEN"' \
  --outputTransport streamableHttp \
  --streamableHttpPath /mcp \
  --protocolVersion 2025-06-18 \
  --stateful true \
  --sessionTimeout 900000 \
  --healthEndpoint /healthz \
  --healthEndpoint /readyz \
  --logLevel info
```

Notes:
- Avoid relying on protocol defaults.
- Stateful mode is recommended for session-isolated lazy tool loading.

## 2) Edge controls (Cloudflare)
Apply all of the following to `/mcp`:
1. HTTPS-only.
2. IP allowlist for Anthropic outbound ranges.
3. Rate limiting (burst + sustained).
4. Preserve required MCP headers end-to-end.
5. Log with secret redaction (no raw bearer tokens).

## 3) MCP headers to preserve
- `MCP-Protocol-Version`
- `Mcp-Session-Id`
- `Last-Event-ID` (if resumability is used)
- `Authorization` (when auth enabled)
- `WWW-Authenticate` on 401 responses

## 4) Verify edge behavior
Use:
- `/Users/kosta/Documents/ProjectsCode/github-mcp-server/scripts/smoke/edge-header-check.sh`
- `/Users/kosta/Documents/ProjectsCode/github-mcp-server/scripts/smoke/remote-mcp-smoke.sh`

Checks:
1. Unknown session returns 404 in stateful mode.
2. Initialize returns valid response and session header (stateful).
3. tools/list succeeds through full path.
4. No secret leakage in logs.

## 5) Optional strict public-bind guard (native HTTP mode)
If using native HTTP mode for this server directly:
- Add `--http-require-auth-on-public-bind true` to refuse startup when binding non-localhost without `--http-auth-token`.
- Keep default as non-breaking in local-only workflows.

## 6) Deferred to Phase 2 (OAuth)
- OAuth metadata discovery endpoints.
- 401 challenge handling with `WWW-Authenticate`.
- Bearer token validation on every request.
- Audience/scope enforcement.

