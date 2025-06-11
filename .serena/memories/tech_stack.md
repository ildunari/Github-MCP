# Tech Stack

- **Language**: JavaScript (Node.js)
- **Module System**: ES Modules (`"type": "module"` in package.json)
- **Key Dependencies**:
  - `@modelcontextprotocol/sdk`: MCP protocol implementation
  - `node-fetch`: HTTP requests to GitHub API
  - `yargs`: CLI argument parsing
- **Target Node Version**: >=18.0.0
- **Package Manager**: npm

**Architecture**: Single-file MCP server that communicates via stdio with rate limiting and error handling.