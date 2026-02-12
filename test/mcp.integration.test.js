import test from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function toolTextJson(result) {
  assert.ok(result);
  assert.ok(Array.isArray(result.content));
  assert.equal(result.content[0]?.type, 'text');
  return JSON.parse(result.content[0].text);
}

async function withClient(serverArgs, fn) {
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['src/index.js', ...serverArgs],
    env: {
      ...process.env,
      // Keep tests offline: server won't call GitHub if we don't invoke network tools.
      GITHUB_TOKEN: 'dummy',
    },
  });

  const listChangedEvents = { tools: [] };
  const client = new Client(
    { name: 'github-mcp-server-test-client', version: '0.0.0' },
    {
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            listChangedEvents.tools.push({ error, tools });
          },
        },
      },
    }
  );

  await client.connect(transport);
  try {
    await fn(client, listChangedEvents);
  } finally {
    await client.close();
    await transport.close();
  }
}

test('full tool list includes new write tools and rest escape hatch', async () => {
  await withClient(
    ['--tool-mode', 'full', '--tool-schema-verbosity', 'compact', '--idle-timeout-ms', '0', '--rate-limit', '0'],
    async (client) => {
      const tools = await client.listTools({});
      const toolNames = new Set((tools.tools || []).map(t => t.name));

      assert.ok(toolNames.has('github_create_pull_request'));
      assert.ok(toolNames.has('github_merge_pull_request'));
      assert.ok(toolNames.has('github_update_issue'));
      assert.ok(toolNames.has('github_delete_file'));
      assert.ok(toolNames.has('github_rest_get'));
      assert.ok(toolNames.has('github_rest_mutate'));
      assert.ok(toolNames.has('github_tool_groups_load'));
    }
  );
});

test('lazy tool list starts small and expands after loading groups', async () => {
  await withClient(
    [
      '--tool-mode', 'lazy',
      '--preload-groups', 'core,search',
      '--tool-schema-verbosity', 'compact',
      '--idle-timeout-ms', '0',
      '--rate-limit', '0',
    ],
    async (client, events) => {
      {
        const tools = await client.listTools({});
        const toolNames = new Set((tools.tools || []).map(t => t.name));

        assert.ok(toolNames.has('github_tool_groups_list'));
        assert.ok(toolNames.has('github_repo_info'));
        assert.ok(toolNames.has('github_search_issues'));

        // Not preloaded:
        assert.ok(!toolNames.has('github_create_issue'));
        assert.ok(!toolNames.has('github_create_pull_request'));
        assert.ok(!toolNames.has('github_rest_mutate'));
      }

      // Calling a non-loaded tool should produce a tool execution error.
      {
        const res = await client.callTool({ name: 'github_create_issue', arguments: { repo_url: 'https://github.com/a/b', title: 'x' } });
        assert.equal(res.isError, true);
        const payload = toolTextJson(res);
        assert.equal(payload.required_group, 'issues');
      }

      // Load issues tools.
      {
        const res = await client.callTool({ name: 'github_tool_groups_load', arguments: { groups: ['issues'] } });
        assert.equal(res.isError, undefined);
        const payload = toolTextJson(res);
        assert.deepEqual(payload.unknown, []);
        assert.deepEqual(payload.loaded, ['issues']);
      }

      // Wait briefly for client-side listChanged handler to refresh tools (best-effort).
      for (let i = 0; i < 50 && events.tools.length === 0; i++) {
        await new Promise(r => setTimeout(r, 20));
      }

      {
        const tools = await client.listTools({});
        const toolNames = new Set((tools.tools || []).map(t => t.name));
        assert.ok(toolNames.has('github_create_issue'));
        assert.ok(toolNames.has('github_update_issue'));
        assert.ok(toolNames.has('github_list_labels'));
      }
    }
  );
});

test('github_rest_mutate refuses without explicit confirm token', async () => {
  await withClient(
    ['--tool-mode', 'full', '--tool-schema-verbosity', 'compact', '--idle-timeout-ms', '0', '--rate-limit', '0'],
    async (client) => {
      const res = await client.callTool({
        name: 'github_rest_mutate',
        arguments: { method: 'POST', path: '/user/repos', body: { name: 'x' }, confirm: 'nope' },
      });
      assert.equal(res.isError, true);
      const payload = toolTextJson(res);
      assert.match(payload.error, /Refusing to run/);
    }
  );
});

