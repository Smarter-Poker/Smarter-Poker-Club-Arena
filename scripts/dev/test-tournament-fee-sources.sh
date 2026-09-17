#!/usr/bin/env bash
# Payload for approved protected execution. This is not a pipeline bypass.
# Do not invoke while the protected local pipeline is unavailable.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
work="$root/tests/fixtures/tournament-fee-sources"
pgbin=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
fixture=$(mktemp -d /tmp/tfs.XXXXXX)
started=0
cleanup() {
  if [ "$started" = 1 ]; then
    "$pgbin/pg_ctl" -D "$fixture/data" -m immediate stop >/dev/null
  fi
  rm -rf "$fixture"
}
trap cleanup EXIT

# Validate the reviewed bytes before extracting authoritative production code.
# Generated SQL is confined to this disposable execution directory.
python3 - "$root" "$work" "$fixture" <<'PY'
from pathlib import Path
import hashlib, json, re, sys
root, work, output = map(Path, sys.argv[1:])
binding = json.loads((work / 'source-binding.json').read_text())
def require_hash(body, expected, label):
    if hashlib.sha256(body).hexdigest() != expected:
        raise SystemExit('Unreviewed source drift: ' + label)
tournament = binding['tournament_component']
raw = (root / tournament['path']).read_bytes()
require_hash(raw, tournament['sha256'], tournament['path'])
source = raw.decode()
for name, expected in tournament['sections'].items():
    start, end = '\n-- BEGIN ' + name + '\n', '\n-- END ' + name + '\n'
    if source.count(start) != 1 or source.count(end) != 1:
        raise SystemExit('Ambiguous component section: ' + name)
    body = source.split(start, 1)[1].split(end, 1)[0].encode()
    require_hash(body, expected, name)
    (output / name).write_bytes(body)
shared = binding['shared_commission_function']
matches = re.findall(r'CREATE FUNCTION public.fn_post_accounting_commission_source\([\s\S]*?END \$function\$;', (root / shared['path']).read_text())
if len(matches) != 1:
    raise SystemExit('Shared commission definition missing or ambiguous')
require_hash(matches[0].encode(), shared['sha256'], shared['function'])
(output / 'shared-commission-writer-native.sql').write_text(matches[0])
for name, expected in binding['fixtures'].items():
    require_hash((work / name).read_bytes(), expected, name)
PY

mkdir "$fixture/socket"
"$pgbin/initdb" -D "$fixture/data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
"$pgbin/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-k $fixture/socket -p 55493 -h ''" start >/dev/null
started=1
"$pgbin/psql" -X -q -v ON_ERROR_STOP=1 -h "$fixture/socket" -p 55493 -U postgres -d postgres \
  -f "$work/tournament-fee-native-bootstrap.sql" \
  -f "$fixture/tournament-fee-receipts-draft.sql" \
  -f "$work/tournament-fee-native-regression.sql" \
  -f "$fixture/tournament-fee-producer-adapter-draft.sql" \
  -f "$work/tournament-fee-producer-native.sql" \
  -f "$fixture/shared-commission-writer-native.sql" \
  -f "$fixture/tournament-fee-recognition-draft.sql" \
  -f "$fixture/tournament-fee-terminal-common-draft.sql" \
  -f "$work/tournament-fee-recognition-native.sql" \
  -f "$work/tournament-fee-settle-native-bootstrap.sql" \
  -f "$fixture/tournament-fee-settle-adapter-draft.sql" \
  -f "$work/tournament-fee-settle-native.sql" \
  -f "$fixture/tournament-fee-legacy-adapters-draft.sql" \
  -f "$work/tournament-fee-terminal-extra-native.sql" \
  -f "$work/tournament-fee-monitor-native-bootstrap.sql" \
  -f "$fixture/tournament-fee-monitor-draft.sql" \
  -f "$work/tournament-fee-monitor-native.sql" \
  -f "$work/tournament-terminal-native-seed.sql" \
  -f "$work/tournament-terminal-native-schema.sql" \
  -f "$work/tournament-terminal-native-support.sql" \
  -f "$work/terminal-marker-native.sql" \
  -f "$fixture/tournament-fee-terminal-gates-draft.sql" \
  -f "$work/tournament-terminal-native.sql" \
  -f "$work/tournament-extra-native-compile-schema.sql" \
  -f "$fixture/tournament-fee-satellite-gates-draft.sql" \
  -f "$fixture/tournament-fee-cancellation-adapter-draft.sql" 2>&1 | tee "$fixture/assertions.log"
python3 - "$fixture/assertions.log" "$work/source-binding.json" <<'PY'
from pathlib import Path
import json, re, sys
expected = json.loads(Path(sys.argv[2]).read_text())['historical_assertion_executions']
count = len(re.findall(r'NOTICE:\s+PASS: ', Path(sys.argv[1]).read_text()))
if count != expected:
    raise SystemExit(f'Assertion execution count changed: expected {expected}, observed {count}')
print(f'Tournament fee source assertions: {count}')
PY
