\set ON_ERROR_STOP on
-- Read the real restored relations independently of the seed JSON.
-- This proves input consistency only, never a payout, historical event or closure.
BEGIN READ ONLY;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
SET LOCAL timezone='UTC';
DO $check$
DECLARE tid uuid:='10000000-0000-4000-8000-000000000001';
        tab uuid:='20000000-0000-4000-8000-000000000001';
        winner uuid:='00000000-0000-4000-8000-000000000003';
        snapshot jsonb; shape jsonb;
BEGIN
 IF session_user<>'fixture_bootstrap' OR current_user<>'postgres'
    OR current_database()<>'qual_spin_expiry_'||replace(current_setting('spin_mixed_qualification.execution_uuid')::uuid::text,'-','')
    OR inet_server_addr() IS NOT NULL OR current_setting('listen_addresses')<>''
    OR current_setting('session_replication_role')<>'origin'
    OR NOT EXISTS(SELECT 1 FROM pg_trigger WHERE NOT tgisinternal)
    OR (SELECT count(*) FROM public.tournaments)<>1
    OR (SELECT count(*) FROM public.tournament_players)<>3
    OR (SELECT sum(chip_balance) FROM public.club_members) IS DISTINCT FROM 270::numeric
    OR (SELECT sum(balance) FROM public.spin_bonus_pools) IS DISTINCT FROM 10::numeric
    OR (SELECT sum(prize_balance) FROM public.tournament_escrow) IS DISTINCT FROM 20::numeric
    OR (SELECT sum(bounty_balance+fee_balance) FROM public.tournament_escrow) IS DISTINCT FROM 0::numeric
    OR (SELECT sum(chips) FROM public.tournament_players) IS DISTINCT FROM 300::bigint
    OR (SELECT count(*) FROM public.table_seats WHERE left_at IS NULL)<>1
    OR (SELECT user_id FROM public.table_seats WHERE left_at IS NULL) IS DISTINCT FROM winner
    OR (SELECT stack FROM public.table_seats WHERE left_at IS NULL) IS DISTINCT FROM 300::numeric
    OR (SELECT count(*) FROM public.chip_ledger)<>5
    OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='tournament_buyin') IS DISTINCT FROM 30::numeric
    OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='spin_entry') IS DISTINCT FROM 30::numeric
    OR (SELECT sum(amount) FROM public.chip_ledger WHERE category='spin_prize') IS DISTINCT FROM 20::numeric
    OR (SELECT count(*) FROM public.wallet_transactions)<>3
    OR (SELECT count(*) FROM public.tournament_refund_entitlements)<>3
    OR (SELECT count(*) FROM public.tournament_entry_close_receipts)<>1
    OR EXISTS(SELECT 1 FROM public.tournament_payouts)
    OR EXISTS(SELECT 1 FROM public.tournament_obligations)
    OR EXISTS(SELECT 1 FROM public.tournament_terminal_settlements)
    OR to_regclass('public.ca_spin_mixed_basis_v1') IS NOT NULL
    OR to_regclass('public.ca_spin_mixed_completion_v1') IS NOT NULL THEN
   RAISE EXCEPTION 'synthetic restored input estate mismatch or output preseeded';
 END IF;
 SELECT jsonb_build_object('version',1,'tournament',to_jsonb(t),'observed_winner_id',winner,
   'tables',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.tables r WHERE tournament_id=tid),
   'roster',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.tournament_players r WHERE tournament_id=tid),
   'receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY completed_at,hand_id) FROM public.settlement_idempotency_keys r WHERE table_id=tab),
   'histories',(SELECT jsonb_agg(to_jsonb(r) ORDER BY hand_number,id) FROM public.hand_history r WHERE table_id=tab),
   'commits',(SELECT jsonb_agg(to_jsonb(r) ORDER BY hand_number) FROM public.hand_atomic_commits r WHERE table_id=tab),
   'knockouts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.tournament_knockout_candidates r WHERE tournament_id=tid))
 INTO snapshot FROM public.tournaments t WHERE id=tid;
 shape:=public.fn_ca_spin_mixed_history_shape_v1(snapshot);
 IF shape->'shape_ok' IS DISTINCT FROM 'true'::jsonb
    OR shape->'payment_authority' IS DISTINCT FROM 'false'::jsonb
    OR shape->'historical_immutability_proven' IS DISTINCT FROM 'false'::jsonb THEN
   RAISE EXCEPTION 'synthetic relational model reader rejected: %',shape;
 END IF;
END $check$;
SELECT jsonb_build_object('synthetic_relational_input_consistent',true,'total_cash_chips',300,
 'wallets',270,'reserve',10,'prize_escrow',20,'history_reader_passed',true,
 'business_execution_qualified',false,'historical_qualification',false,'incident_closed',false);
COMMIT;
