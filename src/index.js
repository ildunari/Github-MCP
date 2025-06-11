#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

// Parse command line arguments
const argv = yargs(hideBin(process.argv))
  .option('github-token', {
    alias: 't',
    type: 'string',
    description: 'GitHub access token for API requests',
    demandOption: true,
  })
  .option('rate-limit', {
    alias: 'r',
    type: 'number',
    description: 'Rate limit delay in ms between requests',
    default: 100,
  })
  .help()
  .alias('help', 'h')
  .example(
    'npx github-mcp-server-kosta --github-token ghp_your_token_here',
    'Run the GitHub MCP server with your access token'
  )
  .example(
    'npx github-mcp-server-kosta -t $GITHUB_TOKEN',
    'Run with token from environment variable'
  )
  .parse();

const GITHUB_TOKEN = argv.githubToken;
const RATE_LIMIT_DELAY = argv.rateLimit;
const API_BASE_URL = 'https://api.github.com';

const HEADERS = {
  'Authorization': `Bearer ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'GitHub-MCP-Server/1.0.0'
};

// Rate limiting
let lastRequestTime = 0;
async function rateLimitedRequest(url, options = {}) {
  const now = Date.now();
  const timeSinceLastRequest = now - lastRequestTime;
  if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
    await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest));
  }
  lastRequestTime = Date.now();
  return fetch(url, { headers: HEADERS, ...options });
}

// Helper Functions
function parseRepoUrl(url) {
  try {
    const parsedUrl = new URL(url);
    if (parsedUrl.hostname !== 'github.com') {
      throw new Error('URL must be a github.com URL.');
    }
    const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      throw new Error('URL path must include owner and repository name.');
    }
    return { owner: pathParts[0], repo: pathParts[1] };
  } catch (e) {
    throw new Error(`Invalid repository URL format: ${url}. Please use format like https://github.com/owner/repo.`);
  }
}

function atobUtf8(b64) {
  try {
    return Buffer.from(b64, 'base64').toString('utf-8');
  } catch (e) {
    throw new Error('Failed to decode Base64 content.');
  }
}

async function fetchJson(url, options = {}) {
  try {
    const response = await rateLimitedRequest(url, options);
    if (!response.ok) {
      let errorBody = '';
      try {
        const errorData = await response.json();
        errorBody = errorData.message || JSON.stringify(errorData);
      } catch (e) {
        try {
          errorBody = await response.text();
        } catch (textError) {
          errorBody = '(Could not retrieve error body)';
        }
      }
      throw new Error(`GitHub API Error ${response.status}: ${response.statusText}. ${errorBody}`);
    }
    
    if (response.status === 204 || response.headers.get('Content-Length') === '0') {
      return null;
    }
    return await response.json();
  } catch (error) {
    throw error;
  }
}

async function fetchAllItems(initialUrl) {
  let items = [];
  let url = initialUrl;
  while (url) {
    const response = await rateLimitedRequest(url);
    if (!response.ok) {
      let errorBody = '';
      try {
        const errorData = await response.json();
        errorBody = errorData.message || JSON.stringify(errorData);
      } catch (e) {
        try {
          errorBody = await response.text();
        } catch (textError) {
          errorBody = '(Could not retrieve error body)';
        }
      }
      throw new Error(`GitHub API Error (Pagination) ${response.status}: ${response.statusText}. ${errorBody}`);
    }

    const data = await response.json();
    if (Array.isArray(data)) {
      items.push(...data);
    } else {
      if (data && Array.isArray(data.items)) {
        items.push(...data.items);
      } else {
        break;
      }
    }

    const linkHeader = response.headers.get('link');
    const nextLinkMatch = linkHeader ? linkHeader.match(/<([^>]+)>;\s*rel="next"/) : null;
    url = nextLinkMatch ? nextLinkMatch[1] : null;
  }
  return items;
}

