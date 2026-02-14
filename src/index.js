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

const rawArgv = hideBin(process.argv);
const wantsHelp = rawArgv.includes('--help') || rawArgv.includes('-h');
const defaultIdleTimeoutMs = (() => {
  const raw = process.env.MCP_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 300_000; // 5 minutes: avoids leaking stdio servers forever by default.
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 300_000;
})();

const y = yargs(rawArgv)
  .option('github-token', {
    alias: 't',
    type: 'string',
    description: 'GitHub access token for API requests',
  })
  .option('idle-timeout-ms', {
    type: 'number',
    description:
      'Exit after this many ms without receiving an MCP request (0 disables). Useful to avoid leaked stdio sessions.',
    default: defaultIdleTimeoutMs,
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
  .example(
    'MCP_IDLE_TIMEOUT_MS=300000 npx github-mcp-server-kosta -t $GITHUB_TOKEN',
    'Auto-exit after 5 minutes idle (helps prevent orphaned sessions)'
  )
  .exitProcess(false);

const argv = y.parse();
if (wantsHelp) {
  process.exit(0);
}

const GITHUB_TOKEN =
  argv.githubToken ||
  process.env.GITHUB_TOKEN ||
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
if (!GITHUB_TOKEN) {
  console.error(
    'Missing GitHub token. Provide --github-token (or -t) or set GITHUB_TOKEN / GITHUB_PERSONAL_ACCESS_TOKEN.'
  );
  process.exit(2);
}

const RATE_LIMIT_DELAY = argv.rateLimit;
const IDLE_TIMEOUT_MS = argv.idleTimeoutMs;
const API_BASE_URL = 'https://api.github.com';

const HEADERS = {
  'Authorization': `Bearer ${GITHUB_TOKEN}`,
  'Accept': 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'GitHub-MCP-Server/3.0.0'
};

// ─── Helper Functions ───────────────────────────────────────────────────────────

let lastRequestTime = 0;
let lastActivityTime = Date.now();
function noteActivity() {
  lastActivityTime = Date.now();
}

async function rateLimitedRequest(url, options = {}) {
  noteActivity();
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

async function fetchDelete(url) {
  try {
    const response = await rateLimitedRequest(url, { method: 'DELETE' });
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
    if (response.status === 204) return { deleted: true };
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

const SERVER_INSTRUCTIONS = `GitHub MCP Server v3.0.0 — provides read and write access to GitHub repositories via the GitHub REST API. 33 tools (17 read, 16 write).

Tool Relationships & Workflows:
- Explore: github_repo_info → github_list_contents → github_get_file_content (overview → browse → read)
- Quick context: github_get_readme for project understanding before diving into code
- Search: github_search_code (within a repo) or github_search_repos (find repos globally)
- Issues: github_list_issues → github_get_issue for details → github_create_issue_comment to respond
- Issue triage: github_list_issues → github_update_issue (close/label) or github_add_labels / github_remove_label for targeted changes
- Full PR lifecycle: github_create_branch → github_create_or_update_file → github_create_pull_request → github_request_reviewers → github_merge_pull_request → github_delete_branch
- PR management: github_list_pulls → github_get_pull → github_update_pull_request (edit/close/reopen)
- History: github_list_commits → github_get_commit for specific change details
- Branching: github_compare to diff branches → github_create_branch for safe changes → github_create_or_update_file to commit
- File editing: github_get_file_content (get SHA) → github_create_or_update_file (update with SHA) or github_delete_file (delete with SHA)
- Releases: github_create_release with generate_release_notes: true for auto-generated changelogs
- Repo setup: github_create_repo to create new repositories, github_fork_repo to fork before contributing upstream

Rate Limiting: All requests have a configurable delay (default 100ms). GitHub API allows 5,000 requests/hour for authenticated users.

Token Permissions:
- Read operations: "repo" scope (or "public_repo" for public repos only)
- Write operations (issues, PRs, files, branches, releases): "repo" scope required
- Repository creation: "repo" scope required
- User info: "read:user" scope

Response Modes: Most tools accept detail_level "summary" (default, concise) or "detailed" (full API response). Use "summary" to conserve tokens.`;

// ─── MCP Server Setup ───────────────────────────────────────────────────────────

const server = new Server(
  {
    name: '@ildunari/github-mcp-server',
    version: '3.0.0',
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

  // ── Tier 1: PR Lifecycle ────────────────────────────────────────────────

  {
    name: 'github_create_pull_request',
    description: 'Create a new pull request. Specify head (branch with changes) and base (branch to merge into). Supports draft PRs. Completes the branch→commit→PR workflow started by github_create_branch and github_create_or_update_file. Requires "repo" token scope.',
    annotations: {
      title: 'Create Pull Request',
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
          description: 'Full GitHub repository URL (e.g., "https://github.com/owner/repo")'
        },
        title: {
          type: 'string',
          description: 'Pull request title'
        },
        head: {
          type: 'string',
          description: 'Branch containing changes (e.g., "feature/add-login")'
        },
        base: {
          type: 'string',
          description: 'Branch to merge into (e.g., "main")'
        },
        body: {
          type: 'string',
          description: 'PR description in GitHub-flavored Markdown'
        },
        draft: {
          type: 'boolean',
          description: 'Create as a draft pull request',
          default: false
        },
        maintainer_can_modify: {
          type: 'boolean',
          description: 'Allow maintainers to push to the head branch',
          default: true
        }
      },
      required: ['repo_url', 'title', 'head', 'base']
    }
  },
  {
    name: 'github_update_pull_request',
    description: 'Update an existing pull request. Edit title, body, state (open/closed), or base branch. Use to close/reopen PRs or update their description.',
    annotations: {
      title: 'Update Pull Request',
      readOnlyHint: false,
      destructiveHint: false,
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
        pull_number: {
          type: 'number',
          description: 'The pull request number to update'
        },
        title: {
          type: 'string',
          description: 'New PR title'
        },
        body: {
          type: 'string',
          description: 'New PR description in Markdown'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Set PR state to open or closed'
        },
        base: {
          type: 'string',
          description: 'Change the base branch'
        }
      },
      required: ['repo_url', 'pull_number']
    }
  },
  {
    name: 'github_merge_pull_request',
    description: 'Merge a pull request. Supports merge commit, squash, and rebase strategies. Optionally provide SHA for optimistic locking to ensure the PR head has not changed. Completes the PR lifecycle.',
    annotations: {
      title: 'Merge Pull Request',
      readOnlyHint: false,
      destructiveHint: true,
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
        pull_number: {
          type: 'number',
          description: 'The pull request number to merge'
        },
        commit_title: {
          type: 'string',
          description: 'Custom merge commit title (defaults to PR title)'
        },
        commit_message: {
          type: 'string',
          description: 'Custom merge commit body'
        },
        merge_method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Merge strategy: "merge" (default), "squash", or "rebase"',
          default: 'merge'
        },
        sha: {
          type: 'string',
          description: 'Expected HEAD SHA of the PR branch for optimistic locking. Merge fails if HEAD has changed.'
        }
      },
      required: ['repo_url', 'pull_number']
    }
  },
  {
    name: 'github_request_reviewers',
    description: 'Request reviewers for a pull request. Add individual users and/or team reviewers by slug. Use after creating a PR to kick off the review process.',
    annotations: {
      title: 'Request PR Reviewers',
      readOnlyHint: false,
      destructiveHint: false,
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
        pull_number: {
          type: 'number',
          description: 'The pull request number'
        },
        reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of GitHub usernames to request as reviewers'
        },
        team_reviewers: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of team slugs to request as reviewers (e.g., ["frontend-team"])'
        }
      },
      required: ['repo_url', 'pull_number']
    }
  },

  // ── Tier 2: Issue Management ────────────────────────────────────────────

  {
    name: 'github_update_issue',
    description: 'Update an existing issue. Edit title, body, state (open/closed), state_reason (completed/not_planned/reopened), labels, assignees, and milestone. Use to close issues, relabel, reassign, or edit content.',
    annotations: {
      title: 'Update Issue',
      readOnlyHint: false,
      destructiveHint: false,
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
        issue_number: {
          type: 'number',
          description: 'The issue number to update'
        },
        title: {
          type: 'string',
          description: 'New issue title'
        },
        body: {
          type: 'string',
          description: 'New issue body in Markdown'
        },
        state: {
          type: 'string',
          enum: ['open', 'closed'],
          description: 'Set issue state'
        },
        state_reason: {
          type: 'string',
          enum: ['completed', 'not_planned', 'reopened'],
          description: 'Reason for state change. Use "completed" or "not_planned" when closing, "reopened" when reopening.'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all labels with this list. Use github_add_labels or github_remove_label for incremental changes.'
        },
        assignees: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all assignees with this list of usernames'
        },
        milestone: {
          type: ['number', 'null'],
          description: 'Milestone number to set, or null to clear the milestone'
        }
      },
      required: ['repo_url', 'issue_number']
    }
  },
  {
    name: 'github_add_labels',
    description: 'Add one or more labels to an issue or pull request without removing existing labels. For quick triage without a full issue update. Labels must already exist in the repository.',
    annotations: {
      title: 'Add Labels',
      readOnlyHint: false,
      destructiveHint: false,
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
        issue_number: {
          type: 'number',
          description: 'The issue or PR number to label'
        },
        labels: {
          type: 'array',
          items: { type: 'string' },
          description: 'Label names to add (e.g., ["bug", "priority:high"])'
        }
      },
      required: ['repo_url', 'issue_number', 'labels']
    }
  },
  {
    name: 'github_remove_label',
    description: 'Remove a single label from an issue or pull request. Returns the remaining labels. Use for targeted label removal without affecting other labels.',
    annotations: {
      title: 'Remove Label',
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
        issue_number: {
          type: 'number',
          description: 'The issue or PR number'
        },
        label: {
          type: 'string',
          description: 'Name of the label to remove'
        }
      },
      required: ['repo_url', 'issue_number', 'label']
    }
  },

  // ── Tier 3: File & Branch Cleanup ───────────────────────────────────────

  {
    name: 'github_delete_file',
    description: 'Delete a file from a GitHub repository via a direct commit. Requires the current file SHA (from github_get_file_content) and a commit message. Creates a delete commit on the specified branch.',
    annotations: {
      title: 'Delete File',
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
          description: 'File path to delete (e.g., "src/old-config.json")'
        },
        message: {
          type: 'string',
          description: 'Git commit message for the deletion (e.g., "Remove deprecated config")'
        },
        sha: {
          type: 'string',
          description: 'Current file SHA (required, get from github_get_file_content)'
        },
        branch: {
          type: 'string',
          description: 'Branch to commit to. Defaults to the default branch.'
        }
      },
      required: ['repo_url', 'path', 'message', 'sha']
    }
  },
  {
    name: 'github_delete_branch',
    description: 'Delete a branch from a GitHub repository. Typically used to clean up feature branches after a PR has been merged. Cannot delete the default branch.',
    annotations: {
      title: 'Delete Branch',
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
        branch_name: {
          type: 'string',
          description: 'Branch name to delete (e.g., "feature/old-feature"). Do not include "refs/heads/" prefix.'
        }
      },
      required: ['repo_url', 'branch_name']
    }
  },

  // ── Tier 4: Releases & Repo Management ─────────────────────────────────

  {
    name: 'github_create_release',
    description: 'Create a new release in a GitHub repository. Tags a version, publishes release notes (manual or auto-generated from commits). Supports draft and pre-release flags.',
    annotations: {
      title: 'Create Release',
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
        tag_name: {
          type: 'string',
          description: 'Tag name for the release (e.g., "v3.0.0"). Creates the tag if it does not exist.'
        },
        name: {
          type: 'string',
          description: 'Release title (e.g., "v3.0.0 — Write Tools Expansion")'
        },
        body: {
          type: 'string',
          description: 'Release notes in Markdown'
        },
        target_commitish: {
          type: 'string',
          description: 'Branch name or commit SHA to tag. Defaults to the default branch.'
        },
        draft: {
          type: 'boolean',
          description: 'Create as a draft release (not published)',
          default: false
        },
        prerelease: {
          type: 'boolean',
          description: 'Mark as a pre-release',
          default: false
        },
        generate_release_notes: {
          type: 'boolean',
          description: 'Auto-generate release notes from commits since the last release',
          default: false
        }
      },
      required: ['repo_url', 'tag_name']
    }
  },
  {
    name: 'github_create_repo',
    description: 'Create a new GitHub repository under the authenticated user\'s account. Optionally initialize with a README, .gitignore template, and license. Returns the new repository URL.',
    annotations: {
      title: 'Create Repository',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Repository name (e.g., "my-new-project")'
        },
        description: {
          type: 'string',
          description: 'Short description of the repository'
        },
        private: {
          type: 'boolean',
          description: 'Create as a private repository',
          default: false
        },
        auto_init: {
          type: 'boolean',
          description: 'Initialize with a README.md',
          default: false
        },
        gitignore_template: {
          type: 'string',
          description: 'Gitignore template name (e.g., "Node", "Python", "Java")'
        },
        license_template: {
          type: 'string',
          description: 'License template identifier (e.g., "mit", "apache-2.0", "gpl-3.0")'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'github_fork_repo',
    description: 'Fork an existing GitHub repository to the authenticated user\'s account or a specified organization. Use before contributing upstream via pull requests.',
    annotations: {
      title: 'Fork Repository',
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
          description: 'Full GitHub repository URL to fork (e.g., "https://github.com/owner/repo")'
        },
        organization: {
          type: 'string',
          description: 'Fork into this organization instead of your personal account'
        },
        name: {
          type: 'string',
          description: 'Custom name for the forked repository'
        },
        default_branch_only: {
          type: 'boolean',
          description: 'Only fork the default branch',
          default: false
        }
      },
      required: ['repo_url']
    }
  },
];

