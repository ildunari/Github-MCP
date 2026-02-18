function parseNonNegativeInt(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n) || Number.isNaN(n) || n < 0) return null;
  return n;
}

export function hasCliIdleTimeoutArg(rawArgv = []) {
  return rawArgv.some(arg => arg === '--idle-timeout-ms' || arg.startsWith('--idle-timeout-ms='));
}

export function resolveIdleTimeoutMs({
  transport = 'stdio',
  cliProvided = false,
  cliValue,
  env = process.env,
} = {}) {
  const defaultMs = 300_000;

  if (cliProvided) {
    return parseNonNegativeInt(cliValue) ?? defaultMs;
  }

  return parseNonNegativeInt(env?.MCP_IDLE_TIMEOUT_MS) ?? defaultMs;
}

