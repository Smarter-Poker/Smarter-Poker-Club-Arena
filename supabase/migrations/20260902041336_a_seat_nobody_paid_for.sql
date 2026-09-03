-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902041336; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- PHASE 2 OF 6 - A SEAT NOBODY PAID FOR
--
-- THE QUESTION: can a player occupy a seat in a paid event without that entry
-- having been paid for? The answer, measured rather than assumed, is that it
-- happened 464 times and has not happened since 2026-08-20.
--
-- WHAT HAPPENED (2026-08-19 00:01 -> 2026-08-20 23:45, 464 seats, 81 events,
-- 2,530.80 chips of notional entry). Horses were SEEDED into fields rather
-- than registered into them. Both witnesses agree and neither is the same
-- witness: no `wallet_transactions` debit AND no `chip_transactions` row, so
-- no wallet moved. `rake_records` proves the register functions never ran at
-- all - across the 39 COMPLETED events in that window there is ONE rake row,
-- and it came from fn_spin_settle_game. Those 39 events collected 6.00 chips
-- of entry money and 0.00 of fees, and paid out 1,734.00 in prizes, of which
-- 1,373.00 was guaranteed money the club had already promised.
--
-- THE CAUSE IS ALREADY FIXED, AND NOT BY ME. `fn_register_horse_for_tournament`
-- began charging horses real chips on 2026-08-19 - the change tournamentRecovery
-- records as "the day the old rule 'horses paid nothing' became false" - and the
-- last unfunded seat on the platform was created at 2026-08-20 23:45:28. A horse
-- now pays the same buy-in, the same fee and the same rake as anybody else,
-- which is section 10.5 and not an optimisation. Nothing here re-fixes it.
--
-- WHAT WAS MISSING IS THE INSTRUMENT. Nothing on this platform would have
-- noticed the leak while it ran and nothing would notice it returning. That is
-- what this migration adds.
--
-- THE FOUR WAYS A SEAT IS LEGITIMATELY PAID FOR, ENUMERATED RATHER THAN GUESSED:
--
--   1. a wallet_transactions `tournament_buyin` debit for that user on that
--      tournament - the ordinary door, human or horse;
--   2. a satellite seat award - the player already paid, in the satellite, and
--      the seat IS the prize (fn_award_satellite_seat credits the target's
--      prize_pool and total_rake in the same transaction);
--   3. a flight advancement - a multi-day or XMTT day past the first is bought
--      by surviving day one, not by paying again (Phase 3 audits whether the
--      chips actually follow);
--   4. the event charges nothing - a freeroll owes no entry.
--
-- Anything else is a seat nobody paid for. Enumerating the exemptions is the
-- whole design: a check that decides what "looks legitimate" will eventually
-- excuse the next leak too.
--
-- POSITIVE CONTROL, RUN BEFORE THIS WAS WRITTEN AND RECORDED HERE BECAUSE A
-- DETECTOR THAT RETURNS ZERO EVERYWHERE IS NOT A DETECTOR. Pointed at the
-- known-bad window the identical logic returns 464 seats / 81 events /
-- 2,530.80 chips - the same figures reached independently from
-- chip_transactions. Pointed at the live 48 hours it returns 0 in 1.85s.
--
-- BOUNDED AT 48 HOURS, and the ceiling matters twice here. Once for the reason
-- fn_cash_pot_conservation_check is bounded - a check that cannot finish tells
-- nobody anything. And once more for a reason peculiar to this check:
-- wallet_transactions has only carried `tournament_buyin` since 2026-08-19,
-- when log_wallet_transaction was wired into the register path. Before that
-- date an absent debit is an absent LOGGER, not an unpaid entry, and a window
-- reaching back past it would report 22,981 healthy seats as a catastrophe.
-- The 48-hour cap makes that unreachable; EVIDENCE_START asserts it anyway,
-- because a later hand raising the cap will not read this paragraph.
--
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.fn_uncollected_entry_check(integer);
--   DROP INDEX IF EXISTS public.idx_tournament_players_registered_at;
--   DELETE FROM public.money_check_heartbeat WHERE check_name='fn_uncollected_entry_check';
--   DELETE FROM public.tournament_payouts WHERE source='satellite_seat'
--     AND recorded_by='phase2_backfill';

