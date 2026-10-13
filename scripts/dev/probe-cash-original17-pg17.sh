#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
evidence_root=${CASH_ORIGINAL17_EVIDENCE_DIR:?Set explicit task-owned evidence directory}
pg_bin=${PG_BIN:?Set PostgreSQL17 bin directory}
mkdir -p "$evidence_root"
if [[ $(uname -s) == Darwin && "$evidence_root" != /Volumes/SmarterWork/agent-work/* ]]; then
  echo 'Cash17 native scratch must use owned external SSD' >&2; exit 1
fi
socket_root=${CASH_ORIGINAL17_SOCKET_ROOT:-$evidence_root/socket-root}
python3 "$repo_root/scripts/qualification/cash-original17/probe-public-safe.py" \
 --public-safe --output "$evidence_root/result" --pg-bin "$pg_bin" --socket-root "$socket_root"
python3 - "$evidence_root/result/result.json" <<'PY'
import json,pathlib,sys
r=json.loads(pathlib.Path(sys.argv[1]).read_text())
if r.get('failure') or r.get('status')!='public_safe_component_qualification_passed' or r.get('cleanup')!={'stopped':True,'removed':True}:raise SystemExit('Cash17 qualification failed or cleanup unknown')
if not r.get('cash17_tested_migration'):raise SystemExit('Cash17 exact migration receipt missing')
print('PASS exact cash17 public-safe components/installer; private original17 money evidence remains separate')
PY
