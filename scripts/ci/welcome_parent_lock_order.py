"""Four original welcome deadlocks: actual bodies, isolated external ports.

Called inside the maintained welcome fixture. Cancellation of empty entries and
the final fixture treasury retirement are explicit ports, not production money
qualification. Captured creator/reset/certification/fence/retired guard are real.
"""
import json
import subprocess
import time


def qualify(g):
    run, command, psql, env = (g[k] for k in ('run', 'command', 'psql', 'env'))
    root, out, results = (g[k] for k in ('ROOT', 'out', 'results'))
    signatures = {
        'fn_create_seat_first_game_atomic': 'public.fn_create_seat_first_game_atomic(uuid,jsonb)',
        'fn_fence_welcome_package_schedule_spawn': 'public.fn_fence_welcome_package_schedule_spawn()',
        'fn_guard_retired_club_mutation': 'public.fn_guard_retired_club_mutation()',
        'fn_remove_first_club_welcome_games': 'public.fn_remove_first_club_welcome_games(uuid,uuid)',
        'fn_unwind_unused_first_club_welcome_package': 'public.fn_unwind_unused_first_club_welcome_package(uuid,uuid)',
        'fn_ca_retire_welcome_certification_club': 'public.fn_ca_retire_welcome_certification_club(uuid,text)',
        'certification_club_admission': 'smarter_private.certification_club_admission(uuid)',
        'fn_lock_tournament_launch_proof_parents': 'public.fn_lock_tournament_launch_proof_parents(uuid[])',
        'trg_lock_and_classify_tournament_table': 'public.trg_lock_and_classify_tournament_table()',
    }
    authorities = json.loads((root / 'scripts/ci/fixtures/welcome-parent-lock-order/authorities.json').read_text())
    authorities += json.loads((root / 'scripts/ci/fixtures/welcome-parent-lock-order/origins.json').read_text())
    old = {}
    for a in authorities:
        sig = signatures[a['proname']]
        r = command(psql, f"SELECT pg_get_functiondef(to_regprocedure('{sig}'));")
        old[sig] = r.stdout.strip()
        run('parent-captured-' + a['proname'], a['definition'] + ';')
        run('parent-source-' + a['proname'],
            f"SELECT md5(pg_get_functiondef('{sig}'::regprocedure))='{a['hash']}';", 't')
    run('parent-real-trigger-order',
        'ALTER TRIGGER scope_retired_club_guard ON tournaments RENAME TO trg_guard_retired_club_mutation;')
    run('parent-fixture-current-creator-columns', """
ALTER TABLE tournaments ADD COLUMN guaranteed_prize numeric,ADD COLUMN blind_structure text,
 ADD COLUMN payout_structure text,ADD COLUMN start_time timestamptz,ADD COLUMN late_reg_levels integer,
 ADD COLUMN late_reg_mins integer,ADD COLUMN satellite_seats integer,ADD COLUMN short_description text,
 ADD COLUMN spin_multiplier numeric,ADD COLUMN spin_locked_tiers jsonb;
ALTER TABLE tables ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE tables ADD COLUMN game_variant text,ADD COLUMN stakes text,ADD COLUMN small_blind numeric,
 ADD COLUMN big_blind numeric,ADD COLUMN min_buy_in numeric,ADD COLUMN max_buy_in numeric;
-- Match the live origin writer and its actual deferred table FK. The fixture
-- has no launch receipts: every accepted original here is prelaunch.
CREATE TABLE tournament_launch_receipts(launch_id uuid PRIMARY KEY,tournament_id uuid UNIQUE,
 lease_generation uuid,completed_at timestamptz);
ALTER TABLE tournament_table_origins ALTER CONSTRAINT tournament_table_origins_table_id_fkey
 DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER aa_tournament_table_launch_proof_lock BEFORE INSERT OR DELETE OR UPDATE ON tables
 FOR EACH ROW EXECUTE FUNCTION trg_lock_and_classify_tournament_table();
CREATE FUNCTION fn_ca_lock_mtt_admission_contract() RETURNS text LANGUAGE sql AS $$SELECT 'legacy-capacity-v1'::text$$;
CREATE FUNCTION fn_entry_purchases_frozen() RETURNS boolean LANGUAGE sql AS $$SELECT false$$;
CREATE TABLE fixture_cancellation_calls(tournament_id uuid PRIMARY KEY);
CREATE FUNCTION atomic_cancel_tournament(p_id uuid,p_actor uuid) RETURNS jsonb LANGUAGE plpgsql AS $$BEGIN
 IF EXISTS(SELECT 1 FROM tournament_players WHERE tournament_id=p_id)
 OR EXISTS(SELECT 1 FROM tournament_escrow WHERE tournament_id=p_id)
 OR EXISTS(SELECT 1 FROM tournament_payouts WHERE tournament_id=p_id) THEN
  RAISE EXCEPTION 'fixture refuses any funded cancellation'; END IF;
 INSERT INTO fixture_cancellation_calls VALUES(p_id);
 UPDATE tournaments SET status='CANCELLED',ended_at=now()
  WHERE id=p_id AND status='REGISTERING' AND current_players=0 AND buy_in_amount=1
   AND buy_in_fee=0 AND tournament_type='SPIN' AND variant='spin' AND name='1 Chip Spin NLH';
 IF NOT FOUND THEN RAISE EXCEPTION 'fixture refuses unsupported cancellation';END IF;
 RETURN jsonb_build_object('ok',true,'fully_settled',true,'status','CANCELLED',
  'tournament_id',p_id,'source_player_count',0);
END$$;
CREATE FUNCTION fixture_creation_boundary() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
 IF current_setting('application_name')='original-creator' THEN
  PERFORM pg_advisory_xact_lock(530099,888); END IF;RETURN NEW;END$$;
CREATE TRIGGER trg_fz_creation_boundary BEFORE INSERT ON tournaments
 FOR EACH ROW EXECUTE FUNCTION fixture_creation_boundary();
REVOKE ALL ON FUNCTION fn_fence_welcome_package_schedule_spawn() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION fn_fence_welcome_package_schedule_spawn() TO service_role;
""")

    def expect(name, ok, **data):
        results['cases'].append({'name': name, 'passed': bool(ok), **data})
        if not ok:
            raise AssertionError(name + ': ' + json.dumps(data))

    def fixture(n):
        owner = f'00000000-0000-4000-8000-0000000000{n}'
        club = f'00000000-0000-4000-9000-0000000000{n}'
        tournament = f'00000000-0000-4000-a000-0000000000{n}'
        run('parent-fixture-' + str(n), f"INSERT INTO auth.users VALUES('{owner}','ca-customization-cert-postdeploy-{n}@example.invalid'); INSERT INTO clubs(id,owner_id,name) VALUES('{club}','{owner}','Crest Cert Original{n}'); INSERT INTO club_members(club_id,user_id) VALUES('{club}','{owner}'); SET request.jwt.claim.sub='{owner}'; INSERT INTO club_creation_requests VALUES('{owner}',gen_random_uuid(),'{club}');")
        cfg = {'club_id': club, 'name': '1 Chip Spin NLH', 'game_type': 'NLH', 'variant': 'spin',
               'tournament_type': 'SPIN', 'buy_in_amount': 1, 'buy_in_fee': 0, 'guaranteed_prize': 0,
               'starting_chips': 300, 'max_players': 3, 'min_players': 3, 'table_size': 3,
               'blind_structure': [{'smallBlind': 10, 'bigBlind': 20}], 'payout_structure': [],
               'start_time': '2026-10-30T00:00:00Z'}
        create = f"SELECT fn_create_seat_first_game_atomic('{tournament}','{json.dumps(cfg)}'::jsonb);"
        return owner, club, tournament, create

    def cleanup_sql(owner, club, kind):
        call = (f"fn_remove_first_club_welcome_games('{club}',gen_random_uuid())" if kind == 'reset'
                else f"fn_ca_retire_welcome_certification_club('{club}','parent-order-native')")
        return f"SET request.jwt.claim.sub='{owner}';SET request.jwt.claim.role='service_role';SELECT {call};"

    def money(club):
        q = f"""SELECT jsonb_build_object('treasury',chip_treasury,'chip_pool',chip_pool,
 'promo',promo_balance,'insurance',insurance_balance,
 'bbj',(SELECT jsonb_agg(jsonb_build_array(main_balance,backup_balance,promo_balance,total_paid_out)) FROM bbj_pools WHERE club_id='{club}'),
 'spin',(SELECT jsonb_agg(jsonb_build_array(balance,seeded_amount,is_active,seed_returned_amount,total_deposited,total_drawn)) FROM spin_bonus_pools WHERE club_id='{club}'),
 'journal',(SELECT jsonb_agg(v ORDER BY v::text) FROM (SELECT jsonb_build_array(transaction_type,amount,balance_after) v FROM chip_transactions WHERE club_id='{club}')j),
 'spin_ledger',(SELECT jsonb_agg(v ORDER BY v::text) FROM (SELECT jsonb_build_array(kind,amount,balance_after) v FROM spin_reserve_ledger WHERE club_id='{club}')j),
 'entrants',(SELECT count(*) FROM tournament_players p JOIN tournaments t ON t.id=p.tournament_id WHERE t.club_id='{club}'),
 'payouts',(SELECT count(*) FROM tournament_payouts p JOIN tournaments t ON t.id=p.tournament_id WHERE t.club_id='{club}')) FROM clubs WHERE id='{club}';"""
        r = command(psql, q)
        if r.returncode:
            raise RuntimeError(r.stderr)
        return json.loads(r.stdout)

    def await_wait(name):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            r = command(psql, f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event_type='Lock';")
            if r.stdout.strip() == '1':
                return
            time.sleep(.02)
        raise AssertionError('No actual lock wait: ' + name)

    def race(n, kind, candidate):
        owner, club, tournament, create = fixture(n)
        before_money = money(club)
        gate = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        gate.stdin.write("BEGIN;SELECT pg_advisory_xact_lock(530099,888);SELECT 'READY';\n")
        gate.stdin.flush()
        while gate.stdout.readline().strip() != 'READY':
            if gate.poll() is not None:
                raise AssertionError('Native gate exited')
        end = 'COMMIT;' if candidate else 'ROLLBACK;'
        creator = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        creator.stdin.write("BEGIN;SET application_name='original-creator';SET deadlock_timeout='100ms';" + create + end + '\n')
        creator.stdin.close(); creator.stdin = None
        await_wait('original-creator')
        cleaner = subprocess.Popen(psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        cleaner.stdin.write("BEGIN;SET application_name='original-cleanup';SET deadlock_timeout='100ms';" + cleanup_sql(owner, club, kind) + end + '\n')
        cleaner.stdin.close(); cleaner.stdin = None
        if not candidate or kind == 'reset':
            await_wait('original-cleanup')
        else:
            uout, uerr = cleaner.communicate(timeout=5)
            expect('candidate-certification-refuses-busy-parent-before-mutation',
                   cleaner.returncode != 0 and 'could not obtain lock on row in relation "clubs"' in uerr,
                   stderr=uerr)
            expect('candidate-certification-busy-refusal-keeps-money', money(club) == before_money)
        gate.stdin.write('COMMIT;\\q\n'); gate.stdin.flush(); gate.wait(timeout=5)
        cout, cerr = creator.communicate(timeout=10)
        if not candidate or kind == 'reset':
            uout, uerr = cleaner.communicate(timeout=10)
        (out / f'parent-race-{n}-{kind}.log').write_text(cout + '\n' + cerr + '\n' + uout + '\n' + uerr)
        if not candidate:
            expect('BEFORE-actual-' + kind + '-40P01', 'deadlock detected' in cerr + uerr,
                   creator_error=cerr, cleanup_error=uerr)
            expect('BEFORE-both-rolled-back-money-' + kind, money(club) == before_money)
            return
        expect('AFTER-actual-creator-' + kind, creator.returncode == 0, stderr=cerr)
        if kind == 'reset':
            expect('AFTER-actual-reset-commits', cleaner.returncode == 0, stderr=uerr)
            run('parent-exact-empty-cancellation-target', f"SELECT count(*),bool_and(tournament_id='{tournament}'::uuid) FROM fixture_cancellation_calls WHERE tournament_id='{tournament}';", '1|t')
        else:
            run('AFTER-certification-after-creator-boundary', cleanup_sql(owner, club, kind))
        return money(club)

    # Current source fails in both recorded callers. Successful peers ROLLBACK.
    race(55, 'reset', False)
    race(56, 'certification', False)
    baseline = {}
    for n, kind in [(57, 'reset'), (58, 'certification')]:
        owner, club, tournament, create = fixture(n)
        run('parent-original-serial-create-' + kind, create)
        run('parent-original-serial-cleanup-' + kind, cleanup_sql(owner, club, kind))
        baseline[kind] = money(club)
    migration = root / 'supabase/migrations/20261031164412_welcome_tournament_inserts_lock_their_club_before_child_fenc.sql'
    run('parent-install-exact-candidate', migration.read_text())
    expect('AFTER-reset-money-identical-to-original-serial', race(59, 'reset', True) == baseline['reset'], expected=baseline['reset'])
    expect('AFTER-certification-money-identical-to-original-serial', race(60, 'certification', True) == baseline['certification'], expected=baseline['certification'])
    owner, club, tournament, create = fixture(61)
    run('parent-retired-negative-setup', f"UPDATE clubs SET lifecycle_status='retired' WHERE id='{club}';")
    before = money(club)
    refused = command(psql, create)
    expect('AFTER-actual-retired-guard-still-refuses', refused.returncode != 0 and 'CLUB_RETIRED' in refused.stderr)
    expect('AFTER-retired-negative-preserves-money', money(club) == before)
    run('parent-retired-negative-has-no-created-row', f"SELECT count(*) FROM tournaments WHERE id='{tournament}';", '0')
    # Leave the historical business fixture exactly as entered. It continues its
    # original unchanged cases after this focused current-authority regression.
    run('parent-remove-fixture-boundary', 'DROP TRIGGER trg_fz_creation_boundary ON tournaments;DROP FUNCTION fixture_creation_boundary();DROP TRIGGER aa_tournament_table_launch_proof_lock ON tables;')
    for sig, definition in old.items():
        run('parent-restore-' + sig.split('(')[0].split('.')[-1],
            definition + ';' if definition else 'DROP FUNCTION ' + sig + ';')
    run('parent-restore-historical-trigger-order',
        'ALTER TRIGGER trg_guard_retired_club_mutation ON tournaments RENAME TO scope_retired_club_guard;')
    # New fixture-only columns/ports stay private to this disposable cluster.
    (out / 'parent-order-boundaries.json').write_text(json.dumps({
        'actual_authority_hashes': {a['proname']: a['hash'] for a in authorities},
        'external_ports': ['legacy-capacity admission selector', 'unfrozen fixture entry gate',
                           'empty-registration cancellation recorder', 'existing fixture treasury retirement'],
        'serial_money': baseline,
        'scope': 'Only welcome child-before-parent deadlocks; not production money/engine qualification',
    }, indent=2))
