import test from 'node:test';
import assert from 'node:assert/strict';

import { hasCliIdleTimeoutArg, resolveIdleTimeoutMs } from '../src/idleTimeoutPolicy.js';

test('detects when --idle-timeout-ms is explicitly provided on CLI', () => {
  assert.equal(hasCliIdleTimeoutArg([]), false);
  assert.equal(hasCliIdleTimeoutArg(['--transport', 'stdio']), false);
  assert.equal(hasCliIdleTimeoutArg(['--idle-timeout-ms', '0']), true);
  assert.equal(hasCliIdleTimeoutArg(['--idle-timeout-ms=900000']), true);
});

test('default idle timeout is 0 for stdio when not explicitly configured', () => {
  const value = resolveIdleTimeoutMs({
    transport: 'stdio',
    cliProvided: false,
    env: {},
  });
  assert.equal(value, 0);
});

test('default idle timeout is 300000 for http when not explicitly configured', () => {
  const value = resolveIdleTimeoutMs({
    transport: 'http',
    cliProvided: false,
    env: {},
  });
  assert.equal(value, 300000);
});

test('env value is used when CLI does not explicitly provide idle timeout', () => {
  const value = resolveIdleTimeoutMs({
    transport: 'stdio',
    cliProvided: false,
    env: { MCP_IDLE_TIMEOUT_MS: '12345' },
  });
  assert.equal(value, 12345);
});

test('explicit CLI value overrides env value', () => {
  const value = resolveIdleTimeoutMs({
    transport: 'stdio',
    cliProvided: true,
    cliValue: 777,
    env: { MCP_IDLE_TIMEOUT_MS: '12345' },
  });
  assert.equal(value, 777);
});

