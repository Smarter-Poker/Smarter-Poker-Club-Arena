-- ===========================================================================
--  A SATELLITE SEAT IS PAID FROM THE SATELLITE'S OWN POOL
-- ===========================================================================
--
-- Chip Accounting Standard, section 3.2 (MTT step 9), Lane G. Measured on
-- production 2026-09-02, SELECT-only, over the last 14 days:
--
--   * 28 satellites completed, 23 seats awarded, all into one target
--     (dfae9288, Sunday $200 Deep Stack, buy-in 180 + fee 20).
--   * Every seat did `target.prize_pool += 180` and `target.total_rake += 20`
--     with no chips debited from anyone: 4,140 prize + 460 rake = 4,600 chips
--     appeared in the target that no wallet and no pool had paid.
--   * The satellite's own `prize_pool` was never reduced. The eleven
--     satellites that awarded those seats collected 3,217.50 between them,
--     paid out 4,600 in seats plus 2,200 in cash, and every one of them still
--     carries its full collected pool in `prize_pool`. The 3,582.50 gap is
--     covered only by hand-written tournament_conservation_baseline rows
--     ("acknowledged pre-funding minting") so the audit would stop shouting.
--
-- The counters are all this database has today (tournament_escrow is Lane B
-- and does not exist yet), so this is the counter-level version of the rule:
--
--   WHEN a seat is genuinely inserted, the seat's value (target buy_in + fee)
--   MOVES from the satellite's prize_pool to the target's prize_pool and
--   total_rake, and one chip_ledger row says so:
--     prize_liability(satellite) -> prize_liability(target), category
--     tournament_buyin, keyed tourney:<sat>:seat:<user>:pool_transfer.
--
-- Money in = seats out + cash out then holds on the satellite, and the
-- target's pool is backed by chips that were collected.
--
-- WHAT THIS DOES NOT DO (Dan's risk rule, SWARM-BRIEF-R2 rule 13):
--
--   * It never REFUSES a seat. If the satellite pool cannot cover the seat
--     (a guaranteed seat count the field did not fund, e.g. 5 seats at 200
--     from a 108 pool), it moves what the pool holds, awards the seat exactly
--     as before, and files a WARNING financial_alert `satellite_seat_unbacked`
--     with the shortfall. That shortfall is a guarantee overlay nobody funded,
--     and naming it is the whole point.
--   * The transfer block is wrapped so that ANY failure in it (a lock, a
--     ledger constraint, a freeze) leaves the seat awarded and the target
--     credited exactly as today, and files ca_ledger_write_failures plus the
--     same warning. The seat is the payout; the bookkeeping must never
--     unseat a player.
--   * The engine reads the satellite's prize_pool ONCE before the award loop
--     (TournamentManager.processSatelliteAwards) and pays the remainder from
--     that snapshot; the recovery sweep never re-drives a satellite that has
--     already awarded. So reducing prize_pool as seats go out changes no
--     award and no remainder. fn_settle_tournament_obligation's R1-lite check
--     compares (cash paid + this pay) against the REDUCED pool, and cash paid
--     + remainder == pool - seats out, so it still passes to the cent.
--
-- fn_satellite_conservation_audit read `prize_pool` as "the collected pool";
-- it now adds back the ledgered seat transfers so a satellite that paid its
-- seats correctly does not show as `excess_disbursed`.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_award_satellite_seat(
  p_satellite_id uuid,
  p_target_id    uuid,
  p_user_id      uuid,
  p_username     text    DEFAULT NULL,
  p_position     integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_t        record;
  v_name     text;
  v_seat_id  uuid;
  v_cap      integer;
  v_existing uuid;
  v_seated   boolean;
  v_sat      record;
  v_field    integer;
  v_value    numeric;
  -- Lane G (2026-09-02): the seat is paid from the satellite's own pool.
  v_sat_pool numeric;
  v_moved    numeric := 0;
  v_short    numeric := 0;
  v_st       text;
  v_msg      text;
BEGIN
  SELECT id, name, club_id, status, buy_in_amount, buy_in_fee,
         max_players, current_players, current_level,
         late_reg_levels, rebuy_levels, prize_pool_finalized
    INTO v_t
    FROM public.tournaments
   WHERE id = p_target_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_not_found');
  END IF;

  -- Mirror of server/src/tournament/satelliteTargetOpen.ts, which is the
  -- authority the engine consults BEFORE calling this. The two must agree:
  -- ANNOUNCED/REGISTERING are open; RUNNING is open only inside late
  -- registration (late_reg_levels, falling back to rebuy_levels, both
  -- meaning "no late reg" when 0/NULL); everything else is closed.
  IF v_t.status IN ('ANNOUNCED', 'REGISTERING') THEN
    NULL; -- open
  ELSIF v_t.status = 'RUNNING' THEN
    v_cap := COALESCE(NULLIF(v_t.late_reg_levels, 0), NULLIF(v_t.rebuy_levels, 0), 0);
    IF v_cap <= 0 OR COALESCE(v_t.current_level, 0) >= v_cap THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
    END IF;
  ELSE
    RETURN jsonb_build_object('ok', false, 'reason', 'target_closed');
  END IF;

  -- A FINALIZED POOL IS A CLOSED DOOR (2026-08-31). fn_register_for_tournament
  -- refuses on this flag and isLateRegClosed() returns true on it regardless of
  -- level; it is the platform's single statement that the pool has stopped
  -- moving, and the payout ladder is sized against it. Adding a buy-in after it
  -- is set pays a ladder that was built without that buy-in.
  IF COALESCE(v_t.prize_pool_finalized, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_pool_finalized');
  END IF;

  IF v_t.max_players IS NOT NULL
     AND COALESCE(v_t.current_players, 0) >= v_t.max_players THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'target_full');
  END IF;

  SELECT COALESCE(NULLIF(p_username, ''),
                  NULLIF(display_name, ''), NULLIF(username, ''), 'Player')
    INTO v_name
    FROM public.profiles WHERE id = p_user_id;
  v_name := COALESCE(v_name, COALESCE(NULLIF(p_username, ''), 'Player'));

  BEGIN
    INSERT INTO public.tournament_players
      (tournament_id, user_id, username, chips, status,
       is_satellite_qualifier, source_satellite_id)
    VALUES (p_target_id, p_user_id, v_name, 0, 'registered', true, p_satellite_id)
    RETURNING id INTO v_seat_id;
  EXCEPTION WHEN unique_violation THEN
    -- Already seated. Move nothing - the pool was credited when the seat was
    -- first taken. But SAY WHO SEATED THEM: a re-drive of THIS satellite must
    -- stay silent, while a win in a DIFFERENT satellite deserves the ticket
    -- value in cash, and only the caller can pay it.
    --
    -- AND SAY WHEN YOU DO NOT KNOW. source_satellite_id has only been written
    -- since 2026-08-30; every seat awarded before that has it NULL. Collapsing
    -- NULL to FALSE answers "a different satellite seated them" and sends the
    -- caller down the branch that pays cash, on top of a seat this satellite
    -- may well have awarded. NULL means unknown, and the caller pays nothing.
    SELECT source_satellite_id INTO v_existing
      FROM public.tournament_players
     WHERE tournament_id = p_target_id AND user_id = p_user_id
     LIMIT 1;

    v_seated := CASE WHEN v_existing IS NULL THEN NULL
                     ELSE (v_existing = p_satellite_id) END;

    RETURN jsonb_build_object(
      'ok', true, 'awarded', false, 'reason', 'already_registered',
      'held_from_this_satellite', v_seated,
      'origin_unknown', (v_existing IS NULL));
  END;

  UPDATE public.tournaments
     SET current_players = COALESCE(current_players, 0) + 1,
         prize_pool      = COALESCE(prize_pool, 0) + COALESCE(v_t.buy_in_amount, 0),
         total_rake      = COALESCE(total_rake, 0) + COALESCE(v_t.buy_in_fee, 0)
   WHERE id = p_target_id;

  IF COALESCE(v_t.buy_in_fee, 0) > 0 AND v_t.club_id IS NOT NULL THEN
    INSERT INTO public.rake_records
      (hand_id, table_id, club_id, rake_amount, pot_size, num_players,
       bbj_contribution, is_tournament, tournament_id, source, metadata)
    VALUES (NULL, NULL, v_t.club_id, v_t.buy_in_fee,
            COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 1, 0,
            true, p_target_id, 'fn_award_satellite_seat',
            jsonb_build_object('kind', 'satellite_seat_entry_fee',
                               'user_id', p_user_id,
                               'satellite_id', p_satellite_id,
                               'registration_id', v_seat_id));
  END IF;

  v_value := round(COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0), 2);

  /* THE SEAT IS PAID FROM THE SATELLITE'S OWN POOL (Lane G, 2026-09-02).
     The target was just credited buy_in + fee. Until now nobody was debited,
     so the target owed prize money it never received and the satellite kept
     a pool it had already spent. Move the seat value out of the satellite's
     prize_pool, and write the one ledger row that says where it went.

     NEVER REFUSE, NEVER UNSEAT. A pool that cannot cover the seat (a
     guaranteed seat count the field did not fund) moves what it holds and
     files a WARNING with the shortfall; any failure inside this block leaves
     the award exactly as it was before this migration and files the same
     warning. The seat is the payout; the bookkeeping is not allowed to take
     it back. */
  BEGIN
    SELECT prize_pool INTO v_sat_pool
      FROM public.tournaments
     WHERE id = p_satellite_id
     FOR UPDATE;
    v_sat_pool := round(COALESCE(v_sat_pool, 0), 2);
    v_moved := LEAST(GREATEST(v_sat_pool, 0), v_value);
    v_short := round(v_value - v_moved, 2);

    IF v_moved > 0 THEN
      UPDATE public.tournaments
         SET prize_pool = round(COALESCE(prize_pool, 0) - v_moved, 2)
       WHERE id = p_satellite_id;

      INSERT INTO public.chip_ledger
        (performed_by, from_type, from_entity_id, from_label,
         to_type, to_entity_id, to_label,
         amount, category, club_id, tournament_id, idempotency_key,
         description, metadata,
         pre_from_balance, post_from_balance)
      VALUES
        (COALESCE(auth.uid(), '2d1cd6c3-5700-4af9-a271-d4863fdab20d'::uuid),
         'prize_liability', p_satellite_id, 'tournaments.prize_pool',
         'prize_liability', p_target_id, 'tournaments.prize_pool+total_rake',
         v_moved, 'tournament_buyin', v_t.club_id, p_satellite_id,
         'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text || ':pool_transfer',
         format('Satellite seat: %s paid from the satellite pool into %s (buy-in %s + fee %s) for the seat of %s',
                v_moved, COALESCE(v_t.name, p_target_id::text),
                COALESCE(v_t.buy_in_amount, 0), COALESCE(v_t.buy_in_fee, 0), p_user_id),
         jsonb_build_object('kind', 'satellite_seat_pool_transfer',
                            'satellite_id', p_satellite_id,
                            'satellite_target_id', p_target_id,
                            'user_id', p_user_id,
                            'registration_id', v_seat_id,
                            'seat_value', v_value,
                            'moved', v_moved,
                            'unbacked', v_short),
         v_sat_pool, round(v_sat_pool - v_moved, 2))
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
    END IF;

    IF v_short > 0 THEN
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'satellite_seat_unbacked',
        format('Satellite %s awarded a seat worth %s into %s but its pool held only %s: %s of that seat is a guarantee overlay nobody funded. The seat was awarded.',
               p_satellite_id, v_value, COALESCE(v_t.name, p_target_id::text), v_sat_pool, v_short),
        jsonb_build_object('kind', 'satellite_seat_unbacked',
                           'satellite_id', p_satellite_id,
                           'target_id', p_target_id,
                           'user_id', p_user_id,
                           'registration_id', v_seat_id,
                           'seat_value', v_value,
                           'satellite_pool_before', v_sat_pool,
                           'moved', v_moved,
                           'shortfall', v_short),
        'sat_unbacked:' || p_satellite_id::text || ':' || p_user_id::text);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_st = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    BEGIN
      INSERT INTO public.ca_ledger_write_failures (club_id, user_id, delta, sqlstate, message)
      VALUES (v_t.club_id, p_user_id, v_value, v_st,
              'fn_award_satellite_seat pool transfer (satellite ' || p_satellite_id::text
              || ' -> target ' || p_target_id::text || '): ' || v_msg);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    BEGIN
      PERFORM public.fn_raise_server_financial_alert(
        'warning', 'satellite_seat_unbacked',
        format('Satellite %s awarded a seat worth %s into %s but the pool transfer failed (%s %s). The seat was awarded; the satellite pool was not reduced.',
               p_satellite_id, v_value, COALESCE(v_t.name, p_target_id::text), v_st, v_msg),
        jsonb_build_object('kind', 'satellite_seat_transfer_failed',
                           'satellite_id', p_satellite_id,
                           'target_id', p_target_id,
                           'user_id', p_user_id,
                           'registration_id', v_seat_id,
                           'seat_value', v_value,
                           'sqlstate', v_st, 'sqlerrm', v_msg),
        'sat_unbacked:' || p_satellite_id::text || ':' || p_user_id::text);
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    v_moved := 0;
    v_short := v_value;
  END;

  /* THE SEAT IS THE PAYOUT. Same transaction, same row lock: the record
     exists if and only if the seat does. Keyed so a recovery re-drive that
     somehow reaches here writes nothing new. Failure to record must never
     unseat a player, so it is caught and raised as a money alert instead. */
  BEGIN
    SELECT tournament_type, prize_pool INTO v_sat
      FROM public.tournaments WHERE id = p_satellite_id;
    SELECT count(*) INTO v_field
      FROM public.tournament_players WHERE tournament_id = p_satellite_id;
    v_value := COALESCE(v_t.buy_in_amount, 0) + COALESCE(v_t.buy_in_fee, 0);

    INSERT INTO public.tournament_payouts
      (tournament_id, user_id, "position", amount, source, idempotency_key,
       paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
    VALUES
      (p_satellite_id, p_user_id, p_position, v_value, 'satellite_seat',
       'tourney:' || p_satellite_id::text || ':seat:' || p_user_id::text,
       now(), v_sat.tournament_type, v_field,
       -- The COLLECTED pool, as every earlier row recorded it: read before
       -- this seat's transfer reduced it.
       COALESCE(v_sat_pool, v_sat.prize_pool),
       'award_satellite_seat',
       jsonb_build_object('satellite_target_id', p_target_id,
                          'target_name', v_t.name,
                          'registration_id', v_seat_id,
                          'target_buy_in', COALESCE(v_t.buy_in_amount, 0),
                          'target_fee', COALESCE(v_t.buy_in_fee, 0),
                          'pool_transfer', v_moved,
                          'unbacked', v_short))
    ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO public.financial_alerts (severity, source, message, context)
    VALUES ('critical', 'satellite_seat_record',
            'A satellite seat was awarded but its payout record could not be written',
            jsonb_build_object('satellite_id', p_satellite_id,
                               'target_id', p_target_id,
                               'user_id', p_user_id,
                               'registration_id', v_seat_id,
                               'sqlstate', SQLSTATE,
                               'sqlerrm', SQLERRM));
  END;

  RETURN jsonb_build_object(
    'ok', true, 'awarded', true, 'registration_id', v_seat_id,
    'prize_contribution', COALESCE(v_t.buy_in_amount, 0),
    'rake', COALESCE(v_t.buy_in_fee, 0),
    'pool_transfer', v_moved,
    'unbacked', v_short);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) TO service_role;

