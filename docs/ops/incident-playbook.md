# Connector Incident Playbook

Use this when Claude.ai connector traffic starts failing or suspicious access is detected.

## Fast triage (first 5 minutes)
1. Confirm endpoint health (`/healthz`/`/readyz` if exposed by gateway).
2. Run smoke test:
   - `/Users/kosta/Documents/ProjectsCode/github-mcp-server/scripts/smoke/remote-mcp-smoke.sh`
3. Check latest status class:
   - 4xx likely auth/header/session issue
   - 5xx likely gateway/origin/server runtime issue

## Credential or exposure suspicion
1. Immediately rotate credentials:
   - GitHub token used by MCP server
   - Any gateway bearer secrets
2. Temporarily disable public connector route at Cloudflare.
3. Re-enable only after fresh validation.

## Common failure mappings
- `401`: missing/invalid auth credential.
- `403`: blocked by edge policy / scope restrictions.
- `404` with session header: expired or unknown session.
- `400`: malformed request or protocol/header mismatch.
- `405`: unsupported method for current transport settings.

## Recovery checklist
1. Confirm gateway process is running and healthy.
2. Verify Cloudflare rules (allowlist/rate-limit/auth) still match intended config.
3. Validate header pass-through for MCP headers.
4. Re-run smoke scripts and capture outputs.
5. Re-test from Claude.ai connector UI.

## Post-incident actions
1. Record timeline and root cause.
2. Document preventive change in runbook.
3. Add/adjust test or smoke check to catch recurrence.

