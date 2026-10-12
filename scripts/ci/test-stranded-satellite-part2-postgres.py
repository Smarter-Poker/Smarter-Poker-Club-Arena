#!/usr/bin/env python3
"""Qualify the real part-2 migration in a private PostgreSQL 17 cluster.

The real closed-target predicate and full settlement migration run unchanged.
The payment door is a fixture writing receipt tables: this qualifies cohort
selection, preimage refusal and transaction rollback, not production payment
execution. No connection or credentials for production are used.
"""
import os
import re
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIG = ROOT / 'supabase/migrations/20261012055313_the_stranded_satellite_tickets_are_paid_part_2.sql'
RULE = ROOT / 'supabase/migrations/20261012054804_a_closed_target_pays_its_satellite_tickets_in_cash.sql'
PG = Path(os.environ.get('PG_BIN', '/opt/homebrew/opt/postgresql@17/bin' if Path('/opt/homebrew/opt/postgresql@17/bin/initdb').exists() else '/usr/lib/postgresql/17/bin'))
cluster = Path(tempfile.mkdtemp(prefix='satellite-part2-', dir=os.environ.get('TMPDIR')))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
started = False


def run(args, sql=None, refusal=None):
    result = subprocess.run(args, input=sql, capture_output=True, text=True, timeout=60)
    if refusal:
        assert result.returncode != 0 and refusal in result.stderr, result.stdout + result.stderr
    elif result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result.stdout.strip()


