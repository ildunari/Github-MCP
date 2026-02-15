# Baseline Connector Smoke (Claude.ai -> Cloudflare -> supergateway -> github-mcp-server)

Use this checklist before and after any connector/auth change.

## Prerequisites
- Public MCP endpoint URL (for example `https://your-domain.example/mcp`)
- Optional bearer token (if edge auth is enabled)
- `curl` available locally
- Local script path:
  - `/Users/kosta/Documents/ProjectsCode/github-mcp-server/scripts/smoke/remote-mcp-smoke.sh`

## Run
```bash
cd /Users/kosta/Documents/ProjectsCode/github-mcp-server
./scripts/smoke/remote-mcp-smoke.sh "https://YOUR_DOMAIN/mcp"
```

If auth is enabled:
```bash
./scripts/smoke/remote-mcp-smoke.sh "https://YOUR_DOMAIN/mcp" "$MCP_BEARER_TOKEN"
```

## Expected outcomes
1. `initialize` succeeds and (for stateful mode) returns `Mcp-Session-Id`.
2. `notifications/initialized` succeeds.
3. `tools/list` succeeds and returns JSON-RPC content.
4. No credentials are printed in logs or command output.

## Capture for baseline record
- Date/time (UTC)
- Endpoint URL
- Protocol version used
- Status lines for initialize/initialized/tools/list
- Session behavior notes (stateful/stateless)
- Any anomalies (timeouts, 4xx/5xx, missing headers)

