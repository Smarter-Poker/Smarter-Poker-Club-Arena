-- Synthetic original rebuy generations; all counterfactual mutations roll back.

-- missing-purchase
BEGIN;SET LOCAL session_replication_role=replica;DELETE FROM entry_purchase_idempotency_receipts;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- foreign-chair
BEGIN;SET LOCAL session_replication_role=replica;UPDATE entry_purchase_idempotency_receipts SET response=jsonb_set(response,'{seat_id}',to_jsonb(md5('foreign')::uuid::text));SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- wrong-table
BEGIN;SET LOCAL session_replication_role=replica;UPDATE entry_purchase_idempotency_receipts SET response=jsonb_set(response,'{table_id}',to_jsonb(md5('foreign')::uuid::text));SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- wrong-grant
BEGIN;SET LOCAL session_replication_role=replica;UPDATE entry_purchase_idempotency_receipts SET response=jsonb_set(response,'{chips_added}','2999');SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- unpaid-result
BEGIN;SET LOCAL session_replication_role=replica;UPDATE entry_purchase_idempotency_receipts SET completed_at=NULL;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- wrong-stack
BEGIN;SET LOCAL session_replication_role=replica;UPDATE table_seats SET stack=3001;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- different-generation
BEGIN;SET LOCAL session_replication_role=replica;UPDATE table_seats SET joined_at=joined_at-interval '1 minute';SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- unsettled-original
BEGIN;SET LOCAL session_replication_role=replica;UPDATE hand_atomic_commits SET post_commit_completed_at=NULL;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- foreign-old-seat
BEGIN;SET LOCAL session_replication_role=replica;UPDATE tournament_knockout_candidates SET seat_id=md5('foreign')::uuid;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- roster-moved
BEGIN;SET LOCAL session_replication_role=replica;UPDATE tournament_players SET seat_number=9;SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN'; END $q$;RESET ROLE;ROLLBACK;

-- begun
BEGIN;SET LOCAL session_replication_role=replica;UPDATE smarter_private.f06_operations SET state='begun';SET LOCAL session_replication_role=origin;SET ROLE postgres;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_PRIOR_INCOMPLETE' THEN RAISE; END IF; RAISE NOTICE 'EXPECTED:F06_MOVEMENT_PRIOR_INCOMPLETE'; END $q$;RESET ROLE;ROLLBACK;

-- acl-anon
SET ROLE anon;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67');RAISE EXCEPTION 'UNEXPECTED_ACCEPT';EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'EXPECTED_ACL_REFUSAL'; END $q$;RESET ROLE;

-- acl-authenticated
SET ROLE authenticated;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67');RAISE EXCEPTION 'UNEXPECTED_ACCEPT';EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'EXPECTED_ACL_REFUSAL'; END $q$;RESET ROLE;

-- acl-service_role
SET ROLE service_role;DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67');RAISE EXCEPTION 'UNEXPECTED_ACCEPT';EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'EXPECTED_ACL_REFUSAL'; END $q$;RESET ROLE;

-- missing-diamond-ledger
BEGIN; DELETE FROM poker_diamond_tournament_ledger; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- missing-custody-movement
BEGIN; DELETE FROM poker_diamond_movements; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- foreign-custody
BEGIN; UPDATE poker_diamond_custody SET user_id=md5('foreign')::uuid; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- foreign-journal
BEGIN; UPDATE poker_diamond_movements SET wallet_journal_id=md5('foreign')::uuid; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- unfunded-amount
BEGIN; UPDATE poker_diamond_movements SET amount=amount+1; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- false-funding-receipt
BEGIN; UPDATE tournament_participant_funding_receipts SET custody_result=jsonb_set(custody_result,'{success}','false'); DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- unsupported-asset
BEGIN; UPDATE tournament_participant_funding_receipts SET asset='unknown'; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- released-custody
BEGIN; UPDATE poker_diamond_custody SET state='released'; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- foreign-source-account
BEGIN; UPDATE poker_diamond_movements SET source_account='player:foreign'; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

-- missing-request-id
BEGIN; UPDATE tournament_participant_funding_receipts SET custody_result=custody_result-'request_id'; DO $q$ BEGIN PERFORM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); RAISE EXCEPTION 'UNEXPECTED_ACCEPT'; EXCEPTION WHEN SQLSTATE '55000' THEN IF SQLERRM<>'F06_MOVEMENT_NEVER_DEALT_ENTRY_UNPROVEN' THEN RAISE; END IF; END $q$; ROLLBACK;

DO $q$ DECLARE r jsonb;s text; BEGIN SELECT md5(jsonb_agg(x ORDER BY x.id)::text) INTO s FROM public.table_seats x; r:=smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67'); IF jsonb_array_length(r->'roster')<>2 OR (r->>'first_hand')::boolean IS DISTINCT FROM true OR r->'permits'<>'[]'::jsonb OR (SELECT md5(jsonb_agg(x ORDER BY x.id)::text) FROM public.table_seats x) IS DISTINCT FROM s THEN RAISE EXCEPTION 'POSITIVE_BAD'; END IF; IF (SELECT count(*) FROM jsonb_array_elements(r->'receipts'->'entries') x WHERE x->>'operation'='rebuy' AND x ? 'atomic_purchase' AND x->>'chips'='3000')<>2 THEN RAISE EXCEPTION 'REBUY_PROOF_BAD'; END IF; IF r IS DISTINCT FROM smarter_private.f06_movement_never_dealt_prior('94d9ee21-a872-53ec-bd8c-f23ad8d43378','4bd1908d-72be-5ec7-b59f-72abbe32c589','96fd2136-9f08-548b-8c71-a4df7cb19e67') THEN RAISE EXCEPTION 'DUPLICATE_READ_CHANGED'; END IF; RAISE NOTICE 'POSITIVE_TWO_REBUYS_NO_WRITES'; END $q$;


SELECT 'NEVER_DEALT_DIAMOND_NATIVE_PASS';
