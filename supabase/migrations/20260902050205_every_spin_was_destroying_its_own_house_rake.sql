-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902050205; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- THE LEAK, proved on six completed spins in the last six hours.
--
-- "100 Chip Spin NLH": three players were debited 100.00 each, so 300.00 left
-- player wallets. 276.00 entered the spin reserve as the contribution. The
-- winner was paid 200.00 out of the reserve. Reserve net +76.00 plus the
-- winner's 200.00 accounts for 276.00 of the 300.00.
--
--   The missing 24.00 is EXACTLY house_rake. It was taken from the players
--   and credited to nobody.
--
-- The same holds for every row checked: 0.48 on a 2-chip spin, 4.80 on a
-- 20-chip, 12.00 on a 50-chip, 0.72, 2.40. And tournaments.total_rake reads
-- 0.0000 on all of them, so not even the tournament row remembers it.
--
-- fn_spin_book_entry computes v_rake, subtracts it from the reserve
-- contribution, and writes a rake_records row for it - and then never moves
-- the chips anywhere. rake_records is an accounting record, not a balance. In
-- the last six hours club treasuries received rake from table_stack on 4,486
-- cash hands and from spins: nothing.
--
-- TWO defects in one, and this is the second time tonight the same shape has
-- appeared (the overlay back-payment wrote no tournament_payouts row):
--   * SUPPLY: chips are destroyed on every spin, roughly 3,195/day at current
--     volume, which is a real component of the unexplained supply drift.
--   * REVENUE: the house earns nothing on spins, so every downstream earner
--     keyed off treasury rake - club share, union share, agent commission,
--     VIP points, rakeback - has been paid zero for spin play. Under the
--     horses-are-players law that shorts everybody equally.
--
-- FIX: credit the club treasury in the same transaction that books the entry,
-- declared so the auto-journal records rake against prize_liability rather
-- than filing it to suspense.
--
-- tournaments.total_rake is deliberately NOT set. fn_ca_supply_snapshot counts
-- total_rake inside tournament_liability for open events, so setting it AND
-- crediting the treasury would double-count the same chips until the event
-- completed. The cash path credits the treasury immediately; spins now match.
--
-- NOT BACKFILLED. The historical rake was destroyed, not misplaced, so
-- restoring it would MINT chips rather than move them. Dan's standing ruling
-- is that the chips are not the concern and the leak is. The forward fix stops
-- it; the historical total stands in the record.

CREATE OR REPLACE FUNCTION public.fn_spin_book_entry(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_t         record;
  v_owner     uuid;
  v_seats     integer;
  v_collected numeric;
  v_rake      numeric;
  v_reserve_in numeric;
  v_balance   numeric;
BEGIN
  SELECT t.id, t.club_id, t.buy_in_amount, t.max_players, t.variant
    INTO v_t
    FROM public.tournaments t
   WHERE t.id = p_tournament_id;

  IF NOT FOUND OR COALESCE(v_t.variant,'') <> 'spin' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_a_spin');
  END IF;
  IF v_t.club_id IS NULL OR COALESCE(v_t.buy_in_amount, 0) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'invalid_inputs');
  END IF;

  -- Cheap read, no locks taken: most calls stop here.
  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  -- THE LOCK COMES FIRST. fn_spin_reserve_pool upserts the pool row, so
  -- resolving the owner before locking made this path take the row lock and
  -- then wait for the advisory lock, while a concurrent booking held the
  -- advisory lock and waited for the row. Advisory-then-row everywhere means
  -- no cycle can form.
  PERFORM pg_advisory_xact_lock(hashtextextended('spin_entry:' || p_tournament_id::text, 0));

  IF EXISTS (SELECT 1 FROM public.spin_reserve_ledger
              WHERE tournament_id = p_tournament_id AND kind = 'contribution') THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'already_booked');
  END IF;

  v_owner := public.fn_spin_reserve_pool(v_t.club_id);
  IF v_owner IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_reserve_owner');
  END IF;

  v_seats      := GREATEST(COALESCE(v_t.max_players, 3), 1);
  v_collected  := round(v_t.buy_in_amount * v_seats, 2);
  v_rake       := round(v_collected * public.fn_spin_rake_rate(v_t.buy_in_amount), 2);
  v_reserve_in := round(v_collected - v_rake, 2);

  PERFORM set_config('app.ledger_category', 'spin_entry', true);
  PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
  PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

  UPDATE public.spin_bonus_pools
     SET balance         = balance + v_reserve_in,
         total_deposited = total_deposited + v_reserve_in,
         spin_count      = spin_count + 1,
         highest_stake   = GREATEST(highest_stake, v_t.buy_in_amount),
         updated_at      = now()
   WHERE club_id = v_owner
   RETURNING balance INTO v_balance;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_pool_row', 'owner_id', v_owner);
  END IF;

  INSERT INTO public.spin_reserve_ledger
    (club_id, tournament_id, kind, amount, balance_after, multiplier, buy_in, seats, house_rake, note)
  VALUES (v_owner, p_tournament_id, 'contribution', v_reserve_in, v_balance,
          NULL, v_t.buy_in_amount, v_seats, v_rake,
          CASE WHEN v_owner = v_t.club_id
               THEN 'buy-ins less fixed rake, booked when the last seat was paid'
               ELSE format('buy-ins less fixed rake, booked when the last seat was paid (club %s)', v_t.club_id)
          END);

  IF v_rake > 0 THEN
    -- THE CHIPS, not just the paperwork. Without this the rake is subtracted
    -- from the contribution above and lands nowhere, which destroyed it on
    -- every spin this platform has ever run.
    PERFORM set_config('app.ledger_category', 'rake', true);
    PERFORM set_config('app.ledger_counterparty', 'prize_liability', true);
    PERFORM set_config('app.ledger_counterparty_entity', p_tournament_id::text, true);

    UPDATE public.clubs
       SET chip_treasury = COALESCE(chip_treasury, 0) + v_rake
     WHERE id = v_t.club_id;

    PERFORM set_config('app.ledger_category', '', true);
    PERFORM set_config('app.ledger_counterparty', '', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);

    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_rake, v_collected, v_seats, 0, true,
            p_tournament_id, 'fn_spin_book_entry',
            jsonb_build_object('kind','spin_rake','buy_in',v_t.buy_in_amount,
                               'rake_rate', public.fn_spin_rake_rate(v_t.buy_in_amount),
                               'booked_at','entry','reserve_owner',v_owner,
                               'treasury_credited', true));
  END IF;

  PERFORM set_config('app.ledger_category', '', true);
  PERFORM set_config('app.ledger_counterparty', '', true);

  RETURN jsonb_build_object('ok', true, 'collected', v_collected,
    'house_rake', v_rake, 'reserve_in', v_reserve_in,
    'balance', v_balance, 'owner_id', v_owner, 'seats', v_seats,
    'treasury_credited', v_rake > 0);
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_spin_book_entry(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_spin_book_entry(uuid) TO service_role;