COMMENT ON FUNCTION public.fn_award_satellite_seat(uuid, uuid, uuid, text, integer) IS
  'Seats a satellite winner in the target and moves the seat value (target buy_in + fee) from the satellite prize_pool to the target prize_pool/total_rake with one chip_ledger row (prize_liability -> prize_liability, tournament_buyin, keyed tourney:<sat>:seat:<user>:pool_transfer). Never refuses a seat: a pool that cannot cover it moves what it holds and files warning satellite_seat_unbacked. Idempotent: a second call for a seated player moves nothing and reports held_from_this_satellite.';

-- ---------------------------------------------------------------------------
-- The audit read prize_pool as "what the satellite collected". It now reads
-- prize_pool + the seat value it has ledgered out, which is the same number
-- for every satellite that completed before this migration (no ledger rows)
-- and the right number for every one after it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_satellite_conservation_audit(p_hours integer DEFAULT 24)
 RETURNS TABLE(satellite_id uuid, satellite_name text, pool numeric, ticket_cost numeric, awardable integer, seats_funded integer, cash_paid numeric, unpaid_winners integer, excess_disbursed numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
WITH sats AS (
  SELECT s.id, s.name,
         -- The collected pool: what is left in prize_pool plus every seat the
         -- satellite has already paid out of it (Lane G, 2026-09-02).
         round(s.prize_pool::numeric
               + COALESCE((SELECT sum(l.amount) FROM chip_ledger l
                            WHERE l.from_type = 'prize_liability'
                              AND l.from_entity_id = s.id
                              AND l.category = 'tournament_buyin'
                              AND l.idempotency_key LIKE 'tourney:' || s.id::text || ':seat:%:pool_transfer'), 0), 2) pool,
         COALESCE(s.satellite_seats, 0) g,
         round(COALESCE(t.buy_in_amount,0) + COALESCE(t.buy_in_fee,0), 2) ticket
    FROM tournaments s
    LEFT JOIN tournaments t ON t.id = s.satellite_target_id
   WHERE s.satellite_target_id IS NOT NULL
     AND s.status = 'COMPLETED'
     AND s.ended_at > now() - make_interval(hours => GREATEST(COALESCE(p_hours,24),1))
),
fin AS (
  SELECT tp.tournament_id, count(*) n
    FROM tournament_players tp JOIN sats ON sats.id = tp.tournament_id
   WHERE tp.position IS NOT NULL GROUP BY 1
),
seatrows AS (
  SELECT (r.metadata->>'satellite_id')::uuid sid, (r.metadata->>'user_id')::uuid uid
    FROM rake_records r
   WHERE r.source = 'fn_award_satellite_seat'
     AND (r.metadata->>'satellite_id')::uuid IN (SELECT id FROM sats)
),
cash AS (
  SELECT wt.related_entity_id sid, wt.user_id uid, sum(wt.amount) amt
    FROM wallet_transactions wt
   WHERE wt.related_entity_id IN (SELECT id FROM sats)
     AND wt.category = 'prize' AND wt.type = 'credit'
   GROUP BY 1, 2
),
ack AS (
  SELECT b.tournament_id sid, sum(b.amount) amt
    FROM tournament_conservation_baseline b
   WHERE b.tournament_id IN (SELECT id FROM sats) GROUP BY 1
),
calc AS (
  SELECT s.id, s.name, s.pool, s.ticket,
         LEAST(GREATEST(s.g, CASE WHEN s.ticket > 0 THEN floor(s.pool / s.ticket)::int ELSE 0 END),
               COALESCE(f.n, 0)) awardable,
         COALESCE((SELECT count(*) FROM seatrows sr WHERE sr.sid = s.id), 0)::int seats_funded,
         COALESCE((SELECT sum(c.amt) FROM cash c WHERE c.sid = s.id), 0) cash_paid,
         COALESCE((SELECT a.amt FROM ack a WHERE a.sid = s.id), 0) acknowledged
    FROM sats s LEFT JOIN fin f ON f.tournament_id = s.id
),
bal AS (
  SELECT c.*,
         round(c.cash_paid + c.seats_funded * c.ticket - (c.pool + c.acknowledged), 2) excess,
         round(c.pool + c.acknowledged - (c.cash_paid + c.seats_funded * c.ticket), 2) undisbursed
    FROM calc c
),
unpaid AS (
  SELECT b.id sid, count(*) n
    FROM bal b
    JOIN tournament_players tp ON tp.tournament_id = b.id
   WHERE tp.position IS NOT NULL AND tp.position <= b.awardable
     AND NOT EXISTS (SELECT 1 FROM seatrows sr WHERE sr.sid = b.id AND sr.uid = tp.user_id)
     AND COALESCE((SELECT ca.amt FROM cash ca WHERE ca.sid = b.id AND ca.uid = tp.user_id), 0) = 0
   GROUP BY 1
)
SELECT b.id, b.name, b.pool, b.ticket, b.awardable, b.seats_funded, b.cash_paid,
       COALESCE(u.n, 0)::int, GREATEST(b.excess, 0)
  FROM bal b LEFT JOIN unpaid u ON u.sid = b.id
 WHERE b.excess > 0.005 OR b.undisbursed > 0.005;
$$;

REVOKE ALL ON FUNCTION public.fn_satellite_conservation_audit(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_satellite_conservation_audit(integer) TO service_role;

-- Post-apply assertions: the vocabulary this migration relies on exists, so a
-- declaration can never fall into the settlement_suspense fallback.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chip_ledger'::regclass
                    AND conname = 'chip_ledger_category_check'
                    AND pg_get_constraintdef(oid) LIKE '%''tournament_buyin''%') THEN
    RAISE EXCEPTION 'chip_ledger category tournament_buyin missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.chip_ledger'::regclass
                    AND conname = 'chip_ledger_from_type_check'
                    AND pg_get_constraintdef(oid) LIKE '%''prize_liability''%') THEN
    RAISE EXCEPTION 'chip_ledger account prize_liability missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
                    AND tablename = 'chip_ledger' AND indexname = 'ux_chip_ledger_idempotency_key') THEN
    RAISE EXCEPTION 'ux_chip_ledger_idempotency_key missing: the ON CONFLICT target would not resolve';
  END IF;
  IF (SELECT prosecdef FROM pg_proc WHERE proname = 'fn_award_satellite_seat'
        AND pronamespace = 'public'::regnamespace) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'fn_award_satellite_seat must stay SECURITY DEFINER';
  END IF;
