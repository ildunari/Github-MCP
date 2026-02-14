# GitHub MCP Server (Kosta's Version)

A Model Context Protocol (MCP) server providing comprehensive GitHub repository operations — read and write — through a simple CLI interface. Built for Claude Desktop and other MCP clients.

**v3.0.0** — Major write tools expansion (21 → 33 tools). Adds full PR lifecycle (create, update, merge, request reviewers), issue management (update, label, close), file/branch deletion, releases, repo creation, and forking. Includes deterministic shutdown, idle timeout, and env var token support.

## Features

- Repository exploration, file reading, and code search
- Full PR lifecycle: create, update, merge, request reviewers
- Issues: create, update, close, label management, comment
- Commit history, diffs, and branch comparison
- File creation, updates, and deletion via direct commits
- Branch creation and deletion (cleanup after merge)
- Release creation with auto-generated notes
- Repository creation and forking
- User/org profile info
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
```

### Global Installation

```bash
npm install -g github-mcp-server-kosta
GITHUB_TOKEN=your_token_here github-mcp-server-kosta
```

## GitHub Token Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token (classic) with these scopes:
   - `repo` (full access for private repos + all write operations)
   - `public_repo` (for public repositories, read-only)
   - `read:user` (for user information)
   - `delete_repo` (only if you plan to delete repositories)
3. Use the token with the CLI:

```bash
npx github-mcp-server-kosta --github-token ghp_your_token_here
```

## Available Tools (33)

### Repository Operations (9 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_repo_info` | Read | Get repository metadata (stars, forks, language, etc.) |
| `github_list_contents` | Read | List files/directories at a path |
| `github_get_file_content` | Read | Read a file's content (returns SHA for updates/deletes) |
| `github_get_readme` | Read | Fetch and decode the README |
| `github_search_code` | Read | Search code within a repository |
| `github_list_repos` | Read | List repositories for a user/organization |
| `github_search_repos` | Read | Search repositories globally |
| `github_create_repo` | Write | Create a new repository (with optional README, .gitignore, license) |
| `github_fork_repo` | Write | Fork a repository to your account or an organization |

### Issue Operations (6 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_list_issues` | Read | List issues (filter by state, labels, assignee) |
| `github_get_issue` | Read | Get full issue details |
| `github_create_issue` | Write | Create a new issue |
| `github_update_issue` | Write | Update issue title, body, state, labels, assignees, milestone |
| `github_add_labels` | Write | Add labels to an issue/PR without removing existing ones |
| `github_remove_label` | Write | Remove a single label from an issue/PR |

### Issue Comments (1 tool)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_create_issue_comment` | Write | Comment on an issue or PR |

### Pull Request Operations (6 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_list_pulls` | Read | List PRs (filter by state, head, base branch) |
| `github_get_pull` | Read | Get full PR details with diff stats |
| `github_create_pull_request` | Write | Create a new pull request (supports drafts) |
| `github_update_pull_request` | Write | Update PR title, body, state, or base branch |
| `github_merge_pull_request` | Write | Merge a PR (merge, squash, or rebase) |
| `github_request_reviewers` | Write | Request reviewers for a PR |

### Branch Operations (4 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_list_branches` | Read | List all branches |
| `github_create_branch` | Write | Create a new branch from a ref |
| `github_delete_branch` | Write | Delete a branch (cleanup after merge) |
| `github_compare` | Read | Compare two branches/tags/commits |

### Commit History (3 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_list_commits` | Read | List commits (filter by path, author, date) |
| `github_get_commit` | Read | Get commit details with full diff |

### File Operations (4 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_create_or_update_file` | Write | Create or update a file via commit |
| `github_delete_file` | Write | Delete a file via commit (requires file SHA) |

### Release Operations (2 tools)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_list_releases` | Read | List releases with notes and assets |
| `github_create_release` | Write | Create a release (with auto-generated notes option) |

### User Operations (1 tool)
| Tool | R/W | Description |
|------|-----|-------------|
| `github_user_info` | Read | Get user/org profile info |

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
      --idle-timeout-ms  Exit after this many ms without receiving an MCP request (0 disables). [default: 300000]
  -r, --rate-limit       Rate limit delay in ms between requests [default: 100]
  -h, --help             Show help
```

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