// ─── Request Handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  noteActivity();
  return { tools: TOOLS };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  noteActivity();
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

      // ── Tier 1: PR Lifecycle ──────────────────────────────────────────

      case 'github_create_pull_request': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.title) throw new Error("Parameter 'title' is required.");
        if (!args.head) throw new Error("Parameter 'head' is required.");
        if (!args.base) throw new Error("Parameter 'base' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {
          title: args.title,
          head: args.head,
          base: args.base,
        };
        if (args.body) body.body = args.body;
        if (args.draft != null) body.draft = args.draft;
        if (args.maintainer_can_modify != null) body.maintainer_can_modify = args.maintainer_can_modify;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/pulls`,
          'POST', body
        );
        break;
      }

      case 'github_update_pull_request': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.pull_number == null) throw new Error("Parameter 'pull_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {};
        if (args.title != null) body.title = args.title;
        if (args.body != null) body.body = args.body;
        if (args.state) body.state = args.state;
        if (args.base) body.base = args.base;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}`,
          'PATCH', body
        );
        break;
      }

      case 'github_merge_pull_request': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.pull_number == null) throw new Error("Parameter 'pull_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {};
        if (args.commit_title) body.commit_title = args.commit_title;
        if (args.commit_message) body.commit_message = args.commit_message;
        if (args.merge_method) body.merge_method = args.merge_method;
        if (args.sha) body.sha = args.sha;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}/merge`,
          'PUT', body
        );
        break;
      }

      case 'github_request_reviewers': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.pull_number == null) throw new Error("Parameter 'pull_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {};
        if (args.reviewers) body.reviewers = args.reviewers;
        if (args.team_reviewers) body.team_reviewers = args.team_reviewers;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}/requested_reviewers`,
          'POST', body
        );
        break;
      }

      // ── Tier 2: Issue Management ──────────────────────────────────────

      case 'github_update_issue': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.issue_number == null) throw new Error("Parameter 'issue_number' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {};
        if (args.title != null) body.title = args.title;
        if (args.body != null) body.body = args.body;
        if (args.state) body.state = args.state;
        if (args.state_reason) body.state_reason = args.state_reason;
        if (args.labels) body.labels = args.labels;
        if (args.assignees) body.assignees = args.assignees;
        if (args.milestone !== undefined) body.milestone = args.milestone;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}`,
          'PATCH', body
        );
        break;
      }

      case 'github_add_labels': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.issue_number == null) throw new Error("Parameter 'issue_number' is required.");
        if (!args.labels || !args.labels.length) throw new Error("Parameter 'labels' is required and must not be empty.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels`,
          'POST', { labels: args.labels }
        );
        break;
      }

      case 'github_remove_label': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (args.issue_number == null) throw new Error("Parameter 'issue_number' is required.");
        if (!args.label) throw new Error("Parameter 'label' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchDelete(
          `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels/${encodeURIComponent(args.label)}`
        );
        break;
      }

      // ── Tier 3: File & Branch Cleanup ─────────────────────────────────

      case 'github_delete_file': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.path) throw new Error("Parameter 'path' is required.");
        if (!args.message) throw new Error("Parameter 'message' is required.");
        if (!args.sha) throw new Error("Parameter 'sha' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const cleanPath = args.path.replace(/^\/+/, '');
        const body = {
          message: args.message,
          sha: args.sha,
        };
        if (args.branch) body.branch = args.branch;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/contents/${encodeURIComponent(cleanPath)}`,
          'DELETE', body
        );
        break;
      }

      case 'github_delete_branch': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.branch_name) throw new Error("Parameter 'branch_name' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        result = await fetchDelete(
          `${API_BASE_URL}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(args.branch_name)}`
        );
        break;
      }

      // ── Tier 4: Releases & Repo Management ────────────────────────────

      case 'github_create_release': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        if (!args.tag_name) throw new Error("Parameter 'tag_name' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = { tag_name: args.tag_name };
        if (args.name) body.name = args.name;
        if (args.body) body.body = args.body;
        if (args.target_commitish) body.target_commitish = args.target_commitish;
        if (args.draft != null) body.draft = args.draft;
        if (args.prerelease != null) body.prerelease = args.prerelease;
        if (args.generate_release_notes != null) body.generate_release_notes = args.generate_release_notes;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/releases`,
          'POST', body
        );
        break;
      }

      case 'github_create_repo': {
        if (!args.name) throw new Error("Parameter 'name' is required.");
        const body = { name: args.name };
        if (args.description) body.description = args.description;
        if (args.private != null) body.private = args.private;
        if (args.auto_init != null) body.auto_init = args.auto_init;
        if (args.gitignore_template) body.gitignore_template = args.gitignore_template;
        if (args.license_template) body.license_template = args.license_template;
        result = await fetchWithBody(
          `${API_BASE_URL}/user/repos`,
          'POST', body
        );
        break;
      }

      case 'github_fork_repo': {
        if (!args.repo_url) throw new Error("Parameter 'repo_url' is required.");
        const { owner, repo } = parseRepoUrl(args.repo_url);
        const body = {};
        if (args.organization) body.organization = args.organization;
        if (args.name) body.name = args.name;
        if (args.default_branch_only != null) body.default_branch_only = args.default_branch_only;
        result = await fetchWithBody(
          `${API_BASE_URL}/repos/${owner}/${repo}/forks`,
          'POST', body
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
      'github_create_pull_request', 'github_update_pull_request',
      'github_merge_pull_request', 'github_request_reviewers',
      'github_update_issue', 'github_add_labels', 'github_remove_label',
      'github_delete_file', 'github_delete_branch',
      'github_create_release', 'github_create_repo', 'github_fork_repo',
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

  // STDIO MCP servers are often long-lived, but some clients accidentally leak processes.
  // This block makes shutdown deterministic and optionally auto-exits when idle.
  let shuttingDown = false;
  async function shutdown(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      console.error(`GitHub MCP Server shutting down (${reason})`);
    } catch {
      // ignore
    }

    try {
      await transport.close?.();
    } catch {
      // ignore
    }
    try {
      await server.close?.();
    } catch {
      // ignore
    }

    process.exit(exitCode);
  }

  process.stdin.on('end', () => shutdown('stdin ended'));
  process.stdin.on('close', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('SIGINT', 130));
  process.on('SIGTERM', () => shutdown('SIGTERM', 143));
  process.on('SIGHUP', () => shutdown('SIGHUP', 129));
  process.on('uncaughtException', (err) => {
    try {
      console.error('uncaughtException:', err);
    } catch {
      // ignore
    }
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    try {
      console.error('unhandledRejection:', err);
    } catch {
      // ignore
    }
    shutdown('unhandledRejection', 1);
  });

  if (IDLE_TIMEOUT_MS > 0) {
    const tickMs = Math.min(Math.max(1000, Math.floor(IDLE_TIMEOUT_MS / 5)), 30_000);
    const interval = setInterval(() => {
      const idleForMs = Date.now() - lastActivityTime;
      if (idleForMs >= IDLE_TIMEOUT_MS) {
        shutdown(`idle timeout (${idleForMs}ms >= ${IDLE_TIMEOUT_MS}ms)`);
      }
    }, tickMs);
    interval.unref?.();
  }

  await server.connect(transport);
  console.error('GitHub MCP Server v3.0.0 running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
