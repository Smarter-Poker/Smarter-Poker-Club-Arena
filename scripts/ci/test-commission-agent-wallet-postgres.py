#!/usr/bin/env python3
"""Weekly commission lands in agent wallets; the owner's share stays in the club bank.

Native PostgreSQL 17 regression for migration 20261022164439 (Dan's owner rules,
2026-10-22). It loads the EXACT live definitions of every changed owner and its
financial dependencies (scripts/ci/fixtures/commission-agent-wallet/
live-preimages-20261022.json, captured from production with their md5), runs
the real round 2 and round 3 stages on an independently fixed board, proves the
defect on the preimage, installs the migration file whole, and proves:

  1. Commission is credited to agents.agent_wallet_balance, never to
     club_members.chip_balance.
  2. Players with no agent belong to the club owner.
  3. The owner's own commission tier never leaves clubs.chip_treasury, and the
     owner's player and agent wallets never move.
  4. Rakeback owed to owner/no-agent players is paid from clubs.chip_treasury.
  5. A real agent's rakeback and its pass-down commission come out of its agent
     wallet; an underfunded agent wallet is refused (agents are prepaid).

Every case runs in a transaction that is rolled back; whole financial state is
hashed before and after. No production access.
"""
import argparse, json, os, shutil, socket, subprocess, sys, tempfile
from pathlib import Path

P=argparse.ArgumentParser()
P.add_argument('--repo',type=Path,default=Path(__file__).resolve().parents[2])
P.add_argument('--pg-bin',type=Path,default=Path(os.environ.get('PG_BIN','/usr/lib/postgresql/17/bin')))
P.add_argument('--scratch-root',type=Path,default=Path(os.environ.get('RUNNER_TEMP',tempfile.gettempdir())))
P.add_argument('--output',type=Path,default=None)
A=P.parse_args()
R=A.repo; F=R/'scripts/ci/fixtures/commission-agent-wallet'; BASE=R/'tests/fixtures/weekly-close-scale'; DR=R/'scripts/ci/fixtures/deleted-weekly-routing'
MIG=next((R/'supabase/migrations').glob('20261022164439_*.sql'))
E={k:v for k,v in os.environ.items() if not k.startswith('PG')};E.update(LC_ALL='C',LANG='C',PGTZ='UTC')
os.environ.update(LC_ALL='C',LANG='C')
A.scratch_root.mkdir(parents=True,exist_ok=True)
W=Path(tempfile.mkdtemp(prefix='caw-',dir=A.scratch_root));D=W/'data';started=False;results=[]
with socket.socket() as sk: sk.bind(('127.0.0.1',0)); port=str(sk.getsockname()[1])
def cmd(a): return subprocess.run(list(map(str,a)),env=E,text=True,capture_output=True,check=True,timeout=120)
def q(sql,check=True):
    with tempfile.TemporaryFile(mode='w+',dir=W) as f:
        f.write(sql); f.seek(0)
        r=subprocess.run([str(A.pg_bin/'psql'),'-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-h','127.0.0.1','-p',port,'-d','postgres'],env=E,text=True,stdin=f,capture_output=True,timeout=300)
    if check and r.returncode: raise RuntimeError(r.stderr[-6000:])
    return r
def load(p): q('SET check_function_bodies=off;\n'+Path(p).read_text().rstrip()+';\n')
R2="public.fn_settle_accounting_commission_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
R2V3=R2.replace('commission_stage(','commission_stage_v3(')
R3="public.fn_settle_accounting_rakeback_stage('club',caw_u('club'),'2026-10-05 07:00+00','2026-10-12 07:00+00')"
def bal(who,col='chip_balance'):
    t='club_members' if col=='chip_balance' else 'agents'
    return f"(SELECT {col} FROM public.{t} WHERE club_id=caw_u('club') AND user_id=caw_u('{who}'))"
BANK="(SELECT chip_treasury FROM public.clubs WHERE id=caw_u('club'))"
def case(name,sql,refusal=None):
    before=q('SELECT caw_money();').stdout.strip()
    r=q('BEGIN;\nSELECT caw_seed('+('true' if 'deleted' in name else 'false')+');\nCREATE TEMP TABLE caw_open AS SELECT caw_balances() b;CREATE TEMP TABLE caw_open_legs AS SELECT id FROM public.chip_ledger;\n'+sql+
        ('\nSELECT caw_assert_conserved((SELECT b FROM caw_open));\nSET CONSTRAINTS ALL IMMEDIATE;' if not refusal else '')+'\nROLLBACK;\n',check=False)
    if refusal: assert r.returncode and refusal in r.stderr,(name,r.stdout[-2000:],r.stderr[-4000:])
    else: assert r.returncode==0,(name,r.stdout[-2000:],r.stderr[-6000:])
    assert q('SELECT caw_money();').stdout.strip()==before,(name,'rolled-back case changed financial rows')
    results.append({'case':name,'passed':True,'expected_refusal':refusal})
    print('PASS',name,flush=True)
