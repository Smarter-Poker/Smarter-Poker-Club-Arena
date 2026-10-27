#!/usr/bin/env python3
"""Prove the engine's exact capacity receipt read using real PostgreSQL roles."""
import os
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin'))
parent = os.environ.get('TMPDIR') or os.environ.get('RUNNER_TEMP')
if not parent or (os.uname().sysname == 'Darwin' and not parent.startswith('/Volumes/SmarterWork/agent-work/')):
    raise SystemExit('Set task-owned SSD TMPDIR or hosted RUNNER_TEMP')
CANDIDATE = ROOT/'supabase/migrations/20261027010432_capacity_receipt_reads_admit_seated_tournament_tables.sql'
TID = '134e00da-d519-48ba-8667-fa85c2de129b'
TABLE = '196af8ef-e53a-49c2-9fa6-29371423bcd6'
query = f"SELECT table_id,created_at FROM public.tournament_capacity_table_receipts WHERE tournament_id='{TID}' AND manager_admitted_at IS NULL ORDER BY created_at ASC LIMIT 20;"
# Derive the read and filter requirements from the maintained caller too.
manager = (ROOT/'server/src/tournament/TournamentManager.ts').read_text()
start = manager.index('protected async admitCommittedCapacityTables')
caller = manager[start:manager.index('const newTableIds:', start)]
for part in [".from('tournament_capacity_table_receipts')", ".select('table_id, created_at')", ".eq('tournament_id', this.tournamentId)", ".is('manager_admitted_at', null)", ".order('created_at', { ascending: true })"]:
    assert part in caller, 'Native read must follow the production caller: '+part
original = (ROOT/'supabase/migrations/20260908042200_late_registration_can_build_its_first_table.sql').read_text()
ack = re.search(r'CREATE OR REPLACE FUNCTION public\.fn_ack_tournament_capacity_tables\(.*?\$function\$;', original, re.S)
assert ack, 'Original acknowledgement source missing'
with tempfile.TemporaryDirectory(prefix='cr-', dir=parent) as folder:
    root = Path(folder)
    data, sock = root/'d', root/'s'
    sock.mkdir()
    def run(args, sql=None, check=True):
        result = subprocess.run([str(x) for x in args], input=sql, text=True, capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stdout+result.stderr)
        return result
    def q(sql, check=True):
        return run([PG/'psql','-XqAt','-v','ON_ERROR_STOP=1','-h',sock,'-U','fixture','-d','postgres'], sql, check)
    def denied(role, sql):
        result = q(f'SET ROLE {role}; '+sql, False)
        assert result.returncode != 0 and 'permission denied' in result.stderr, result.stdout+result.stderr
    run([PG/'initdb','-D',data,'-U','fixture','--auth-local=trust','--auth-host=reject','--no-locale'])
    with (data/'postgresql.conf').open('a') as config:
        config.write("\nlisten_addresses=''\nunix_socket_directories='"+str(sock)+"'\n")
    started = False
    try:
        run([PG/'pg_ctl','-D',data,'-l',root/'server.log','-w','start'])
        started = True
        q(f"""CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.tournament_capacity_table_receipts(table_id uuid PRIMARY KEY,tournament_id uuid NOT NULL,manager_wake_id bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),manager_admitted_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
ALTER TABLE public.tournament_capacity_table_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.tournament_capacity_table_receipts FROM PUBLIC,anon,authenticated,service_role;
INSERT INTO public.tournament_capacity_table_receipts(table_id,tournament_id,manager_wake_id) VALUES('{TABLE}','{TID}',987831);
"""+ack.group(0)+"\nREVOKE ALL ON FUNCTION public.fn_ack_tournament_capacity_tables(uuid,uuid[]) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION public.fn_ack_tournament_capacity_tables(uuid,uuid[]) TO service_role;")
        denied('service_role', query)
        print('PASS baseline: exact engine receipt read is permission denied', flush=True)
        q(CANDIDATE.read_text())
        found = q('SET ROLE service_role; '+query).stdout
        assert TABLE in found, 'Funded committed table must reach the engine receipt consumer'
        # Applying the exact grant twice cannot create a dealer, receipt or monetary effect.
        q(CANDIDATE.read_text())
        for role in ['anon','authenticated']:
            denied(role, query)
        for sql in ['SELECT manager_wake_id FROM public.tournament_capacity_table_receipts;', 'SELECT updated_at FROM public.tournament_capacity_table_receipts;', 'UPDATE public.tournament_capacity_table_receipts SET manager_admitted_at=now();', 'DELETE FROM public.tournament_capacity_table_receipts;', "INSERT INTO public.tournament_capacity_table_receipts(table_id,tournament_id,manager_wake_id) VALUES(gen_random_uuid(),gen_random_uuid(),1);"]:
            denied('service_role', sql)
        result = q(f"SET ROLE service_role; SELECT public.fn_ack_tournament_capacity_tables('{TID}',ARRAY['{TABLE}'::uuid]);").stdout
        assert '"ok": true' in result and '"newly_admitted": 1' in result, result
        assert q('SET ROLE service_role; '+query).stdout.strip() == '', 'Acknowledged receipt must leave the pending read'
        duplicate = q(f"SET ROLE service_role; SELECT public.fn_ack_tournament_capacity_tables('{TID}',ARRAY['{TABLE}'::uuid]);").stdout
        assert '"newly_admitted": 0' in duplicate, duplicate
        print('PASS exact column grant: engine read, original ack, duplicate ack, browser denial and raw-write denial')
    finally:
        if started:
            run([PG/'pg_ctl','-D',data,'-m','immediate','-w','stop'])
