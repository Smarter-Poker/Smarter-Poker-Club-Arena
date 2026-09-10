#!/usr/bin/env python3
"""Isolated PostgreSQL proof; never accepts or connects to a remote database.

Uses reviewed installed draw, settlement, entry and paid-entry SQL. Pool
ownership, maintenance state and RNG are controlled. This proves transaction,
funding and receipt boundaries; it is not a production ledger certification.
"""
from pathlib import Path
import json
import os
import shutil
import subprocess
import tempfile
import time
from played_spin_proof_cases import run_played_proof_cases

repo = Path(__file__).resolve().parents[2]
fixture = repo / 'scripts/dev/fixtures/spin-funding'
migration = repo / 'supabase/migrations/20260909174722_spin_draw_books_one_funded_rule_receipt.sql'
played_replay_migration = repo / 'supabase/migrations/20260909193732_a_booked_played_spin_replays_its_original_funded_draw.sql'
configured = os.environ.get('POKER_AUDIT_PG_BIN')
pg = Path(configured) if configured else Path(subprocess.check_output(
    ['brew', '--prefix', 'postgresql@17'], text=True).strip()) / 'bin'
root = Path(tempfile.mkdtemp(prefix='ca-atomic-spin-pg17-'))
cluster = root / 'cluster'
sock = root / 'socket'
sock.mkdir()
port = str(35000 + os.getpid() % 10000)
log_path = Path(os.environ.get('POKER_AUDIT_SPIN_LOG', '/tmp/codex-poker-audit-sep09-atomic-spin-pg17.log'))
club = 'aaaaaaaa-0000-0000-0000-000000000001'
passed = []
processes = []


def uid(n):
    return f'bbbbbbbb-0000-0000-0000-{n:012d}'


def manifest():
    # A small algebraically valid distribution (EV 2.76) makes the two
    # affordability outcomes deterministic under the controlled high RNG.
    def tier(multiplier, freq, payouts):
        return dict(multiplier=multiplier, freq=freq, reserveThresholdX=0,
                    blind_structure=[dict(level=i, smallBlind=i*10, bigBlind=i*20,
                                          ante=0, duration=180) for i in range(1, 13)],
                    payout_structure=[dict(place=i+1, percentage=p) for i, p in enumerate(payouts)])
    tiers = [tier(2, 181, [100]), tier(10, 19, [80, 20])]
    for item in tiers:
        item['blind_structure'][-1]['spinContinuation'] = dict(version=1, anchorLevel=12, anchorBigBlind=240, growth=1.4, roundBigTo=10)
    return dict(version=1, buy_in=1, seats=3, rake_rate=0.08, starting_chips=300, tiers=tiers)


def literal(value):
    return "'" + json.dumps(value, separators=(',', ':')).replace("'", "''") + "'::jsonb"


def rpc(n, rules=None, generation=None, launch=None):
    return ("public.fn_spin_draw_and_settle_atomic(" + f"'{uid(n)}','{launch or uid(n)}',"
            + f"'{generation or uid(n)}'," + literal(rules or manifest()) + ')')


