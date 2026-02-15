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

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

AUTH_HEADER=()
if [[ -n "$BEARER_TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${BEARER_TOKEN}")
fi

print_status() {
  local header_file="$1"
  local label="$2"
  local status_line
  status_line="$(head -n 1 "$header_file" | tr -d '\r')"
  local status_code
  status_code="$(awk 'NR==1 {print $2}' "$header_file")"
  local session_id
  session_id="$(awk 'BEGIN{IGNORECASE=1} /^Mcp-Session-Id:/ {print $2}' "$header_file" | tr -d '\r' | tail -n1)"
  echo "[$label] status: ${status_line}"
  if [[ -n "$session_id" ]]; then
    echo "[$label] session: ${session_id}"
  fi
}

echo "== MCP smoke: initialize =="
INIT_HEADERS="${WORKDIR}/init.headers"
INIT_BODY="${WORKDIR}/init.body"
curl -sS -D "$INIT_HEADERS" -o "$INIT_BODY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  "${AUTH_HEADER[@]}" \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"'"${PROTOCOL_VERSION}"'","capabilities":{"roots":{"listChanged":true}},"clientInfo":{"name":"remote-mcp-smoke","version":"1.0.0"}}}' \
  "$MCP_URL"
print_status "$INIT_HEADERS" "initialize"

SESSION_ID="$(awk 'BEGIN{IGNORECASE=1} /^Mcp-Session-Id:/ {print $2}' "$INIT_HEADERS" | tr -d '\r' | tail -n1)"
SESSION_HEADER=()
if [[ -n "$SESSION_ID" ]]; then
  SESSION_HEADER=(-H "Mcp-Session-Id: ${SESSION_ID}")
fi

echo "== MCP smoke: notifications/initialized =="
READY_HEADERS="${WORKDIR}/ready.headers"
READY_BODY="${WORKDIR}/ready.body"
curl -sS -D "$READY_HEADERS" -o "$READY_BODY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  "${AUTH_HEADER[@]}" \
  "${SESSION_HEADER[@]}" \
  --data-binary '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  "$MCP_URL"
print_status "$READY_HEADERS" "initialized"

echo "== MCP smoke: tools/list =="
TOOLS_HEADERS="${WORKDIR}/tools.headers"
TOOLS_BODY="${WORKDIR}/tools.body"
curl -sS -D "$TOOLS_HEADERS" -o "$TOOLS_BODY" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -H "MCP-Protocol-Version: ${PROTOCOL_VERSION}" \
  "${AUTH_HEADER[@]}" \
  "${SESSION_HEADER[@]}" \
  --data-binary '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  "$MCP_URL"
print_status "$TOOLS_HEADERS" "tools/list"

echo "== Response preview (tools/list body first 30 lines) =="
sed -n '1,30p' "$TOOLS_BODY"

