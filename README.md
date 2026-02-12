# GitHub MCP Server (Kosta's Version)

A Model Context Protocol (MCP) server providing comprehensive GitHub repository operations — read and write — through a simple CLI interface. Built for Claude Desktop and other MCP clients.

**v2.2.0** — Adds optional native Streamable HTTP transport (single `/mcp` endpoint with GET/POST/DELETE), plus optional structured tool output (`structuredContent`) and `outputSchema` for better MCP 2025-11-25 alignment.

## Features

- Repository exploration, file reading, and code search
- Issues and pull requests (list, view, create, comment)
- Commit history, diffs, and branch comparison
- File creation/updates via direct commits
- Branch creation
- Release and user info
- Tool annotations (readOnly, destructive hints) for smart AI tool selection
- Server instructions for AI workflow guidance
- Rate limiting and comprehensive error handling

## Installation & Usage

### Quick Start (Recommended)

```bash
# Run directly with npx (no installation needed)
GITHUB_TOKEN=your_token_here npx github-mcp-server-kosta

# Idle auto-exit defaults to 5 minutes (prevents leaked stdio servers from piling up).
# Disable if you need an always-on process:
MCP_IDLE_TIMEOUT_MS=0 GITHUB_TOKEN=your_token_here npx github-mcp-server-kosta

# Not recommended (token is visible via `ps` on the machine):
npx github-mcp-server-kosta --github-token YOUR_GITHUB_TOKEN

# Streamable HTTP mode (native /mcp endpoint)
GITHUB_TOKEN=your_token_here npx github-mcp-server-kosta --transport http --http-port 3000
```

### Global Installation

```bash
npm install -g github-mcp-server-kosta
GITHUB_TOKEN=your_token_here github-mcp-server-kosta
```

## GitHub Token Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token (classic) with these scopes:
   - `repo` (full access for private repos + write operations)
   - `public_repo` (for public repositories, read-only)
   - `read:user` (for user information)
3. Use the token with the CLI:

```bash
npx github-mcp-server-kosta --github-token ghp_your_token_here
```

## Available Tools

### Repository Operations
| Tool | Description |
|------|-------------|
| `github_repo_info` | Get repository metadata (stars, forks, language, etc.) |
| `github_list_contents` | List files/directories at a path |
| `github_get_file_content` | Read a file's content (returns SHA for updates) |
| `github_get_readme` | Fetch and decode the README |
| `github_search_code` | Search code within a repository |
| `github_list_repos` | List repositories for a user/organization |
| `github_search_repos` | Search repositories globally |

### Issues & Pull Requests
| Tool | Description |
|------|-------------|
| `github_list_issues` | List issues (filter by state, labels, assignee) |
| `github_get_issue` | Get full issue details |
| `github_list_pulls` | List PRs (filter by state, head, base branch) |
| `github_get_pull` | Get full PR details with diff stats |
| `github_create_issue` | Create a new issue |
| `github_update_issue` | Update an issue (or PR) via Issues API (title/body/state/labels/assignees/milestone) |
| `github_create_issue_comment` | Comment on an issue or PR |
| `github_create_pull_request` | Create a pull request |
| `github_update_pull_request` | Update a pull request |
| `github_merge_pull_request` | Merge a pull request |
| `github_search_issues` | Search issues and pull requests (GitHub search syntax) |

### Branches, Commits & History
| Tool | Description |
|------|-------------|
| `github_list_branches` | List all branches |
| `github_list_commits` | List commits (filter by path, author, date) |
| `github_get_commit` | Get commit details with full diff |
| `github_compare` | Compare two branches/tags/commits |
| `github_create_branch` | Create a new branch from a ref |

### Releases & Users
| Tool | Description |
|------|-------------|
| `github_list_releases` | List releases with notes and assets |
| `github_user_info` | Get user/org profile info |

### File Operations
| Tool | Description |
|------|-------------|
| `github_create_or_update_file` | Create or update a file via commit |
| `github_delete_file` | Delete a file via commit (requires SHA) |

