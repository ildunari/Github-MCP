# OAuth Scaffold (Phase 2 Preparation)

This document explains the OAuth-related scaffolding now available in the MCP HTTP server for staged deployment testing.

## What this scaffold does

1. Adds `resource_metadata` in `WWW-Authenticate` for unauthorized requests when configured.
2. Optionally serves a local Protected Resource Metadata JSON endpoint.
3. Lets you include `authorization_servers` and `scopes_supported` in that metadata document.

## What this scaffold does **not** do

- It is **not** a full OAuth authorization server.
- It does **not** replace gateway/edge token validation strategy.
- It does **not** implement end-to-end OAuth login UI flow for connector users by itself.

## Flags

- `--http-oauth-resource-metadata-url`
- `--http-oauth-protected-resource-path`
- `--http-oauth-authorization-server-issuer`
- `--http-oauth-scopes`
- `--http-oauth-cutover-path`
- `--http-oauth-cutover-token`

## Minimal local validation

Start server:

```bash
cd /Users/kosta/Documents/ProjectsCode/github-mcp-server
GITHUB_TOKEN=... node src/index.js \
  --transport http \
  --http-port 3000 \
  --http-auth-token test-token \
  --http-oauth-resource-metadata-url "https://connector.example.com/.well-known/oauth-protected-resource" \
  --http-oauth-protected-resource-path "/.well-known/oauth-protected-resource" \
  --http-oauth-authorization-server-issuer "https://auth.example.com" \
  --http-oauth-scopes "mcp.read,mcp.write"
```

Check metadata endpoint:

```bash
curl -iS http://127.0.0.1:3000/.well-known/oauth-protected-resource
```

Check challenge:

```bash
curl -iS http://127.0.0.1:3000/mcp
```

Expected:
- `401 Unauthorized`
- `WWW-Authenticate: Bearer resource_metadata="..."`

## Staged cutover mode

Use this when you want to keep your existing `/mcp` endpoint behavior but test an auth-required connector path in parallel:

```bash
cd /Users/kosta/Documents/ProjectsCode/github-mcp-server
GITHUB_TOKEN=... node src/index.js \
  --transport http \
  --http-port 3000 \
  --http-path /mcp \
  --http-oauth-cutover-path /mcp-oauth \
  --http-oauth-cutover-token test-cutover-token
```

Behavior:
1. `/mcp` follows the primary endpoint auth behavior.
2. `/mcp-oauth` always requires bearer token auth (token above, or fallback `--http-auth-token`).
3. Sessions are endpoint-bound (a session created on `/mcp-oauth` is not valid on `/mcp`).