def q(sql, refusal=None):
    return run([str(PG / 'psql'), '-XqAt', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', str(port), '-U', 'postgres', '-d', 'postgres'], sql, refusal)


def check(condition, label):
    assert condition, label
    print('PASS: ' + label, flush=True)


sql = MIG.read_text()
rule = RULE.read_text()
start = rule.index('CREATE OR REPLACE FUNCTION public.fn_ca_satellite_ticket_target_is_closed(')
closed = rule[start:rule.index('$function$;', start) + len('$function$;')]
fixture = """
CREATE TABLE public.tournaments(id uuid PRIMARY KEY,status text,prize_pool_finalized boolean);
CREATE TABLE public.tournament_tickets(id uuid PRIMARY KEY,value numeric,status text,redemption_mode text,
 source_satellite_award_place integer,source_refund_entitlement_id uuid,created_at timestamptz,
 source_tournament_id uuid,redeemed_at timestamptz);
CREATE TABLE public.chip_ledger(id uuid PRIMARY KEY,amount numeric,from_type text,to_type text,category text);
CREATE TABLE public.chip_ledger_idem(idempotency_key text PRIMARY KEY,leg_id uuid);
CREATE TABLE public.payment_calls(ticket_id uuid);
INSERT INTO public.tournaments VALUES('00000000-0000-0000-0000-000000000001','COMPLETED',true),
 ('00000000-0000-0000-0000-000000000002','REGISTERING',false);
CREATE FUNCTION public.fn_ca_pay_closed_target_ticket_in_cash(p_id uuid,p_source text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE amount numeric;
BEGIN
 INSERT INTO public.payment_calls VALUES(p_id);
 SELECT value INTO amount FROM public.tournament_tickets WHERE id=p_id;
 INSERT INTO public.chip_ledger VALUES(p_id,amount,'escrow','player_wallet','ticket_redeem');
 INSERT INTO public.chip_ledger_idem VALUES('ticket:'||p_id::text||':closed-target-cash',p_id);
 UPDATE public.tournament_tickets SET status='redeemed',redeemed_at=transaction_timestamp() WHERE id=p_id;
 RETURN jsonb_build_object('ok',true,'replayed',false,'amount',amount);
END $$;
"""
seed = """
TRUNCATE public.tournament_tickets,public.chip_ledger,public.chip_ledger_idem,public.payment_calls;
-- Independently chosen amounts sum to the witnessed 190 tickets / 7730.00.
INSERT INTO public.tournament_tickets
SELECT md5('cohort-'||i)::uuid,CASE WHEN i=190 THEN 170 ELSE 40 END,'issued',
 'tournament_entry_only',1,NULL,'2026-09-12 19:00:00+00'::timestamptz+(i-1)*interval '1 minute',
 '00000000-0000-0000-0000-000000000001',NULL FROM generate_series(1,190) i;
-- Adjacent boundaries, open target, non-direct and used tickets stay out.
INSERT INTO public.tournament_tickets VALUES
 (md5('before')::uuid,99,'issued','tournament_entry_only',1,NULL,'2026-09-12 18:59:59+00','00000000-0000-0000-0000-000000000001',NULL),
 (md5('upper')::uuid,99,'issued','tournament_entry_only',1,NULL,'2026-09-17 21:45:00+00','00000000-0000-0000-0000-000000000001',NULL),
 (md5('open')::uuid,99,'issued','tournament_entry_only',1,NULL,'2026-09-13 00:00:00+00','00000000-0000-0000-0000-000000000002',NULL),
 (md5('ordinary')::uuid,99,'issued','cash',1,NULL,'2026-09-13 00:00:00+00','00000000-0000-0000-0000-000000000001',NULL),
 (md5('used')::uuid,99,'redeemed','tournament_entry_only',1,NULL,'2026-09-13 00:00:00+00','00000000-0000-0000-0000-000000000001',NULL);
"""
try:
    run([str(PG / 'initdb'), '-D', str(cluster / 'data'), '-U', 'postgres', '-A', 'trust', '--no-locale'])
    # SSD task paths exceed macOS's Unix socket path limit; TCP is local only.
    run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'), '-l', str(cluster / 'server.log'), '-o', f'-h 127.0.0.1 -p {port} -k ""', '-w', 'start'])
    started = True
    check(q('SHOW server_version_num;').startswith('17'), 'PostgreSQL 17')
    q(fixture + closed + seed)
    # Reconstruct only the actual old defect: identical lower and upper bounds.
    before = re.sub(r'DO \$preimage\$.*?\$preimage\$;\n', '', sql, flags=re.S)
    before = before.replace("created_at>='2026-09-12 19:00:00+00'", "created_at>='2026-09-17 21:45:00+00'")
    q(before, 'STRANDED_TICKET_CASH_RESULT_CHANGED: paid 0 tickets worth 0')
    check(q('SELECT count(*) FROM public.payment_calls;') == '0', 'old empty range fails and rolls back')
    q(sql)
    check(q('SELECT count(*)||\'|\'||sum(amount) FROM public.chip_ledger;') == '190|7730', 'full corrected migration pays exactly the witnessed cohort')
    check(q("SELECT count(*) FROM public.tournament_tickets WHERE status='issued';") == '4', 'adjacent boundaries and ineligible tickets remain untouched')
    proof = next(line.split('-- @live-proof: ', 1)[1] for line in sql.splitlines() if line.startswith('-- @live-proof: '))
    check(q('SELECT (' + proof + ');') == 't', 'live proof covers the corrected interval')
    q(sql, 'STRANDED_TICKET_CASH_PREIMAGE_CHANGED')
    check(q('SELECT count(*) FROM public.payment_calls;') == '190', 'replay refused before any payment call')
    for change, label in [
        ("DELETE FROM public.tournament_tickets WHERE id=md5('cohort-1')::uuid;", 'missing ticket'),
        ("UPDATE public.tournament_tickets SET value=value+0.01 WHERE id=md5('cohort-1')::uuid;", 'changed amount'),
    ]:
        q(seed + change)
        q(sql, 'STRANDED_TICKET_CASH_PREIMAGE_CHANGED')
        check(q('SELECT count(*) FROM public.payment_calls;') == '0', label + ' refuses before payment')
finally:
    if started:
        run([str(PG / 'pg_ctl'), '-D', str(cluster / 'data'), '-m', 'immediate', '-w', 'stop'])
    shutil.rmtree(cluster)
