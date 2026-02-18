import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";

const API_BASE_URL = "https://api.github.com";

// Intentionally global so multiple per-session servers (HTTP) share throttling.
let globalLastRequestTime = 0;

export function createGithubServer({
  githubToken,
  rateLimitDelay = 100,
  toolMode = "full",
  toolSchemaVerbosity = "full",
  preloadGroups = [],
  toolOutput = "text", // text|structured|both
  toolOutputSchemaMode = "none", // none|bootstrap|all_loose
  serverVersion = "0.0.0",
  onActivity,
} = {}) {
  if (!githubToken) {
    throw new Error("Missing githubToken.");
  }

  const TOOL_MODE = toolMode;
  const TOOL_SCHEMA_VERBOSITY = toolSchemaVerbosity;

  const HEADERS = {
    Authorization: `Bearer ${githubToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `GitHub-MCP-Server/${serverVersion}`,
  };
  const RATE_LIMIT_DELAY = rateLimitDelay;

  function noteActivity() {
    try {
      onActivity?.();
    } catch {
      // ignore
    }
  }

  async function rateLimitedRequest(url, options = {}) {
    noteActivity();
    const now = Date.now();
    const timeSinceLastRequest = now - globalLastRequestTime;
    if (timeSinceLastRequest < RATE_LIMIT_DELAY) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastRequest),
      );
    }
    globalLastRequestTime = Date.now();
    const mergedHeaders = { ...HEADERS, ...(options.headers || {}) };
    const finalOptions = { ...options, headers: mergedHeaders };
    const response = await fetch(url, finalOptions);

    // Handle GitHub rate limiting (403/429 with exhausted quota)
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      const retryAfter = response.headers.get("retry-after");
      const resetEpoch = response.headers.get("x-ratelimit-reset");
      let waitMs = 60_000; // default 1 minute
      if (retryAfter) {
        waitMs = Number(retryAfter) * 1000;
      } else if (resetEpoch) {
        waitMs = Math.max(0, Number(resetEpoch) * 1000 - Date.now()) + 1000;
      }
      waitMs = Math.min(waitMs, 300_000); // cap at 5 minutes
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      globalLastRequestTime = Date.now();
      return fetch(url, finalOptions);
    }

    return response;
  }

  function encodePathSegments(path) {
    return path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
  }

  function parseRepoUrl(url) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname !== "github.com") {
        throw new Error("URL must be a github.com URL.");
      }
      const pathParts = parsedUrl.pathname.split("/").filter(Boolean);
      if (pathParts.length < 2) {
        throw new Error("URL path must include owner and repository name.");
      }
      return {
        owner: pathParts[0],
        repo: pathParts[1],
      };
    } catch (e) {
      throw new Error(
        `Invalid repository URL format: ${url}. Please use format like https://github.com/owner/repo.`,
      );
    }
  }

  function atobUtf8(b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf-8");
    } catch (e) {
      throw new Error("Failed to decode Base64 content.");
    }
  }

  async function fetchJson(url, options = {}) {
    const response = await rateLimitedRequest(url, options);
    if (!response.ok) {
      let errorBody = "";
      try {
        const errorData = await response.json();
        errorBody = errorData.message || JSON.stringify(errorData);
      } catch (e) {
        try {
          errorBody = await response.text();
        } catch (textError) {
          errorBody = "(Could not retrieve error body)";
        }
      }
      throw new Error(
        `GitHub API Error ${response.status}: ${response.statusText}. ${errorBody}`,
      );
    }
    if (
      response.status === 204 ||
      response.headers.get("Content-Length") === "0"
    ) {
      return null;
    }
    return await response.json();
  }

  async function fetchWithBody(url, method, body, options = {}) {
    const response = await rateLimitedRequest(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errorBody = "";
      try {
        const errorData = await response.json();
        errorBody = errorData.message || JSON.stringify(errorData);
      } catch (e) {
        try {
          errorBody = await response.text();
        } catch (textError) {
          errorBody = "(Could not retrieve error body)";
        }
      }
      throw new Error(
        `GitHub API Error ${response.status}: ${response.statusText}. ${errorBody}`,
      );
    }
    if (
      response.status === 204 ||
      response.headers.get("Content-Length") === "0"
    ) {
      return null;
    }
    return await response.json();
  }

  function toolResultFromText(text, { isError = false } = {}) {
    const result = {
      content: [
        {
          type: "text",
          text,
        },
      ],
    };
    if (isError) result.isError = true;
    return result;
  }

  function toolResultFromJson(data, { isError = false } = {}) {
    const wantStructured =
      !isError && (toolOutput !== "text" || toolOutputSchemaMode !== "none");
    const wantText =
      toolOutput === "text" ||
      toolOutput === "both" ||
      (toolOutputSchemaMode !== "none" && toolOutput === "text");

    const result = {
      content: wantText
        ? [
            {
              type: "text",
              text: JSON.stringify(data, null, 2),
            },
          ]
        : [],
    };

    if (wantStructured) {
      result.structuredContent = data;
    }
    if (isError) result.isError = true;
    return result;
  }

  function toolError(message, details) {
    const payload = details
      ? { error: message, ...details }
      : { error: message };
    return toolResultFromJson(payload, { isError: true });
  }

  function normalizeApiPath(path) {
    if (typeof path !== "string" || path.length === 0) {
      throw new Error("Parameter 'path' must be a non-empty string.");
    }
    if (!path.startsWith("/")) {
      throw new Error("Parameter 'path' must start with '/'.");
    }
    if (path.includes("://")) {
      throw new Error(
        "Parameter 'path' must be a GitHub API path, not a full URL.",
      );
    }
    if (path.includes("..")) {
      throw new Error("Parameter 'path' must not contain '..'.");
    }
    if (path.includes("\n") || path.includes("\r")) {
      throw new Error("Parameter 'path' must not contain newlines.");
    }
    return path;
  }

  function buildApiUrl(path, query) {
    const cleanPath = normalizeApiPath(path);
    const url = new URL(`${API_BASE_URL}${cleanPath}`);
    if (query && typeof query === "object") {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (typeof k !== "string") continue;
        if (typeof v !== "string") {
          throw new Error("Parameter 'query' values must be strings.");
        }
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  async function fetchAllItems(initialUrl, { maxPages = 100 } = {}) {
    let items = [];
    let url = initialUrl;
    let page = 0;
    while (url) {
      if (++page > maxPages) {
        break;
      }
      const response = await rateLimitedRequest(url);
      if (!response.ok) {
        let errorBody = "";
        try {
          const errorData = await response.json();
          errorBody = errorData.message || JSON.stringify(errorData);
        } catch (e) {
          try {
            errorBody = await response.text();
          } catch (textError) {
            errorBody = "(Could not retrieve error body)";
          }
        }
        throw new Error(
          `GitHub API Error (Pagination) ${response.status}: ${response.statusText}. ${errorBody}`,
        );
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

      const linkHeader = response.headers.get("link");
      const nextLinkMatch = linkHeader
        ? linkHeader.match(/<([^>]+)>;\s*rel="next"/)
        : null;
      url = nextLinkMatch ? nextLinkMatch[1] : null;
    }
    return items;
  }

  function summarize(data, detailLevel = "summary") {
    if (!data) return null;
    if (detailLevel === "detailed") return data;

    if (Array.isArray(data)) {
      if (data.length === 0) return { total_items: 0, preview: [] };
      const key = ["name", "login", "title", "path"].find((k) =>
        data[0]?.hasOwnProperty(k),
      );
      return {
        total_items: data.length,
        preview: data
          .slice(0, 5)
          .map(
            (item) =>
              item &&
              (key ? item[key] : `Item (type: ${item.type || "unknown"})`),
          ),
      };
    }

    const summary = {
      name: data.name || data.login || data.title || data.path,
      url: data.html_url || data.url,
      type: data.type,
    };

    if (data.description) summary.description = data.description;
    if (data.stargazers_count != null) summary.stars = data.stargazers_count;
    if (data.forks_count != null) summary.forks = data.forks_count;
    if (data.open_issues_count != null)
      summary.open_issues = data.open_issues_count;
    if (data.size != null) summary.size = data.size;
    if (data.sha) summary.sha = data.sha;

    Object.keys(summary).forEach(
      (key) => summary[key] === undefined && delete summary[key],
    );
    return summary;
  }

  function buildContentsUrl(owner, repo, path = "", ref) {
    const cleanPath = path ? path.replace(/^\/+/, "") : "";
    const base = `${API_BASE_URL}/repos/${owner}/${repo}/contents`;
    const pathSegment = cleanPath ? `/${encodePathSegments(cleanPath)}` : "";
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return `${base}${pathSegment}${refQuery}`;
  }

  function buildReadmeUrl(owner, repo, ref) {
    const refQuery = ref ? `?ref=${encodeURIComponent(ref)}` : "";
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
      name: "@ildunari/github-mcp-server",
      version: serverVersion,
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions:
        TOOL_SCHEMA_VERBOSITY === "compact"
          ? "GitHub MCP Server — use tools to interact with the GitHub REST API."
          : SERVER_INSTRUCTIONS,
    },
  );

  // ─── Tool Definitions ───────────────────────────────────────────────────────────

  const READ_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };

  const TOOL_DEFS = [
    // ── Lazy Tool Discovery Bootstrap ──────────────────────────────────────────
    {
      name: "github_tool_groups_list",
      title: "List Tool Groups",
      description: "List available tool groups and whether they are loaded.",
      annotations: { ...READ_ANNOTATIONS, openWorldHint: false },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: "github_tool_groups_load",
      title: "Load Tool Groups",
      description:
        "Load one or more tool groups and notify the client that the tool list has changed.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        type: "object",
        properties: {
          groups: {
            type: "array",
            items: { type: "string" },
            description: "Group IDs to load.",
          },
        },
        required: ["groups"],
        additionalProperties: false,
      },
    },
    {
      name: "github_tool_catalog_search",
      title: "Search Tool Catalog",
      description:
        "Search available tool groups and tool names without loading full tool schemas.",
      annotations: { ...READ_ANNOTATIONS, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },

    // ── Repository Operations ──────────────────────────────────────────────────

    {
      name: "github_repo_info",
      title: "Get Repository Info",
      description:
        "Retrieve metadata for a GitHub repository including stars, forks, open issues count, default branch, visibility, and language breakdown. Use as a starting point to understand a repository before exploring its contents.",
      annotations: { title: "Get Repository Info", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description:
              'Full GitHub repository URL (e.g., "https://github.com/facebook/react")',
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description:
              'Response detail: "summary" returns key metrics; "detailed" returns full API response.',
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_list_contents",
      title: "List Directory Contents",
      description:
        "List files and directories at a given path in a GitHub repository. Returns names, types (file/dir/submodule), and sizes. Use to explore repository structure before reading specific files with github_get_file_content.",
      annotations: { title: "List Directory Contents", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description:
              'Full GitHub repository URL (e.g., "https://github.com/owner/repo")',
          },
          path: {
            type: "string",
            description:
              'Path within the repository (e.g., "src/components"). Defaults to root.',
            default: "",
          },
          ref: {
            type: "string",
            description:
              "Branch name, tag, or commit SHA. Defaults to the default branch.",
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description:
              'Response detail: "summary" returns names and types; "detailed" includes SHAs and URLs.',
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_get_file_content",
      title: "Get File Content",
      description:
        "Read the contents of a single file from a GitHub repository. Returns decoded UTF-8 text, the file SHA (needed for updates via github_create_or_update_file), size, and URL. Files over 1MB cannot be retrieved via this endpoint.",
      annotations: { title: "Get File Content", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description:
              'Full GitHub repository URL (e.g., "https://github.com/owner/repo")',
          },
          path: {
            type: "string",
            description:
              'Path to the file (e.g., "src/index.js" or "README.md")',
          },
          ref: {
            type: "string",
            description:
              "Branch name, tag, or commit SHA. Defaults to the default branch.",
          },
        },
        required: ["repo_url", "path"],
      },
    },
    {
      name: "github_get_readme",
      title: "Get README",
      description:
        "Fetch and decode the README file of a GitHub repository. Automatically finds README regardless of casing or extension. Returns decoded content for quick project understanding.",
      annotations: { title: "Get README", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description:
              'Full GitHub repository URL (e.g., "https://github.com/owner/repo")',
          },
          ref: {
            type: "string",
            description:
              "Branch name, tag, or commit SHA. Defaults to the default branch.",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_search_code",
      title: "Search Code in Repo",
      description:
        "Search for code matching a query within a specific GitHub repository. Returns file paths and text fragments. Supports GitHub qualifiers like language:, filename:, extension:, and path: in the query string.",
      annotations: { title: "Search Code in Repo", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "GitHub repository URL to search within",
          },
          query: {
            type: "string",
            description:
              'Search query. Supports qualifiers: "useState language:typescript", "filename:package.json", "extension:yml path:.github"',
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description:
              'Response detail: "summary" returns file paths; "detailed" includes text matches and scores.',
            default: "summary",
          },
        },
        required: ["repo_url", "query"],
      },
    },
    {
      name: "github_list_repos",
      title: "List User/Org Repos",
      description:
        "List repositories for a specific GitHub user or organization. Returns names, descriptions, languages, and star counts. Use github_search_repos for global search or this tool when you know the owner.",
      annotations: { title: "List User/Org Repos", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              'GitHub username or organization name (e.g., "octocat" or "microsoft")',
          },
          type: {
            type: "string",
            enum: ["all", "owner", "member"],
            description: "Filter by ownership type.",
            default: "owner",
          },
          sort: {
            type: "string",
            enum: ["created", "updated", "pushed", "full_name"],
            description: "Sort field.",
            default: "full_name",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 30,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["username"],
      },
    },
    {
      name: "github_search_repos",
      title: "Search Repositories",
      description:
        'Search GitHub repositories globally by keyword, language, stars, or other qualifiers. Returns matching repository names, descriptions, and star counts. Supports qualifiers like "language:", "stars:>100", "topic:", "org:".',
      annotations: { title: "Search Repositories", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Search query with optional qualifiers (e.g., "machine learning language:python stars:>1000")',
          },
          sort: {
            type: "string",
            enum: ["stars", "forks", "help-wanted-issues", "updated"],
            description: "Sort field. Omit for best-match relevance.",
          },
          order: {
            type: "string",
            enum: ["asc", "desc"],
            description: "Sort order.",
            default: "desc",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 30,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "github_search_issues",
      title: "Search Issues and PRs",
      description:
        'Search issues and pull requests using GitHub Search Issues API. Use query qualifiers like "repo:owner/repo is:issue is:pr".',
      annotations: { title: "Search Issues and PRs", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (GitHub search syntax).",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 30,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },

    // ── Issues & Pull Requests ─────────────────────────────────────────────────

    {
      name: "github_list_issues",
      title: "List Issues",
      description:
        "List issues in a GitHub repository with optional filtering by state, labels, and assignee. Returns titles, numbers, states, and labels. Note: GitHub API includes pull requests as issues; filter by absence of pull_request field for true issues.",
      annotations: { title: "List Issues", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter by issue state.",
            default: "all",
          },
          labels: {
            type: "string",
            description:
              'Comma-separated label names to filter by (e.g., "bug,help wanted")',
          },
          assignee: {
            type: "string",
            description:
              'Filter by assignee username. Use "*" for any assignee, "none" for unassigned.',
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 100,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_get_issue",
      title: "Get Issue Details",
      description:
        "Retrieve full details of a specific issue by number, including title, body (Markdown), state, labels, assignees, milestone, and comments count. Use after github_list_issues to get complete information.",
      annotations: { title: "Get Issue Details", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "The issue number (e.g., 42)",
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url", "issue_number"],
      },
    },
    {
      name: "github_list_pulls",
      title: "List Pull Requests",
      description:
        "List pull requests in a GitHub repository with optional filtering by state, head branch, and base branch. Returns PR titles, numbers, states, authors, and branch info.",
      annotations: { title: "List Pull Requests", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          state: {
            type: "string",
            enum: ["open", "closed", "all"],
            description: "Filter by PR state.",
            default: "all",
          },
          head: {
            type: "string",
            description: 'Filter by head branch name (e.g., "feature-branch")',
          },
          base: {
            type: "string",
            description: 'Filter by base branch name (e.g., "main")',
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 100,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_get_pull",
      title: "Get Pull Request Details",
      description:
        "Retrieve full details of a specific pull request by number, including title, body, diff stats (additions/deletions/changed files), merge status, head/base branches, and review status.",
      annotations: { title: "Get Pull Request Details", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          pull_number: {
            type: "number",
            description: "The pull request number (e.g., 123)",
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url", "pull_number"],
      },
    },

    // ── Branches, Commits & History ────────────────────────────────────────────

    {
      name: "github_list_branches",
      title: "List Branches",
      description:
        "List all branches in a GitHub repository. Returns branch names, commit SHAs, and protection status. Use to discover branches before switching refs in other tools.",
      annotations: { title: "List Branches", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_list_commits",
      title: "List Commits",
      description:
        "List commits in a GitHub repository with optional filtering by file path, author, branch, and date range. Returns SHAs, messages, authors, and timestamps. Useful for understanding recent changes or tracking file history.",
      annotations: { title: "List Commits", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          sha: {
            type: "string",
            description:
              "Branch name, tag, or SHA to list commits from. Defaults to the default branch.",
          },
          path: {
            type: "string",
            description:
              'Only commits modifying this file path (e.g., "src/index.js")',
          },
          author: {
            type: "string",
            description: "Filter by author username or email",
          },
          since: {
            type: "string",
            description:
              'Only commits after this ISO 8601 date (e.g., "2024-01-01T00:00:00Z")',
          },
          until: {
            type: "string",
            description: "Only commits before this ISO 8601 date",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 30,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_get_commit",
      title: "Get Commit Details",
      description:
        "Retrieve full details of a specific commit by SHA, including message, author, timestamp, parent SHAs, and the complete diff (files changed with patches). Use after github_list_commits to inspect a change.",
      annotations: { title: "Get Commit Details", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          sha: {
            type: "string",
            description: 'Full or abbreviated commit SHA (e.g., "abc1234")',
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description:
              '"summary" returns message and stats; "detailed" includes full patch diffs.',
            default: "summary",
          },
        },
        required: ["repo_url", "sha"],
      },
    },
    {
      name: "github_compare",
      title: "Compare Refs",
      description:
        "Compare two git refs (branches, tags, or commits) and return the diff. Shows ahead/behind counts, commit list, and file changes. Useful for reviewing changes between releases or branches.",
      annotations: { title: "Compare Refs", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          base: {
            type: "string",
            description:
              'Base ref: branch name (e.g., "main"), tag (e.g., "v1.0.0"), or commit SHA',
          },
          head: {
            type: "string",
            description:
              'Head ref (the "newer" side): branch name, tag, or commit SHA',
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description:
              '"summary" returns stats and commit list; "detailed" includes file patches.',
            default: "summary",
          },
        },
        required: ["repo_url", "base", "head"],
      },
    },

    // ── Releases ───────────────────────────────────────────────────────────────

    {
      name: "github_list_releases",
      title: "List Releases",
      description:
        "List releases in a GitHub repository including names, tag names, publication dates, pre-release status, and release notes. Returns asset download URLs.",
      annotations: { title: "List Releases", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 30,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
      },
    },
    {
      name: "github_create_release",
      title: "Create Release",
      description: "Create a new release in a GitHub repository.",
      annotations: {
        title: "Create Release",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          tag_name: {
            type: "string",
            description: 'Tag name for the release (e.g., "v3.0.0")',
          },
          name: { type: "string", description: "Release title" },
          body: { type: "string", description: "Release notes in Markdown" },
          target_commitish: {
            type: "string",
            description: "Branch name or commit SHA to tag",
          },
          draft: {
            type: "boolean",
            description: "Create as draft release",
            default: false,
          },
          prerelease: {
            type: "boolean",
            description: "Mark as prerelease",
            default: false,
          },
          generate_release_notes: {
            type: "boolean",
            description: "Auto-generate release notes",
            default: false,
          },
        },
        required: ["repo_url", "tag_name"],
        additionalProperties: false,
      },
    },

    // ── Users ──────────────────────────────────────────────────────────────────

    {
      name: "github_user_info",
      title: "Get User Info",
      description:
        "Retrieve a GitHub user's public profile: name, bio, company, location, public repo count, followers, and account creation date. Works for user and organization accounts.",
      annotations: { title: "Get User Info", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description:
              'GitHub username or organization name (e.g., "octocat")',
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["username"],
      },
    },
    {
      name: "github_create_repo",
      title: "Create Repository",
      description:
        "Create a new GitHub repository under the authenticated account.",
      annotations: {
        title: "Create Repository",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Repository name" },
          description: {
            type: "string",
            description: "Repository description",
          },
          private: {
            type: "boolean",
            description: "Create as private repository",
            default: false,
          },
          auto_init: {
            type: "boolean",
            description: "Initialize with README",
            default: false,
          },
          gitignore_template: {
            type: "string",
            description: "Gitignore template name",
          },
          license_template: {
            type: "string",
            description: "License template identifier",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    {
      name: "github_fork_repo",
      title: "Fork Repository",
      description:
        "Fork an existing GitHub repository to the authenticated account or organization.",
      annotations: {
        title: "Fork Repository",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL to fork",
          },
          organization: {
            type: "string",
            description: "Fork into this organization",
          },
          name: {
            type: "string",
            description: "Custom name for forked repository",
          },
          default_branch_only: {
            type: "boolean",
            description: "Only fork default branch",
            default: false,
          },
        },
        required: ["repo_url"],
        additionalProperties: false,
      },
    },

    // ── Write Operations ───────────────────────────────────────────────────────

    {
      name: "github_create_issue",
      title: "Create Issue",
      description:
        'Create a new issue in a GitHub repository. Requires a title; optionally set body (Markdown), labels, assignees, and milestone. Returns the created issue number and URL. Requires "repo" token scope.',
      annotations: {
        title: "Create Issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          title: {
            type: "string",
            description: "Issue title (concise summary)",
          },
          body: {
            type: "string",
            description: "Issue body in GitHub-flavored Markdown",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description:
              'Label names to apply (e.g., ["bug", "priority:high"]). Labels must exist in the repo.',
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: 'Usernames to assign (e.g., ["octocat"])',
          },
          milestone: {
            type: "number",
            description: "Milestone number (not title) to associate with",
          },
        },
        required: ["repo_url", "title"],
      },
    },
    {
      name: "github_update_issue",
      title: "Update Issue",
      description:
        "Update an issue (or pull request) via the Issues API (edit title/body/state/labels/assignees/milestone).",
      annotations: {
        title: "Update Issue",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue number (or PR number) to update",
          },
          title: { type: "string", description: "New title" },
          body: {
            type: "string",
            description: "New body (GitHub-flavored Markdown)",
          },
          state: {
            type: "string",
            enum: ["open", "closed"],
            description: "Open or close the issue",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Set label names (overwrites existing labels)",
          },
          assignees: {
            type: "array",
            items: { type: "string" },
            description: "Set assignees (overwrites existing assignees)",
          },
          milestone: {
            type: ["number", "null"],
            description: "Milestone number, or null to clear",
          },
        },
        required: ["repo_url", "issue_number"],
        additionalProperties: false,
      },
    },
    {
      name: "github_create_issue_comment",
      title: "Comment on Issue/PR",
      description:
        "Add a comment to an existing issue or pull request. Body supports GitHub-flavored Markdown. Works for both issues and PRs (they share the same comment API). Returns the comment ID and URL.",
      annotations: {
        title: "Comment on Issue/PR",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description:
              "Issue or pull request number to comment on (e.g., 42)",
          },
          body: {
            type: "string",
            description: "Comment body in GitHub-flavored Markdown",
          },
        },
        required: ["repo_url", "issue_number", "body"],
      },
    },
    {
      name: "github_create_pull_request",
      title: "Create Pull Request",
      description: "Create a pull request in a repository.",
      annotations: {
        title: "Create Pull Request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          title: { type: "string", description: "Pull request title" },
          head: {
            type: "string",
            description: 'Head branch (or "owner:branch")',
          },
          base: { type: "string", description: "Base branch name" },
          body: { type: "string", description: "Pull request body (Markdown)" },
          draft: {
            type: "boolean",
            description: "Create as draft pull request",
            default: false,
          },
        },
        required: ["repo_url", "title", "head", "base"],
        additionalProperties: false,
      },
    },
    {
      name: "github_update_pull_request",
      title: "Update Pull Request",
      description: "Update a pull request (title/body/state/base).",
      annotations: {
        title: "Update Pull Request",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          pull_number: { type: "number", description: "Pull request number" },
          title: { type: "string", description: "New title" },
          body: { type: "string", description: "New body (Markdown)" },
          state: {
            type: "string",
            enum: ["open", "closed"],
            description: "Open or close the pull request",
          },
          base: { type: "string", description: "Change the base branch" },
        },
        required: ["repo_url", "pull_number"],
        additionalProperties: false,
      },
    },
    {
      name: "github_merge_pull_request",
      title: "Merge Pull Request",
      description: "Merge a pull request.",
      annotations: {
        title: "Merge Pull Request",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          pull_number: { type: "number", description: "Pull request number" },
          commit_title: {
            type: "string",
            description: "Title for the merge commit message",
          },
          commit_message: {
            type: "string",
            description: "Extra detail to append to merge commit message",
          },
          sha: {
            type: "string",
            description: "SHA that pull request head must match to allow merge",
          },
          merge_method: {
            type: "string",
            enum: ["merge", "squash", "rebase"],
            description: "Merge method",
          },
        },
        required: ["repo_url", "pull_number"],
        additionalProperties: false,
      },
    },
    {
      name: "github_request_reviewers",
      title: "Request PR Reviewers",
      description: "Request reviewers for a pull request.",
      annotations: {
        title: "Request PR Reviewers",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          pull_number: { type: "number", description: "Pull request number" },
          reviewers: {
            type: "array",
            items: { type: "string" },
            description: "GitHub usernames to request",
          },
          team_reviewers: {
            type: "array",
            items: { type: "string" },
            description: "Team slugs to request",
          },
        },
        required: ["repo_url", "pull_number"],
        additionalProperties: false,
      },
    },
    {
      name: "github_list_labels",
      title: "List Labels",
      description: "List labels in a GitHub repository.",
      annotations: { title: "List Labels", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          per_page: {
            type: "number",
            description: "Results per page (max 100).",
            default: 100,
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            description: "Response detail level.",
            default: "summary",
          },
        },
        required: ["repo_url"],
        additionalProperties: false,
      },
    },
    {
      name: "github_create_label",
      title: "Create Label",
      description: "Create a new label in a GitHub repository.",
      annotations: {
        title: "Create Label",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          name: { type: "string", description: "Label name" },
          color: {
            type: "string",
            description: 'Label color without leading # (e.g., "f29513")',
          },
          description: { type: "string", description: "Label description" },
        },
        required: ["repo_url", "name", "color"],
        additionalProperties: false,
      },
    },
    {
      name: "github_set_issue_labels",
      title: "Set Issue Labels",
      description: "Replace all labels for an issue or pull request.",
      annotations: {
        title: "Set Issue Labels",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue or pull request number",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Label names to set (replaces existing)",
          },
        },
        required: ["repo_url", "issue_number", "labels"],
        additionalProperties: false,
      },
    },
    {
      name: "github_add_issue_labels",
      title: "Add Issue Labels",
      description: "Add labels to an issue or pull request.",
      annotations: {
        title: "Add Issue Labels",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue or pull request number",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Label names to add",
          },
        },
        required: ["repo_url", "issue_number", "labels"],
        additionalProperties: false,
      },
    },
    {
      name: "github_remove_issue_label",
      title: "Remove Issue Label",
      description: "Remove a label from an issue or pull request.",
      annotations: {
        title: "Remove Issue Label",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue or pull request number",
          },
          name: { type: "string", description: "Label name to remove" },
        },
        required: ["repo_url", "issue_number", "name"],
        additionalProperties: false,
      },
    },
    {
      name: "github_add_labels",
      title: "Add Labels",
      description:
        "Add one or more labels to an issue or pull request without replacing existing labels.",
      annotations: {
        title: "Add Labels",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue or pull request number",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "Label names to add",
          },
        },
        required: ["repo_url", "issue_number", "labels"],
        additionalProperties: false,
      },
    },
    {
      name: "github_remove_label",
      title: "Remove Label",
      description: "Remove a single label from an issue or pull request.",
      annotations: {
        title: "Remove Label",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          issue_number: {
            type: "number",
            description: "Issue or pull request number",
          },
          label: { type: "string", description: "Label name to remove" },
        },
        required: ["repo_url", "issue_number", "label"],
        additionalProperties: false,
      },
    },
    {
      name: "github_create_or_update_file",
      title: "Create or Update File",
      description:
        "Create a new file or update an existing file in a GitHub repository via a direct commit. For updates, you MUST provide the current file SHA (get it from github_get_file_content). Content should be the full file text (not a diff). Creates a commit on the specified branch.",
      annotations: {
        title: "Create or Update File",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          path: {
            type: "string",
            description: 'File path in the repo (e.g., "src/config.json")',
          },
          content: {
            type: "string",
            description:
              "Full file content as UTF-8 text. Will be Base64-encoded automatically.",
          },
          message: {
            type: "string",
            description: 'Git commit message (e.g., "Add config file")',
          },
          branch: {
            type: "string",
            description: "Branch to commit to. Defaults to the default branch.",
          },
          sha: {
            type: "string",
            description:
              "Current file SHA. REQUIRED for updates (from github_get_file_content). Omit for new files.",
          },
        },
        required: ["repo_url", "path", "content", "message"],
      },
    },
    {
      name: "github_delete_file",
      title: "Delete File",
      description:
        "Delete a file via the GitHub Contents API. Requires the current file SHA.",
      annotations: {
        title: "Delete File",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          path: {
            type: "string",
            description: 'File path in the repo (e.g., "src/config.json")',
          },
          message: { type: "string", description: "Git commit message" },
          sha: {
            type: "string",
            description: "Blob SHA of the file being deleted",
          },
          branch: {
            type: "string",
            description: "Branch name. Defaults to the default branch.",
          },
          committer: {
            type: "object",
            description:
              "Committer info (requires name and email if provided).",
            properties: { name: { type: "string" }, email: { type: "string" } },
            required: ["name", "email"],
            additionalProperties: false,
          },
          author: {
            type: "object",
            description: "Author info (requires name and email if provided).",
            properties: { name: { type: "string" }, email: { type: "string" } },
            required: ["name", "email"],
            additionalProperties: false,
          },
        },
        required: ["repo_url", "path", "message", "sha"],
        additionalProperties: false,
      },
    },
    {
      name: "github_create_branch",
      title: "Create Branch",
      description:
        "Create a new branch in a GitHub repository from an existing ref. Resolves the source ref to a commit SHA, then creates the branch. Use before github_create_or_update_file for safe changes on a separate branch.",
      annotations: {
        title: "Create Branch",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          branch_name: {
            type: "string",
            description:
              'New branch name (e.g., "feature/add-login"). Do not include "refs/heads/" prefix.',
          },
          from_ref: {
            type: "string",
            description:
              "Source ref: branch name, tag, or commit SHA. Defaults to the default branch.",
          },
        },
        required: ["repo_url", "branch_name"],
      },
    },
    {
      name: "github_delete_branch",
      title: "Delete Branch",
      description: "Delete a branch from a GitHub repository.",
      annotations: {
        title: "Delete Branch",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          repo_url: {
            type: "string",
            description: "Full GitHub repository URL",
          },
          branch_name: {
            type: "string",
            description: "Branch name to delete (without refs/heads/ prefix)",
          },
        },
        required: ["repo_url", "branch_name"],
        additionalProperties: false,
      },
    },

    // ── Escape Hatch REST Tools ───────────────────────────────────────────────
    {
      name: "github_rest_get",
      title: "GitHub REST GET",
      description:
        "Perform an arbitrary GET request against the GitHub REST API (path-based).",
      annotations: { title: "GitHub REST GET", ...READ_ANNOTATIONS },
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: 'API path starting with "/" (e.g., "/user").',
          },
          query: {
            type: "object",
            description: "Query parameters (string -> string).",
            additionalProperties: { type: "string" },
          },
          accept: { type: "string", description: "Override Accept header." },
          api_version: {
            type: "string",
            description: "Override X-GitHub-Api-Version header.",
            default: "2022-11-28",
          },
          detail_level: {
            type: "string",
            enum: ["summary", "detailed"],
            default: "summary",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "github_rest_mutate",
      title: "GitHub REST Mutate",
      description:
        "Perform an arbitrary write request against the GitHub REST API (guarded by an explicit confirmation string).",
      annotations: {
        title: "GitHub REST Mutate",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["POST", "PUT", "PATCH", "DELETE"],
            description: "HTTP method.",
          },
          path: {
            type: "string",
            description:
              'API path starting with "/" (e.g., "/repos/{owner}/{repo}/hooks").',
          },
          query: {
            type: "object",
            description: "Query parameters (string -> string).",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "object",
            description: "JSON body (object).",
            additionalProperties: true,
          },
          accept: { type: "string", description: "Override Accept header." },
          api_version: {
            type: "string",
            description: "Override X-GitHub-Api-Version header.",
            default: "2022-11-28",
          },
          confirm: {
            type: "string",
            description: 'Must be exactly "CONFIRM_GITHUB_WRITE".',
          },
        },
        required: ["method", "path", "confirm"],
        additionalProperties: false,
      },
    },
  ];

  function outputSchemaForTool(toolName) {
    if (toolOutputSchemaMode === "none") return undefined;

    if (toolOutputSchemaMode === "bootstrap") {
      switch (toolName) {
        case "github_tool_groups_list":
          return {
            type: "object",
            properties: {
              groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                    loaded: { type: "boolean" },
                    tool_count: { type: "number" },
                  },
                  required: [
                    "id",
                    "title",
                    "description",
                    "loaded",
                    "tool_count",
                  ],
                  additionalProperties: false,
                },
              },
            },
            required: ["groups"],
            additionalProperties: false,
          };
        case "github_tool_groups_load":
          return {
            type: "object",
            properties: {
              loaded: { type: "array", items: { type: "string" } },
              unknown: { type: "array", items: { type: "string" } },
            },
            required: ["loaded", "unknown"],
            additionalProperties: false,
          };
        case "github_tool_catalog_search":
          return {
            type: "object",
            properties: {
              groups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                    loaded: { type: "boolean" },
                  },
                  required: ["id", "title", "description", "loaded"],
                  additionalProperties: false,
                },
              },
              tools: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    title: { type: "string" },
                    description: { type: "string" },
                    group: { type: "string" },
                  },
                  required: ["name", "group"],
                  additionalProperties: false,
                },
              },
            },
            required: ["groups", "tools"],
            additionalProperties: false,
          };
        default:
          return undefined;
      }
    }

    // all_loose: opt-in for structuredContent without exploding schemas.
    const excluded = new Set(["github_get_file_content", "github_get_readme"]);
    if (excluded.has(toolName)) return undefined;
    return { type: "object", additionalProperties: true };
  }

  const TOOL_DEFS_WITH_OUTPUT_SCHEMA = TOOL_DEFS.map((t) => {
    const schema = outputSchemaForTool(t.name);
    return schema ? { ...t, outputSchema: schema } : t;
  });

  const ALL_TOOLS_BY_NAME = new Map(
    TOOL_DEFS_WITH_OUTPUT_SCHEMA.map((t) => [t.name, t]),
  );

  const TOOL_GROUPS = {
    core: {
      title: "Core Repository Tools",
      description: "Repository exploration and file reading.",
      toolNames: [
        "github_repo_info",
        "github_list_contents",
        "github_get_file_content",
        "github_get_readme",
      ],
    },
    search: {
      title: "Search Tools",
      description: "Search code, repositories, issues, and pull requests.",
      toolNames: [
        "github_search_code",
        "github_search_repos",
        "github_search_issues",
      ],
    },
    issues: {
      title: "Issues Tools",
      description: "List/get/create/update issues and manage issue labels.",
      toolNames: [
        "github_list_issues",
        "github_get_issue",
        "github_create_issue",
        "github_create_issue_comment",
        "github_update_issue",
        "github_list_labels",
        "github_create_label",
        "github_set_issue_labels",
        "github_add_issue_labels",
        "github_remove_issue_label",
        "github_add_labels",
        "github_remove_label",
      ],
    },
    pulls: {
      title: "Pull Requests Tools",
      description: "List/get/create/update/merge pull requests.",
      toolNames: [
        "github_list_pulls",
        "github_get_pull",
        "github_create_pull_request",
        "github_update_pull_request",
        "github_merge_pull_request",
        "github_request_reviewers",
      ],
    },
    branches_commits: {
      title: "Branches and Commits",
      description: "List branches/commits, compare refs, and create branches.",
      toolNames: [
        "github_list_branches",
        "github_list_commits",
        "github_get_commit",
        "github_compare",
        "github_create_branch",
        "github_delete_branch",
      ],
    },
    releases_users: {
      title: "Releases and Users",
      description: "Releases and user/org profile info.",
      toolNames: [
        "github_list_releases",
        "github_create_release",
        "github_user_info",
        "github_list_repos",
        "github_create_repo",
        "github_fork_repo",
      ],
    },
    files_write: {
      title: "File Write Tools",
      description: "Create/update/delete files via commits.",
      toolNames: ["github_create_or_update_file", "github_delete_file"],
    },
    rest: {
      title: "REST Escape Hatch",
      description: "Generic GitHub REST GET and guarded write tool.",
      toolNames: ["github_rest_get", "github_rest_mutate"],
    },
  };

  const BOOTSTRAP_TOOL_NAMES = new Set([
    "github_tool_groups_list",
    "github_tool_groups_load",
    "github_tool_catalog_search",
  ]);

  const TOOL_TO_GROUP = (() => {
    const m = new Map();
    for (const [groupId, group] of Object.entries(TOOL_GROUPS)) {
      for (const toolName of group.toolNames) {
        if (!m.has(toolName)) m.set(toolName, groupId);
      }
    }
    return m;
  })();

  const loadedGroups = new Set(preloadGroups);

  function getListedToolNames() {
    if (TOOL_MODE !== "lazy") {
      return Array.from(ALL_TOOLS_BY_NAME.keys());
    }

    const out = new Set(BOOTSTRAP_TOOL_NAMES);
    for (const groupId of loadedGroups) {
      const group = TOOL_GROUPS[groupId];
      if (!group) continue;
      for (const toolName of group.toolNames) out.add(toolName);
    }
    return Array.from(out);
  }

  function getListedTools() {
    const listedNames = new Set(getListedToolNames());
    const tools = [];
    for (const name of listedNames) {
      const tool = ALL_TOOLS_BY_NAME.get(name);
      if (!tool) continue;

      if (TOOL_SCHEMA_VERBOSITY !== "compact") {
        tools.push(tool);
        continue;
      }

      // Compact mode: keep schema intact but trim descriptions and avoid title duplication in annotations.
      const compact = { ...tool };
      if (typeof compact.description === "string") {
        compact.description = compact.description.split("\n")[0].trim();
        if (compact.description.length > 220)
          compact.description = `${compact.description.slice(0, 217)}...`;
      }
      if (compact.annotations && typeof compact.annotations === "object") {
        compact.annotations = { ...compact.annotations };
        delete compact.annotations.title;
      }
      tools.push(compact);
    }

    // Stable order in tool listings.
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return tools;
  }

  function ensureToolAccessible(toolName) {
    if (TOOL_MODE !== "lazy") return { ok: true };
    if (BOOTSTRAP_TOOL_NAMES.has(toolName)) return { ok: true };
    const listed = new Set(getListedToolNames());
    if (listed.has(toolName)) return { ok: true };
    const groupId = TOOL_TO_GROUP.get(toolName);
    return { ok: false, groupId };
  }

  // ─── Request Handlers ───────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    noteActivity();
    return { tools: getListedTools() };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    noteActivity();
    const { name, arguments: args } = request.params;

    try {
      const toolDef = ALL_TOOLS_BY_NAME.get(name);
      if (!toolDef) {
        return toolError(`Unknown tool: ${name}`);
      }

      const access = ensureToolAccessible(name);
      if (!access.ok) {
        const groupId = access.groupId || "unknown";
        return toolError(
          `Tool '${name}' is not currently available in tool-mode=lazy. Load group '${groupId}' via github_tool_groups_load.`,
          { tool: name, required_group: groupId },
        );
      }

      let result;
      const detailLevel = args.detail_level || "summary";

      switch (name) {
        // ── Lazy Tool Discovery Bootstrap ─────────────────────────────────────

        case "github_tool_groups_list": {
          const groups = Object.entries(TOOL_GROUPS).map(([id, g]) => ({
            id,
            title: g.title,
            description: g.description,
            loaded: TOOL_MODE === "lazy" ? loadedGroups.has(id) : true,
            tool_count: g.toolNames.length,
          }));
          result = { groups };
          break;
        }

        case "github_tool_groups_load": {
          if (!Array.isArray(args.groups) || args.groups.length === 0) {
            return toolError(
              "Parameter 'groups' must be a non-empty array of group IDs.",
            );
          }
          const loaded = [];
          const unknown = [];
          for (const id of args.groups) {
            if (typeof id !== "string" || id.trim() === "") continue;
            const groupId = id.trim();
            if (!TOOL_GROUPS[groupId]) {
              unknown.push(groupId);
              continue;
            }
            if (TOOL_MODE === "lazy") loadedGroups.add(groupId);
            loaded.push(groupId);
          }
          try {
            await server.sendToolListChanged();
          } catch {
            // If the client doesn't support notifications, this is still useful via tools/list polling.
          }
          result = { loaded, unknown };
          break;
        }

        case "github_tool_catalog_search": {
          if (!args.query) return toolError("Parameter 'query' is required.");
          const q = String(args.query).toLowerCase();
          const groupMatches = [];
          const toolMatches = [];
          for (const [id, g] of Object.entries(TOOL_GROUPS)) {
            const hay = `${id} ${g.title} ${g.description}`.toLowerCase();
            if (hay.includes(q)) {
              groupMatches.push({
                id,
                title: g.title,
                description: g.description,
                loaded: loadedGroups.has(id),
              });
            }
            for (const toolName of g.toolNames) {
              const t = ALL_TOOLS_BY_NAME.get(toolName);
              if (!t) continue;
              const th =
                `${toolName} ${t.title || ""} ${t.description || ""}`.toLowerCase();
              if (th.includes(q)) {
                toolMatches.push({
                  name: toolName,
                  title: t.title,
                  description:
                    typeof t.description === "string"
                      ? t.description.split("\n")[0]
                      : undefined,
                  group: id,
                });
              }
            }
          }
          toolMatches.sort((a, b) => a.name.localeCompare(b.name));
          result = { groups: groupMatches, tools: toolMatches.slice(0, 50) };
          break;
        }

        // ── Repository Operations ────────────────────────────────────────────

        case "github_user_info": {
          if (!args.username)
            throw new Error("Parameter 'username' is required.");
          result = await fetchJson(
            `${API_BASE_URL}/users/${encodeURIComponent(args.username)}`,
          );
          break;
        }

        case "github_repo_info": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(`${API_BASE_URL}/repos/${owner}/${repo}`);
          break;
        }

        case "github_list_contents": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            buildContentsUrl(owner, repo, args.path, args.ref),
          );
          break;
        }

        case "github_get_file_content": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.path) throw new Error("Parameter 'path' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const fileData = await fetchJson(
            buildContentsUrl(owner, repo, args.path, args.ref),
          );

          if (
            !fileData ||
            fileData.type !== "file" ||
            typeof fileData.content !== "string"
          ) {
            if (fileData && fileData.type === "dir") {
              throw new Error(
                `Path '${args.path}' is a directory, not a file. Use 'github_list_contents'.`,
              );
            }
            if (
              fileData &&
              fileData.content === undefined &&
              fileData.size > 0
            ) {
              throw new Error(
                `File '${args.path}' is too large (${fileData.size} bytes). GitHub Contents API limit is ~1MB.`,
              );
            }
            throw new Error(
              `Could not retrieve file content for: ${args.path}.`,
            );
          }

          if (fileData.encoding !== "base64") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      name: fileData.name,
                      path: fileData.path,
                      size: fileData.size,
                      encoding: fileData.encoding,
                      content: fileData.content,
                      sha: fileData.sha,
                      html_url: fileData.html_url,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    name: fileData.name,
                    path: fileData.path,
                    size: fileData.size,
                    encoding: "utf-8",
                    content: atobUtf8(fileData.content),
                    sha: fileData.sha,
                    html_url: fileData.html_url,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "github_get_readme": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const readmeData = await fetchJson(
            buildReadmeUrl(owner, repo, args.ref),
          );

          if (!readmeData || typeof readmeData.content !== "string") {
            throw new Error(`Could not retrieve README for: ${args.repo_url}.`);
          }

          if (readmeData.encoding !== "base64") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      name: readmeData.name,
                      path: readmeData.path,
                      size: readmeData.size,
                      encoding: readmeData.encoding,
                      content: readmeData.content,
                      sha: readmeData.sha,
                      html_url: readmeData.html_url,
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    name: readmeData.name,
                    path: readmeData.path,
                    size: readmeData.size,
                    encoding: "utf-8",
                    content: atobUtf8(readmeData.content),
                    sha: readmeData.sha,
                    html_url: readmeData.html_url,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "github_search_code": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.query) throw new Error("Parameter 'query' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const searchParams = new URLSearchParams({
            q: `${args.query} repo:${owner}/${repo}`,
          });
          const searchResponse = await fetchJson(
            `${API_BASE_URL}/search/code?${searchParams.toString()}`,
          );
          result = searchResponse.items || [];
          break;
        }

        case "github_list_repos": {
          if (!args.username)
            throw new Error("Parameter 'username' is required.");
          const params = new URLSearchParams();
          params.set("per_page", String(args.per_page || 30));
          if (args.type) params.set("type", args.type);
          if (args.sort) params.set("sort", args.sort);
          result = await fetchJson(
            `${API_BASE_URL}/users/${encodeURIComponent(args.username)}/repos?${params.toString()}`,
          );
          break;
        }

        case "github_search_repos": {
          if (!args.query) throw new Error("Parameter 'query' is required.");
          const params = new URLSearchParams();
          params.set("q", args.query);
          params.set("per_page", String(args.per_page || 30));
          if (args.sort) params.set("sort", args.sort);
          if (args.order) params.set("order", args.order);
          const searchResponse = await fetchJson(
            `${API_BASE_URL}/search/repositories?${params.toString()}`,
          );
          result = searchResponse.items || [];
          break;
        }

        case "github_search_issues": {
          if (!args.query) throw new Error("Parameter 'query' is required.");
          const params = new URLSearchParams();
          params.set("q", args.query);
          params.set("per_page", String(args.per_page || 30));
          const searchResponse = await fetchJson(
            `${API_BASE_URL}/search/issues?${params.toString()}`,
          );
          result = searchResponse.items || [];
          break;
        }

        // ── Issues & Pull Requests ───────────────────────────────────────────

        case "github_list_issues": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const params = new URLSearchParams();
          params.set("state", args.state || "all");
          params.set("per_page", String(args.per_page || 100));
          if (args.labels) params.set("labels", args.labels);
          if (args.assignee) params.set("assignee", args.assignee);
          result = await fetchAllItems(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues?${params.toString()}`,
          );
          break;
        }

        case "github_get_issue": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}`,
          );
          break;
        }

        case "github_list_pulls": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const params = new URLSearchParams();
          params.set("state", args.state || "all");
          params.set("per_page", String(args.per_page || 100));
          if (args.head) params.set("head", args.head);
          if (args.base) params.set("base", args.base);
          result = await fetchAllItems(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls?${params.toString()}`,
          );
          break;
        }

        case "github_get_pull": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.pull_number == null)
            throw new Error("Parameter 'pull_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}`,
          );
          break;
        }

        // ── Branches, Commits & History ──────────────────────────────────────

        case "github_list_branches": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchAllItems(
            `${API_BASE_URL}/repos/${owner}/${repo}/branches?per_page=100`,
          );
          break;
        }

        case "github_list_commits": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const params = new URLSearchParams();
          params.set("per_page", String(args.per_page || 30));
          if (args.sha) params.set("sha", args.sha);
          if (args.path) params.set("path", args.path);
          if (args.author) params.set("author", args.author);
          if (args.since) params.set("since", args.since);
          if (args.until) params.set("until", args.until);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/commits?${params.toString()}`,
          );
          break;
        }

        case "github_get_commit": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.sha) throw new Error("Parameter 'sha' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/commits/${encodeURIComponent(args.sha)}`,
          );
          break;
        }

        case "github_compare": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.base) throw new Error("Parameter 'base' is required.");
          if (!args.head) throw new Error("Parameter 'head' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}`,
          );
          break;
        }

        // ── Releases ─────────────────────────────────────────────────────────

        case "github_list_releases": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const params = new URLSearchParams();
          params.set("per_page", String(args.per_page || 30));
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/releases?${params.toString()}`,
          );
          break;
        }

        // ── Write Operations ─────────────────────────────────────────────────

        case "github_create_issue": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.title) throw new Error("Parameter 'title' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = { title: args.title };
          if (args.body) body.body = args.body;
          if (args.labels) body.labels = args.labels;
          if (args.assignees) body.assignees = args.assignees;
          if (args.milestone) body.milestone = args.milestone;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues`,
            "POST",
            body,
          );
          break;
        }

        case "github_update_issue": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = {};
          if (args.title !== undefined) body.title = args.title;
          if (args.body !== undefined) body.body = args.body;
          if (args.state !== undefined) body.state = args.state;
          if (args.labels !== undefined) body.labels = args.labels;
          if (args.assignees !== undefined) body.assignees = args.assignees;
          if (args.milestone !== undefined) body.milestone = args.milestone;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}`,
            "PATCH",
            body,
          );
          break;
        }

        case "github_create_issue_comment": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!args.body) throw new Error("Parameter 'body' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/comments`,
            "POST",
            { body: args.body },
          );
          break;
        }

        case "github_create_pull_request": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
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
          if (args.draft !== undefined) body.draft = !!args.draft;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls`,
            "POST",
            body,
          );
          break;
        }

        case "github_update_pull_request": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.pull_number == null)
            throw new Error("Parameter 'pull_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = {};
          if (args.title !== undefined) body.title = args.title;
          if (args.body !== undefined) body.body = args.body;
          if (args.state !== undefined) body.state = args.state;
          if (args.base !== undefined) body.base = args.base;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}`,
            "PATCH",
            body,
          );
          break;
        }

        case "github_merge_pull_request": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.pull_number == null)
            throw new Error("Parameter 'pull_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = {};
          if (args.commit_title !== undefined)
            body.commit_title = args.commit_title;
          if (args.commit_message !== undefined)
            body.commit_message = args.commit_message;
          if (args.sha !== undefined) body.sha = args.sha;
          if (args.merge_method !== undefined)
            body.merge_method = args.merge_method;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}/merge`,
            "PUT",
            body,
          );
          break;
        }
        case "github_request_reviewers": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.pull_number == null)
            throw new Error("Parameter 'pull_number' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = {};
          if (args.reviewers !== undefined) body.reviewers = args.reviewers;
          if (args.team_reviewers !== undefined)
            body.team_reviewers = args.team_reviewers;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/pulls/${args.pull_number}/requested_reviewers`,
            "POST",
            body,
          );
          break;
        }

        case "github_list_labels": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const perPage = Math.min(
            Math.max(1, Number(args.per_page || 100)),
            100,
          );
          result = await fetchAllItems(
            `${API_BASE_URL}/repos/${owner}/${repo}/labels?per_page=${perPage}`,
          );
          break;
        }

        case "github_create_label": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.name) throw new Error("Parameter 'name' is required.");
          if (!args.color) throw new Error("Parameter 'color' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = { name: args.name, color: args.color };
          if (args.description !== undefined)
            body.description = args.description;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/labels`,
            "POST",
            body,
          );
          break;
        }

        case "github_set_issue_labels": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!Array.isArray(args.labels))
            throw new Error(
              "Parameter 'labels' is required and must be an array.",
            );
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels`,
            "PUT",
            { labels: args.labels },
          );
          break;
        }

        case "github_add_issue_labels": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!Array.isArray(args.labels))
            throw new Error(
              "Parameter 'labels' is required and must be an array.",
            );
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels`,
            "POST",
            { labels: args.labels },
          );
          break;
        }

        case "github_remove_issue_label": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!args.name) throw new Error("Parameter 'name' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels/${encodeURIComponent(args.name)}`,
            { method: "DELETE" },
          );
          break;
        }
        case "github_add_labels": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!Array.isArray(args.labels) || args.labels.length === 0) {
            throw new Error(
              "Parameter 'labels' is required and must be a non-empty array.",
            );
          }
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels`,
            "POST",
            { labels: args.labels },
          );
          break;
        }
        case "github_remove_label": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (args.issue_number == null)
            throw new Error("Parameter 'issue_number' is required.");
          if (!args.label) throw new Error("Parameter 'label' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/issues/${args.issue_number}/labels/${encodeURIComponent(args.label)}`,
            { method: "DELETE" },
          );
          break;
        }

        case "github_create_or_update_file": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.path) throw new Error("Parameter 'path' is required.");
          if (!args.content)
            throw new Error("Parameter 'content' is required.");
          if (!args.message)
            throw new Error("Parameter 'message' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const cleanPath = args.path.replace(/^\/+/, "");
          const body = {
            message: args.message,
            content: Buffer.from(args.content, "utf-8").toString("base64"),
          };
          if (args.branch) body.branch = args.branch;
          if (args.sha) body.sha = args.sha;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/contents/${encodePathSegments(cleanPath)}`,
            "PUT",
            body,
          );
          break;
        }

        case "github_delete_file": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.path) throw new Error("Parameter 'path' is required.");
          if (!args.message)
            throw new Error("Parameter 'message' is required.");
          if (!args.sha) throw new Error("Parameter 'sha' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const cleanPath = args.path.replace(/^\/+/, "");
          const body = { message: args.message, sha: args.sha };
          if (args.branch) body.branch = args.branch;
          if (args.committer) body.committer = args.committer;
          if (args.author) body.author = args.author;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/contents/${encodePathSegments(cleanPath)}`,
            "DELETE",
            body,
          );
          break;
        }

        case "github_create_branch": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.branch_name)
            throw new Error("Parameter 'branch_name' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);

          // Resolve the source ref to a SHA
          let sourceSha;
          if (args.from_ref) {
            try {
              const refData = await fetchJson(
                `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(args.from_ref)}`,
              );
              sourceSha = refData.object.sha;
            } catch (e) {
              try {
                const tagData = await fetchJson(
                  `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(args.from_ref)}`,
                );
                sourceSha = tagData.object.sha;
              } catch (e2) {
                // Assume it's a commit SHA directly
                sourceSha = args.from_ref;
              }
            }
          } else {
            const repoData = await fetchJson(
              `${API_BASE_URL}/repos/${owner}/${repo}`,
            );
            const defaultBranch = repoData.default_branch;
            const refData = await fetchJson(
              `${API_BASE_URL}/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
            );
            sourceSha = refData.object.sha;
          }

          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/git/refs`,
            "POST",
            { ref: `refs/heads/${args.branch_name}`, sha: sourceSha },
          );
          break;
        }
        case "github_delete_branch": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.branch_name)
            throw new Error("Parameter 'branch_name' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          result = await fetchJson(
            `${API_BASE_URL}/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(args.branch_name)}`,
            { method: "DELETE" },
          );
          break;
        }
        case "github_create_release": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          if (!args.tag_name)
            throw new Error("Parameter 'tag_name' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = { tag_name: args.tag_name };
          if (args.name !== undefined) body.name = args.name;
          if (args.body !== undefined) body.body = args.body;
          if (args.target_commitish !== undefined)
            body.target_commitish = args.target_commitish;
          if (args.draft !== undefined) body.draft = args.draft;
          if (args.prerelease !== undefined) body.prerelease = args.prerelease;
          if (args.generate_release_notes !== undefined)
            body.generate_release_notes = args.generate_release_notes;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/releases`,
            "POST",
            body,
          );
          break;
        }
        case "github_create_repo": {
          if (!args.name) throw new Error("Parameter 'name' is required.");
          const body = { name: args.name };
          if (args.description !== undefined)
            body.description = args.description;
          if (args.private !== undefined) body.private = args.private;
          if (args.auto_init !== undefined) body.auto_init = args.auto_init;
          if (args.gitignore_template !== undefined)
            body.gitignore_template = args.gitignore_template;
          if (args.license_template !== undefined)
            body.license_template = args.license_template;
          result = await fetchWithBody(
            `${API_BASE_URL}/user/repos`,
            "POST",
            body,
          );
          break;
        }
        case "github_fork_repo": {
          if (!args.repo_url)
            throw new Error("Parameter 'repo_url' is required.");
          const { owner, repo } = parseRepoUrl(args.repo_url);
          const body = {};
          if (args.organization !== undefined)
            body.organization = args.organization;
          if (args.name !== undefined) body.name = args.name;
          if (args.default_branch_only !== undefined)
            body.default_branch_only = args.default_branch_only;
          result = await fetchWithBody(
            `${API_BASE_URL}/repos/${owner}/${repo}/forks`,
            "POST",
            body,
          );
          break;
        }

        case "github_rest_get": {
          if (!args.path) throw new Error("Parameter 'path' is required.");
          const url = buildApiUrl(args.path, args.query);
          const headers = {};
          if (args.accept) headers.Accept = args.accept;
          headers["X-GitHub-Api-Version"] = args.api_version || "2022-11-28";
          result = await fetchJson(url, { headers });
          break;
        }

        case "github_rest_mutate": {
          if (!args.confirm)
            throw new Error("Parameter 'confirm' is required.");
          if (args.confirm !== "CONFIRM_GITHUB_WRITE") {
            return toolError(
              "Refusing to run github_rest_mutate without explicit confirmation. Set confirm to exactly 'CONFIRM_GITHUB_WRITE'.",
            );
          }
          if (!args.method) throw new Error("Parameter 'method' is required.");
          if (!args.path) throw new Error("Parameter 'path' is required.");
          const url = buildApiUrl(args.path, args.query);
          const headers = {};
          if (args.accept) headers.Accept = args.accept;
          headers["X-GitHub-Api-Version"] = args.api_version || "2022-11-28";
          const body = args.body || {};
          result = await fetchWithBody(url, args.method, body, { headers });
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      // Apply summarization — skip for tools that return full content or write results
      const skipSummarize = [
        "github_get_file_content",
        "github_get_readme",
        "github_get_issue",
        "github_get_pull",
        "github_get_commit",
        "github_create_issue",
        "github_create_issue_comment",
        "github_create_or_update_file",
        "github_create_branch",
        "github_update_issue",
        "github_create_pull_request",
        "github_update_pull_request",
        "github_merge_pull_request",
        "github_request_reviewers",
        "github_list_labels",
        "github_create_label",
        "github_set_issue_labels",
        "github_add_issue_labels",
        "github_remove_issue_label",
        "github_add_labels",
        "github_remove_label",
        "github_delete_file",
        "github_delete_branch",
        "github_create_release",
        "github_create_repo",
        "github_fork_repo",
        "github_rest_get",
        "github_rest_mutate",
        "github_tool_groups_list",
        "github_tool_groups_load",
        "github_tool_catalog_search",
      ];
      const finalResult = skipSummarize.includes(name)
        ? result
        : summarize(result, detailLevel);

      return toolResultFromJson(finalResult);
    } catch (error) {
      return toolError(error.message || String(error));
    }
  });

  return {
    server,
    shutdown: async () => {
      try {
        await server.close?.();
      } catch {
        // ignore
      }
    },
  };
}