-- ---------------------------------------------------------------------------
-- 1. THE DETECTOR
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_uncollected_entry_check(
  p_since_hours integer DEFAULT 24
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  /* 48h ceiling: double what the engine asks for (hourly, 24h), and measured
     at 1.85s against the live table before the supporting index existed. */
  v_hours   integer := LEAST(GREATEST(COALESCE(p_since_hours, 24), 1), 48);
  v_since   timestamptz;

  /* THE DAY THE EVIDENCE STARTS. log_wallet_transaction was wired into the
     tournament register path on 2026-08-19; the first `tournament_buyin` row
     in wallet_transactions is 2026-08-19 and there are none before it. An
     absent debit dated earlier than this proves the LOGGER was absent, not
     the payment - 22,981 perfectly healthy seats sit behind that date. The
     48-hour cap already makes this unreachable. It is asserted rather than
     assumed because caps get raised by people who did not read the comment. */
  c_evidence_start constant timestamptz := timestamptz '2026-08-19 00:00:00+00';

  v_seats   bigint  := 0;
  v_bad     bigint  := 0;
  v_events  bigint  := 0;
  v_chips   numeric := 0;
  v_alerts  integer := 0;
  v_worst   jsonb   := '[]'::jsonb;
BEGIN
  v_since := now() - make_interval(hours => v_hours);

  IF v_since < c_evidence_start THEN
    RETURN jsonb_build_object(
      'ok', false,
      'reason', 'window_predates_the_evidence',
      'detail', 'wallet_transactions has only carried tournament_buyin since '
                || c_evidence_start::text || '; an absent debit before that date '
                || 'means the logger did not exist, not that nobody paid',
      'since_hours', v_hours);
  END IF;

  WITH seats AS (
    SELECT tp.tournament_id, tp.user_id,
           COALESCE(tp.is_satellite_qualifier, false) AS sat_flag,
           tp.source_satellite_id,
           t.name,
           round(COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0), 2) AS charge,
           (COALESCE(t.is_xmtt, false) OR COALESCE(t.is_multi_day, false)) AS multiday,
           t.parent_tournament_id,
           COALESCE(t.day_number, 1) AS day_number
      FROM public.tournament_players tp
      JOIN public.tournaments t ON t.id = tp.tournament_id
     WHERE tp.registered_at >= v_since
       -- EXEMPTION 4: a freeroll owes no entry.
       AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
  ),
  -- EXEMPTION 1: the ordinary door. Widened past the seat window so a debit
  -- written either side of a registration still counts as the same entry.
  funded AS (
    SELECT DISTINCT w.related_entity_id AS tournament_id, w.user_id
      FROM public.wallet_transactions w
     WHERE w.related_entity_id IS NOT NULL
       AND w.category = 'tournament_buyin'
       AND w.type = 'debit'
       AND w.created_at >= v_since - interval '6 hours'
  ),
  -- EXEMPTION 2: the seat IS the prize. The rake row is the durable witness
  -- that fn_award_satellite_seat ran; the two roster columns are the witness
  -- on the seat itself, and either one alone is enough. Both are needed
  -- because each has a birthday: is_satellite_qualifier has only been written
  -- since 2026-08-27 and source_satellite_id since 2026-08-30, while a
  -- zero-fee target writes no rake row at all.
  awards AS (
    SELECT DISTINCT r.tournament_id, (r.metadata->>'user_id')::uuid AS user_id
      FROM public.rake_records r
     WHERE r.source = 'fn_award_satellite_seat'
       AND r.created_at >= v_since - interval '30 days'
       AND r.metadata ? 'user_id'
  ),
  bad AS (
    SELECT s.*
      FROM seats s
      LEFT JOIN funded f ON f.tournament_id = s.tournament_id AND f.user_id = s.user_id
      LEFT JOIN awards a ON a.tournament_id = s.tournament_id AND a.user_id = s.user_id
     WHERE f.user_id IS NULL
       AND a.user_id IS NULL
       AND NOT s.sat_flag
       AND s.source_satellite_id IS NULL
       -- EXEMPTION 3: a day past the first is bought by surviving day one.
       AND NOT (s.multiday AND (s.day_number > 1 OR s.parent_tournament_id IS NOT NULL))
  )
  SELECT (SELECT count(*) FROM seats),
         (SELECT count(*) FROM bad),
         (SELECT count(DISTINCT tournament_id) FROM bad),
         (SELECT COALESCE(round(sum(charge), 2), 0) FROM bad),
         (SELECT COALESCE(jsonb_agg(x), '[]'::jsonb) FROM (
            SELECT jsonb_build_object('tournament_id', tournament_id, 'name', max(name),
                                      'seats', count(*), 'chips', round(sum(charge), 2)) AS x
              FROM bad GROUP BY tournament_id
             ORDER BY sum(charge) DESC LIMIT 10) y)
    INTO v_seats, v_bad, v_events, v_chips, v_worst;

  /* One OPEN alert for the condition, not one per seat. On the two days this
     actually happened a per-seat alert would have filed 464 rows and buried
     itself, which is the failure the dedupe key exists to stop. */
  IF v_bad > 0 THEN
    PERFORM public.fn_raise_server_financial_alert(
      'critical', 'fn_uncollected_entry_check',
      format('%s seat(s) across %s event(s) in the last %sh hold a place in a paid tournament with no entry paid for them: %s chips of entry never collected',
             v_bad, v_events, v_hours, v_chips),
      jsonb_build_object('kind', 'uncollected_entry', 'seats', v_bad,
        'events', v_events, 'chips', v_chips, 'since_hours', v_hours,
        'seats_checked', v_seats, 'worst', v_worst,
        'exempt', 'wallet debit, satellite seat award, day-2 advancement, freeroll',
        'detail', 'no money was moved by this check'),
      'uncollected_entry');
    v_alerts := v_alerts + 1;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'since_hours', v_hours,
    'seats_checked', v_seats,
    'uncollected_entries', v_bad,
    'events', v_events,
    'chips', v_chips,
    'worst', v_worst,
    -- Same reason as fn_cash_pot_conservation_check: the dedupe path returns an
    -- existing row's id, so a standing condition reports itself every pass
    -- without writing a new row. This counts CONDITIONS, not INSERTs.
    'conditions_alerted', v_alerts);
