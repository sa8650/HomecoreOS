#!/usr/bin/env bash
# Exercises every console endpoint against the local API and reports the
# status of each one, so a broken page is visible as a failing request.
#
#   scripts/dev/probe_endpoints.sh [base-url]

BASE="${1:-http://127.0.0.1:8787}"
JAR="${HC_JAR:-/tmp/hc-probe-cookies.txt}"
rm -f "$JAR"

email="${HC_PROBE_EMAIL:-probe-owner@example.com}"
pass="correct-horse-battery"

echo "── signing in"
code=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' -H 'User-Agent: probe' \
  -d "{\"email\":\"$email\",\"password\":\"$pass\"}" -o /dev/null -w '%{http_code}')
if [ "$code" != "200" ]; then
  code=$(curl -s -c "$JAR" -X POST "$BASE/api/auth/signup" \
    -H 'Content-Type: application/json' -H 'User-Agent: probe' \
    -d "{\"email\":\"$email\",\"password\":\"$pass\",\"full_name\":\"Probe Owner\",\"home_name\":\"Probe Home\"}" \
    -o /dev/null -w '%{http_code}')
  echo "  signup: $code"
fi
echo "  login: $code"

probe() {
  local method="$1" path="$2" body="${3:-}"
  local out code
  if [ -n "$body" ]; then
    out=$(curl -s -b "$JAR" -X "$method" "$BASE$path" \
      -H 'Content-Type: application/json' -H 'User-Agent: probe' \
      -d "$body" -w '\n__CODE__%{http_code}')
  else
    out=$(curl -s -b "$JAR" -X "$method" "$BASE$path" \
      -H 'User-Agent: probe' -w '\n__CODE__%{http_code}')
  fi
  code=$(printf '%s' "$out" | sed -n 's/.*__CODE__//p')
  local bodytext
  bodytext=$(printf '%s' "$out" | sed 's/__CODE__[0-9]*$//' | tr -d '\n' | cut -c1-150)
  local mark="OK "
  case "$code" in
    2*) mark="OK " ;;
    401|403) mark="AUTH" ;;
    404) mark="404 " ;;
    500) mark="FAIL" ;;
    *) mark="FAIL" ;;
  esac
  printf '  [%s] %-6s %-46s %s  %s\n' "$mark" "$code" "$method $path" "" "$bodytext"
}

echo ""
echo "── owner console"
for p in /api/owner/overview /api/owner/setup /api/owner/customers /api/owner/staff \
         /api/owner/firmware /api/owner/boards /api/owner/emqx/settings /api/owner/usage \
         /api/owner/settings /api/owner/integrations /api/owner/audit \
         /api/owner/auth /api/owner/auth/security; do
  probe GET "$p"
done

echo ""
echo "── customer console"
for p in /api/overview /api/rooms /api/devices /api/sensors /api/boards /api/automations \
         /api/firmware/catalog /api/firmware/history /api/activity /api/staff /api/settings \
         /api/board-catalog /api/buses /api/announcements /api/usage /api/telemetry /api/commands \
         /api/stream /api/context /api/auth/me /api/auth/sessions; do
  probe GET "$p"
done