function summarize(data, detailLevel = 'summary') {
  if (!data) return null;
  if (detailLevel === 'detailed') return data;

  if (Array.isArray(data)) {
    if (data.length === 0) return { total_items: 0, preview: [] };
    const key = ['name', 'login', 'title', 'path'].find(k => data[0]?.hasOwnProperty(k));
    return {
      total_items: data.length,
      preview: data.slice(0, 5).map(item => item && (key ? item[key] : `Item (type: ${item.type || 'unknown'})`))
    };
  }

  const summary = {
    name: data.name || data.login || data.title || data.path,
    url: data.html_url || data.url,
    type: data.type
  };
  
  if (data.description) summary.description = data.description;
  if (data.stargazers_count != null) summary.stars = data.stargazers_count;
  if (data.forks_count != null) summary.forks = data.forks_count;
  if (data.open_issues_count != null) summary.open_issues = data.open_issues_count;
  if (data.size != null) summary.size = data.size;
  if (data.sha) summary.sha = data.sha;

  Object.keys(summary).forEach(key => summary[key] === undefined && delete summary[key]);
  return summary;
}

function buildContentsUrl(owner, repo, path = '', ref) {
  const cleanPath = path ? path.replace(/^\/+/, '') : '';
  const base = `${API_BASE_URL}/repos/${owner}/${repo}/contents`;
  const pathSegment = cleanPath ? `/${encodeURIComponent(cleanPath)}` : '';
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return `${base}${pathSegment}${refQuery}`;
}

function buildReadmeUrl(owner, repo, ref) {
  const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return `${API_BASE_URL}/repos/${owner}/${repo}/readme${refQuery}`;
}

