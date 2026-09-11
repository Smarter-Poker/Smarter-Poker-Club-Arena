#!/usr/bin/env bash
# This runner creates and mutates ONLY its own temporary PostgreSQL cluster.
set -euo pipefail
export LC_ALL=C LANG=C
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PAYER_REPO=/Users/smarter.poker/Documents/.agent-trees/club-arena/codex-rakeback-payers-sep10
readonly PGBIN=/opt/homebrew/opt/postgresql@17/bin
readonly PAYER_COMMIT=7adbfb02544b68ccc1754c51f11d2f61fa406180
# Never accept an inherited libpq target, service alias, options or credential.
unset PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSFILE PGPASSWORD PGSSLMODE
proof_tmp="$(mktemp -d /tmp/ca-cash-seal-native.XXXXXX)"
readonly proof_tmp
readonly proof_data="$proof_tmp/data"
readonly proof_socket="$proof_tmp/socket"
mkdir "$proof_socket" "$proof_tmp/archive"
# Exact archived inputs only; no production rows or credentials are loaded.
git -C "$PAYER_REPO" archive "$PAYER_COMMIT" docs/audits/2026-09-10-rakeback-payer-proof | tar -x -C "$proof_tmp/archive"
base="$proof_tmp/archive/docs/audits/2026-09-10-rakeback-payer-proof/round1-owner"
cp -R "$base/vendor" "$proof_tmp/input"
fixture="$proof_tmp/input/source-authority/owner-composition"
cp "$base"/function-catalog-round1.json "$base"/table-catalog-round1.json "$fixture/"
cp "$base"/table-catalog-capacity-extra.json "$base"/function-catalog-capacity-extra.json "$base"/trigger-catalog-capacity-extra.json "$fixture/"
proof_share="$("$PGBIN/pg_config" --sharedir)"
if [[ ! -f "$proof_share/postgres.bki" ]]; then proof_share="$PGBIN/../share/postgresql"; fi
"$PGBIN/initdb" -L "$proof_share" -D "$proof_data" -U postgres -A trust --no-locale -E UTF8 >/dev/null
cleanup(){ "$PGBIN/pg_ctl" -D "$proof_data" -m immediate -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Empty listen_addresses means there is no TCP listener. This socket path was
# created above in this invocation and cannot resolve to the production server.
"$PGBIN/pg_ctl" -D "$proof_data" -l "$proof_tmp/postgres.log" -o "-h '' -k '$proof_socket' -p 55489" -w start >/dev/null
# All later fixture calls use this fixed-target wrapper. Its clean environment
# and last-position connection flags exclude libpq environment/service overrides.
cat > "$proof_tmp/psql-local" <<WRAPPER
#!/bin/sh
exec env -i LC_ALL=C LANG=C PATH=/opt/homebrew/bin:/usr/bin:/bin "$PGBIN/psql" "\$@" --host="$proof_socket" --port=55489 --username=postgres --dbname=postgres --no-psqlrc
WRAPPER
chmod 700 "$proof_tmp/psql-local"
export COMMISSION_PSQL="$proof_tmp/psql-local" ROUND1_HERE="$base" ROUND1_INPUT="$proof_tmp/input" SEAL_HERE="$HERE"
export SEAL_DATA="$proof_data" SEAL_SOCKET="$proof_socket"
# First connection is READ ONLY. Mutation stages are unreachable until the
# connected server proves the data directory, private socket and empty public
# schema of the cluster this invocation just initialized.
python3 - <<'PY'
import os,subprocess,json
from pathlib import Path
q="SELECT json_build_object('data_directory',current_setting('data_directory'),'unix_socket_directories',current_setting('unix_socket_directories'),'listen_addresses',current_setting('listen_addresses'),'database',current_database(),'user',current_user,'tcp_address',inet_server_addr(),'public_tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),'version',version());"
r=subprocess.run([os.environ['COMMISSION_PSQL'],'-X','-qAt','-v','ON_ERROR_STOP=1','-c',q],capture_output=True,text=True,check=True)
d=json.loads(r.stdout);assert Path(d['data_directory']).resolve()==Path(os.environ['SEAL_DATA']).resolve()
assert d['unix_socket_directories']==os.environ['SEAL_SOCKET'] and d['listen_addresses']=='' and d['tcp_address'] is None
assert d['database']=='postgres' and d['user']=='postgres' and d['public_tables']==0
assert Path(os.environ['SEAL_DATA']).parent.name.startswith('ca-cash-seal-native.')
Path(os.environ['SEAL_HERE'],'cluster-identity.json').write_text(json.dumps(d,indent=2)+'\n')
print('ISOLATION VERIFIED: own fresh data directory, own Unix socket, no TCP listener, zero public tables',flush=True)
PY
python3 "$fixture/build-fixture.py"
for stage in schema-tables schema-functions schema-defaults schema-constraints schema-foreign-keys seed; do
 "$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$fixture/$stage.sql"
done
"$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$base/fixture-seed.sql"
"$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$fixture/schema-triggers.sql"
"$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$fixture/exercise.sql"
for phase in 01-schema 02-online-index 03-cutover; do "$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/$phase.sql"; done
for phase in 01-source-schema 02-capture; do "$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/source-authority/$phase.sql"; done
"$COMMISSION_PSQL" -X -v ON_ERROR_STOP=1 -q -f "$proof_tmp/input/source-authority/bank-owner/00-bank-legacy-index.sql"
python3 "$base/activate-fixture.py"
python3 "$HERE/native-probe.py"
