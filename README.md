# GitHub MCP Server (Kosta's Version)

A Model Context Protocol (MCP) server providing comprehensive GitHub repository operations — read and write — through a simple CLI interface. Built for Claude Desktop and other MCP clients.

**v2.0.0** — 21 tools, MCP SDK v1.26.0, tool annotations, server instructions.

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
npx github-mcp-server-kosta --github-token YOUR_GITHUB_TOKEN

# Or use environment variable
export GITHUB_TOKEN=your_token_here
npx github-mcp-server-kosta --github-token $GITHUB_TOKEN
```

### Global Installation

```bash
npm install -g github-mcp-server-kosta
github-mcp-server-kosta --github-token YOUR_GITHUB_TOKEN
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

## Available Tools (21)

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
| `github_create_issue_comment` | Comment on an issue or PR |

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
  -t, --github-token  GitHub access token for API requests [required]
  -r, --rate-limit    Rate limit delay in ms between requests [default: 100]
  -h, --help          Show help
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
