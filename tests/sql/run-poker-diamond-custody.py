#!/usr/bin/env python3
"""Real PostgreSQL races on the isolated, guarded Phase 3 fixture only."""
import concurrent.futures
import json
import subprocess
import uuid
from pathlib import Path

PSQL = ['/opt/homebrew/opt/postgresql@17/bin/psql', '-h', '/tmp/codex-diamond-phase2-pg',
        '-p', '55472', '-d', 'poker_diamond_phase3_test', '-v', 'ON_ERROR_STOP=1', '-At']
USER = '10000000-0000-0000-0000-000000000001'
TABLE = '30000000-0000-0000-0000-000000000001'
passed = 0

def sql(query, ok=True):
    result = subprocess.run(PSQL + ['-c', query], capture_output=True, text=True)
    if ok and result.returncode:
        raise AssertionError(result.stderr)
    return result.stdout.strip() if ok else result

def check(condition, label):
    global passed
    assert condition, label
    passed += 1
    print('PASS:', label, flush=True)

def reserve(amount, request=None, entry=None, ok=True):
    request = request or str(uuid.uuid4())
    entry = entry or request
    return sql(f"select fn_poker_diamond_reserve('{USER}','cash_seat','{TABLE}','{entry}',{amount},'{request}')", ok)

def release(custody, request=None):
    return json.loads(sql(f"select fn_poker_diamond_release('{custody}','{request or uuid.uuid4()}')"))

subprocess.run(PSQL + ['-f', str(Path(__file__).with_name('poker-diamond-custody.sql'))], check=True, capture_output=True)
subprocess.run(PSQL + ['-f', str(Path(__file__).with_name('poker-diamond-production-wallet-fixture.sql'))], check=True, capture_output=True)
# Let the existing journal grace expire without altering any financial history.
sql('select pg_sleep(2.1)')
for amount in ['0', '-1', '1.5', '2147483648', "'NaN'::numeric", 'NULL']:
    check(reserve(amount, ok=False).returncode != 0, 'reject invalid amount ' + amount)
request = str(uuid.uuid4())
first = json.loads(reserve(100, request, 'bound'))
check(reserve(101, request, 'bound', False).returncode != 0, 'bind replay amount')
check(reserve(100, request, 'changed', False).returncode != 0, 'bind replay entry')
check(reserve(100, entry='bound', ok=False).returncode != 0, 'one funding per entry identity')
release_id = str(uuid.uuid4())
a = release(first['custody_id'], release_id)
check(a == release(first['custody_id'], release_id), 'release replay exact receipt')
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    results = list(pool.map(lambda _: reserve(600, ok=False), range(2)))
check(sum(r.returncode == 0 for r in results) == 1, 'concurrent reserves cannot overdraw')
check(sql('select (select sum(diamonds) from profiles)+fn_ca_arena_diamonds()') == '1000', 'race conserves supply')
for result in results:
    if result.returncode == 0:
        release(json.loads(result.stdout)['custody_id'])
request = str(uuid.uuid4())
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    results = list(pool.map(lambda _: reserve(100, request, 'same-request'), range(4)))
check(len(set(results)) == 1, 'concurrent retries return identical receipt')
check(sql(f"select count(*) from poker_diamond_movements where request_id='{request}'") == '1', 'concurrent retries write one movement')
custody = json.loads(results[0])['custody_id']
# Inject a journal failure, not a mocked successful money write.
sql("create function fixture_fail_release() returns trigger language plpgsql as $$ begin if NEW.type='arena_withdraw' then raise exception 'injected journal failure'; end if; return NEW; end $$; create trigger fixture_fail_release before insert on diamond_transactions for each row execute function fixture_fail_release()")
release_id = str(uuid.uuid4())
sql("create function fixture_fail_incident() returns trigger language plpgsql as $$ begin raise exception 'injected incident failure'; end $$; create trigger fixture_fail_incident before insert on fixture_incidents for each row execute function fixture_fail_incident()")
failed = release(custody, release_id)
check(sql("select count(*) from poker_diamond_obligations where state='pending'") == '1', 'incident failure cannot erase release obligation')
sql('drop trigger fixture_fail_incident on fixture_incidents')
check(failed.get('pending') is True and failed['success'] is False, 'failed release remains recoverable')
check(sql('select diamonds from profiles') == '900', 'failed release rolls back wallet credit')
check(sql('select fn_ca_arena_diamonds()') == '100', 'failed release retains custody')
check(sql("select count(*) from poker_diamond_obligations where state='pending'") == '1', 'failure persists obligation')
competing_release = sql(f"select fn_poker_diamond_release('{custody}','{uuid.uuid4()}')", False)
check(competing_release.returncode != 0 and 'diamond_release_request_already_bound' in competing_release.stderr,
      'pending custody binds one durable release request')
