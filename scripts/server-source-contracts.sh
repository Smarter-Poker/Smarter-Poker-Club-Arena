#!/usr/bin/env bash
# Prints the server source-contract law files (paths relative to server/) that
# the given changed server source files must run. Arguments are paths relative
# to server/ (e.g. src/engine/ServerTableEngineTurns.ts), as the pre-push hook
# builds them. Prints nothing when no contract applies. Never fails the caller.
#
# A source-contract law reads server source as text rather than importing it,
# so `vitest related` cannot find it. Each rule below names the text a changed
# file must contain to be governed by that law.
set -u
TOP="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
out=""
for rel in "$@"; do
  f="$TOP/server/$rel"
  [ -f "$f" ] || continue
  # Horse telemetry: every fired key must be registered in the Horse data ledger.
  if grep -q "noteFire(" "$f" 2>/dev/null; then
    case " $out " in *" src/engine/HorseDataLedger.test.ts "*) ;; *) out="$out src/engine/HorseDataLedger.test.ts" ;; esac
  fi
done
echo "${out# }"
