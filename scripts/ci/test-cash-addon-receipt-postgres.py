#!/usr/bin/env python3
"""Qualify the real read-only add-on receipt door on isolated PostgreSQL."""
import os, socket, subprocess, tempfile, shutil
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
PG = Path(os.environ.get('PG_BIN') or next(p for p in ['/opt/homebrew/opt/postgresql@17/bin','/usr/lib/postgresql/17/bin'] if (Path(p)/'initdb').exists()))
work = ROOT/'work'
work.mkdir(exist_ok=True)
env = dict(os.environ, LC_ALL='C', LANG='C')
with tempfile.TemporaryDirectory(prefix='cash-addon-', dir=os.environ.get('TMPDIR') or work) as tmp:
    folder = Path(tmp)
    def run(args, sql=None, fail=False):
        p = subprocess.run([str(a) for a in args], input=sql, text=True, capture_output=True, env=env, timeout=45)
        if fail:
            assert p.returncode != 0, 'Expected refusal'
        elif p.returncode:
            raise RuntimeError(p.stdout+p.stderr)
        return p.stdout.strip()
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); port=s.getsockname()[1]
    run([PG/'initdb','-D',folder/'data','-U','postgres','-A','trust','--no-locale'])
    run([PG/'pg_ctl','-D',folder/'data','-l',folder/'server.log','-o',f'-h 127.0.0.1 -p {port} -k {folder}', '-w','start'])
    def q(sql, fail=False):
        return run([PG/'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-h','127.0.0.1','-p',port,'-U','postgres','-d','postgres'],sql,fail)
    try:
        q('''CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.entry_purchase_idempotency_receipts(key_domain text,idempotency_key text,request jsonb,response jsonb);
CREATE TABLE public.poker_diamond_movements(request_id uuid,request jsonb,receipt jsonb);
CREATE TABLE public.table_seats(table_id uuid,user_id uuid,stack numeric,left_at timestamptz);
CREATE TABLE public.table_pending_addons(table_id uuid,user_id uuid,amount numeric,resolved_at timestamptz,id uuid,applied_to_stack numeric);
CREATE TABLE public.cash_participant_funding_receipts(operation_kind text,operation_key text,table_id uuid,user_id uuid,pending_addon_id uuid);
REVOKE ALL ON public.entry_purchase_idempotency_receipts FROM PUBLIC,anon,authenticated,service_role;
''')
        q((ROOT/'supabase/migrations/20261023182011_cash_addon_receipt_readback.sql').read_text())
        t='11111111-1111-4111-8111-111111111111'; u='22222222-2222-4222-8222-222222222222'
        call=f"public.fn_cash_addon_receipt('{t}','{u}','operation')"
        assert q(f'SELECT {call} IS NULL') == 't'
        q(f'''INSERT INTO public.table_seats VALUES ('{t}','{u}',20,NULL);
INSERT INTO public.table_pending_addons VALUES ('{t}','{u}',5,NULL,'{t}',NULL),('{t}','{u}',99,now(),'{u}',99);
INSERT INTO public.entry_purchase_idempotency_receipts VALUES ('cash_addon','operation',
jsonb_build_object('door','atomic_table_addon','table_id','{t}','user_id','{u}','amount',10,'apply_to_seat',true),'{{"balance":90}}');''')
        before=q('SELECT md5(string_agg(row_to_json(r)::text,\'\')) FROM public.entry_purchase_idempotency_receipts r')
        assert q(f"SET ROLE service_role; SELECT {call}->>'stack';") == '20'
        assert q(f"SET ROLE service_role; SELECT {call}->>'pending';") == '5'
        assert q(f"SET ROLE service_role; SELECT {call}->>'amount';") == '10'
        assert q(f"SET ROLE service_role; SELECT {call}->>'stack';") == '20'
        q(f'SET ROLE authenticated; SELECT {call};',fail=True)
        q(f'SET ROLE anon; SELECT {call};',fail=True)
        q(f"SELECT public.fn_cash_addon_receipt('{u}','{t}','operation');",fail=True)
        q('SET ROLE service_role; SELECT * FROM public.entry_purchase_idempotency_receipts;',fail=True)
        after=q('SELECT md5(string_agg(row_to_json(r)::text,\'\')) FROM public.entry_purchase_idempotency_receipts r')
        assert before == after
        q(f"UPDATE public.table_seats SET stack=17 WHERE table_id='{t}';")
        assert q(f"SELECT {call}->>'stack'") == '17', 'Recovery must read current stack, not an old delta'
        q(f"UPDATE public.entry_purchase_idempotency_receipts SET request=jsonb_set(request,'{{apply_to_seat}}','false'); INSERT INTO public.cash_participant_funding_receipts VALUES ('addon','operation','{t}','{u}','{t}');")
        assert q(f"SELECT {call}->>'queued'") == 'true'
        q(f"UPDATE public.table_pending_addons SET resolved_at=now(),applied_to_stack=3 WHERE id='{t}';")
        assert q(f"SELECT {call}->>'queued'") == 'false'
        assert q(f"SELECT {call}->>'amount'") == '3', 'A settled replay must report actual landing after refund'
        q("UPDATE public.entry_purchase_idempotency_receipts SET response=NULL;")
        q(f'SELECT {call};',fail=True)
        diamond=f"public.fn_diamond_top_up_receipt('{t}','{u}','{t}')"
        assert q(f'SELECT {diamond} IS NULL') == 't'
        q(f"INSERT INTO public.poker_diamond_movements VALUES ('{t}',jsonb_build_object('table_id','{t}','user_id','{u}','action','top_up','amount',10),'{{}}');")
        assert q(f"SET ROLE service_role; SELECT {diamond}->>'stack';") == '17'
        assert q(f"SET ROLE service_role; SELECT {diamond}->>'amount';") == '10'
        q(f'SET ROLE authenticated; SELECT {diamond};',fail=True)
        q(f'SET ROLE anon; SELECT {diamond};',fail=True)
        q(f"SELECT public.fn_diamond_top_up_receipt('{u}','{t}','{t}');",fail=True)
        print('PASS: native receipt readback, current seat/pending truth, duplicate reads, immutable receipt, identity and ACL refusals')
    finally:
        run([PG/'pg_ctl','-D',folder/'data','-m','immediate','-w','stop'])