sql('drop trigger fixture_fail_release on diamond_transactions')
reconcile_definition = sql("select pg_get_functiondef('fn_poker_diamond_reconcile()'::regprocedure)")
sql("create or replace function fn_poker_diamond_reconcile() returns table(custody_id uuid,kind text,difference numeric) language plpgsql as $$ begin raise exception 'injected reconciliation outage'; end $$")
check(sql('select fn_poker_diamond_recover_releases()') == '1', 'recovery completes despite reconciliation outage')
sql(reconcile_definition)
check(sql('select diamonds from profiles') == '1000', 'recovery pays exactly once')
check(sql('select count(*) from fn_poker_diamond_reconcile()') == '0', 'movement and lot reconciliation clear')
# Release is exact even for a boosted account; borrowed money is not a reward.
sql('update profiles set diamond_multiplier=4')
x=json.loads(reserve(100))
check(release(x['custody_id'])['amount']==100 and sql('select diamonds from profiles')=='1000','cashout ignores reward multiplier')
# Reserved purchased units are not consumed by an unrelated spend.
x=json.loads(reserve(400))
check(sql(f"select fn_ca_consume_purchase_lots('{USER}',200)")=='100','spend cannot consume reserved purchase lot')
release(x['custody_id'])
# Simulate the debt created by a provider reversal while funds are reserved.
x=json.loads(reserve(100))
sql(f"insert into diamond_debts(user_id,amount,reason) values('{USER}',60,'fixture provider reversal')")
sql("create function fixture_fail_register() returns trigger language plpgsql as $$ begin raise exception 'injected register failure'; end $$; create trigger fixture_fail_register before insert on ca_mint_ledger for each row execute function fixture_fail_register()")
debt_release_id=str(uuid.uuid4())
check(release(x['custody_id'],debt_release_id).get('pending') is True, 'register failure leaves debt release recoverable')
check(sql('select diamonds from profiles')=='900', 'register failure rolls back spendable credit')
check(sql('select amount from diamond_debts where settled_at is null')=='60', 'register failure preserves debt')
sql('drop trigger fixture_fail_register on ca_mint_ledger')
r=release(x['custody_id'],debt_release_id)
check(sql("select sum(amount) from ca_mint_ledger where action='burn'")=='60', 'release registers debt retirement exactly once')
check(r['debt_settled']==60 and r['available_balance']==940,'release settles debt without negative balance')
# A damaged recovery item must not abort the rest of the batch.
x=json.loads(reserve(20))
sql("create trigger fixture_fail_release before insert on diamond_transactions for each row execute function fixture_fail_release()")
bad_id=str(uuid.uuid4())
check(release(x['custody_id'],bad_id).get('pending') is True, 'prepare durable recovery failure')
second_table=str(uuid.uuid4())
sql(f"insert into tables select '{second_table}'::uuid,club_id,min_buy_in,max_buy_in,status from tables where id='{TABLE}'")
good=json.loads(sql(f"select fn_poker_diamond_reserve('{USER}','cash_seat','{second_table}','later-release',20,'{uuid.uuid4()}')"))
check(release(good['custody_id']).get('pending') is True, 'prepare independent later release')
sql('drop trigger fixture_fail_release on diamond_transactions')
sql(f"update poker_diamond_custody set state='active' where id='{x['custody_id']}'")
check(sql('select fn_poker_diamond_recover_releases()')=='1', 'invalid recovery item does not abort later release')
check(sql(f"select state from poker_diamond_custody where id='{good['custody_id']}'")=='released',
      'later release commits despite earlier invalid item')
check('diamond_custody_requires_settlement' in sql(f"select last_error from poker_diamond_obligations where request_id='{bad_id}'"),
      'recovery keeps actionable error on obligation')