with log_path.open('w') as log:
    def q(sql, fail=False):
        result = subprocess.run(args + ['-c', sql], capture_output=True, text=True, timeout=35)
        log.write(result.stdout + result.stderr)
        log.flush()
        if fail:
            assert result.returncode != 0, 'Expected transaction rejection'
            return result.stderr
        if result.returncode:
            raise AssertionError(result.stderr)
        return result.stdout.strip()

    def load_sql(path):
        result = subprocess.run(args + ['-f', str(path)], stdout=log, stderr=log, timeout=35)
        if result.returncode:
            raise AssertionError(f'Could not load {path}; see {log_path}')

    def seed(n, pool=10):
        q(f"SELECT public.probe_spin_fixture('{uid(n)}',{pool});")

    def check(name, condition):
        assert condition, name
        passed.append(name)
        log.write('PASS: ' + name + '\n')
        log.flush()

    try:
        version = subprocess.check_output([str(pg/'postgres'), '--version'], text=True)
        assert ' 17.' in version, version
        subprocess.run([str(pg/'initdb'), '-D', str(cluster), '--auth=trust', '--no-locale'],
                       check=True, stdout=log, stderr=log)
        subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-o',
                        f'-k {sock} -p {port} -c listen_addresses=', '-w', 'start'],
                       check=True, stdout=log, stderr=log)
        args = [str(pg/'psql'), '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-h', str(sock), '-p', port, '-d', 'postgres']
        load_sql(fixture/'bootstrap.sql')
        source = (repo/'supabase/migrations/20260830112000_spin_draw_settle_concurrency_hardening.sql').read_text()
        start = source.index('CREATE OR REPLACE FUNCTION public.fn_spin_seed_instalment')
        end = source.index('$function$;', source.index('AS $function$', start)) + len('$function$;')
        q(source[start:end])
        load_sql(fixture/'installed.sql')
        load_sql(fixture/'baseline.sql')
        check('installed baseline reproduces duplicate reserve spending and unbacked overlay', True)
        q('TRUNCATE public.clubs,public.tournaments,public.spin_bonus_pools,public.spin_reserve_ledger,'
          'public.rake_records,public.chip_ledger,public.tournament_escrow RESTART IDENTITY;')
        load_sql(fixture/'proof-bootstrap.sql')
        load_sql(fixture/'installed-proof-functions.sql')
        load_sql(migration)
        atomic_source_md5 = q("SELECT md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))")
        check('atomic Spin draw authority matches the reviewed composition source',
              atomic_source_md5 == '71e869039854497e472ed20e259be4db')
        log.write('ATOMIC_SPIN_DRAW_BASELINE_MD5: ' + atomic_source_md5 + '\n')
        if os.environ.get('POKER_AUDIT_DUMP_ATOMIC_SOURCE') == '1':
            log.write('ATOMIC_SPIN_DRAW_SOURCE_BEGIN\n')
            log.write(q("SELECT pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure)"))
            log.write('\nATOMIC_SPIN_DRAW_SOURCE_END\n')
        log.flush()
        load_sql(fixture/'played-proof-bootstrap.sql')
        load_sql(fixture/'installed-played-proof.sql')
        check('played recovery uses the installed proof body, without a verdict stub',
              q("SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_prove_played_spin_launch_recovery(uuid)'::regprocedure")
              == 'b7bc1bb46141fb6bd415b3658e622a3b')
        load_sql(played_replay_migration)
        played_replay_source_md5 = q("SELECT md5(pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure))")
        check('played Spin replay matches the installed funded draw authority',
              played_replay_source_md5 == '1c911e3ada50ffe0493b9b375e3fa9ae')
        log.write('ATOMIC_SPIN_DRAW_PLAYED_REPLAY_MD5: ' + played_replay_source_md5 + '\n')
        if os.environ.get('POKER_AUDIT_DUMP_ATOMIC_SOURCE') == '1':
            log.write('ATOMIC_SPIN_DRAW_PATCHED_SOURCE_BEGIN\n')
            log.write(q("SELECT pg_get_functiondef('public.fn_spin_draw_and_settle_atomic(uuid,uuid,uuid,jsonb)'::regprocedure)"))
            log.write('\nATOMIC_SPIN_DRAW_PATCHED_SOURCE_END\n')
        log.flush()
        q('CREATE TRIGGER zzz_spin_ladder_is_the_drawn_one BEFORE INSERT OR UPDATE ON public.tournaments FOR EACH ROW EXECUTE FUNCTION public.fn_spin_ladder_is_the_drawn_one()')
        q("CREATE OR REPLACE FUNCTION extensions.gen_random_bytes(integer) RETURNS bytea "
          "LANGUAGE sql VOLATILE AS $$ SELECT decode(repeat('ff', $1), 'hex') $$;")

        seed(1, 8)
        check('generic refund planner cannot be used as Spin admission proof',
              'escrow does not equal its immutable entitlement rails' in q(
                  f"SELECT * FROM public.fn_ca_tournament_refund_plan('{uid(1)}',(SELECT user_id FROM public.tournament_players WHERE tournament_id='{uid(1)}' LIMIT 1))", fail=True))
        first = json.loads(q('SELECT ' + rpc(1)))
        check('already booked 2.76 entry is not counted twice against an 8-chip pool',
              first['multiplier'] == 2 and first['pool_covered'] == 2
              and first['locked'] == [dict(multiplier=10, reason='unaffordable', unlocksAt=10)])
        changed = manifest()
        changed['starting_chips'] = 1000
        changed['tiers'][0]['blind_structure'][0]['duration'] = 600
        replay = json.loads(q('SELECT ' + rpc(1, changed)))
        check('response-loss replay preserves every original field despite new rules',
              replay == dict(first, replay=True))
        q(f"UPDATE public.engine_tournament_leases SET lease_generation='{uid(900)}' WHERE tournament_id='{uid(1)}';"
          f"UPDATE public.tournament_launch_receipts SET lease_generation='{uid(900)}' WHERE tournament_id='{uid(1)}';")
        check('lease replacement adopts original receipt without a second draw',
              json.loads(q('SELECT ' + rpc(1, changed, uid(900)))) == dict(first, replay=True))
        check('stale owner cannot use a committed receipt',
              json.loads(q('SELECT ' + rpc(1)))['reason'] == 'launch_lease_lost')
        check('service role cannot rewrite durable receipt', 'permission denied' in q(
              f"SET ROLE service_role; UPDATE public.spin_draw_receipts SET rule_sha256=repeat('0',64) WHERE tournament_id='{uid(1)}';", fail=True))
        check('immutable trigger rejects privileged receipt deletion', 'immutable' in q(
              f"DELETE FROM public.spin_draw_receipts WHERE tournament_id='{uid(1)}';", fail=True))
        check('untrusted role cannot execute funded draw', 'permission denied' in q(
              'SET ROLE authenticated; SELECT ' + rpc(1), fail=True))

        seed(2)
        q(f"UPDATE public.spin_bonus_pools SET balance=0 WHERE club_id='{club}';"
          f"DELETE FROM public.spin_reserve_ledger WHERE tournament_id='{uid(2)}' AND kind='contribution';")
        second = json.loads(q('SELECT ' + rpc(2)))
        check('unbooked actual entries are credited once before the draw',
              second['multiplier'] == 2 and float(q(f"SELECT balance FROM public.spin_bonus_pools WHERE club_id='{club}'")) == .76)
        check('exact entry and fixed rake are booked only once', q(
              f"SELECT count(*)=1 FROM public.spin_reserve_ledger WHERE tournament_id='{uid(2)}' AND kind='contribution'") == 't')

        seed(3)
        q(f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{uid(3)}'")
        check('cancellation before draw prevents all booking',
              json.loads(q('SELECT ' + rpc(3)))['reason'] == 'launch_receipt_state_mismatch')
        seed(4)
        q('UPDATE public.probe_maintenance SET frozen=true')
        check('maintenance prevents a new funded draw',
              json.loads(q('SELECT ' + rpc(4)))['reason'] == 'entry_purchases_frozen')
        q('UPDATE public.probe_maintenance SET frozen=false')
        q(f"UPDATE public.engine_tournament_leases SET heartbeat_at=now()-interval '31 seconds' WHERE tournament_id='{uid(4)}'")
        check('expired lease prevents a new funded draw',
              json.loads(q('SELECT ' + rpc(4)))['reason'] == 'launch_lease_lost')
        seed(5)
        q(f"DELETE FROM public.tournament_players WHERE id=(SELECT id FROM public.tournament_players WHERE tournament_id='{uid(5)}' LIMIT 1)")
        check('two funded registrations cannot launch a three-seat Spin',
              json.loads(q('SELECT ' + rpc(5)))['reason'] == 'spin_field_unproven')
        seed(6)
        q(f"INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount) SELECT tournament_id,user_id,'credit','refund',1 FROM public.tournament_players WHERE tournament_id='{uid(6)}' LIMIT 1")
        check('past debit with unmatched refund evidence cannot fund a draw',
              json.loads(q('SELECT ' + rpc(6)))['reason'] == 'spin_paid_entry_unproven')
        seed(7)
        q(f"INSERT INTO public.tournament_refund_tranches SELECT e.tournament_id,e.user_id,e.id,e.refund_wallet_club_id,e.gross,e.refund_prize,e.refund_bounty,e.refund_fee FROM public.tournament_refund_entitlements e WHERE e.tournament_id='{uid(7)}' LIMIT 1;"
          f"INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount) SELECT tournament_id,user_id,'credit','refund',amount_paid_now FROM public.tournament_refund_tranches WHERE tournament_id='{uid(7)}'")
        check('fully refunded entry is excluded despite its original buy-in debit',
              json.loads(q('SELECT ' + rpc(7)))['reason'] == 'spin_paid_entry_unproven')
        seed(8)
        invalid = manifest()
        invalid['tiers'][0]['freq'] += 1
        check('a rule manifest that changes the fixed rake economics is rejected',
              json.loads(q('SELECT ' + rpc(8, invalid)))['reason'] == 'spin_rule_manifest_invalid')

        seed(9)
        q(f"UPDATE public.spin_bonus_pools SET balance=8 WHERE club_id='{club}'")
        check('old settlement callers cannot create an unfunded operator overlay', 'exceeds funded reserve' in q(
              f"SELECT public.fn_spin_settle_game('{uid(9)}','{club}',1,3,10,0.08)", fail=True))
        check('rejected old settlement changes neither balance, draw ledger nor overlay', q(
              f"SELECT (SELECT balance=8 FROM public.spin_bonus_pools WHERE club_id='{club}') AND NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger WHERE tournament_id='{uid(9)}' AND kind='jackpot_draw') AND (SELECT overlay_in=0 FROM public.tournament_escrow WHERE tournament_id='{uid(9)}')") == 't')

        seed(10)
        seed(11)
        q(f"UPDATE public.spin_bonus_pools SET balance=10 WHERE club_id='{club}'")
        a = subprocess.Popen(args + ['-c', 'SET application_name=\'spin-probe-a\'; BEGIN; SELECT '
                  + rpc(10) + '; SELECT pg_sleep(1.5); COMMIT;'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(a)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='spin-probe-a' AND wait_event='PgSleep'") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('First transaction did not reach the post-booking hold')
        denied = q('SELECT ' + rpc(11), fail=True)
        out, err = a.communicate(timeout=10)
        log.write(out + err)
        check('two actual concurrent transactions cannot select the same 10-chip reserve',
              a.returncode == 0 and 'no_eligible_tiers' in denied and q(
                  f"SELECT count(*)=1 AND sum(-amount)=10 FROM public.spin_reserve_ledger WHERE tournament_id IN ('{uid(10)}','{uid(11)}') AND kind='jackpot_draw'") == 't')
        check('losing concurrent draw leaves no receipt or phantom overlay', q(
              f"SELECT NOT EXISTS(SELECT 1 FROM public.spin_draw_receipts WHERE tournament_id='{uid(11)}') AND (SELECT overlay_in=0 FROM public.tournament_escrow WHERE tournament_id='{uid(11)}')") == 't')

        # A cancellation contends on the same parent lock. If it commits first,
        # the waiting draw sees CANCELLED and creates no new receipt or debit.
        seed(12)
        b = subprocess.Popen(args + ['-c', "SET application_name='spin-probe-cancel'; BEGIN; "
            f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{uid(12)}'; SELECT pg_sleep(1.5); COMMIT;"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(b)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='spin-probe-cancel' AND wait_event='PgSleep'") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('Cancellation did not acquire the parent lock')
        result = json.loads(q('SELECT ' + rpc(12)))
        out, err = b.communicate(timeout=10)
        log.write(out + err)
        check('concurrent cancellation wins before the locked draw can book',
              b.returncode == 0 and result['reason'] == 'launch_receipt_state_mismatch')
        seed(13)
        q(f"UPDATE public.spin_bonus_pools SET balance=20 WHERE club_id='{club}';"
          f"SELECT public.fn_spin_settle_game('{uid(13)}','{club}',1,3,2,0.08);")
        legacy_tier = manifest()['tiers'][0]
        q(f"UPDATE public.tournaments SET spin_multiplier=2,blind_structure="
          + literal(legacy_tier['blind_structure']) + ',payout_structure='
          + literal(legacy_tier['payout_structure']) + f" WHERE id='{uid(13)}'")
        old = json.loads(q('SELECT ' + rpc(13, changed)))
        check('legacy recovery preserves actual projected rules without inventing historical odds',
              old['rule_provenance'] == 'legacy_projection'
              and old['rule_manifest']['probability_snapshot'] is None
              and old['blind_structure'] == legacy_tier['blind_structure']
              and old['payout_structure'] == legacy_tier['payout_structure']
              and float(q(f"SELECT balance FROM public.spin_bonus_pools WHERE club_id='{club}'")) == 18)
        check('legacy adoption leaves one original draw and replays the adopted receipt',
              json.loads(q('SELECT ' + rpc(13))) == dict(old, replay=True) and q(
                  f"SELECT count(*)=1 FROM public.spin_reserve_ledger WHERE tournament_id='{uid(13)}' AND kind='jackpot_draw'") == 't')
        seed(14)
        q(f"SELECT public.fn_spin_settle_game('{uid(14)}','{club}',1,3,2,0.08)")
        check('legacy crash without a projected rule proof never substitutes current rules',
              json.loads(q('SELECT ' + rpc(14)))['reason'] == 'legacy_spin_rules_unproven')
        seed(15)
        malformed = manifest()
        malformed['tiers'][0]['blind_structure'][0]['duration'] = 0
        check('an invalid rule on any tier is rejected before choosing a prize',
              json.loads(q('SELECT ' + rpc(15, malformed)))['reason'] == 'spin_rule_manifest_invalid')

        seed(16)
        q(f"UPDATE public.spin_bonus_pools SET balance=10 WHERE club_id='{club}'")
        duplicate = subprocess.Popen(args + ['-c', "SET application_name='spin-probe-duplicate'; BEGIN; SELECT "
            + rpc(16) + '; SELECT pg_sleep(1.5); COMMIT;'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        processes.append(duplicate)
        until = time.monotonic() + 5
        while time.monotonic() < until:
            if q("SELECT count(*) FROM pg_stat_activity WHERE application_name='spin-probe-duplicate' AND wait_event='PgSleep'") == '1':
                break
            time.sleep(.02)
        else:
            raise AssertionError('Duplicate launch did not reach the committed-result hold')
        repeated = json.loads(q('SELECT ' + rpc(16)))
        out, err = duplicate.communicate(timeout=10)
        log.write(out + err)
        check('concurrent calls for one launch share one durable draw',
              duplicate.returncode == 0 and repeated['replay'] is True and repeated['multiplier'] == 10
              and q(f"SELECT count(*)=1 FROM public.spin_reserve_ledger WHERE tournament_id='{uid(16)}' AND kind='jackpot_draw'") == 't')

        seed(17)
        q(f"UPDATE public.spin_bonus_pools SET balance=10 WHERE club_id='{club}';"
          "CREATE FUNCTION public.probe_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "
          f"IF NEW.tournament_id='{uid(17)}'::uuid THEN RAISE EXCEPTION 'simulated receipt write failure'; END IF; RETURN NEW; END $$;"
          "CREATE TRIGGER probe_fail_receipt BEFORE INSERT ON public.spin_draw_receipts FOR EACH ROW EXECUTE FUNCTION public.probe_fail_receipt();")
        check('a receipt persistence failure aborts the whole funded transaction',
              'simulated receipt write failure' in q('SELECT ' + rpc(17), fail=True))
        check('response cannot escape with a booked prize but no durable rule receipt', q(
              f"SELECT (SELECT balance=10 FROM public.spin_bonus_pools WHERE club_id='{club}') AND NOT EXISTS(SELECT 1 FROM public.spin_reserve_ledger WHERE tournament_id='{uid(17)}' AND kind='jackpot_draw') AND NOT EXISTS(SELECT 1 FROM public.spin_draw_receipts WHERE tournament_id='{uid(17)}')") == 't')
        q('DROP TRIGGER probe_fail_receipt ON public.spin_draw_receipts; DROP FUNCTION public.probe_fail_receipt();')
        seed(18)
        q('SELECT ' + rpc(18))
        q(f"UPDATE public.tournaments SET status='CANCELLED' WHERE id='{uid(18)}'")
        check('cancellation after booking preserves evidence and prevents a reveal replay',
              json.loads(q('SELECT ' + rpc(18)))['reason'] == 'launch_receipt_state_mismatch'
              and q(f"SELECT count(*)=1 FROM public.spin_draw_receipts WHERE tournament_id='{uid(18)}'") == 't')
        seed(19)
        q(f"UPDATE public.tournaments SET spin_multiplier=10 WHERE id='{uid(19)}'")
        check('an already projected but unbooked result is never silently redrawn',
              json.loads(q('SELECT ' + rpc(19)))['reason'] == 'projected_spin_draw_has_no_funding_proof')
        q(f"INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount) SELECT tournament_id,user_id,'credit','refund',1 FROM public.tournament_players WHERE tournament_id='{uid(16)}' LIMIT 1")
        check('a receipt cannot be replayed after one of its entries was refunded',
              json.loads(q('SELECT ' + rpc(16)))['reason'] == 'spin_paid_entry_unproven')

        seed(20)
        q(f"UPDATE public.spin_bonus_pools SET balance=100 WHERE club_id='{club}'")
        played = json.loads(q('SELECT ' + rpc(20)))
        q(f"UPDATE public.tournament_players SET status='playing' WHERE tournament_id='{uid(20)}';"
          f"UPDATE public.tournament_players SET status='eliminated' WHERE id=(SELECT id FROM public.tournament_players WHERE tournament_id='{uid(20)}' ORDER BY id LIMIT 1)")
        check('two active rows still fail closed when played-Spin proof is absent',
              json.loads(q('SELECT ' + rpc(20)))['reason'] == 'spin_field_unproven')
        q(f"SELECT public.probe_played_spin_evidence('{uid(20)}')")
        run_played_proof_cases(q, check, rpc, uid, 20)
        played_replay = json.loads(q('SELECT ' + rpc(20)))
        log.write('PLAYED_SPIN_REPLAY_RECEIPT: ' + json.dumps(played_replay, sort_keys=True) + '\n')
        log.flush()
        check('a proved played Spin replays the one immutable funded draw after one bust',
              played_replay == dict(played, replay=True))
        q(f"INSERT INTO public.wallet_transactions(related_entity_id,user_id,type,category,amount) "
          f"SELECT tournament_id,user_id,'credit','refund',1 FROM public.tournament_players WHERE tournament_id='{uid(20)}' AND status='eliminated'")
        check('played replay still rejects an entrant whose original charge was refunded',
              json.loads(q('SELECT ' + rpc(20)))['reason'] == 'spin_paid_entry_unproven')

        seed(21)
        q(f"UPDATE public.spin_bonus_pools SET balance=100 WHERE club_id='{club}'")
        q(f"SELECT public.fn_spin_settle_game('{uid(21)}','{club}',1,3,2,0.08)")
        adopted_tier = manifest()['tiers'][0]
        q(f"UPDATE public.tournaments SET spin_multiplier=2,blind_structure="
          + literal(adopted_tier['blind_structure']) + ',payout_structure='
          + literal(adopted_tier['payout_structure']) + f" WHERE id='{uid(21)}';"
          f"UPDATE public.tournament_players SET status='playing' WHERE tournament_id='{uid(21)}';"
          f"UPDATE public.tournament_players SET status='eliminated' WHERE id=(SELECT id FROM public.tournament_players WHERE tournament_id='{uid(21)}' ORDER BY id LIMIT 1)")
        q(f"SELECT public.probe_played_spin_evidence('{uid(21)}')")
        adopted_played = json.loads(q('SELECT ' + rpc(21)))
        check('a proved pre-receipt played Spin adopts its original funded draw once',
              adopted_played['rule_provenance'] == 'legacy_projection'
              and json.loads(q('SELECT ' + rpc(21))) == dict(adopted_played, replay=True)
              and q(f"SELECT count(*)=1 FROM public.spin_draw_receipts WHERE tournament_id='{uid(21)}'") == 't')

        # A mutable global payout table must never rewrite a booked contract.
        q(f"UPDATE public.tournaments SET spin_multiplier=2 WHERE id='{uid(1)}'")
        q('UPDATE public.spin_payout_ladder SET structure=' + literal([dict(place=1,percentage=90),dict(place=2,percentage=10)]) + ' WHERE multiplier=2')
        q(f"UPDATE public.tournaments SET name='New metadata',blind_structure='[]',payout_structure='[]' WHERE id='{uid(1)}'")
        projected = json.loads(q(f"SELECT jsonb_build_object('blinds',blind_structure::jsonb,'payouts',payout_structure::jsonb) FROM public.tournaments WHERE id='{uid(1)}'"))
        check('database projection preserves frozen payouts and blinds after global rules change',
              projected['blinds'] == first['blind_structure'] and projected['payouts'] == first['payout_structure'])
        check('database refuses replacing a booked multiplier', 'original multiplier' in q(
              f"UPDATE public.tournaments SET spin_multiplier=10 WHERE id='{uid(1)}'", fail=True))
        check('database refuses changing the funded board stack', 'funded entry and board contract' in q(
              f"UPDATE public.tournaments SET starting_chips=1000 WHERE id='{uid(1)}'", fail=True))
        print(f'{len(passed)} PostgreSQL checks passed. Log: {log_path}', flush=True)
    finally:
        for process in processes:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
        if cluster.exists():
            subprocess.run([str(pg/'pg_ctl'), '-D', str(cluster), '-m', 'immediate', 'stop'],
                           stdout=log, stderr=log)
        shutil.rmtree(root)
