import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function toolTextJson(result) {
  assert.ok(result);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

async function startServer(args) {
  const proc = spawn('node', ['src/index.js', ...args], {
    env: {
      ...process.env,
      GITHUB_TOKEN: 'dummy',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  let url;

  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for server to listen. stderr:\n${stderr}`));
    }, 10_000);

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      stderr += chunk;
      const m = stderr.match(/MCP HTTP listening on (https?:\/\/[^\s]+)/);
      if (m && m[1]) {
        url = m[1];
        clearTimeout(timeout);
        resolve();
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (code) => {
      if (url) return;
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code}. stderr:\n${stderr}`));
    });
  });

  await ready;
  return { proc, url: new URL(url), getStderr: () => stderr };
}

async function startServerExpectExit(args) {
  const proc = spawn('node', ['src/index.js', ...args], {
    env: {
      ...process.env,
      GITHUB_TOKEN: 'dummy',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for process exit. stderr:\n${stderr}`));
    }, 10_000);
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('exit', (exitCode) => {
      clearTimeout(timeout);
      resolve(exitCode);
    });
  });

  return { code, stderr };
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5000);
    proc.on('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function withHttpClient(serverArgs, fn) {
  const { proc, url } = await startServer(serverArgs);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: 'github-mcp-server-http-test-client', version: '0.0.0' }, {});

  try {
    await client.connect(transport);
    await fn(client, transport, url);
  } finally {
    try {
      await transport.terminateSession();
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
    try {
      await transport.close();
    } catch {
      // ignore
    }
    await stopServer(proc);
  }
}

test('http: full tool list includes rest escape hatch', async () => {
  await withHttpClient(
    ['--transport', 'http', '--http-port', '0', '--tool-mode', 'full', '--tool-schema-verbosity', 'compact', '--idle-timeout-ms', '0', '--rate-limit', '0'],
    async (client, transport, url) => {
      const tools = await client.listTools({});
      const toolNames = new Set((tools.tools || []).map(t => t.name));
      assert.ok(toolNames.has('github_rest_mutate'));
      assert.ok(toolNames.has('github_tool_groups_load'));

      // Unknown session should be rejected.
      const resp = await fetch(url, {
        method: 'GET',
        headers: { 'Mcp-Session-Id': 'not-a-real-session' },
      });
      assert.equal(resp.status, 404);
    }
  );
});

test('http: lazy tool list starts small and expands after loading groups', async () => {
  await withHttpClient(
    [
      '--transport', 'http',
      '--http-port', '0',
      '--tool-mode', 'lazy',
      '--preload-groups', 'core,search',
      '--tool-schema-verbosity', 'compact',
      '--idle-timeout-ms', '0',
      '--rate-limit', '0',
    ],
    async (client, transport, url) => {
      {
        const tools = await client.listTools({});
        const toolNames = new Set((tools.tools || []).map(t => t.name));
        assert.ok(toolNames.has('github_tool_groups_list'));
        assert.ok(!toolNames.has('github_rest_mutate'));
      }

      {
        const result = await client.callTool({
          name: 'github_tool_groups_load',
          arguments: { groups: ['issues'] },
        });
        const parsed = toolTextJson(result);
        assert.ok(Array.isArray(parsed.loaded));
      }

      {
        const tools = await client.listTools({});
        const toolNames = new Set((tools.tools || []).map(t => t.name));
        assert.ok(toolNames.has('github_update_issue'));
      }

      // Terminate session and verify it disappears server-side (best-effort polling).
      const sid = transport.sessionId;
      assert.ok(sid);
      await transport.terminateSession();
      for (let i = 0; i < 20; i++) {
        const resp = await fetch(url, { method: 'GET', headers: { 'Mcp-Session-Id': sid } });
        if (resp.status === 404) break;
        await new Promise(r => setTimeout(r, 25));
      }
      const resp2 = await fetch(url, { method: 'GET', headers: { 'Mcp-Session-Id': sid } });
      assert.equal(resp2.status, 404);
    }
  );
});

test('http: requires auth token on public bind when strict flag is enabled', async () => {
  const { code, stderr } = await startServerExpectExit([
    '--transport', 'http',
    '--http-host', '0.0.0.0',
    '--http-port', '0',
    '--http-require-auth-on-public-bind', 'true',
  ]);

  assert.notEqual(code, 0);
  assert.match(stderr, /auth/i);
});

test('http: rejects unauthenticated request when --http-auth-token is set', async () => {
  const { proc, url } = await startServer([
    '--transport', 'http',
    '--http-port', '0',
    '--http-auth-token', 'test-token',
    '--idle-timeout-ms', '0',
  ]);
  try {
    const resp = await fetch(url, { method: 'GET' });
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('www-authenticate'), 'Bearer');
  } finally {
    await stopServer(proc);
  }
});

test('http: enforces origin allowlist when configured', async () => {
  const { proc, url } = await startServer([
    '--transport', 'http',
    '--http-port', '0',
    '--http-allowed-origins', 'https://allowed.example.com',
    '--idle-timeout-ms', '0',
  ]);
  try {
    const denied = await fetch(url, {
      method: 'GET',
      headers: { Origin: 'https://blocked.example.com' },
    });
    assert.equal(denied.status, 403);

    const allowed = await fetch(url, {
      method: 'GET',
      headers: { Origin: 'https://allowed.example.com' },
    });
    assert.equal(allowed.status, 400);
  } finally {
    await stopServer(proc);
  }
});

test('http oauth scaffold: serves protected resource metadata document', async () => {
  const { proc, url } = await startServer([
    '--transport', 'http',
    '--http-port', '0',
    '--http-oauth-protected-resource-path', '/.well-known/oauth-protected-resource',
    '--http-oauth-authorization-server-issuer', 'https://auth.example.com',
    '--http-oauth-scopes', 'mcp.read,mcp.write',
    '--idle-timeout-ms', '0',
  ]);
  try {
    const resp = await fetch(new URL('/.well-known/oauth-protected-resource', url));
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.resource, url.toString());
    assert.ok(Array.isArray(body.authorization_servers));
    assert.ok(body.authorization_servers.includes('https://auth.example.com'));
    assert.ok(Array.isArray(body.scopes_supported));
    assert.ok(body.scopes_supported.includes('mcp.read'));
  } finally {
    await stopServer(proc);
  }
});

test('http oauth scaffold: unauthorized challenge advertises resource metadata URL', async () => {
  const { proc, url } = await startServer([
    '--transport', 'http',
    '--http-port', '0',
    '--http-auth-token', 'test-token',
    '--http-oauth-resource-metadata-url', 'https://auth.example.com/.well-known/oauth-protected-resource',
    '--idle-timeout-ms', '0',
  ]);
  try {
    const resp = await fetch(url, { method: 'GET' });
    assert.equal(resp.status, 401);
    const challenge = resp.headers.get('www-authenticate') || '';
    assert.match(challenge, /Bearer/i);
    assert.match(challenge, /resource_metadata=/i);
    assert.match(challenge, /https:\/\/auth\.example\.com\/\.well-known\/oauth-protected-resource/i);
  } finally {
    await stopServer(proc);
  }
});

test('http oauth cutover path: keeps /mcp open while requiring auth on /mcp-oauth', async () => {
  const { proc, url } = await startServer([
    '--transport', 'http',
    '--http-port', '0',
    '--http-oauth-cutover-path', '/mcp-oauth',
    '--http-oauth-cutover-token', 'cutover-token',
    '--idle-timeout-ms', '0',
  ]);
  try {
    const primary = await fetch(url, { method: 'GET' });
    assert.equal(primary.status, 400);

    const cutoverNoAuth = await fetch(new URL('/mcp-oauth', url), { method: 'GET' });
    assert.equal(cutoverNoAuth.status, 401);

    const initResp = await fetch(new URL('/mcp-oauth', url), {
      method: 'POST',
      headers: {
        'Accept': 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-06-18',
        'Authorization': 'Bearer cutover-token',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: { roots: { listChanged: true } },
          clientInfo: { name: 'cutover-test', version: '1.0.0' },
        },
      }),
    });
    assert.notEqual(initResp.status, 401);
    const sid = initResp.headers.get('mcp-session-id');
    assert.ok(sid);

    // Session created on cutover endpoint should not be valid on primary endpoint.
    const wrongPathUse = await fetch(url, {
      method: 'GET',
      headers: { 'Mcp-Session-Id': sid },
    });
    assert.equal(wrongPathUse.status, 404);
  } finally {
    await stopServer(proc);
  }
});

test('http oauth cutover path: requires cutover token or fallback auth token', async () => {
  const { code, stderr } = await startServerExpectExit([
    '--transport', 'http',
    '--http-port', '0',
    '--http-oauth-cutover-path', '/mcp-oauth',
  ]);

  assert.notEqual(code, 0);
  assert.match(stderr, /oauthCutoverToken|cutover/i);
});