sql(f"update poker_diamond_custody set state='reserved' where id='{x['custody_id']}'")
check(sql('select fn_poker_diamond_recover_releases()')=='1', 'repaired obligation completes with original identity')
# Role boundaries: authenticated callers read only their own holdings, cannot fund or edit.
check(sql("set role authenticated; select fn_poker_diamond_reserve(null,null,null,null,null,null)",False).returncode!=0,'client cannot invoke funding RPC')
check(sql("set role authenticated; update poker_diamond_custody set balance=999",False).returncode!=0,'client cannot edit custody')
check(sql("set role authenticated; select count(*) from poker_diamond_custody").splitlines()[-1]=='0','anonymous subject sees no custody rows')
# Independent register comparison includes held funds exactly once.
sql(f"insert into ca_mint_ledger(action,amount,asset,holder_type,holder_id) values('mint',1000,'diamonds','player','{USER}')")
check(sql('select difference from fn_ca_diamond_register_vs_supply()')=='0.00','register counts available supply')
sql('select fn_ca_diamond_snapshot()')
x=json.loads(reserve(100))
check(sql('select difference from fn_ca_diamond_register_vs_supply()')=='0.00','register counts custody supply')
check(sql("select count(*) from fn_ca_diamond_trial_balance() where account in ('player_diamonds','register','total') and difference<>0")=='0','trial balance treats reserve as transfer')
check(sql('select fn_ca_diamond_snapshot()')=='0','snapshot measures custody in same basis')
release(x['custody_id'])
# A fixture transfer must not appear as drift in either accounting population.
fixture_definition = sql("select pg_get_functiondef('fn_ca_is_fixture_account(uuid)'::regprocedure)")
sql(f"create or replace function fn_ca_is_fixture_account(uuid) returns boolean language sql stable as $$ select $1='{USER}'::uuid $$")
sql('select fn_ca_diamond_snapshot()')
fixture_window = sql('select max(taken_at) from ca_diamond_snapshots')
x=json.loads(reserve(100))
check(sql(f"select count(*) from fn_ca_diamond_trial_balance('{fixture_window}') where account in ('player_diamonds','fixture_accounts','register') and difference is distinct from 0")=='0',
      'fixture reserve preserves both accounting populations')
check(sql('select fn_ca_diamond_snapshot()')=='0', 'fixture reserve creates no player snapshot drift')
check(sql('select arena_fixture_diamonds from ca_diamond_snapshots order by taken_at desc limit 1')=='100',
      'snapshot records fixture custody separately')
release(x['custody_id'])
check(sql(f"select count(*) from fn_ca_diamond_trial_balance('{fixture_window}') where account in ('player_diamonds','fixture_accounts','register') and difference is distinct from 0")=='0',
      'fixture release preserves both accounting populations')
check(sql('select fn_ca_diamond_snapshot()')=='0', 'fixture release creates no player snapshot drift')
sql(fixture_definition)
sql('select fn_ca_diamond_snapshot()')
# Tournament entry binds the authoritative price and the same immutable request.
tournament=str(uuid.uuid4())
sql(f"insert into tournaments values('{tournament}','20000000-0000-0000-0000-000000000001',90,10,'registering')")
tournament_request=str(uuid.uuid4())
entry_query=f"select fn_poker_diamond_reserve('{USER}','tournament_entry','{tournament}','entry-1',100,'{tournament_request}')"
entry=json.loads(sql(entry_query))
check(json.loads(sql(entry_query))==entry, 'tournament entry replay returns original receipt')
check(sql(entry_query.replace(',100,',',99,'),False).returncode!=0, 'tournament entry replay binds price')
release(entry['custody_id'])
check(sql(f"select fn_poker_diamond_reserve('{USER}','tournament_entry','{tournament}','entry-2',99,'{uuid.uuid4()}')",False).returncode!=0,
      'tournament entry rejects non-authoritative price')
check(sql('select diamonds from profiles')=='940', 'tournament entry release restores exact wallet')
# Hostile identities, durable history and held-lot restrictions.
x=json.loads(reserve(100))
check(reserve(100, entry='second-open-entry', ok=False).returncode != 0,
      'different entry keys cannot fund the same open target twice')
check(sql("update poker_diamond_movements set amount=amount", False).returncode != 0,
      'custody movements reject updates')
check(sql("delete from poker_diamond_movements", False).returncode != 0,
      'custody movements reject deletion')
other='10000000-0000-0000-0000-000000000002'
sql(f"insert into profiles(id,diamonds) values('{other}',0)")
own=sql(f"set role authenticated; set request.jwt.claim.sub='{USER}'; select fn_poker_diamond_custody_balance()").splitlines()[-1]
check(json.loads(own)['in_play']==100, 'authenticated player reads held balance')
hidden=sql(f"set role authenticated; set request.jwt.claim.sub='{other}'; select count(*) from poker_diamond_custody").splitlines()[-1]
check(hidden=='0', 'another player cannot see custody history')
check(sql(f"delete from profiles where id='{USER}'", False).returncode != 0,
      'profile deletion cannot erase held money or financial history')
release(x['custody_id'])
sql(f"delete from profiles where id='{other}'")
# Archiving a wallet journal must not make the independent movement disappear.
sql("insert into ca_diamond_journal_archive select * from diamond_transactions")
sql("delete from diamond_transactions")
check(sql('select count(*) from fn_poker_diamond_reconcile()')=='0',
      'custody reconciliation follows archived wallet journals')
