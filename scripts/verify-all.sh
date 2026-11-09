#!/usr/bin/env bash
# Runs every check that does not need a physical board or a deployed service.
#
#   scripts/verify-all.sh
#
# The database checks need a PostgreSQL server. Set HC_PG_DSN to point at one:
#
#   HC_PG_DSN="host=/tmp port=5433 user=postgres dbname=postgres" scripts/verify-all.sh
#
# Without it the database checks are reported as skipped, not as passed.

set -uo pipefail

cd "$(dirname "$0")/.."

pass=0
fail=0
skip=0

run() {
  local name="$1"
  shift
  echo
  echo "══════════════════════════════════════════════════════════════════════"
  echo "  $name"
  echo "══════════════════════════════════════════════════════════════════════"
  if "$@"; then
    echo "→ $name: OK"
    pass=$((pass + 1))
  else
    echo "→ $name: FAILED"
    fail=$((fail + 1))
  fi
}

skip_suite() {
  local name="$1"
  local why="$2"
  echo
  echo "══════════════════════════════════════════════════════════════════════"
  echo "  $name — SKIPPED ($why)"
  echo "══════════════════════════════════════════════════════════════════════"
  skip=$((skip + 1))
}

# --------------------------------------------------------------- the database --
# The schema check rebuilds the schema, so it runs in its own scratch database
# and never touches the one the console is using.
if [ -n "${HC_PG_DSN:-}" ]; then
  run "Database schema" python3 scripts/db/verify_schema_in_scratch.py --dsn "$HC_PG_DSN"
else
  skip_suite "Database schema" "set HC_PG_DSN to run it"
fi

# --------------------------------------------------------------- the package --
run "Release package" node scripts/firmware/verify_package.mjs
run "Owner Console upload path" node scripts/firmware/verify_api_package.mjs

# -------------------------------------------------------------- the firmware --
if command -v g++ >/dev/null 2>&1; then
  run "Firmware SHA-256" bash -c 'g++ -std=c++17 -O2 scripts/firmware/verify_digest.cpp -o /tmp/hc_digest_test && /tmp/hc_digest_test'

  run "Firmware headers" bash -c \
    'g++ -std=c++17 -I scripts/firmware/arduino-shim -I firmware/homecoreos_esp32 scripts/firmware/verify_firmware_headers.cpp -o /tmp/hc_headers_test && /tmp/hc_headers_test'
  run "MQTT topic handling" bash -c \
    'g++ -std=c++17 -Wall -Wextra -I firmware/homecoreos_esp32 scripts/firmware/verify_mqtt_topics.cpp -o /tmp/hc_topics_test && /tmp/hc_topics_test'
  run "Controller lifecycle rules" bash -c \
    'g++ -std=c++17 -Wall -Wextra -I firmware/homecoreos_esp32 scripts/firmware/verify_lifecycle.cpp -o /tmp/hc_lifecycle_test && /tmp/hc_lifecycle_test'
else
  skip_suite "Firmware SHA-256" "no g++ available"
  skip_suite "Firmware headers" "no g++ available"
  skip_suite "MQTT topic handling" "no g++ available"
  skip_suite "Controller lifecycle rules" "no g++ available"
fi

# --------------------------------------------------------- the types and build --
run "TypeScript typecheck" npm run typecheck
run "Production build" npm run build

# --------------------------------------------------------------- the consoles --
# The browser sweep needs a running console and a signed-in account, so it is
# only run when both are given.
if [ -n "${HC_CONSOLE_URL:-}" ] && [ -n "${HC_CONSOLE_EMAIL:-}" ]; then
  run "Console pages" node scripts/dev/audit_console.mjs \
    "$HC_CONSOLE_URL" "$HC_CONSOLE_EMAIL" "${HC_CONSOLE_PASSWORD:-correct-horse-battery}"
  run "Dark mode" node scripts/dev/audit_dark_mode.mjs \
    "$HC_CONSOLE_URL" "$HC_CONSOLE_EMAIL" "${HC_CONSOLE_PASSWORD:-correct-horse-battery}"
  run "Console controls" node scripts/dev/test_interactions.mjs \
    "$HC_CONSOLE_URL" "${HC_CONSOLE_CUSTOMER_EMAIL:-customer@example.com}" \
    "${HC_CONSOLE_PASSWORD:-correct-horse-battery}"
else
  skip_suite "Console pages" "set HC_CONSOLE_URL and HC_CONSOLE_EMAIL to run it"
  skip_suite "Dark mode" "set HC_CONSOLE_URL and HC_CONSOLE_EMAIL to run it"
  skip_suite "Console controls" "set HC_CONSOLE_URL and HC_CONSOLE_EMAIL to run it"
fi

# ---------------------------------------------------------------- the summary --
echo
echo "══════════════════════════════════════════════════════════════════════"
echo "  $pass passed, $fail failed, $skip skipped"
echo "══════════════════════════════════════════════════════════════════════"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
