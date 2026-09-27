-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260815071041 "repair_late_night_grind_wrong_winner_and_unpaid_pos2"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e9ce4840e80cef93cadc008fe07f0431 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- LIVE E2E TOURNAMENT REPAIR 2026-08-15 — "Late Night Grind (PLO4)" 7ddd516f
-- The tournament stalled with sophie (14,632 chips) and nancy (5,367) stranded
-- seatless; a force-complete at 06:48 then promoted tatiana — already
-- eliminated in 3rd at 01:31 and paid 9.00 — to "winner" and paid her the
-- 20.00 first prize. Correct per the engine's own larger-stack-finishes-higher
-- rule: sophie 1st (20.00), nancy 2nd (12.50), tatiana back to 3rd (9.00,
-- already paid). All three are horses. Net payout after repair = 50.00 = pool.
DO $$
DECLARE
  v_state RECORD;
  v_sum numeric;
BEGIN
  -- Guard: only run against the exact broken state audited.
  SELECT
    (SELECT status FROM tournament_players WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='a9fbbefc-e39c-41c5-afdc-251f7eb76b4f') AS tatiana_status,
    (SELECT status FROM tournament_players WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='1c33a761-7cc3-4a86-8176-7df20ed53977') AS sophie_status,
    (SELECT status FROM tournament_players WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='9dc5344d-403b-4fe1-951f-66b091d52e85') AS nancy_status
  INTO v_state;
  IF v_state.tatiana_status <> 'winner' OR v_state.sophie_status <> 'playing' OR v_state.nancy_status <> 'playing' THEN
    RAISE EXCEPTION 'state changed since audit (tatiana=%, sophie=%, nancy=%) — aborting', v_state.tatiana_status, v_state.sophie_status, v_state.nancy_status;
  END IF;

  -- 1. Wallet corrections (idempotent by key).
  PERFORM atomic_credit_wallet_and_log(
    '1c33a761-7cc3-4a86-8176-7df20ed53977'::uuid, 20.00, 'prize',
    'Tournament winner prize: 1st place (repair 2026-08-15: stranded heads-up, wrong winner recorded)',
    NULL, NULL, '7ddd516f-e42d-46de-839b-d84a50004d14'::uuid,
    'tourney:7ddd516f-e42d-46de-839b-d84a50004d14:prize:1c33a761-7cc3-4a86-8176-7df20ed53977:1');
  PERFORM atomic_credit_wallet_and_log(
    '9dc5344d-403b-4fe1-951f-66b091d52e85'::uuid, 12.50, 'prize',
    'Tournament prize: position 2 (repair 2026-08-15: never paid after stall)',
    NULL, NULL, '7ddd516f-e42d-46de-839b-d84a50004d14'::uuid,
    'tourney:7ddd516f-e42d-46de-839b-d84a50004d14:prize:9dc5344d-403b-4fe1-951f-66b091d52e85:2');
  PERFORM atomic_credit_wallet_and_log(
    'a9fbbefc-e39c-41c5-afdc-251f7eb76b4f'::uuid, -20.00, 'prize_reversal',
    'Reversal of incorrect 1st-place prize (repair 2026-08-15: player finished 3rd, already paid 9.00)',
    NULL, NULL, '7ddd516f-e42d-46de-839b-d84a50004d14'::uuid,
    'tourney:7ddd516f-e42d-46de-839b-d84a50004d14:clawback:a9fbbefc-e39c-41c5-afdc-251f7eb76b4f:1');

  -- 2. Mirror into wallet_transactions (the tournament prize ledger).
  INSERT INTO wallet_transactions (user_id, wallet_type, amount, type, category, description, related_entity_id)
  VALUES
    ('1c33a761-7cc3-4a86-8176-7df20ed53977', 'PLAYER', 20.00, 'credit', 'prize',
     'Tournament winner prize: 1st place (repair 2026-08-15)', '7ddd516f-e42d-46de-839b-d84a50004d14'),
    ('9dc5344d-403b-4fe1-951f-66b091d52e85', 'PLAYER', 12.50, 'credit', 'prize',
     'Tournament prize: position 2 (repair 2026-08-15)', '7ddd516f-e42d-46de-839b-d84a50004d14'),
    ('a9fbbefc-e39c-41c5-afdc-251f7eb76b4f', 'PLAYER', -20.00, 'debit', 'prize',
     'Reversal of incorrect 1st-place prize (repair 2026-08-15)', '7ddd516f-e42d-46de-839b-d84a50004d14');

  -- 3. Correct the standings.
  UPDATE tournament_players SET status='winner', position=1, prize=20.00, eliminated_at=now()
    WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='1c33a761-7cc3-4a86-8176-7df20ed53977';
  UPDATE tournament_players SET status='eliminated', position=2, prize=12.50, eliminated_at=now()
    WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='9dc5344d-403b-4fe1-951f-66b091d52e85';
  UPDATE tournament_players SET status='eliminated', position=3, prize=9.00
    WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND user_id='a9fbbefc-e39c-41c5-afdc-251f7eb76b4f';

  -- 4. Conservation assertions.
  SELECT COALESCE(sum(amount),0) INTO v_sum FROM wallet_transactions
    WHERE related_entity_id='7ddd516f-e42d-46de-839b-d84a50004d14';
  IF v_sum <> 50.00 THEN
    RAISE EXCEPTION 'CONSERVATION FAILED: wallet ledger sums to % (expected 50.00)', v_sum;
  END IF;
  SELECT COALESCE(sum(prize),0) INTO v_sum FROM tournament_players
    WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14';
  IF v_sum <> 50.00 THEN
    RAISE EXCEPTION 'CONSERVATION FAILED: recorded prizes sum to % (expected 50.00)', v_sum;
  END IF;
  IF EXISTS (SELECT 1 FROM tournament_players
    WHERE tournament_id='7ddd516f-e42d-46de-839b-d84a50004d14' AND status='playing') THEN
    RAISE EXCEPTION 'REPAIR INCOMPLETE: players still marked playing';
  END IF;
END $$;
