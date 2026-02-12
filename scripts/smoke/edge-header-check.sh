#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <mcp_url> [bearer_token]" >&2
  echo "Example: $0 https://example.com/mcp" >&2
  exit 2
fi

MCP_URL="$1"
BEARER_TOKEN="${2:-}"
PROTOCOL_VERSION="${MCP_PROTOCOL_VERSION:-2025-06-18}"

AUTH_HEADER=()
if [[ -n "$BEARER_TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${BEARER_TOKEN}")
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

run_request() {
  local name="$1"
  local method="$2"
  local outfile_prefix="${WORKDIR}/${name}"
  shift 2

  curl -sS -D "${outfile_prefix}.headers" -o "${outfile_prefix}.body" \
    -X "$method" \
    "${AUTH_HEADER[@]}" \
    "$@" \
    "$MCP_URL"

  local status_line
  status_line="$(head -n 1 "${outfile_prefix}.headers" | tr -d '\r')"
  echo "[${name}] ${status_line}"
  awk 'BEGIN{IGNORECASE=1}
    /^Mcp-Session-Id:/ {print "[header] Mcp-Session-Id: " $2}
    /^WWW-Authenticate:/ {sub(/\r$/, "", $0); print "[header] " $0}
    /^Content-Type:/ {sub(/\r$/, "", $0); print "[header] " $0}
  ' "${outfile_prefix}.headers"
}

echo "== edge check: GET without session =="
run_request "get-no-session" "GET" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  -H "Origin: https://diagnostic.local"

echo
echo "== edge check: GET with fake session =="
run_request "get-fake-session" "GET" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  -H "Mcp-Session-Id: not-a-real-session" \
  -H "Origin: https://diagnostic.local"

echo
echo "== edge check: POST initialize =="
run_request "post-initialize" "POST" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"${PROTOCOL_VERSION}"'","capabilities":{"roots":{"listChanged":true}},"clientInfo":{"name":"edge-header-check","version":"1.0.0"}}}'

echo
echo "== body previews (first 20 lines each) =="
for f in "${WORKDIR}"/*.body; do
  echo "-- $(basename "$f") --"
  sed -n '1,20p' "$f"
done