### Labels
| Tool | Description |
|------|-------------|
| `github_list_labels` | List repository labels |
| `github_create_label` | Create a repository label |
| `github_set_issue_labels` | Replace all labels on an issue/PR |
| `github_add_issue_labels` | Add labels to an issue/PR |
| `github_remove_issue_label` | Remove a label from an issue/PR |

### Lazy Tool Loading (Optional)
| Tool | Description |
|------|-------------|
| `github_tool_groups_list` | List tool groups and whether they are loaded |
| `github_tool_groups_load` | Load tool groups and emit `notifications/tools/list_changed` |
| `github_tool_catalog_search` | Search groups/tool names without loading all tools |

### REST Escape Hatch
| Tool | Description |
|------|-------------|
| `github_rest_get` | Generic GET against GitHub REST API (path-based) |
| `github_rest_mutate` | Generic write request (POST/PUT/PATCH/DELETE) guarded by `confirm: "CONFIRM_GITHUB_WRITE"` |

## MCP Client Configuration

For Claude Desktop (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["github-mcp-server-kosta", "--github-token", "YOUR_GITHUB_TOKEN"]
    }
  }
}
```

## CLI Options

```
Options:
  -t, --github-token     GitHub access token for API requests (or set GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN)
      --transport        Transport mode: stdio|http [default: stdio]
      --tool-mode        Tool listing mode: "full" or "lazy" [default: full]
      --preload-groups   Comma-separated tool group IDs to preload in lazy mode [default: core,search in lazy]
      --tool-schema-verbosity  Tool schema verbosity: "full" or "compact" [default: full]
      --tool-output      Tool output: text|structured|both [default: text]
      --tool-output-schema  Tool output schema: none|bootstrap|all_loose [default: none]
      --idle-timeout-ms  Exit after this many ms without receiving an MCP request (0 disables). [default: 300000]
  -r, --rate-limit       Rate limit delay in ms between requests [default: 100]
      --http-host        HTTP bind host (http transport) [default: 127.0.0.1]
      --http-port        HTTP bind port (http transport; 0 chooses ephemeral) [default: 3000]
      --http-path        MCP endpoint path (http transport) [default: /mcp]
      --http-tls-key     TLS private key path (enables https when paired with --http-tls-cert)
      --http-tls-cert    TLS cert path (enables https when paired with --http-tls-key)
      --http-auth-token  Optional Bearer token required to access /mcp
      --http-allowed-origins  Comma-separated Origin allowlist (enforced only when Origin header is present)
      --http-allowed-hosts    Comma-separated Host allowlist (recommended when binding 0.0.0.0/::)
      --http-max-sessions     Maximum concurrent MCP sessions (DoS guard) [default: 50]
      --http-require-auth-on-public-bind  Refuse startup if binding non-localhost without --http-auth-token [default: false]
      --http-oauth-resource-metadata-url  Optional URL to advertise in WWW-Authenticate as resource_metadata
      --http-oauth-protected-resource-path  Optional local path to serve OAuth protected resource metadata JSON
      --http-oauth-authorization-server-issuer  Optional authorization server issuer included in metadata
      --http-oauth-scopes  Comma-separated scopes_supported included in metadata
      --http-oauth-cutover-path  Optional second MCP endpoint path for staged OAuth cutover (example: /mcp-oauth)
      --http-oauth-cutover-token  Bearer token required on cutover endpoint (falls back to --http-auth-token)
  -h, --help             Show help
```

### Lazy Tool Loading Notes

- In `--tool-mode lazy`, the server only exposes bootstrap tools plus any preloaded groups (default: `core,search`).
- Load additional groups at runtime using `github_tool_groups_load` (e.g., `issues`, `pulls`, `rest`).
- The server advertises `tools.listChanged: true` and emits `notifications/tools/list_changed` after loading groups, but some MCP clients may not auto-refresh tool lists. If your client does not, call `tools/list` again (or restart the session).

## Streamable HTTP (`/mcp`) Notes

- `--transport http` exposes a single MCP endpoint (default `http://127.0.0.1:3000/mcp`) supporting `GET`, `POST`, and `DELETE`.
- By default the server binds to `127.0.0.1` for safety. If you bind to `0.0.0.0` or another interface, you should set `--http-auth-token` and strongly consider `--http-allowed-hosts` and `--http-allowed-origins`.
- In HTTP mode, lazy tool loading state is session-isolated: each `Mcp-Session-Id` gets its own tool-group load state.
- Optional stricter startup guard: `--http-require-auth-on-public-bind true` refuses startup when binding non-localhost without `--http-auth-token`.

