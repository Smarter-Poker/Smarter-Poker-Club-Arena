#!/usr/bin/env bash
set -euo pipefail
export LC_ALL=C LANG=C
INSPECTOR_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export INSPECTOR_HERE CASCADE_OUTER_MODE=1
readonly OUTER_REPO=/Users/smarter.poker/Documents/.agent-trees/Smarter-Poker-Club-Arena/codex-union-cascade-integration-sep10
readonly OUTER_COMMIT=15d61d05315b78b3128d330d84e0c9984367c93e
export INSPECTOR_OUTER_COMMIT="$OUTER_COMMIT"
archive_dir="$(mktemp -d /tmp/ca-completeness-input.XXXXXX)"
git -C "$OUTER_REPO" archive "$OUTER_COMMIT" docs/audits/2026-09-10-union-source-cascade | tar -x -C "$archive_dir"
outer="$archive_dir/docs/audits/2026-09-10-union-source-cascade"
export INSPECTOR_OUTER="$outer"
# Preserve the reviewed cluster isolation and exact actual-owner composition.
# Replace only the probe selector, so unchanged suites are not rerun.
python3 - <<'PATCH'
import os
from pathlib import Path
p=Path(os.environ['INSPECTOR_OUTER']);s=(p/'run-local.sh').read_text()
old=' python3 "$HERE/outer-native-probe.py"';new=' python3 "$INSPECTOR_HERE/native-probe.py"'
assert s.count(old)==1
(p/'run-inspector.sh').write_text(s.replace(old,new))
PATCH
bash "$outer/run-inspector.sh"
cp "$outer/cluster-identity-outer.json" "$INSPECTOR_HERE/cluster-identity.json"
