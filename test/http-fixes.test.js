import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/httpMcpServer.js', import.meta.url), 'utf-8');

test('HTTP server has error handler', () => {
  assert.match(src, /server\.on\(\s*['"]error['"]/,
    'HTTP server should have a server.on("error") handler');
});

test('HTTP handler has client disconnect detection', () => {
  assert.match(src, /res\.on\(\s*['"]close['"]/,
    'Handler should detect client disconnects via res.on("close")');
});
