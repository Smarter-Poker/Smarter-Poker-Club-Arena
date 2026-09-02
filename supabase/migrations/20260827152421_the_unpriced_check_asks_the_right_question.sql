-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827152421; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- THE UNPRICED-TOURNAMENT CHECK ASKS THE RIGHT QUESTION
-- ═══════════════════════════════════════════════════════════════════════════
-- The first version of this check reported 5,230 unpriced tournaments and
-- ~33,367 chips uncollected. That was MY BUG, and it is precisely the
-- antipattern the rest of tonight's work removed: an alarm firing on 5,230
-- things nobody needs to act on drowns the 140 that matter, exactly as 575
-- nightly dead-wallet criticals hid a 115-day ledger outage.
--
-- TWO WRONG ASSUMPTIONS, each caught by an assertion rather than by shipping:
--
-- 1. "A zero buy_in_fee means a free tournament." No. 4,664 of the 5,230 were
--    SPINs, which carry buy_in_fee = 0 BY DESIGN and earn through their own
--    schedule via fn_spin_settle_game. Verified rather than assumed: of 500
--    zero-fee spins sampled from 7 days, 500 of 500 produced tournament rake
--    records totalling 1,707.18. The right question is not what the column
--    says, it is whether the event EARNED anything.
--
-- 2. "Any event with no rake is a miss." No. The corrected check still flagged
--    6 spins, all of them status REGISTERING and as young as 2h44m -- they had
--    not started. An event that has not finished cannot have earned, so only
--    COMPLETED events can be judged. CANCELLED is excluded too: entries are
--    refunded, so earning nothing is correct.
--
-- What survives is real and bounded:
--     MTT  140 events, ~698 chips, 2026-08-21 to 2026-08-25
--     SNG  426 events, ~244 chips, 2026-08-21 to 2026-08-23
-- Both windows are CLOSED - nothing since 08-25 - so this is detection for the
-- next time, not a live leak.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.fn_unpriced_tournaments(p_since interval DEFAULT '7 days')
RETURNS TABLE (
  tournament_id   uuid,
  name            text,
  tournament_type text,
  buy_in_amount   numeric,
  buy_in_fee      numeric,
  entrants        integer,
  uncollected     numeric,
  created_at      timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, t.tournament_type, t.buy_in_amount, coalesce(t.buy_in_fee, 0),
         coalesce(t.current_players, 0),
         round((t.buy_in_amount * 0.10 * coalesce(t.current_players, 0))::numeric, 2),
         t.created_at
  FROM public.tournaments t
  WHERE t.buy_in_amount > 0
    AND coalesce(t.current_players, 0) > 0            -- nobody entered, nothing lost
    AND t.created_at > now() - p_since
    /* Only a FINISHED event can be judged. REGISTERING and RUNNING have not
       earned yet; CANCELLED refunds its entries, so earning nothing is right. */
    AND upper(coalesce(t.status, '')) = 'COMPLETED'
    /* Satellites award a seat rather than a prize pool and legitimately carry
       no fee of their own; the target event charges it. */
    AND t.satellite_target_id IS NULL
    AND coalesce(t.satellite_seats, 0) = 0
    /* THE ACTUAL TEST: did it earn anything at all? Asking the rake ledger
       instead of the buy_in_fee column is the difference between 566 real
       findings and 5,230 false ones. */
    AND NOT EXISTS (
      SELECT 1 FROM public.rake_records r
       WHERE r.tournament_id = t.id AND r.is_tournament AND r.rake_amount > 0
    )
  ORDER BY t.created_at DESC;
$$;

COMMENT ON FUNCTION public.fn_unpriced_tournaments(interval) IS
  'COMPLETED tournaments that took a buy-in, had entrants, and earned NO rake of any kind. Added 2026-08-27 after 140 MTTs and 426 SNGs ran free between 08-21 and 08-25 with nothing noticing. Tests the rake_records ledger rather than buy_in_fee, because spins legitimately carry a zero fee and price themselves via fn_spin_settle_game. Excludes satellites, empty events, and anything not finished.';

REVOKE ALL ON FUNCTION public.fn_unpriced_tournaments(interval) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_unpriced_tournaments(interval) TO service_role, authenticated;

DO $$
DECLARE v_n bigint; v_spins bigint; v_unfinished bigint;
BEGIN
  SELECT count(*) INTO v_spins FROM public.fn_unpriced_tournaments('7 days')
   WHERE tournament_type = 'SPIN';
  IF v_spins > 0 THEN
    RAISE EXCEPTION 'spins still flagged (%) - they price themselves via fn_spin_settle_game', v_spins;
  END IF;

  SELECT count(*) INTO v_unfinished
    FROM public.fn_unpriced_tournaments('7 days') u
    JOIN public.tournaments t ON t.id = u.tournament_id
   WHERE upper(coalesce(t.status,'')) <> 'COMPLETED';
  IF v_unfinished > 0 THEN
    RAISE EXCEPTION 'unfinished tournaments flagged (%) - they cannot have earned yet', v_unfinished;
  END IF;

  SELECT count(*) INTO v_n FROM public.fn_unpriced_tournaments('7 days');
  RAISE NOTICE 'unpriced tournaments: % (was 5230 before the two corrections)', v_n;
END $$;
