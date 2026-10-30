"""Credit tracking qualification on the actual R2/R3 native PostgreSQL board.
No production rows. Original financial owners and document/ledger triggers run;
synthetic caller and wallet-membership eligibility are explicit isolation bounds.
"""
import json,re,hashlib

def qualify(q,R,results,r2,r3,prep,calc):
    migration=next((R/'supabase/migrations').glob('20261030051934_*'))
    original=json.loads((R/'scripts/ci/fixtures/credit-tracking/original-owners.json').read_text())
    q("""ALTER TABLE agents ADD COLUMN IF NOT EXISTS credit_limit numeric DEFAULT 0,ADD COLUMN IF NOT EXISTS credit_used numeric DEFAULT 0,ADD COLUMN IF NOT EXISTS is_prepaid boolean DEFAULT true,ADD COLUMN IF NOT EXISTS promo_wallet_balance numeric DEFAULT 0;
    CREATE TABLE credit_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),agent_id uuid NOT NULL,period_start timestamptz NOT NULL,period_end timestamptz NOT NULL,debt_owed numeric NOT NULL DEFAULT 0,amount_paid numeric NOT NULL DEFAULT 0,amount_remaining numeric NOT NULL DEFAULT 0,status text NOT NULL DEFAULT 'pending',due_date timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),paid_at timestamptz,void_reason text,UNIQUE(agent_id,period_end));
    CREATE TABLE credit_payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid NOT NULL,amount numeric NOT NULL,payment_method text NOT NULL,transaction_id text,created_at timestamptz NOT NULL DEFAULT now(),operation_id uuid UNIQUE,payer_user_id uuid,payment_reference text);
    CREATE TABLE IF NOT EXISTS chip_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),club_id uuid,from_user_id uuid,to_user_id uuid,amount numeric,transaction_type text,notes text,metadata jsonb,balance_after numeric,reversible_until timestamptz);
    ALTER TABLE chip_transactions ADD COLUMN IF NOT EXISTS reversible_until timestamptz;
    CREATE OR REPLACE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.credit_actor',true),'')::uuid$$;
    CREATE OR REPLACE FUNCTION fn_is_platform_admin()RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
    CREATE OR REPLACE FUNCTION fn_is_club_admin_uid(uuid)RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT FROM club_members WHERE club_id=$1 AND user_id=auth.uid() AND role='owner')$$;
    CREATE OR REPLACE FUNCTION fn_ensure_club_wallet(uuid,uuid)RETURNS boolean LANGUAGE sql AS $$SELECT EXISTS(SELECT FROM club_members WHERE user_id=$1 AND club_id=$2 AND status IN('active','approved'))$$;
    """)
    q("CREATE OR REPLACE FUNCTION fn_club_bank_role(uuid)RETURNS text LANGUAGE sql AS $$SELECT role FROM club_members WHERE club_id=$1 AND user_id=auth.uid() AND status IN('active','approved')$$;")
    q("CREATE FUNCTION fn_club_cashier_can_transact(uuid,uuid,uuid)RETURNS boolean LANGUAGE sql AS $$SELECT $2=$3$$;") # Only the self-player-wallet path is exercised here.
    # Exact original owner hashes are checked by the whole installer. Missing
    # unrelated retired RPC dependencies are not executed by this finite board.
    for row in original:
        q('SET check_function_bodies=off;'+row['definition'].rstrip()+';')
        if 'acl'in row:
            sig=row['signature'];q('REVOKE ALL ON FUNCTION '+sig+' FROM PUBLIC,anon,authenticated,service_role;'+''.join('GRANT EXECUTE ON FUNCTION '+sig+' TO '+a.split('=')[0]+';'for a in row['acl']if not a.startswith('postgres=')))
    q("CREATE TRIGGER accounting_credit_invoice_document AFTER INSERT ON credit_invoices FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert();CREATE TRIGGER accounting_credit_payment_document AFTER INSERT ON credit_payments FOR EACH ROW EXECUTE FUNCTION fn_accounting_credit_document_on_insert();")
    # Use the actual autoledger for the two sources of a wallet top-up. Existing
    # actual guards, enrichment, append-only journal and receipt pipeline remain.
    q("CREATE TRIGGER tracking_club_ledger AFTER UPDATE ON clubs FOR EACH ROW EXECUTE FUNCTION fn_ca_autoledger('chip_treasury=club_treasury');")
    candidate=migration.read_text()
    broken=candidate.replace('b6a564b2790c6fdcfe7f7a86d058048a','00000000000000000000000000000000',1)
    failed=q('SET check_function_bodies=off;'+broken,check=False)
    assert failed.returncode and 'credit_tracking_owner_preimage_changed' in failed.stderr,failed.stderr[-3000:]
    assert q("SELECT to_regclass('agent_credit_weekly_basis')IS NULL").stdout.strip()=='t'
    post_fault=candidate.replace('1ee7dc270ba19bf1b6a4a894900d9b38','00000000000000000000000000000000')
    failed=q('SET check_function_bodies=off;'+post_fault,check=False)
    assert failed.returncode and 'credit_tracking_owner_postimage_changed'in failed.stderr,failed.stderr[-3000:]
    assert q("SELECT to_regclass('agent_credit_weekly_basis')IS NULL AND to_regclass('agent_credit_weekly_scopes')IS NULL").stdout.strip()=='t'
    q('SET check_function_bodies=off;'+candidate)
    replay=q('SET check_function_bodies=off;'+candidate,check=False)
    assert replay.returncode and 'credit_tracking_owner_preimage_changed' in replay.stderr
    signatures=json.loads(re.search(r'\$json\$(.*?)\$json\$',candidate,re.S).group(1))
    signatures.append({'signature':'public.fn_capture_agent_credit_week(uuid[],timestamptz,timestamptz,text,uuid)'})
    posts=[{'signature':x['signature'],'md5':q("SELECT md5(pg_get_functiondef('"+x['signature']+"'::regprocedure))").stdout.strip()}for x in signatures]
    # Maintained source binding is generated once from PG, then asserted on each run.
    binding=R/'scripts/ci/fixtures/credit-tracking/postimages.json'
    if binding.exists():assert posts==json.loads(binding.read_text()),'credit_tracking_postimage_changed'
    else:binding.write_text(json.dumps(posts,indent=2)+'\n')
    results.append({'case':'credit-tracking-whole-installer-preimage-and-replay-refusal','passed':True,'postimages':posts})
    q("UPDATE agent_credit_tracking_policy SET activated_at='2026-10-01';") # Synthetic epoch only; no production bypass.
    def case(name,sql,refusal=None):
        before=q('SELECT caw_money()').stdout.strip()
        r=q("BEGIN;SET LOCAL test.own_namespace='tracking-"+name+"';SELECT own_playing_seed();UPDATE agents SET credit_limit=CASE WHEN user_id=caw_u('A')THEN 500 ELSE 0 END,credit_used=0,is_prepaid=CASE WHEN user_id=caw_u('A')THEN false ELSE true END;CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM chip_ledger;"+sql+("SELECT caw_assert_conserved((SELECT b FROM caw_open));SET CONSTRAINTS ALL IMMEDIATE;"if not refusal else'')+'ROLLBACK;',check=False)
        if refusal:assert r.returncode and refusal in r.stderr,(name,r.stderr[-5000:])
        else:assert not r.returncode,(name,r.stderr[-6000:])
        assert q('SELECT caw_money()').stdout.strip()==before
        results.append({'case':'credit-tracking-'+name,'passed':True,'expected_refusal':refusal});print('PASS credit-tracking-'+name,flush=True)
    capture="SELECT fn_capture_agent_credit_week(ARRAY[caw_u('club')],'2026-10-12 07:00Z','2026-10-19 07:00Z','club',caw_u('club'));"
    invoice="(SELECT id FROM credit_invoices WHERE agent_id=caw_u('agentA'))"
    payment=lambda amt,method='wallet',op='payment':"fn_process_credit_invoice_payment("+invoice+","+str(amt)+",'"+method+"',caw_u('"+op+"'),"+("'external-native-reference'"if method=='external'else'NULL')+")"
    actor="SELECT set_config('test.credit_actor',caw_u('A')::text,true);"
    case('frozen-before-real-r2-and-r3',"SELECT "+prep+";SELECT "+calc+";SELECT own_pause_round(2);SELECT "+r2+";SELECT caw_assert((SELECT debt_owed=500 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'line500 minus wallet0 before R2');SELECT own_pause_round(3);SELECT "+r3+";SELECT caw_assert((SELECT debt_owed=500 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'R3 own earnings never netted');SELECT caw_assert((SELECT agent_wallet_before_rakeback=0 AND credit_line=500 FROM agent_credit_weekly_basis WHERE agent_id=caw_u('agentA')),'immutable zero basis');SELECT "+r2+";SELECT caw_assert((SELECT count(*)=1 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'retry one invoice');")
    case('fallback-r2-snapshots-before-paying',"SELECT "+prep+";SELECT "+calc+";SELECT own_pause_round(2);SELECT "+r2.replace('commission_stage(','commission_stage_v3(')+";SELECT caw_assert((SELECT debt_owed=500 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'fallback freezes before commission');")
    case('wallet-topup-and-replay',capture+actor+"SELECT caw_assert(("+payment(125)+")->>'success'='true','funded player topup');SELECT caw_assert(("+payment(125)+")->>'duplicate'='true','idempotent topup');SELECT caw_assert((SELECT agent_wallet_balance=125 AND credit_used=0 FROM agents WHERE id=caw_u('agentA')),'agent restored credit untouched');SELECT caw_assert((SELECT chip_balance=875 FROM club_members WHERE user_id=caw_u('A')AND club_id=caw_u('club')),'player source charged once');SELECT caw_assert((SELECT amount_remaining=375 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'invoice remainder');")
    case('external-topup-and-reference-replay',capture+"SELECT set_config('test.credit_actor',caw_u('O')::text,true);SELECT caw_assert(("+payment(100,'external')+")->>'success'='true','bank funds external topup');SELECT caw_assert(("+payment(100,'external','different-operation')+")->>'duplicate'='true','same reference not applied twice');SELECT caw_assert((SELECT agent_wallet_balance=100 AND credit_used=0 FROM agents WHERE id=caw_u('agentA')),'external restores wallet');")
    case('no-unfunded-wallet-topup',capture+actor+"SELECT caw_assert(("+payment(5000)+")->>'reason'='amount_exceeds_remaining','overpayment refused');SELECT caw_assert((SELECT agent_wallet_balance=0 FROM agents WHERE id=caw_u('agentA')),'no minted chips');")
    case('foreign-wallet-refused',capture+"SELECT set_config('test.credit_actor',caw_u('S')::text,true);SELECT "+payment(10)+";",'not_your_wallet')
    case('missing-pre-rakeback-basis',"SELECT fn_generate_scope_credit_invoices(caw_u('club'),'2026-10-19 07:00Z','2026-10-26 07:00Z');",'pre_rakeback_credit_basis_required')
    case('no-rakeback-reduction-on-retry',capture+actor+"SELECT "+payment(100)+";"+capture+"SELECT caw_assert((SELECT debt_owed=500 AND amount_remaining=400 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'retry original terms after topup');")
    case('next-week-does-not-double-bill',capture+actor+"SELECT "+payment(100)+";SELECT fn_capture_agent_credit_week(ARRAY[caw_u('club')],'2026-10-19 07:00Z','2026-10-26 07:00Z','club',caw_u('club'));SELECT caw_assert((SELECT sum(amount_remaining)=400 AND count(*)=2 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'current shortfall only, prior immutable totals retained');")
    case('late-agent-keeps-closed-week-immutable',capture+"UPDATE agents SET credit_limit=250,is_prepaid=false WHERE id=caw_u('agentS');"+capture+"SELECT caw_assert(NOT EXISTS(SELECT FROM agent_credit_weekly_basis WHERE agent_id=caw_u('agentS')),'new agent cannot be added after snapshot');SELECT fn_generate_scope_credit_invoices(caw_u('club'),'2026-10-12 07:00Z','2026-10-19 07:00Z');SELECT caw_assert((SELECT count(*)=1 FROM credit_invoices),'late agent neither rebilled nor blocks close');")
    case('invalid-balance-refused',"UPDATE agents SET credit_limit='NaN' WHERE id=caw_u('agentA');"+capture,'agent_credit_weekly_basis')

    send="fn_agent_wallet_send_core_20260830(caw_u('club'),caw_u('A'),50,'player_wallet','Synthetic funded send',caw_u('send'))"
    case('line-cannot-fund-send',actor+"SELECT caw_assert(("+send+")->>'credit_tracking_only'='true','empty agent wallet cannot spend tracking line');SELECT caw_assert(NOT EXISTS(SELECT FROM chip_transactions WHERE transaction_type='agent_wallet_send'),'refusal writes no send receipt');")
    case('funded-send-and-exact-replay',capture+actor+"SELECT "+payment(125)+";SELECT caw_assert(("+send+")->>'success'='true','funded send');SELECT caw_assert(("+send+")->>'replayed'='true','send once');SELECT caw_assert((SELECT agent_wallet_balance=75 AND credit_used=0 FROM agents WHERE id=caw_u('agentA')),'whole send debited funded wallet, no draw');")
    case('zero-basis-replay',"SELECT set_config('app.ledger_autoskip_agents','1',true);UPDATE agents SET agent_wallet_balance=504.72 WHERE id=caw_u('agentA');SELECT set_config('app.ledger_autoskip_agents','',true);DROP TABLE caw_open;CREATE TEMP TABLE caw_open AS SELECT caw_balances()b;"+capture+"SELECT caw_assert((SELECT amount_owed=0 FROM agent_credit_weekly_basis WHERE agent_id=caw_u('agentA')),'line500 wallet504.72 owes0');SELECT caw_assert(NOT EXISTS(SELECT FROM credit_invoices),'zero invoice not created');"+capture)
    # Two independent transactions compete for the same immutable invoice.
    # This disposable database owns all synthetic rows, so this case can commit
    # its fixture while testing actual row/advisory locks across connections.
    from concurrent.futures import ThreadPoolExecutor
    prefix="BEGIN;SET LOCAL test.own_namespace='tracking-concurrent';"
    q(prefix+"SELECT own_playing_seed();UPDATE agents SET credit_limit=CASE WHEN user_id=caw_u('A')THEN 500 ELSE 0 END,credit_used=0,is_prepaid=CASE WHEN user_id=caw_u('A')THEN false ELSE true END;"+capture+"CREATE TABLE caw_open AS SELECT caw_balances()b;CREATE TABLE caw_open_legs AS SELECT id FROM chip_ledger;COMMIT;")
    def pay_once(op):
        out=q(prefix+actor+'SELECT '+payment(400,op=op)+';COMMIT;').stdout
        return json.loads(next(line for line in out.splitlines()if line.startswith('{')))
    with ThreadPoolExecutor(max_workers=2)as pool:answers=list(pool.map(pay_once,['concurrent-1','concurrent-2']))
    assert sum(x.get('success')is True for x in answers)==1,answers
    q(prefix+"SELECT caw_assert((SELECT amount_paid=400 AND amount_remaining=100 FROM credit_invoices WHERE agent_id=caw_u('agentA')),'concurrent payments cannot overcollect');SELECT caw_assert((SELECT agent_wallet_balance=400 FROM agents WHERE id=caw_u('agentA')),'only funded winning payment restored wallet');SELECT caw_assert_conserved((SELECT b FROM caw_open));SET CONSTRAINTS ALL IMMEDIATE;ROLLBACK;")
    results.append({'case':'credit-tracking-concurrent-payment-locks-and-independent-chip-conservation','passed':True})
