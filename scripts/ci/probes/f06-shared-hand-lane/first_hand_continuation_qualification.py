"""A last table that never dealt continues from its entries (20260926132457).

Production 2026-09-26: e9c07fe8 (spin-v1, three chairs at the 1,000 starting
chips) and 114c6069 (sng-v1, two chairs at 1,000) parked their only table
before its first hand. fn_f06_continue_no_start_last_table proved chairs only
against a last committed hand and refused F06_CONTINUATION_PRIOR_COMMIT_REQUIRED
for ever. Red on the production image, green after the migration, and every
variant that is not exactly the entries still refuses. Money, seats and
permits are compared before and after every refusal and the whole scenario.
"""
import json

PRE = '974e426ede5bd86fa3410fc98f5461f9'
MIGRATION = 'supabase/migrations/20260926132457_a_last_table_that_never_dealt_continues_from_its_entries.sql'


def qualify(root, out, cmd, command, run, probe, require, results):
    migration = (root / MIGRATION).read_text()
    signature = 'public.fn_f06_continue_no_start_last_table(uuid,uuid,uuid,bigint,uuid,uuid,bigint)'
    run('first-hand-production-preimage', "SELECT md5(prosrc) FROM pg_proc WHERE oid='%s'::regprocedure;" % signature, PRE)
    # The dependency shape the entry proof reads, on this lane's minimal fixture.
    run('first-hand-shape', """
      ALTER TABLE public.tournaments ADD COLUMN IF NOT EXISTS starting_chips integer;
      ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS rebuys integer DEFAULT 0;
      ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS add_on boolean DEFAULT false;
      ALTER TABLE public.tournament_players ADD COLUMN IF NOT EXISTS eliminated_at timestamptz;
      CREATE TABLE IF NOT EXISTS public.tournament_participant_funding_receipts(tournament_id uuid,operation text);
      CREATE TABLE IF NOT EXISTS public.table_hole_cards(table_id uuid,hand_number bigint,user_id uuid,seat_number integer);
    """)
    run('first-hand-seed', """
      SET session_replication_role=replica;
      INSERT INTO tournaments(id,status,format_contract,table_size,current_players,starting_chips)
        VALUES(md5('first-hand')::uuid,'RUNNING','spin-v1',3,3,1000);
      INSERT INTO engine_tournament_leases VALUES(md5('first-hand')::uuid,'first-hand-current','fixed',now(),now(),md5('first-hand-gen')::uuid,2);
      INSERT INTO tables(id,tournament_id,status,max_players) VALUES(md5('first-hand-table')::uuid,md5('first-hand')::uuid,'waiting',3);
      INSERT INTO table_seats(id,table_id,user_id,seat_number,stack,occupancy_id,joined_at)
        SELECT md5('first-hand-seat'||j)::uuid,md5('first-hand-table')::uuid,md5('first-hand-user'||j)::uuid,j,1000,
               md5('first-hand-occupancy'||j)::uuid,'2026-09-18 05:52:00+00'::timestamptz+j*interval '1 second' FROM generate_series(1,3) j;
      INSERT INTO tournament_players(id,tournament_id,table_id,user_id,seat_number,chips,status)
        SELECT md5('first-hand-registration'||j)::uuid,md5('first-hand')::uuid,md5('first-hand-table')::uuid,md5('first-hand-user'||j)::uuid,j,1000,'playing'
        FROM generate_series(1,3) j;
      INSERT INTO tournament_participant_funding_receipts(tournament_id,operation) SELECT md5('first-hand')::uuid,'entry' FROM generate_series(1,3);
      INSERT INTO smarter_private.f06_operations(break_id,tournament_id,source_table_id,lifecycle,boundary_id,origin_generation,custody_id,custody_generation,revision)
        SELECT md5('first-hand-park')::uuid,tournament_id,id,f06_lifecycle,md5('first-hand-boundary')::uuid,
               md5('first-hand-gen')::uuid,md5('first-hand-park-custody')::uuid,md5('first-hand-gen')::uuid,1
          FROM tables WHERE id=md5('first-hand-table')::uuid;
      INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id)
        SELECT md5('first-hand-permit')::uuid,tournament_id,id,f06_lifecycle,12402064,md5('first-hand-custody')::uuid,
               md5('first-hand-gen')::uuid,'never_started',md5('first-hand-park-custody')::uuid FROM tables WHERE id=md5('first-hand-table')::uuid;
      SET session_replication_role=origin;
    """)
    auth = ("SET request.jwt.claims='{\"role\":\"service_role\"}'; SET app.smarter_data_actor='tournament-manager';"
            " DO $$BEGIN PERFORM set_config('app.smarter_tournament_id',md5('first-hand')::uuid::text,false);"
            " PERFORM set_config('app.smarter_tournament_lease_generation',md5('first-hand-gen')::uuid::text,false); END $$;")
    args = ("md5('first-hand')::uuid,md5('first-hand-gen')::uuid,md5('first-hand-table')::uuid,"
            "(SELECT f06_lifecycle FROM tables WHERE id=md5('first-hand-table')::uuid),md5('first-hand-park')::uuid,md5('first-hand-park-custody')::uuid,1")
    call = 'SELECT fn_f06_continue_no_start_last_table(' + args + ');'
    witness = """SELECT jsonb_build_object(
      'seats',(SELECT jsonb_agg(s ORDER BY id) FROM table_seats s WHERE table_id=md5('first-hand-table')::uuid),
      'roster',(SELECT jsonb_agg(p ORDER BY id) FROM tournament_players p WHERE tournament_id=md5('first-hand')::uuid),
      'permits',(SELECT jsonb_agg(h ORDER BY permit_id) FROM smarter_private.f06_hand_permits h WHERE table_id=md5('first-hand-table')::uuid),
      'leases',(SELECT jsonb_agg(l) FROM engine_tournament_leases l WHERE tournament_id=md5('first-hand')::uuid),
      'ledger',(SELECT jsonb_agg(f ORDER BY id) FROM fixture_ledger f));"""
    before = run('first-hand-witness-before', witness)
    # Red: the production image refuses a table that never dealt.
    probe('first-hand-refused-on-production-image', auth + call, error='F06_CONTINUATION_PRIOR_COMMIT_REQUIRED')
    # The installer refuses a drifted pre-image and leaves nothing behind.
    body = migration.replace('\nBEGIN;\n', '\n', 1).removesuffix('COMMIT;\n')
    probe('first-hand-install-refuses-drift',
          'GRANT EXECUTE ON FUNCTION ' + signature + ' TO authenticated;' + body,
          error='F06_FIRST_HAND_CONTINUATION_PREIMAGE_DRIFT')
    run('first-hand-install', migration)
    require(run('first-hand-install-no-effect', witness) == before, 'Installation changed chips, seats, permits or leases')
    # Green: the exact entries continue, and nothing but the park and its receipt moves.
    result = json.loads(probe('first-hand-continues', auth + call))
    require(result['state'] == 'continued_never_started' and result['credit'] == 0, 'Incorrect first-hand continuation outcome')
    probe('first-hand-receipt-names-the-entries', auth + "DO $c$ BEGIN PERFORM fn_f06_continue_no_start_last_table(" + args + "); END $c$;"
          " SELECT prior_committed->>'first_hand' || ':' || (prior_committed->>'starting_chips') || ':' || (prior_committed->>'players')"
          " FROM smarter_private.f06_no_start_continuations WHERE break_id=md5('first-hand-park')::uuid;", 'true:1000:3')
    probe('first-hand-park-withdrawn', auth + "DO $c$ BEGIN PERFORM fn_f06_continue_no_start_last_table(" + args + "); END $c$;"
          " SELECT state FROM smarter_private.f06_operations WHERE break_id=md5('first-hand-park')::uuid;", 'withdrawn_before_manifest')
    replica = 'SET LOCAL session_replication_role=replica;'
    origin = 'SET LOCAL session_replication_role=origin;'
    for label, mutation, error in [
        ('chair-over-entry', "UPDATE table_seats SET stack=1001 WHERE id=md5('first-hand-seat1')::uuid; UPDATE tournament_players SET chips=1001 WHERE id=md5('first-hand-registration1')::uuid;", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('chair-under-entry', "UPDATE table_seats SET stack=999 WHERE id=md5('first-hand-seat1')::uuid; UPDATE tournament_players SET chips=999 WHERE id=md5('first-hand-registration1')::uuid;", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('rebuy', "UPDATE tournament_players SET rebuys=1 WHERE id=md5('first-hand-registration2')::uuid;", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('add-on', "UPDATE tournament_players SET add_on=true WHERE id=md5('first-hand-registration2')::uuid;", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('purchase-receipt', "INSERT INTO tournament_participant_funding_receipts VALUES(md5('first-hand')::uuid,'addon');", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('unseated-entrant', "INSERT INTO tournament_players(id,tournament_id,table_id,user_id,seat_number,chips,status) VALUES(md5('first-hand-registration4')::uuid,md5('first-hand')::uuid,NULL,md5('first-hand-user4')::uuid,NULL,0,'eliminated');", 'F06_CONTINUATION_FIRST_HAND_STACK_CHANGED'),
        ('no-entry-rate', "UPDATE tournaments SET starting_chips=NULL WHERE id=md5('first-hand')::uuid;", 'F06_CONTINUATION_FIRST_HAND_ENTRY_UNPROVEN'),
        ('history-without-commit', "INSERT INTO hand_history(table_id,hand_number) VALUES(md5('first-hand-table')::uuid,12402063);", 'F06_CONTINUATION_FIRST_HAND_DEALT'),
        ('completed-snapshot', "INSERT INTO hand_state_snapshots(table_id,hand_number,is_complete) VALUES(md5('first-hand-table')::uuid,12402063,true);", 'F06_CONTINUATION_FIRST_HAND_DEALT'),
        ('earlier-permit', "INSERT INTO smarter_private.f06_hand_permits(permit_id,tournament_id,table_id,lifecycle,hand_number,custody_id,generation,state,evidence_id) SELECT gen_random_uuid(),tournament_id,table_id,lifecycle,hand_number-1,gen_random_uuid(),generation,'never_started',gen_random_uuid() FROM smarter_private.f06_hand_permits WHERE permit_id=md5('first-hand-permit')::uuid;", 'F06_CONTINUATION_FIRST_HAND_DEALT'),
    ]:
        probe('first-hand-refuses-' + label, auth + replica + mutation + origin + call, error=error)
    require(run('first-hand-witness-after-refusals', witness) == before, 'A refusal changed protected state')
    run('first-hand-helper-private', "SELECT NOT has_function_privilege('service_role','smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','smarter_private.f06_no_start_first_hand_stacks(uuid,jsonb)','EXECUTE');", 't')
    run('first-hand-rpc-acl', "SELECT has_function_privilege('service_role','%s','EXECUTE') AND NOT has_function_privilege('anon','%s','EXECUTE') AND NOT has_function_privilege('authenticated','%s','EXECUTE');" % (signature, signature, signature), 't')
    results['firstHandContinuation'] = {'passed': True, 'preimage': PRE,
                                        'scope': 'never-dealt last table continues from its entries; every other image refuses; no money, seat, permit or lease mutation'}
