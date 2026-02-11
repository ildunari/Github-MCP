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

// ─── CLI Parsing ────────────────────────────────────────────────────────────────

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
  'User-Agent': 'GitHub-MCP-Server/2.0.0'
};

// ─── Helper Functions ───────────────────────────────────────────────────────────

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

async function fetchWithBody(url, method, body) {
  try {
    const response = await rateLimitedRequest(url, {
      method,
      headers: {
        ...HEADERS,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
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

// ─── Server Instructions ────────────────────────────────────────────────────────

const SERVER_INSTRUCTIONS = `GitHub MCP Server — provides read and write access to GitHub repositories via the GitHub REST API.

Tool Relationships & Workflows:
- Explore: github_repo_info → github_list_contents → github_get_file_content (overview → browse → read)
- Quick context: github_get_readme for project understanding before diving into code
- Search: github_search_code (within a repo) or github_search_repos (find repos globally)
- Issues: github_list_issues → github_get_issue for details → github_create_issue_comment to respond
- PRs: github_list_pulls → github_get_pull for details
- History: github_list_commits → github_get_commit for specific change details
- Branching: github_compare to diff branches → github_create_branch for safe changes → github_create_or_update_file to commit
- File editing: github_get_file_content (get SHA) → github_create_or_update_file (update with SHA)

Rate Limiting: All requests have a configurable delay (default 100ms). GitHub API allows 5,000 requests/hour for authenticated users.

Token Permissions:
- Read operations: "repo" scope (or "public_repo" for public repos only)
- Write operations (create issue/comment/file/branch): "repo" scope required
- User info: "read:user" scope

Response Modes: Most tools accept detail_level "summary" (default, concise) or "detailed" (full API response). Use "summary" to conserve tokens.`;

// ─── MCP Server Setup ───────────────────────────────────────────────────────────

const server = new Server(
  {
    name: '@ildunari/github-mcp-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ─── Tool Definitions ───────────────────────────────────────────────────────────

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const TOOLS = [
  // ── Repository Operations ──────────────────────────────────────────────────

  {
    name: 'github_repo_info',
    description: 'Retrieve metadata for a GitHub repository including stars, forks, open issues count, default branch, visibility, and language breakdown. Use as a starting point to understand a repository before exploring its contents.',
    annotations: { title: 'Get Repository Info', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL (e.g., "https://github.com/facebook/react")'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail: "summary" returns key metrics; "detailed" returns full API response.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_list_contents',
    description: 'List files and directories at a given path in a GitHub repository. Returns names, types (file/dir/submodule), and sizes. Use to explore repository structure before reading specific files with github_get_file_content.',
    annotations: { title: 'List Directory Contents', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL (e.g., "https://github.com/owner/repo")'
        },
        path: {
          type: 'string',
          description: 'Path within the repository (e.g., "src/components"). Defaults to root.',
          default: ''
        },
        ref: {
          type: 'string',
          description: 'Branch name, tag, or commit SHA. Defaults to the default branch.'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail: "summary" returns names and types; "detailed" includes SHAs and URLs.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_file_content',
    description: 'Read the contents of a single file from a GitHub repository. Returns decoded UTF-8 text, the file SHA (needed for updates via github_create_or_update_file), size, and URL. Files over 1MB cannot be retrieved via this endpoint.',
    annotations: { title: 'Get File Content', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL (e.g., "https://github.com/owner/repo")'
        },
        path: {
          type: 'string',
          description: 'Path to the file (e.g., "src/index.js" or "README.md")'
        },
        ref: {
          type: 'string',
          description: 'Branch name, tag, or commit SHA. Defaults to the default branch.'
        }
      },
      required: ['repo_url', 'path']
    }
  },
  {
    name: 'github_get_readme',
    description: 'Fetch and decode the README file of a GitHub repository. Automatically finds README regardless of casing or extension. Returns decoded content for quick project understanding.',
    annotations: { title: 'Get README', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL (e.g., "https://github.com/owner/repo")'
        },
        ref: {
          type: 'string',
          description: 'Branch name, tag, or commit SHA. Defaults to the default branch.'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_search_code',
    description: 'Search for code matching a query within a specific GitHub repository. Returns file paths and text fragments. Supports GitHub qualifiers like language:, filename:, extension:, and path: in the query string.',
    annotations: { title: 'Search Code in Repo', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'GitHub repository URL to search within'
        },
        query: {
          type: 'string',
          description: 'Search query. Supports qualifiers: "useState language:typescript", "filename:package.json", "extension:yml path:.github"'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail: "summary" returns file paths; "detailed" includes text matches and scores.',
          default: 'summary'
        }
      },
      required: ['repo_url', 'query']
    }
  },
  {
    name: 'github_list_repos',
    description: 'List repositories for a specific GitHub user or organization. Returns names, descriptions, languages, and star counts. Use github_search_repos for global search or this tool when you know the owner.',
    annotations: { title: 'List User/Org Repos', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'GitHub username or organization name (e.g., "octocat" or "microsoft")'
        },
        type: {
          type: 'string',
          enum: ['all', 'owner', 'member'],
          description: 'Filter by ownership type.',
          default: 'owner'
        },
        sort: {
          type: 'string',
          enum: ['created', 'updated', 'pushed', 'full_name'],
          description: 'Sort field.',
          default: 'full_name'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 30
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['username']
    }
  },
  {
    name: 'github_search_repos',
    description: 'Search GitHub repositories globally by keyword, language, stars, or other qualifiers. Returns matching repository names, descriptions, and star counts. Supports qualifiers like "language:", "stars:>100", "topic:", "org:".',
    annotations: { title: 'Search Repositories', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query with optional qualifiers (e.g., "machine learning language:python stars:>1000")'
        },
        sort: {
          type: 'string',
          enum: ['stars', 'forks', 'help-wanted-issues', 'updated'],
          description: 'Sort field. Omit for best-match relevance.'
        },
        order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order.',
          default: 'desc'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 30
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['query']
    }
  },

  // ── Issues & Pull Requests ─────────────────────────────────────────────────

  {
    name: 'github_list_issues',
    description: 'List issues in a GitHub repository with optional filtering by state, labels, and assignee. Returns titles, numbers, states, and labels. Note: GitHub API includes pull requests as issues; filter by absence of pull_request field for true issues.',
    annotations: { title: 'List Issues', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by issue state.',
          default: 'all'
        },
        labels: {
          type: 'string',
          description: 'Comma-separated label names to filter by (e.g., "bug,help wanted")'
        },
        assignee: {
          type: 'string',
          description: 'Filter by assignee username. Use "*" for any assignee, "none" for unassigned.'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 100
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_issue',
    description: 'Retrieve full details of a specific issue by number, including title, body (Markdown), state, labels, assignees, milestone, and comments count. Use after github_list_issues to get complete information.',
    annotations: { title: 'Get Issue Details', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        issue_number: {
          type: 'number',
          description: 'The issue number (e.g., 42)'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url', 'issue_number']
    }
  },
  {
    name: 'github_list_pulls',
    description: 'List pull requests in a GitHub repository with optional filtering by state, head branch, and base branch. Returns PR titles, numbers, states, authors, and branch info.',
    annotations: { title: 'List Pull Requests', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'all'],
          description: 'Filter by PR state.',
          default: 'all'
        },
        head: {
          type: 'string',
          description: 'Filter by head branch name (e.g., "feature-branch")'
        },
        base: {
          type: 'string',
          description: 'Filter by base branch name (e.g., "main")'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 100
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_pull',
    description: 'Retrieve full details of a specific pull request by number, including title, body, diff stats (additions/deletions/changed files), merge status, head/base branches, and review status.',
    annotations: { title: 'Get Pull Request Details', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        pull_number: {
          type: 'number',
          description: 'The pull request number (e.g., 123)'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url', 'pull_number']
    }
  },

  // ── Branches, Commits & History ────────────────────────────────────────────

  {
    name: 'github_list_branches',
    description: 'List all branches in a GitHub repository. Returns branch names, commit SHAs, and protection status. Use to discover branches before switching refs in other tools.',
    annotations: { title: 'List Branches', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_list_commits',
    description: 'List commits in a GitHub repository with optional filtering by file path, author, branch, and date range. Returns SHAs, messages, authors, and timestamps. Useful for understanding recent changes or tracking file history.',
    annotations: { title: 'List Commits', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        sha: {
          type: 'string',
          description: 'Branch name, tag, or SHA to list commits from. Defaults to the default branch.'
        },
        path: {
          type: 'string',
          description: 'Only commits modifying this file path (e.g., "src/index.js")'
        },
        author: {
          type: 'string',
          description: 'Filter by author username or email'
        },
        since: {
          type: 'string',
          description: 'Only commits after this ISO 8601 date (e.g., "2024-01-01T00:00:00Z")'
        },
        until: {
          type: 'string',
          description: 'Only commits before this ISO 8601 date'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 30
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },
  {
    name: 'github_get_commit',
    description: 'Retrieve full details of a specific commit by SHA, including message, author, timestamp, parent SHAs, and the complete diff (files changed with patches). Use after github_list_commits to inspect a change.',
    annotations: { title: 'Get Commit Details', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        sha: {
          type: 'string',
          description: 'Full or abbreviated commit SHA (e.g., "abc1234")'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: '"summary" returns message and stats; "detailed" includes full patch diffs.',
          default: 'summary'
        }
      },
      required: ['repo_url', 'sha']
    }
  },
  {
    name: 'github_compare',
    description: 'Compare two git refs (branches, tags, or commits) and return the diff. Shows ahead/behind counts, commit list, and file changes. Useful for reviewing changes between releases or branches.',
    annotations: { title: 'Compare Refs', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        base: {
          type: 'string',
          description: 'Base ref: branch name (e.g., "main"), tag (e.g., "v1.0.0"), or commit SHA'
        },
        head: {
          type: 'string',
          description: 'Head ref (the "newer" side): branch name, tag, or commit SHA'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: '"summary" returns stats and commit list; "detailed" includes file patches.',
          default: 'summary'
        }
      },
      required: ['repo_url', 'base', 'head']
    }
  },

  // ── Releases ───────────────────────────────────────────────────────────────

  {
    name: 'github_list_releases',
    description: 'List releases in a GitHub repository including names, tag names, publication dates, pre-release status, and release notes. Returns asset download URLs.',
    annotations: { title: 'List Releases', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        per_page: {
          type: 'number',
          description: 'Results per page (max 100).',
          default: 30
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['repo_url']
    }
  },

  // ── Users ──────────────────────────────────────────────────────────────────

  {
    name: 'github_user_info',
    description: 'Retrieve a GitHub user\'s public profile: name, bio, company, location, public repo count, followers, and account creation date. Works for user and organization accounts.',
    annotations: { title: 'Get User Info', ...READ_ANNOTATIONS },
    inputSchema: {
      type: 'object',
      properties: {
        username: {
          type: 'string',
          description: 'GitHub username or organization name (e.g., "octocat")'
        },
        detail_level: {
          type: 'string',
          enum: ['summary', 'detailed'],
          description: 'Response detail level.',
          default: 'summary'
        }
      },
      required: ['username']
    }
  },

  // ── Write Operations ───────────────────────────────────────────────────────

  {
    name: 'github_create_issue',
    description: 'Create a new issue in a GitHub repository. Requires a title; optionally set body (Markdown), labels, assignees, and milestone. Returns the created issue number and URL. Requires "repo" token scope.',
    annotations: {
      title: 'Create Issue',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        title: {
          type: 'string',
          description: 'Issue title (concise summary)'
        },
        body: {
          type: 'string',
          description: 'Issue body in GitHub-flavored Markdown'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label names to apply (e.g., ["bug", "priority:high"]). Labels must exist in the repo.'
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Usernames to assign (e.g., ["octocat"])'
        },
        milestone: {
          type: 'number',
          description: 'Milestone number (not title) to associate with'
        }
      },
      required: ['repo_url', 'title']
    }
  },
  {
    name: 'github_create_issue_comment',
    description: 'Add a comment to an existing issue or pull request. Body supports GitHub-flavored Markdown. Works for both issues and PRs (they share the same comment API). Returns the comment ID and URL.',
    annotations: {
      title: 'Comment on Issue/PR',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        issue_number: {
          type: 'number',
          description: 'Issue or pull request number to comment on (e.g., 42)'
        },
        body: {
          type: 'string',
          description: 'Comment body in GitHub-flavored Markdown'
        }
      },
      required: ['repo_url', 'issue_number', 'body']
    }
  },
  {
    name: 'github_create_or_update_file',
    description: 'Create a new file or update an existing file in a GitHub repository via a direct commit. For updates, you MUST provide the current file SHA (get it from github_get_file_content). Content should be the full file text (not a diff). Creates a commit on the specified branch.',
    annotations: {
      title: 'Create or Update File',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        path: {
          type: 'string',
          description: 'File path in the repo (e.g., "src/config.json")'
        },
        content: {
          type: 'string',
          description: 'Full file content as UTF-8 text. Will be Base64-encoded automatically.'
        },
        message: {
          type: 'string',
          description: 'Git commit message (e.g., "Add config file")'
        },
        branch: {
          type: 'string',
          description: 'Branch to commit to. Defaults to the default branch.'
        },
        sha: {
          type: 'string',
          description: 'Current file SHA. REQUIRED for updates (from github_get_file_content). Omit for new files.'
        }
      },
      required: ['repo_url', 'path', 'content', 'message']
    }
  },
  {
    name: 'github_create_branch',
    description: 'Create a new branch in a GitHub repository from an existing ref. Resolves the source ref to a commit SHA, then creates the branch. Use before github_create_or_update_file for safe changes on a separate branch.',
    annotations: {
      title: 'Create Branch',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        repo_url: {
          type: 'string',
          description: 'Full GitHub repository URL'
        },
        branch_name: {
          type: 'string',
          description: 'New branch name (e.g., "feature/add-login"). Do not include "refs/heads/" prefix.'
        },
        from_ref: {
          type: 'string',
          description: 'Source ref: branch name, tag, or commit SHA. Defaults to the default branch.'
        }
      },
      required: ['repo_url', 'branch_name']
    }
  },
];

// ─── Request Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    const detailLevel = args.detail_level || 'summary';

    switch (name) {

      // ── Repository Operations ────────────────────────────────────────────

      case 'github_user_info': {
        if (!args.username) throw new Error("Parameter 'username' is required.");
        result = await fetchJson(`${API_BASE_URL}/users/${encodeURIComponent(args.username)}`);
        break;
      }

      case 'github_repo_info': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}`);
        break;
      }

      case 'github_list_contents': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(buildContentsUrl(owner, repo, args.path, args.ref));
        break;
      }

      case 'github_get_file_content': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.path) throw new Error("Parameter 'path' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const fileData = await fetchJson(buildContentsUrl(owner, repo, args.path, args.ref));

        if (!fileData || fileData.type !== 'file' || typeof fileData.content !== 'string') {
          if (fileData && fileData.type === 'dir') {
            throw new Error(`Path '${args.path}' is a directory, not a file. Use 'github_list_contents'.`);
          }
          if (fileData && fileData.content === undefined && fileData.size > 0) {
            throw new Error(`File '${args.path}' is too large (${fileData.size} bytes). GitHub Contents API limit is ~1MB.`);
          }
          throw new Error(`Could not retrieve file content for: ${args.path}.`);
        }

        if (fileData.encoding !== 'base64') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                name: fileData.name, path: fileData.path, size: fileData.size,
                encoding: fileData.encoding, content: fileData.content,
                sha: fileData.sha, html_url: fileData.html_url
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              name: fileData.name, path: fileData.path, size: fileData.size,
              encoding: 'utf-8', content: atobUtf8(fileData.content),
              sha: fileData.sha, html_url: fileData.html_url
            }, null, 2),
          }],
        };
      }

      case 'github_get_readme': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const readmeData = await fetchJson(buildReadmeUrl(owner, repo, args.ref));

        if (!readmeData || typeof readmeData.content !== 'string') {
          throw new Error(`Could not retrieve README for: ${args.repo_url}.`);
        }

        if (readmeData.encoding !== 'base64') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                name: readmeData.name, path: readmeData.path, size: readmeData.size,
                encoding: readmeData.encoding, content: readmeData.content,
                sha: readmeData.sha, html_url: readmeData.html_url
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              name: readmeData.name, path: readmeData.path, size: readmeData.size,
              encoding: 'utf-8', content: atobUtf8(readmeData.content),
              sha: readmeData.sha, html_url: readmeData.html_url
            }, null, 2),
          }],
        };
      }

      case 'github_search_code': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.query) throw new Error("Parameter 'query' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const searchParams = new URLSearchParams({ q: `${args.query} repo:${owner}/${repo}` });
        const searchResponse = await fetchJson(`${API_BASE_URL}/search/code?${searchParams.toString()}`);
        result = searchResponse.items || [];
        break;
      }

      case 'github_list_repos': {
        if (!args.username) throw new Error("Parameter 'username' is required.");
        const params = new URLSearchParams();
        params.set('per_page', String(args.per_page || 30));
        if (args.type) params.set('type', args.type);
        if (args.sort) params.set('sort', args.sort);
        result = await fetchJson(
          `${API_BASE_URL}/users/${encodeURIComponent(args.username)}/repos?${params.toString()}`
        );
        break;
      }

      case 'github_search_repos': {
        if (!args.query) throw new Error("Parameter 'query' is required.");
        const params = new URLSearchParams();
        params.set('q', args.query);
        params.set('per_page', String(args.per_page || 30));
        if (args.sort) params.set('sort', args.sort);
        if (args.order) params.set('order', args.order);
        const searchResponse = await fetchJson(`${API_BASE_URL}/search/repositories?${params.toString()}`);
        result = searchResponse.items || [];
        break;
      }

      // ── Issues & Pull Requests ───────────────────────────────────────────

      case 'github_list_issues': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const params = new URLSearchParams();
        params.set('state', args.state || 'all');
        params.set('per_page', String(args.per_page || 100));
        if (args.labels) params.set('labels', args.labels);
        if (args.assignee) params.set('assignee', args.assignee);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/issues?${params.toString()}`);
        break;
      }

      case 'github_get_issue': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.issue_number == null) throw new Error("Parameter 'issue_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}`);
        break;
      }

      case 'github_list_pulls': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const params = new URLSearchParams();
        params.set('state', args.state || 'all');
        params.set('per_page', String(args.per_page || 100));
        if (args.head) params.set('head', args.head);
        if (args.base) params.set('base', args.base);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/pulls?${params.toString()}`);
        break;
      }

      case 'github_get_pull': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.pull_number == null) throw new Error("Parameter 'pull_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}`);
        break;
      }

      // ── Branches, Commits & History ──────────────────────────────────────

      case 'github_list_branches': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchAllItems(`${API_BASE_URL}/repos/${owner}/${repo}/branches?per_page=100`);
        break;
      }

      case 'github_list_commits': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const params = new URLSearchParams();
        params.set('per_page', String(args.per_page || 30));
        if (args.sha) params.set('sha', args.sha);
        if (args.path) params.set('path', args.path);
        if (args.author) params.set('author', args.author);
        if (args.since) params.set('since', args.since);
        if (args.until) params.set('until', args.until);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/commits?${params.toString()}`);
        break;
      }

      case 'github_get_commit': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.sha) throw new Error("Parameter 'sha' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/commits/${encodeURIComponent(args.sha)}`);
        break;
      }

      case 'github_compare': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.base) throw new Error("Parameter 'base' is required.");
        if (!args.head) throw new Error("Parameter 'head' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchJson(
          `${API_BASE_URL}/repos/${owner}/${repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`
        );
        break;
      }

      // ── Releases ─────────────────────────────────────────────────────────

      case 'github_list_releases': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const params = new URLSearchParams();
        params.set('per_page', String(args.per_page || 30));
        result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}/releases?${params.toString()}`);
        break;
      }

      // ── Write Operations ─────────────────────────────────────────────────

      case 'github_create_issue': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.title) throw new Error("Parameter 'title' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = { title: args.title };
        if (args.body) body.body = args.body;
        if (args.labels) body.labels = args.labels;
        if (args.assignees) body.assignees = args.assignees;
        if (args.milestone) body.milestone = args.milestone;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/issues`,
          'POST', body
        );
        break;
      }

      case 'github_create_issue_comment': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.issue_number == null) throw new Error("Parameter 'issue_number' is required.");
        if (!args.body) throw new Error("Parameter 'body' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/comments`,
          'POST', { body: args.body }
        );
        break;
      }

      case 'github_create_or_update_file': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.path) throw new Error("Parameter 'path' is required.");
        if (!args.content) throw new Error("Parameter 'content' is required.");
        if (!args.message) throw new Error("Parameter 'message' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const cleanPath = args.path.replace(/^\/+/, '');
        const body = {
          message: args.message,
          content: Buffer.from(args.content, 'utf-8').toString('base64'),
        };
        if (args.branch) body.branch = args.branch;
        if (args.sha) body.sha = args.sha;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/contents/${encodeURIComponent(cleanPath)}`,
          'PUT', body
        );
        break;
      }

      case 'github_create_branch': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.branch_name) throw new Error("Parameter 'branch_name' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);

        // Resolve the source ref to a SHA
        let sourceSha;
        if (args.from_ref) {
          try {
            const refData = await fetchJson(
              `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(args.from_ref)}`
            );
            sourceSha = refData.object.sha;
          } catch (e) {
            try {
              const tagData = await fetchJson(
                `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(args.from_ref)}`
              );
              sourceSha = tagData.object.sha;
            } catch (e2) {
              // Assume it's a commit SHA directly
              sourceSha = args.from_ref;
            }
          }
        } else {
          const repoData = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}`);
          const defaultBranch = repoData.default_branch;
          const refData = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
          );
          sourceSha = refData.object.sha;
        }

        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/git/refs`,
          'POST',
          { ref: `refs/heads/${args.branch_name}`, sha: sourceSha }
        );
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    // Apply summarization — skip for tools that return full content or write results
    const skipSummarize = [
      'github_get_file_content', 'github_get_readme',
      'github_get_issue', 'github_get_pull', 'github_get_commit',
      'github_create_issue', 'github_create_issue_comment',
      'github_create_or_update_file', 'github_create_branch',
    ];
    const finalResult = skipSummarize.includes(name)
      ? result
      : summarize(result, detailLevel);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(finalResult, null, 2),
      }],
    };
  } catch (error) {
    throw new McpError(
      ErrorCode.InternalError,
      `GitHub MCP Server Error: ${error.message}`
    );
  }
});

// ─── Start Server ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('GitHub MCP Server v2.0.0 running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
