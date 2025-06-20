# GitHub MCP Server

A Model Context Protocol (MCP) server that provides comprehensive GitHub repository operations through a simple CLI interface.

## Features

- 🔍 Repository exploration and file content retrieval
- 📄 README and file content access
- 🔎 Code search within repositories
- 📋 Issues and pull requests management
- 🌿 Branch and commit information
- 👤 User information lookup
- 🚀 Rate limiting and error handling
- 📦 Easy npx installation

## Installation & Usage

### Quick Start (Recommended)

```bash
# Run directly with npx (no installation needed)
npx @ildunari/github-mcp-server --github-token YOUR_GITHUB_TOKEN

# Or use environment variable
export GITHUB_TOKEN=your_token_here
npx @ildunari/github-mcp-server --github-token $GITHUB_TOKEN
```

### Global Installation

```bash
npm install -g @ildunari/github-mcp-server
@ildunari/github-mcp-server --github-token YOUR_GITHUB_TOKEN
```

## GitHub Token Setup

1. Go to GitHub Settings → Developer settings → Personal access tokens
2. Generate a new token (classic) with these scopes:
   - `repo` (for private repositories)
   - `public_repo` (for public repositories)
   - `read:user` (for user information)

3. Use the token with the CLI:
```bash
npx @ildunari/github-mcp-server --github-token ghp_your_token_here
```

## Available Tools

### Repository Operations
- `github_repo_info` - Get repository information
- `github_list_contents` - List directory contents
- `github_get_file_content` - Get file content
- `github_get_readme` - Get repository README
- `github_search_code` - Search code in repository

### Issues & Pull Requests
- `github_list_issues` - List repository issues
- `github_get_issue` - Get specific issue details
- `github_list_pulls` - List pull requests
- `github_get_pull` - Get specific pull request details

### Repository Management
- `github_list_branches` - List repository branches
- `github_user_info` - Get user information

## CLI Options

```bash
Options:
  -t, --github-token  GitHub access token for API requests [required]
  -r, --rate-limit    Rate limit delay in ms between requests [default: 100]
  -h, --help          Show help
```

## Examples

### Basic Usage
```bash
# Start the MCP server
npx @ildunari/github-mcp-server --github-token YOUR_TOKEN

# The server will run on stdio and accept MCP requests
```

### With Custom Rate Limiting
```bash
# Slower rate limiting (500ms between requests)
npx @ildunari/github-mcp-server --github-token YOUR_TOKEN --rate-limit 500
```

### MCP Client Configuration

For use with Claude Desktop or other MCP clients:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["@ildunari/github-mcp-server", "--github-token", "YOUR_GITHUB_TOKEN"]
    }
  }
}
```

## Response Formats

All tools support two detail levels:
- `summary` (default) - Condensed information
- `detailed` - Full API response

Example tool call:
```json
{
  "name": "github_repo_info",
  "arguments": {
    "repo_url": "https://github.com/microsoft/vscode",
    "detail_level": "summary"
  }
}
```

## Error Handling

The server includes comprehensive error handling for:
- Invalid GitHub URLs
- API rate limits
- Authentication errors
- Network issues
- File encoding problems

## License

MIT License

## Author

ildunari

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request