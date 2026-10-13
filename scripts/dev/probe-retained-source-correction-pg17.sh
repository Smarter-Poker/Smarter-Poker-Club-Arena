#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../.." && pwd)
evidence_root=${RETAINED_SOURCE_CORRECTION_EVIDENCE_DIR:?Set an explicit task-owned evidence directory}
pg_bin=${PG_BIN:?Set the PostgreSQL 17 bin directory}
mkdir -p "$evidence_root"
evidence_root=$(cd "$evidence_root" && pwd)
if [[ $(uname -s) == Darwin && "$evidence_root" != /Volumes/SmarterWork/agent-work/* ]]; then
  echo 'Mac native scratch and evidence must use the owned external SSD' >&2
  exit 1
fi
socket_root="$evidence_root/socket-root"
mkdir -p "$socket_root"
python3 "$repo_root/scripts/qualification/retained18-correction/probe-native-bootstrap.py" \
  --output "$evidence_root/result" --pg-bin "$pg_bin" --socket-root "$socket_root" "$@"
python3 - "$evidence_root/result/result.json" <<'PY'
import json, pathlib, sys
result = json.loads(pathlib.Path(sys.argv[1]).read_text())
if result.get('failure') or result.get('status') not in (
    'public_safe_component_qualification_passed',
    'actual_original30_connected_qualification_passed',
):
    raise SystemExit('Retained source correction qualification failed; inspect the retained scoped result')
if result.get('cleanup') != {'stopped': True, 'removed': True}:
    raise SystemExit('Owned native cluster cleanup is unverified')
print(result['status'])
PY
