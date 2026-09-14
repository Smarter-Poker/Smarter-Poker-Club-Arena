#!/usr/bin/env python3
"""Test the actual read RPC in a disposable PostgreSQL 17 cluster.

Synthetic identities and obligations only. No production URL or payment mutation.
The fixture isolates read permissions, filters, money preservation and pagination;
it does not certify tournament settlement or journal reconciliation.
"""
from pathlib import Path
import json
import os
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
migrations = list((repo / 'supabase/migrations').glob('*_players_can_read_their_tournament_payment_status.sql'))
assert len(migrations) == 1
configured = os.environ.get('POKER_AUDIT_PG_BIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-payment-status-pg17-'))
cluster, socket = root / 'cluster', root / 'socket'
socket.mkdir()
port = str(35000 + os.getpid() % 10000)
passed = []
started = False
print('Evidence: ' + str(root), flush=True)

with (root / 'results.log').open('w') as log:
    def run(cmd):
        result = subprocess.run(cmd, text=True, capture_output=True, timeout=30)
        log.write(result.stdout + result.stderr)
        log.flush()
        if result.returncode:
            raise AssertionError('Command failed: ' + str(root / 'results.log'))
        return result.stdout.strip()

    def sql(body):
        return run(args + ['-c', body])

    def check(name):
        passed.append(name)
        print('PASS ' + name, flush=True)

    try:
        assert ' 17.' in subprocess.check_output([str(pg/'postgres'), '--version'], text=True)
        run([str(pg/'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'])
        run([str(pg/'pg_ctl'), '-D', str(cluster), '-l', str(root/'postgres.log'),
             '-o', f'-k {socket} -p {port} -c listen_addresses=', '-w', 'start'])
        started = True
        run([str(pg/'createdb'), '-h', str(socket), '-p', port, 'payments'])
        args = [str(pg/'psql'), '-h', str(socket), '-p', port, '-d', 'payments',
                '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']
        sql("""
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
$$;
CREATE TABLE public.tournaments(id uuid PRIMARY KEY, name text NOT NULL, club_id uuid);
CREATE TABLE public.tournament_obligations(
 id uuid PRIMARY KEY, tournament_id uuid NOT NULL REFERENCES public.tournaments(id),
 kind text NOT NULL, user_id uuid, amount_owed numeric NOT NULL CHECK(amount_owed>=0),
 amount_paid numeric NOT NULL CHECK(amount_paid>=0 AND amount_paid<=amount_owed),
 created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
ALTER TABLE public.tournament_obligations ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.tournament_obligations TO service_role;
INSERT INTO public.tournaments VALUES
 ('00000000-0000-0000-0000-000000000011','Completed Final','00000000-0000-0000-0000-000000000021'),
 ('00000000-0000-0000-0000-000000000012','Other Club','00000000-0000-0000-0000-000000000022'),
 ('00000000-0000-0000-0000-000000000013','Other Event','00000000-0000-0000-0000-000000000021');
INSERT INTO public.tournament_obligations
SELECT ('00000000-0000-0000-0000-'||lpad(i::text,12,'0'))::uuid,
 CASE WHEN i=4 THEN '00000000-0000-0000-0000-000000000012'::uuid
      WHEN i=5 THEN '00000000-0000-0000-0000-000000000013'::uuid
      ELSE '00000000-0000-0000-0000-000000000011'::uuid END,
 'place','00000000-0000-0000-0000-000000000031',12.50,
 CASE WHEN i=1 THEN 12.50 WHEN i=2 THEN 2.25 ELSE 0 END,
 '2026-09-09T21:00:00.123456Z','2026-09-09T21:01:00Z'
FROM generate_series(1,5) AS i;
INSERT INTO public.tournament_obligations
SELECT md5('other-player-'||i)::uuid,'00000000-0000-0000-0000-000000000011',
 'place', '00000000-0000-0000-0000-000000000032',99,0,
 '2026-09-09T22:00:00Z','2026-09-09T22:00:00Z' FROM generate_series(1,20000) AS i;
INSERT INTO public.tournament_obligations VALUES
 ('00000000-0000-0000-0000-000000000099','00000000-0000-0000-0000-000000000011',
 'place',NULL,77,0,'2026-09-09T23:00:00Z','2026-09-09T23:00:00Z');
""")
        before = sql("SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM public.tournament_obligations o")
        run(args + ['-f', str(migrations[0])])
        sql("""
DO $$
DECLARE sig text := 'public.fn_ca_my_tournament_payments(uuid,uuid,timestamptz,uuid,integer)';
BEGIN
 IF NOT has_function_privilege('authenticated',sig,'EXECUTE')
 OR has_function_privilege('anon',sig,'EXECUTE')
 OR has_function_privilege('service_role',sig,'EXECUTE')
 OR has_table_privilege('authenticated','public.tournament_obligations','SELECT')
 OR has_table_privilege('anon','public.tournament_obligations','SELECT')
 THEN RAISE EXCEPTION 'Read privileges escaped their intended scope'; END IF;
END $$;
SET ROLE authenticated;
DO $$
BEGIN
 BEGIN
  PERFORM public.fn_ca_my_tournament_payments();
  RAISE EXCEPTION 'Missing identity accepted';
 EXCEPTION WHEN SQLSTATE '28000' THEN NULL;
 END;
END $$;
RESET ROLE;
""")
        check('authenticated own-player RPC only; no new table, anonymous or service access')
        identity = "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000031';"
        sql(identity + """
DO $$
DECLARE p jsonb;
BEGIN
 p := public.fn_ca_my_tournament_payments();
 IF p->>'user_id' <> '00000000-0000-0000-0000-000000000031'
 OR jsonb_array_length(p->'payments') <> 5
 OR (p->>'has_more')::boolean
 THEN RAISE EXCEPTION 'Wrong owner/row count'; END IF;
 IF NOT EXISTS(SELECT FROM jsonb_array_elements(p->'payments') r
    WHERE r->>'amount_owed'='12.50' AND r->>'amount_paid'='2.25')
 THEN RAISE EXCEPTION 'Partial payment cents were changed'; END IF;
 p := public.fn_ca_my_tournament_payments('00000000-0000-0000-0000-000000000011');
 IF jsonb_array_length(p->'payments')<>3 THEN RAISE EXCEPTION 'Event filter failed'; END IF;
 p := public.fn_ca_my_tournament_payments(NULL,'00000000-0000-0000-0000-000000000021');
 IF jsonb_array_length(p->'payments')<>4 THEN RAISE EXCEPTION 'Club filter failed'; END IF;
 p := public.fn_ca_my_tournament_payments('00000000-0000-0000-0000-000000000011',
                                        '00000000-0000-0000-0000-000000000022');
 IF p->'payments'<>'[]'::jsonb THEN RAISE EXCEPTION 'Crossed filters leaked rows'; END IF;
END $$;
RESET ROLE;
""")
        check('owner, club and tournament filters preserve actual partial payments; unbound and other-player rows hidden')
        sql(identity + """
DO $$
DECLARE p jsonb; ids text[] := '{}'; r jsonb; stamp timestamptz; last_id uuid; pages int:=0;
BEGIN
 LOOP
  p := public.fn_ca_my_tournament_payments(NULL,NULL,stamp,last_id,2);
  pages := pages+1;
  FOR r IN SELECT * FROM jsonb_array_elements(p->'payments') LOOP
   IF r->>'id'=ANY(ids) THEN RAISE EXCEPTION 'Duplicate payment'; END IF;
   ids:=array_append(ids,r->>'id');
  END LOOP;
  EXIT WHEN NOT (p->>'has_more')::boolean;
  IF pages>3 THEN RAISE EXCEPTION 'Cursor did not advance'; END IF;
  stamp:=(p->>'next_before_created_at')::timestamptz;
  last_id:=(p->>'next_before_id')::uuid;
  IF stamp <> '2026-09-09T21:00:00.123456Z'::timestamptz
  THEN RAISE EXCEPTION 'Cursor precision lost'; END IF;
 END LOOP;
 IF cardinality(ids)<>5 OR pages<>3 OR p->'next_before_id'<>'null'::jsonb
 THEN RAISE EXCEPTION 'Paging dropped a record or retained a terminal cursor'; END IF;
 BEGIN
  PERFORM public.fn_ca_my_tournament_payments(p_limit=>0);
  RAISE EXCEPTION 'Invalid page size accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
 BEGIN
  PERFORM public.fn_ca_my_tournament_payments(p_before_id=>'00000000-0000-0000-0000-000000000001');
  RAISE EXCEPTION 'Incomplete cursor accepted';
 EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
END $$;
SET request.jwt.claim.sub='00000000-0000-0000-0000-000000000033';
DO $$
BEGIN
 IF public.fn_ca_my_tournament_payments()->'payments'<>'[]'::jsonb
 THEN RAISE EXCEPTION 'Missing records inferred as paid'; END IF;
END $$;
RESET ROLE;
""")
        check('tied timestamps page exactly once; incomplete cursors refused; missing records stay empty')
        after = sql("SELECT md5(jsonb_agg(to_jsonb(o) ORDER BY id)::text) FROM public.tournament_obligations o")
        assert before == after, 'Read path mutated obligations'
        check('all obligation rows and amounts unchanged by reads')
        plan = sql("""
ANALYZE public.tournament_obligations;
EXPLAIN SELECT o.id FROM public.tournament_obligations o
WHERE o.user_id='00000000-0000-0000-0000-000000000031'
ORDER BY o.created_at DESC,o.id DESC LIMIT 51;
""")
        assert 'ix_tournament_obligations_user_created' in plan, plan
        check('owner pagination uses the new index on a populated fixture')
    finally:
        if started:
            subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-m', 'fast', '-w', 'stop'],
                           stdout=log, stderr=log, check=True, timeout=15)

(root/'results.json').write_text(json.dumps({
    'passed': passed, 'production_database_used': False,
    'migration': migrations[0].name, 'fixture_limits': __doc__.strip(),
}, indent=2)+'\n')
print(str(len(passed))+' scenario groups passed; '+str(root/'results.json'))