try:
    assert '17.' in cmd([A.pg_bin/'postgres','--version']).stdout,'PostgreSQL 17 required'
    cmd([A.pg_bin/'initdb','-D',D,'-U','postgres','-A','trust','--no-locale','-E','UTF8'])
    cmd([A.pg_bin/'pg_ctl','-D',D,'-l',W/'server.log','-w','start','-o',f"-k '' -p {port} -h 127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off"]);started=True
    load(BASE/'prelude.sql');load(BASE/'schema-tables.sql');load(DR/'platform-boundaries.sql')
    q("DROP FUNCTION public.fn_settle_accounting_commission_stage_v3(text,uuid,timestamptz,timestamptz);")
    for n in ['fn_caller_is_engine','fn_union_week_start','fn_lock_rakeback_payer_clubs','fn_resolve_accounting_routing_scope','fn_agent_commission_rollup_recompute']: load(BASE/'preimage'/f'{n}.sql')
    for n in ['fn_guard_membership_lifecycle_write','fn_block_browser_balance_writes','fn_club_members_ledger_writer','fn_ca_declare_ledger','fn_ca_chip_ledger_enrich','fn_calculate_cash_rakeback_periods','fn_rakeback_split_write']: load(DR/f'{n}.sql')
    load(F/'schema.sql')
    pre=json.loads((F/'live-preimages-20261022.json').read_text())
    for row in pre:
        q('SET check_function_bodies=off;'+row['definition']+';')
        got=q(f"SELECT md5(pg_get_functiondef('{row['signature']}'::regprocedure));").stdout.strip()
        assert got==row['md5'],('live preimage did not load byte-exact',row['signature'],got)
        q(f"REVOKE ALL ON FUNCTION {row['signature']} FROM PUBLIC,anon,authenticated,service_role;"+(f"GRANT EXECUTE ON FUNCTION {row['signature']} TO service_role;" if row['acl'] and 'service_role=X' in row['acl'] else ''))
    load(F/'triggers.sql');load(DR/'ledger-enrichment-wiring.sql');load(DR/'authority-and-triggers.sql');load(DR/'receipt-boundary.sql');load(F/'seed.sql')
    # The defect, on the exact installed stages: commission lands in player
    # wallets and the owner is paid from the club bank as top agent.
    case('preimage-pays-commission-into-player-wallets-and-the-owner','SELECT '+R2+';'+
      f"SELECT caw_assert({bal('O')}=315,'owner player wallet took 115 from the bank (the defect)');"
      f"SELECT caw_assert({bal('A')}=1040,'agent commission in player wallet (the defect)');"
      f"SELECT caw_assert({BANK}=820,'bank paid the owner tier (the defect)');")
    # Install the migration file whole, exactly as production receives it.
    q('SET check_function_bodies=off;\n'+MIG.read_text())
    proof=[l for l in MIG.read_text().splitlines() if l.startswith('-- @live-proof: ')]
    assert len(proof)==1 and q('SELECT '+proof[0].split(': ',1)[1]+';').stdout.strip()=='t','live proof false after install'
    replay=q('SET check_function_bodies=off;\n'+MIG.read_text(),check=False)
    assert replay.returncode and 'commission_agent_wallet_preimage_changed' in replay.stderr,'replay must refuse on the changed preimage'
    q('ROLLBACK;')
    for label,call in [('main',R2),('v3',R2V3)]:
        case(f'round2-{label}-agent-wallets-and-owner-share-in-bank','SELECT '+call+';'+
          f"SELECT caw_assert({bal('A','agent_wallet_balance')}=40,'A agent wallet +40 (own 30+10)');"
          f"SELECT caw_assert({bal('S','agent_wallet_balance')}=25,'S agent wallet keeps own 25 after passing 40');"
          f"SELECT caw_assert({bal('O','agent_wallet_balance')}=500,'owner agent wallet untouched');"
          f"SELECT caw_assert({bal('O')}=200 AND {bal('S')}=300 AND {bal('A')}=1000,'no player wallet moved');"
          f"SELECT caw_assert({BANK}=935,'bank paid only the 65 owed below the owner; owner 115 retained');"
          "SELECT caw_assert((SELECT count(*)=2 AND sum(amount)=105 AND bool_and(to_type='agent_wallet') FROM chip_ledger WHERE category='commission'),'two legs into agent wallets');"
          "SELECT caw_assert((SELECT count(*)=1 FROM chip_ledger WHERE category='commission' AND from_type='club_treasury' AND to_entity_id=caw_u('S') AND amount=65),'bank to S 65');"
          "SELECT caw_assert((SELECT count(*)=1 FROM chip_ledger WHERE category='commission' AND from_type='agent_wallet' AND from_entity_id=caw_u('S') AND to_entity_id=caw_u('A') AND amount=40),'S agent wallet to A 40');"
          "SELECT caw_assert(NOT EXISTS(SELECT 1 FROM chip_ledger WHERE category='commission' AND (to_entity_id=caw_u('O') OR from_entity_id=caw_u('O'))),'owner never in a commission leg');"
          "SELECT caw_assert((SELECT count(*)=2 FROM settlement_invoices WHERE breakdown->>'category'='commission'),'one receipt per leg');"
          f"SELECT caw_assert(({call})->>'duplicate'='true','replay is a duplicate');"
          f"SELECT caw_assert((SELECT (result->>'owner_retained_in_club_bank')::numeric=115 AND (result->>'own_commission_amount')::numeric=180 AND (result->>'amount')::numeric=65 FROM accounting_routed_settlement_runs WHERE round_no=2),'receipt records owner share retained');"
          "SELECT caw_assert((SELECT count(*)=3 FROM agent_commission_settlements),'all three earners settled, owner included');")
    case('round3-agent-wallet-and-bank-pay-rakeback','SELECT '+R2+';SELECT '+R3+';'+
      f"SELECT caw_assert({bal('P1')}=9 AND {bal('P2')}=4 AND {bal('P3')}=5 AND {bal('P4')}=10,'players paid in full');"
      f"SELECT caw_assert({bal('A','agent_wallet_balance')}=26,'A agent wallet paid 14 of rakeback (40-14)');"
      f"SELECT caw_assert({bal('A')}=1000,'A player wallet never pays rakeback');"
      f"SELECT caw_assert({bal('O')}=200 AND {bal('O','agent_wallet_balance')}=500,'owner wallets never pay rakeback');"
      f"SELECT caw_assert({BANK}=921,'bank 935 paid owner/no-agent rakeback 14');"
      "SELECT caw_assert((SELECT sum(amount)=14 FROM chip_ledger WHERE category='rakeback' AND from_type='club_treasury'),'bank legs 14');"
      "SELECT caw_assert((SELECT sum(amount)=14 FROM chip_ledger WHERE category='rakeback' AND from_type='agent_wallet' AND from_entity_id=caw_u('A')),'A agent-wallet legs 14');"
      "SELECT caw_assert(NOT EXISTS(SELECT 1 FROM chip_ledger WHERE category='rakeback' AND from_type='player_wallet'),'no rakeback from any player wallet');"
      "SELECT caw_assert((SELECT bool_and(smarter_private.split_rakeback_payout_complete(p.id,c.id)) FROM rakeback_period_payouts p JOIN accounting_rakeback_period_calculations c ON c.period_id=p.rakeback_period_id WHERE c.payer_kind='split'),'split payout evidence complete');"
      "SELECT caw_assert((SELECT bool_and(status='paid') FROM rakeback_periods),'all periods paid');"
      f"SELECT caw_assert(({R3})->>'duplicate'='true','round3 replay is a duplicate');")
    case('round3-prepaid-agent-without-funds-is-refused',
      f"UPDATE agents SET agent_wallet_balance=0 WHERE user_id=caw_u('A');SELECT {R3};",'routed_rakeback_agent_funding_shortfall')
    case('round3-bank-short-for-owner-share-is-refused',
      f"SELECT {R2};UPDATE clubs SET chip_treasury=1 WHERE id=caw_u('club');SELECT {R3};",'routed_rakeback_club_funding_shortfall')
    case('round2-bank-short-is-refused',
      "UPDATE clubs SET chip_treasury=10 WHERE id=caw_u('club');SELECT "+R2+";",'routed_commission_club_funding_shortfall')
    case('deleted-agent-commission-returns-to-bank-after-reserve','SELECT '+R2+';'+
      f"SELECT caw_assert({bal('A','agent_wallet_balance')}=14,'deleted A keeps exactly its published rakeback 14 (9 + split 5)');"
      f"SELECT caw_assert({BANK}=961,'26 free agent-wallet net returned to bank');"
      f"SELECT caw_assert({bal('A')}=1000,'deleted A player wallet untouched by the commission stage');"
      'SELECT '+R3+';'+
      f"SELECT caw_assert({bal('A','agent_wallet_balance')}=0,'reserve paid out');"
      f"SELECT caw_assert({bal('P1')}=9 AND {bal('P4')}=10,'players paid');")
    if A.output:
        A.output.parent.mkdir(parents=True,exist_ok=True)
        A.output.write_text(json.dumps({'status':'passed','migration':MIG.name,'cases':results},indent=2)+'\n')
    print(json.dumps({'status':'passed','cases':len(results)}))
finally:
    if started: subprocess.run([str(A.pg_bin/'pg_ctl'),'-D',str(D),'-m','immediate','stop'],env=E,capture_output=True)
    shutil.rmtree(W,ignore_errors=True)