END $$;

-- The 2026-08-31 door-closing guards must survive this full rewrite: the
-- level gate closes AT the cap (>=, never >) and a finalized pool is refused.
-- Same assertions as 20260831210000, so a stale mirror cannot re-open them.
DO $$
DECLARE v_src text;
BEGIN
  SELECT prosrc INTO v_src FROM pg_proc
   WHERE proname = 'fn_award_satellite_seat' AND pronamespace = 'public'::regnamespace;
  IF v_src NOT LIKE '%COALESCE(v_t.current_level, 0) >= v_cap%' THEN
    RAISE EXCEPTION 'the level guard is not >= after the rewrite';
  END IF;
  IF v_src LIKE '%COALESCE(v_t.current_level, 0) > v_cap%' THEN
    RAISE EXCEPTION 'the off-by-one level guard survived the rewrite';
  END IF;
  IF v_src NOT LIKE '%prize_pool_finalized%'
     OR v_src NOT LIKE '%target_pool_finalized%' THEN
    RAISE EXCEPTION 'the finalized-pool guard is not present after the rewrite';
  END IF;
  IF v_src NOT LIKE '%:pool_transfer%' OR v_src NOT LIKE '%satellite_seat_unbacked%' THEN
    RAISE EXCEPTION 'the satellite pool transfer is not present after the rewrite';
  END IF;
END $$;

COMMIT;