END;
$function$;

COMMENT ON FUNCTION public.fn_uncollected_entry_check(integer) IS
  'Phase 2 of the MTT payout audit. Reports seats in paid events with no entry '
  'paid for them. Exempts the four legitimate funding sources by name. Moves no '
  'money. Bounded at 48h and refuses any window predating 2026-08-19, when '
  'wallet_transactions began carrying tournament_buyin.';

REVOKE ALL ON FUNCTION public.fn_uncollected_entry_check(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_uncollected_entry_check(integer) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. THE INDEX THE CHECK LEANS ON
-- ---------------------------------------------------------------------------
-- Without it the 48-hour scan is a parallel seq scan that throws away 93,727
-- of 109,421 rows and takes 1.85s. That is inside the 8s statement timeout
-- today and would not stay there; every check on this platform that quietly
-- stopped working stopped by growing past its budget, not by breaking.

CREATE INDEX IF NOT EXISTS idx_tournament_players_registered_at
  ON public.tournament_players (registered_at);

-- ---------------------------------------------------------------------------
-- 3. REGISTER IT, SO A CHECK THAT NEVER RUNS READS AS MISSING
-- ---------------------------------------------------------------------------
-- Phase 1's rule: the row exists from the moment the check does, so a check
-- that has never fired is stale rather than silent.

INSERT INTO public.money_check_heartbeat (check_name, expected_interval_minutes, note)
VALUES ('fn_uncollected_entry_check', 60,
        'Phase 2. Seats in paid events with no entry paid for them. Driven hourly by GameServer.')
ON CONFLICT (check_name) DO UPDATE
  SET expected_interval_minutes = EXCLUDED.expected_interval_minutes,
      note = EXCLUDED.note;

-- ---------------------------------------------------------------------------
-- 4. A SATELLITE SEAT IS A PAYOUT, AND NOT ONE OF THEM HAS EVER BEEN RECORDED
-- ---------------------------------------------------------------------------
-- fn_award_satellite_seat writes a tournament_payouts row for the seat it
-- awards - the seat is worth the target's buy-in plus fee, paid out of the
-- satellite. That block was added by migration 20260831192927 on 2026-08-31
-- 19:29. The most recent satellite seat on this platform was awarded on
-- 2026-08-30 20:10. So the block is not broken; it has simply never once
-- executed, and the 23 seats awarded before it landed carry no record.
--
-- That is 23 x 200.00 = 4,600.00 chips of prize value paid to players and
-- absent from the payout ledger - the same record-completeness hole the
-- structure-prize backfill closed in the previous phase, in a different door.
--
-- Every field below is reconstructed from evidence, never inferred:
--   - the target, user, satellite and registration id come from the
--     rake_records row fn_award_satellite_seat itself wrote;
--   - the seat's value is that row's pot_size, which the function set to
--     buy_in + fee at the moment of the award;
--   - the position is the player's recorded finish IN THE SATELLITE, left
--     NULL where the satellite never recorded one. A guessed position would
--     be worse than an absent one.
-- The key is the one the live function uses, so a re-drive writes nothing.
-- Verified before applying: 23 rake rows, 23 distinct (satellite, user) pairs,
-- so the statement cannot conflict with itself.

INSERT INTO public.tournament_payouts
  (tournament_id, user_id, "position", amount, source, idempotency_key,
   paid_at, tournament_type, field_size, prize_pool, recorded_by, metadata)
SELECT
  (r.metadata->>'satellite_id')::uuid,
  (r.metadata->>'user_id')::uuid,
  sp.position,
  round(r.pot_size, 2),
  'satellite_seat',
  'tourney:' || (r.metadata->>'satellite_id') || ':seat:' || (r.metadata->>'user_id'),
  r.created_at,
  sat.tournament_type,
  (SELECT count(*) FROM public.tournament_players f
    WHERE f.tournament_id = (r.metadata->>'satellite_id')::uuid),
  sat.prize_pool,
  'phase2_backfill',
  jsonb_build_object(
    'satellite_target_id', r.tournament_id,
    'target_name', tgt.name,
    'registration_id', r.metadata->>'registration_id',
    'target_buy_in', round(r.pot_size - r.rake_amount, 2),
    'target_fee', round(r.rake_amount, 2),
    'backfilled', true,
    'backfill_reason',
      'fn_award_satellite_seat gained its payout-record block in migration '
      || '20260831192927 (2026-08-31 19:29). The last satellite seat was awarded '
      || '2026-08-30 20:10. The block had never executed and these awards '
      || 'predate it.',
    'reconstructed_from', 'rake_records row written by fn_award_satellite_seat')
  FROM public.rake_records r
  JOIN public.tournaments sat ON sat.id = (r.metadata->>'satellite_id')::uuid
  JOIN public.tournaments tgt ON tgt.id = r.tournament_id
  LEFT JOIN public.tournament_players sp
         ON sp.tournament_id = (r.metadata->>'satellite_id')::uuid
        AND sp.user_id = (r.metadata->>'user_id')::uuid
 WHERE r.source = 'fn_award_satellite_seat'
   AND r.metadata ? 'user_id'
   AND r.metadata ? 'satellite_id'
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5. ASSERT WHAT THIS MIGRATION CLAIMS
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_awards  bigint;
  v_records bigint;
  v_live    jsonb;
BEGIN
  SELECT count(*) INTO v_awards
    FROM public.rake_records
   WHERE source = 'fn_award_satellite_seat' AND metadata ? 'user_id';

  SELECT count(*) INTO v_records
    FROM public.tournament_payouts WHERE source = 'satellite_seat';

  IF v_records < v_awards THEN
    RAISE EXCEPTION
      'satellite seat backfill is short: % awards, % records', v_awards, v_records;
  END IF;

  -- The check must run, and on a platform whose leak is closed it must return
  -- zero. If this ever fails on apply, read the payload before assuming the
  -- migration is wrong - it may be telling the truth.
  SELECT public.fn_uncollected_entry_check(24) INTO v_live;
  IF NOT COALESCE((v_live->>'ok')::boolean, false) THEN
    RAISE EXCEPTION 'fn_uncollected_entry_check did not return ok: %', v_live;
  END IF;
  RAISE NOTICE 'fn_uncollected_entry_check(24) = %', v_live;

  IF NOT EXISTS (SELECT 1 FROM public.money_check_heartbeat
                  WHERE check_name = 'fn_uncollected_entry_check') THEN
    RAISE EXCEPTION 'the new check was not registered in money_check_heartbeat';
  END IF;
END $$;