# All remaining available balance is covered by an unsettled purchase.
sql(f"insert into diamond_purchase_lots(user_id,issued,created_at) values('{USER}',940,now())")
check(reserve(10,ok=False).returncode!=0, 'recent purchase cannot fund a reservation')
sql("update diamond_purchase_lots set created_at=now()-interval '30 days',frozen_at=now()")
check(reserve(10,ok=False).returncode!=0, 'frozen purchase cannot fund a reservation')
sql("update diamond_purchase_lots set frozen_at=null")
sql("update clubs set asset='chips'")
check(reserve(10,ok=False).returncode!=0, 'chip target cannot enter diamond custody')
sql("update clubs set asset='diamonds',union_id=gen_random_uuid()")
check(reserve(10,ok=False).returncode!=0, 'union target cannot enter diamond custody')
sql("update clubs set union_id=null")
sql("update tables set status='closed'")
check(reserve(10,ok=False).returncode!=0, 'closed target cannot reserve money')
# A provider refund while all purchased value is reserved becomes debt, then retires on release.
subprocess.run(PSQL + ['-f', str(Path(__file__).with_name('poker-diamond-production-refund-fixture.sql'))], check=True, capture_output=True)
refund_user='10000000-0000-0000-0000-000000000003'
purchase=str(uuid.uuid4())
sql(f"insert into profiles(id,diamonds) values('{refund_user}',0)")
sql(f"select add_diamonds_to_balance('{refund_user}',1000,'purchase','isolated purchase','purchase:{purchase}')")
sql(f"insert into diamond_purchases(id,user_id,status,diamonds_amount) values('{purchase}','{refund_user}','completed',1000)")
sql(f"insert into diamond_purchase_lots(user_id,purchase_id,issued,created_at) values('{refund_user}','{purchase}',1000,now()-interval '30 days')")
sql("update tables set status='waiting'")
held=json.loads(sql(f"select fn_poker_diamond_reserve('{refund_user}','cash_seat','{TABLE}','refund-held',1000,'{uuid.uuid4()}')"))
refund=json.loads(sql(f"select fn_diamond_purchase_refund('{purchase}',1000,1000)"))
check(refund['success'] and refund['chargeback_debt_amount']==1000, 'provider refund records fully reserved value as debt')
check(sql(f"select balance from poker_diamond_custody where id='{held['custody_id']}'")=='1000', 'provider refund preserves custody liability')
check(sql(f"select arena_reserved from diamond_purchase_lots where purchase_id='{purchase}'")=='1000', 'provider refund preserves held lot identity')
sql(f"select fn_diamond_purchase_refund('{purchase}',1000,1000)")
check(sql(f"select sum(amount) from diamond_debts where user_id='{refund_user}' and settled_at is null")=='1000', 'provider refund replay does not duplicate debt')
paid=release(held['custody_id'])
check(paid['debt_settled']==1000 and paid['available_balance']==0, 'release settles provider debt without spendable overpayment')
check(sql(f"select arena_reserved from diamond_purchase_lots where purchase_id='{purchase}'")=='0', 'provider debt release clears lot reservation')
check(sql('select difference from fn_ca_diamond_register_vs_supply()')=='0.00', 'provider refund and custody release conserve registered supply')
check(sql('select count(*) from fn_poker_diamond_reconcile()')=='0', 'provider refund and custody release reconcile')
# Concurrent shop debit and custody cashout serialize on the same profile.
race_user='10000000-0000-0000-0000-000000000004'
sql(f"insert into profiles(id,diamonds) values('{race_user}',0)")
sql(f"select add_diamonds_to_balance('{race_user}',1000,'purchase','isolated race','race-purchase')")
race_held=json.loads(sql(f"select fn_poker_diamond_reserve('{race_user}','cash_seat','{TABLE}','race-spend',600,'{uuid.uuid4()}')"))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    release_future=pool.submit(release,race_held['custody_id'])
    spend_future=pool.submit(sql,f"select add_diamonds_to_balance('{race_user}',-800,'deduction','isolated shop spend','race-spend')")
    released=release_future.result()
    spent=json.loads(spend_future.result())
check(released['success'], 'cashout completes during concurrent shop spend')
expected=200 if spent['success'] else 1000
check(sql(f"select diamonds from profiles where id='{race_user}'")==str(expected), 'cashout and shop spend produce one serialized wallet result')
check(sql('select difference from fn_ca_diamond_register_vs_supply()')=='0.00', 'concurrent shop spend and cashout conserve registered supply')
check(sql('select count(*) from fn_poker_diamond_reconcile()')=='0', 'concurrent shop spend and cashout reconcile')
check(sql('select count(*) from ca_ledger_write_failures')=='0', 'production audit triggers complete without hidden failures')
print(f'{passed} additional assertions passed', flush=True)