### supergateway + Cloudflare Baseline

If you run this behind supergateway for Claude.ai remote connectors, pin the gateway transport/session/protocol flags explicitly:

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

See operational docs:
- `docs/ops/baseline-connector-smoke.md`
- `docs/ops/claude-connector-hardening.md`
- `docs/ops/incident-playbook.md`

Smoke scripts:
- `scripts/smoke/remote-mcp-smoke.sh`
- `scripts/smoke/edge-header-check.sh`

### OAuth Scaffolding (Phase 2 Prep)

This server now supports optional OAuth discovery/challenge scaffolding for staged rollout:

- `--http-oauth-resource-metadata-url`: when unauthenticated requests are rejected (`401`), `WWW-Authenticate` includes:
  - `Bearer resource_metadata="..."`
- `--http-oauth-protected-resource-path`: serves a local OAuth Protected Resource Metadata JSON document.
- `--http-oauth-authorization-server-issuer`: adds `authorization_servers` to the metadata JSON.
- `--http-oauth-scopes`: adds `scopes_supported` to the metadata JSON.
- `--http-oauth-cutover-path`: adds a second staged endpoint (for example `/mcp-oauth`) so you can keep `/mcp` behavior unchanged while testing auth-required connector cutover.
- `--http-oauth-cutover-token`: token required on the cutover endpoint; if unset, the server falls back to `--http-auth-token`.

Example:

```bash
npx github-mcp-server-kosta \
  --transport http \
  --http-host 127.0.0.1 \
  --http-port 3000 \
  --http-path /mcp \
  --http-auth-token "$MCP_BEARER_TOKEN" \
  --http-oauth-resource-metadata-url "https://connector.example.com/.well-known/oauth-protected-resource" \
  --http-oauth-protected-resource-path "/.well-known/oauth-protected-resource" \
  --http-oauth-authorization-server-issuer "https://auth.example.com" \
  --http-oauth-scopes "mcp.read,mcp.write"
```

Staged cutover example (`/mcp` open, `/mcp-oauth` protected):

```bash
npx github-mcp-server-kosta \
  --transport http \
  --http-host 127.0.0.1 \
  --http-port 3000 \
  --http-path /mcp \
  --http-oauth-cutover-path /mcp-oauth \
  --http-oauth-cutover-token "$MCP_CUTOVER_TOKEN"
```

Important:
- This is scaffolding for phased rollout, not a complete OAuth authorization server implementation.
- In production Claude.ai connector deployments, the recommended pattern is still edge/gateway-owned OAuth.

### Plain-English Security Guidance

If you only ever run this on your own machine and nothing else can reach it, you can usually skip authentication.

If you bind the HTTP server to a network interface that other devices can reach (for example `--http-host 0.0.0.0`), then anyone who can access that address could potentially use your GitHub token via these tools. In that case you should:

- Prefer putting authentication at your gateway (supergateway / Cloudflare / your connector) so the MCP server itself can remain localhost-only.
- Or set `--http-auth-token` so the `/mcp` endpoint requires a Bearer token.

## Response Formats

Most tools support two detail levels:
- `summary` (default) — concise key fields, 5-item previews for lists
- `detailed` — full GitHub API response

## Tool Annotations

All tools include MCP annotations to help AI clients make smart decisions:
- `readOnlyHint` — safe to call without side effects
- `destructiveHint` — may modify or delete data (e.g., file updates)
- `idempotentHint` — safe to retry with same arguments
- `openWorldHint` — interacts with external GitHub API

## Server Instructions

The server provides workflow guidance to AI models, including:
- Tool relationships (e.g., "use `github_get_file_content` to get SHA before `github_create_or_update_file`")
- Rate limiting info
- Token permission requirements
- Response mode recommendations

## License

MIT License

## Author

Kosta Milovanovic (ildunari)

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request
