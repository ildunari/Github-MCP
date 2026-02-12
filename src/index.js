#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { createGithubServer } from './githubServerFactory.js';
import { startHttpMcpServer } from './httpMcpServer.js';

const SERVER_VERSION = (() => {
  try {
    const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw);
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

function defaultIdleTimeoutMs() {
  const raw = process.env.MCP_IDLE_TIMEOUT_MS;
  if (raw === undefined) return 300_000; // 5 minutes: avoids leaking stdio servers forever by default.
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 300_000;
}

const rawArgv = hideBin(process.argv);
const wantsHelp = rawArgv.includes('--help') || rawArgv.includes('-h');

const y = yargs(rawArgv)
  .option('github-token', {
    alias: 't',
    type: 'string',
    description: 'GitHub access token for API requests',
  })
  .option('transport', {
    type: 'string',
    choices: ['stdio', 'http'],
    description: 'Transport mode. stdio is default; http exposes a native /mcp endpoint (Streamable HTTP).',
    default: process.env.MCP_TRANSPORT || 'stdio',
  })
  .option('tool-mode', {
    type: 'string',
    choices: ['full', 'lazy'],
    description: 'Tool listing mode. "lazy" starts with minimal tools and loads groups on demand.',
    default: process.env.MCP_TOOL_MODE || 'full',
  })
  .option('preload-groups', {
    type: 'string',
    description: 'Comma-separated tool group IDs to preload (used in --tool-mode lazy).',
    default: process.env.MCP_PRELOAD_GROUPS || '',
  })
  .option('tool-schema-verbosity', {
    type: 'string',
    choices: ['full', 'compact'],
    description: 'Tool schema verbosity to reduce initial context cost.',
    default: process.env.MCP_TOOL_SCHEMA_VERBOSITY || 'full',
  })
  .option('tool-output', {
    type: 'string',
    choices: ['text', 'structured', 'both'],
    description: 'Tool output mode: JSON text, structuredContent, or both.',
    default: process.env.MCP_TOOL_OUTPUT || 'text',
  })
  .option('tool-output-schema', {
    type: 'string',
    choices: ['none', 'bootstrap', 'all_loose'],
    description: 'Whether tools advertise outputSchema (enables structuredContent validation in clients).',
    default: process.env.MCP_TOOL_OUTPUT_SCHEMA || 'none',
  })
  .option('idle-timeout-ms', {
    type: 'number',
    description:
      'Exit after this many ms without receiving an MCP request (0 disables). In http mode this applies to idle sessions.',
    default: defaultIdleTimeoutMs(),
  })
  .option('rate-limit', {
    alias: 'r',
    type: 'number',
    description: 'Rate limit delay in ms between GitHub API requests',
    default: 100,
  })
  // Streamable HTTP options
  .option('http-host', {
    type: 'string',
    description: 'Host to bind Streamable HTTP server to.',
    default: process.env.MCP_HTTP_HOST || '127.0.0.1',
  })
  .option('http-port', {
    type: 'number',
    description: 'Port to bind Streamable HTTP server to (0 chooses an ephemeral port).',
    default: process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : 3000,
  })
  .option('http-path', {
    type: 'string',
    description: 'Path for Streamable HTTP endpoint.',
    default: process.env.MCP_HTTP_PATH || '/mcp',
  })
  .option('http-tls-key', {
    type: 'string',
    description: 'Path to TLS private key (enables https when used with --http-tls-cert).',
    default: process.env.MCP_HTTP_TLS_KEY,
  })
  .option('http-tls-cert', {
    type: 'string',
    description: 'Path to TLS certificate (enables https when used with --http-tls-key).',
    default: process.env.MCP_HTTP_TLS_CERT,
  })
  .option('http-auth-token', {
    type: 'string',
    description: 'Optional Bearer token required to access the /mcp endpoint.',
    default: process.env.MCP_HTTP_AUTH_TOKEN,
  })
  .option('http-allowed-origins', {
    type: 'string',
    description: 'Comma-separated Origin allowlist (enforced only when Origin header is present).',
    default: process.env.MCP_HTTP_ALLOWED_ORIGINS || '',
  })
  .option('http-allowed-hosts', {
    type: 'string',
    description: 'Comma-separated Host allowlist (recommended when binding to 0.0.0.0/::).',
    default: process.env.MCP_HTTP_ALLOWED_HOSTS || '',
  })
  .option('http-max-sessions', {
    type: 'number',
    description: 'Maximum concurrent MCP sessions (DoS guard).',
    default: process.env.MCP_HTTP_MAX_SESSIONS ? Number(process.env.MCP_HTTP_MAX_SESSIONS) : 50,
  })
  .option('http-require-auth-on-public-bind', {
    type: 'boolean',
    description: 'Refuse startup if HTTP binds off-localhost without --http-auth-token.',
    default: process.env.MCP_HTTP_REQUIRE_AUTH_ON_PUBLIC_BIND === 'true',
  })
  .help()
  .alias('help', 'h')
  .exitProcess(false);

const argv = y.parse();
if (wantsHelp) process.exit(0);

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

const TOOL_MODE = argv.toolMode || 'full';
const TOOL_SCHEMA_VERBOSITY = argv.toolSchemaVerbosity || 'full';
const TOOL_OUTPUT = argv.toolOutput || 'text';
const TOOL_OUTPUT_SCHEMA = argv.toolOutputSchema || 'none';
const PRELOAD_GROUPS_RAW = argv.preloadGroups || '';
const DEFAULT_PRELOAD_GROUPS = TOOL_MODE === 'lazy' ? 'core,search' : '';
const PRELOAD_GROUPS = (PRELOAD_GROUPS_RAW || DEFAULT_PRELOAD_GROUPS)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const RATE_LIMIT_DELAY = argv.rateLimit;
const IDLE_TIMEOUT_MS = argv.idleTimeoutMs;
const TRANSPORT = argv.transport || 'stdio';

function makeServer({ onActivity } = {}) {
  return createGithubServer({
    githubToken: GITHUB_TOKEN,
    rateLimitDelay: RATE_LIMIT_DELAY,
    toolMode: TOOL_MODE,
    toolSchemaVerbosity: TOOL_SCHEMA_VERBOSITY,
    preloadGroups: PRELOAD_GROUPS,
    toolOutput: TOOL_OUTPUT,
    toolOutputSchemaMode: TOOL_OUTPUT_SCHEMA,
    serverVersion: SERVER_VERSION,
    onActivity,
  });
}

async function runStdio() {
  const transport = new StdioServerTransport();
  let lastActivityTime = Date.now();

  const { server, shutdown } = makeServer({
    onActivity: () => {
      lastActivityTime = Date.now();
    },
  });

  let shuttingDown = false;
  async function closeAll(reason, exitCode = 0) {
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
      await shutdown();
    } catch {
      // ignore
    }

    process.exit(exitCode);
  }

  process.stdin.on('end', () => closeAll('stdin ended'));
  process.stdin.on('close', () => closeAll('stdin closed'));
  process.on('SIGINT', () => closeAll('SIGINT', 130));
  process.on('SIGTERM', () => closeAll('SIGTERM', 143));
  process.on('SIGHUP', () => closeAll('SIGHUP', 129));
  process.on('uncaughtException', (err) => {
    try {
      console.error('uncaughtException:', err);
    } catch {
      // ignore
    }
    closeAll('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => {
    try {
      console.error('unhandledRejection:', err);
    } catch {
      // ignore
    }
    closeAll('unhandledRejection', 1);
  });

  if (IDLE_TIMEOUT_MS > 0) {
    const tickMs = Math.min(Math.max(1000, Math.floor(IDLE_TIMEOUT_MS / 5)), 30_000);
    const interval = setInterval(() => {
      const idleForMs = Date.now() - lastActivityTime;
      if (idleForMs >= IDLE_TIMEOUT_MS) {
        closeAll(`idle timeout (${idleForMs}ms >= ${IDLE_TIMEOUT_MS}ms)`);
      }
    }, tickMs);
    interval.unref?.();
  }

  await server.connect(transport);
  console.error(`GitHub MCP Server v${SERVER_VERSION} running on stdio`);
}

async function runHttp() {
  const httpHost = argv.httpHost;
  const httpPort = argv.httpPort;
  const httpPath = argv.httpPath;

  const { close } = await startHttpMcpServer({
    host: httpHost,
    port: httpPort,
    path: httpPath,
    tlsKeyPath: argv.httpTlsKey,
    tlsCertPath: argv.httpTlsCert,
    authToken: argv.httpAuthToken,
    allowedOrigins: argv.httpAllowedOrigins,
    allowedHosts: argv.httpAllowedHosts,
    maxSessions: argv.httpMaxSessions,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    requireAuthOnPublicBind: Boolean(argv.httpRequireAuthOnPublicBind),
    createServerForSession: ({ onActivity }) => makeServer({ onActivity }),
  });

  let shuttingDown = false;
  async function shutdownHttp(reason, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      console.error(`GitHub MCP Server shutting down (${reason})`);
    } catch {
      // ignore
    }
    try {
      await close();
    } catch {
      // ignore
    }
    process.exit(exitCode);
  }

  process.on('SIGINT', () => shutdownHttp('SIGINT', 130));
  process.on('SIGTERM', () => shutdownHttp('SIGTERM', 143));
  process.on('SIGHUP', () => shutdownHttp('SIGHUP', 129));
}

async function main() {
  if (TRANSPORT === 'http') {
    await runHttp();
    return;
  }
  await runStdio();
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