// MCP Server Setup
const server = new Server(
  {
    name: 'github-mcp-server-kosta',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool Definitions
const TOOLS = [
  {
    name: 'github_repo_info',
    description: 'Get information about a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL (e.g., https://github.com/owner/repo)'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_list_contents',
    description: 'List contents of a directory in a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        path: {
          type: 'string',
          description: 'Path within the repository (optional, defaults to root)',
          default: ''
        },
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit SHA (optional)'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_file_content',
    description: 'Get the content of a specific file from a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        path: {
          type: 'string',
          description: 'Path to the file within the repository'
        },
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit SHA (optional)'
        }
      },
      required: ['repo_url', 'path']
    }
  },
  {
    name: 'github_get_readme',
    description: 'Get the README content of a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        ref: {
          type: 'string',
          description: 'Branch, tag, or commit SHA (optional)'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_search_code',
    description: 'Search for code within a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        query: {
          type: 'string',
          description: 'Search query'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url', 'query']
    }
  },
  {
    name: 'github_list_issues',
    description: 'List issues in a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_issue',
    description: 'Get details of a specific issue',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        issue_number: {
          type: 'number',
          description: 'Issue number'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url', 'issue_number']
    }
  },
  {
    name: 'github_list_pulls',
    description: 'List pull requests in a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_pull',
    description: 'Get details of a specific pull request',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        pull_number: {
          type: 'number',
          description: 'Pull request number'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url', 'pull_number']
    }
  },
  {
    name: 'github_list_branches',
    description: 'List branches in a GitHub repository',
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_user_info',
    description: 'Get information about a GitHub user',
    inputSchema: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'GitHub username'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Level of detail in response',
          default: 'summary'
        }
      },
      required: ['username']
    }
  }
];

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOLS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    let result;
    const detailLevel = args.detail_level || 'summary';

    switch (name) {
      case 'github_user_info': {
        if (!args.username) {
          throw new Error("Parameter 'username' is required for action 'github_user_info'.");
        }
        result = await fetchJson(`${API_BASE_URL}/users/${encodeURIComponent(args.username)}`);
        break;
      }
      
      case 'github_repo_info': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_repo_info'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}`);
        break;
      }

      case 'github_list_contents': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_list_contents'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(buildContentsUrl(owner, repo, args.path, args.ref));
        break;
      }

      case 'github_get_file_content': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_get_file_content'.");
        }
        if (!args.path) {
          throw new Error("Parameter 'path' is required for action 'github_get_file_content'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const fileData = await fetchJson(buildContentsUrl(owner, repo, args.path, args.ref));
        
        if (!fileData || fileData.type !== 'file' || typeof fileData.content !== 'string') {
          if (fileData && fileData.type === 'dir') {
            throw new Error(`Path '${args.path}' is a directory, not a file. Use 'github_list_contents' action.`);
          }
          if (fileData && fileData.content === undefined && fileData.size > 0) {
            throw new Error(`File content for '${args.path}' is too large to retrieve via this API method. Size: ${fileData.size} bytes.`);
          }
          throw new Error(`Could not retrieve file content for path: ${args.path}. It might not be a file or an error occurred.`);
        }
        
        if (fileData.encoding !== 'base64') {
          return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: fileData.name,
                path: fileData.path,
                size: fileData.size,
                encoding: fileData.encoding,
                content: fileData.content,
                sha: fileData.sha,
                html_url: fileData.html_url
              }, null, 2),
            },
          ],
        };
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: fileData.name,
                path: fileData.path,
                size: fileData.size,
                encoding: 'utf-8',
                content: atobUtf8(fileData.content),
                sha: fileData.sha,
                html_url: fileData.html_url
              }, null, 2),
            },
          ],
        };
      }

      case 'github_get_readme': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_get_readme'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const readmeData = await fetchJson(buildReadmeUrl(owner, repo, args.ref));
        
        if (!readmeData || typeof readmeData.content !== 'string') {
          throw new Error(`Could not retrieve README content for repository: ${args.repo_url}.`);
        }
        
        if (readmeData.encoding !== 'base64') {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  name: readmeData.name,
                  path: readmeData.path,
                  size: readmeData.size,
                  encoding: readmeData.encoding,
                  content: readmeData.content,
                  sha: readmeData.sha,
                  html_url: readmeData.html_url
                }, null, 2),
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                name: readmeData.name,
                path: readmeData.path,
                size: readmeData.size,
                encoding: 'utf-8',
                content: atobUtf8(readmeData.content),
                sha: readmeData.sha,
                html_url: readmeData.html_url
              }, null, 2),
            },
          ],
        };
      }

      case 'github_search_code': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_search_code'.");
        }
        if (!args.query) {
          throw new Error("Parameter 'query' is required for action 'github_search_code'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const searchParams = new URLSearchParams({
          q: `${args.query} repo:${owner}/${repo}`
        });
        const url = `${API_BASE_URL}/search/code?${searchParams.toString()}`;
        const searchResponse = await fetchJson(url);
        result = searchResponse.items || [];
        break;
      }

      case 'github_list_issues': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_list_issues'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/issues?state=all&per_page=100`);
        break;
      }

      case 'github_get_issue': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_get_issue'.");
        }
        if (args.issue_number == null) {
          throw new Error("Parameter 'issue_number' is required for action 'github_get_issue'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}`);
        break;
      }

      case 'github_list_pulls': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_list_pulls'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/pulls?state=all&per_page=100`);
        break;
      }

      case 'github_get_pull': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_get_pull'.");
        }
        if (args.pull_number == null) {
          throw new Error("Parameter 'pull_number' is required for action 'github_get_pull'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}`);
        break;
      }

      case 'github_list_branches': {
        if (!args.repo_url) {
          throw new Error("Parameter 'repo_url' is required for action 'github_list_branches'.");
        }
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/branches?per_page=100`);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    // Apply summarization for actions that didn't return early
    const finalResult = ['github_get_file_content', 'github_get_readme', 'github_get_issue', 'github_get_pull'].includes(name) 
      ? result 
      : summarize(result, detailLevel);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(finalResult, null, 2),
        },
      ],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `GitHub MCP Server Error: ${error.message}`
    );
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitHub MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});