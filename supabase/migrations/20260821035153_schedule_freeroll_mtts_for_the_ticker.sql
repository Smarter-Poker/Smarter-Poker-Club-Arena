-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821035153 "schedule_freeroll_mtts_for_the_ticker"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 8b1e648ae375b6b2838000ac4fdfc98e of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- The 5-minute MTT ticker shipped on 2026-08-20 and has never been seen,
-- because the platform holds 7,306 spins and 2,809 heads-up games and ZERO
-- MTTs in a pre-start state. The bar is correct; there is simply nothing for
-- it to announce.
--
-- These three are FREEROLLS: buy_in_amount 0, buy_in_fee 0, guaranteed_prize
-- 0. No player pays anything and no treasury funds a prize, so scheduling them
-- moves no money. They exist so the announcement has something true to say and
-- so the path can be watched end to end.
--
-- Cloned from a known-good MTT rather than hand-built, so every column the
-- engine needs — blind_structure, payout_structure, starting_chips, late reg —
-- is exactly what a working tournament carries. Only the identity, the club,
-- the start time and the status differ.
--
-- A REAL recurring schedule (which events, what guarantees, funded from where)
-- is a product decision and is deliberately NOT made here.

WITH template AS (
    SELECT * FROM public.tournaments
     WHERE tournament_type = 'MTT' AND blind_structure IS NOT NULL AND payout_structure IS NOT NULL
     ORDER BY created_at DESC LIMIT 1
), target AS (
    SELECT id AS club_id FROM public.clubs WHERE club_id = 25450
), spec(label, offset_min) AS (
    VALUES ('Late Night Freeroll (NLH)', 12),
           ('Night Owl Freeroll (NLH)', 45),
           ('Last Call Freeroll (NLH)', 90)
)
INSERT INTO public.tournaments (
    name, description, game_type, variant, buy_in_amount, buy_in_fee, guaranteed_prize,
    start_time, status, current_players, max_players, late_reg_mins, starting_chips,
    blind_structure, payout_structure, club_id, min_players, tournament_type, prize_pool,
    is_rebuy, add_on_available, is_bounty, is_pko, is_turbo, created_at, updated_at
)
SELECT
    spec.label,
    'Freeroll. No buy-in, no fee.',
    t.game_type, t.variant,
    0, 0, 0,
    now() + (spec.offset_min || ' minutes')::interval,
    'REGISTERING',
    0,
    t.max_players, t.late_reg_mins, t.starting_chips,
    t.blind_structure, t.payout_structure,
    target.club_id,
    t.min_players, 'MTT', 0,
    false, false, false, false, false,
    now(), now()
FROM template t, target, spec
WHERE NOT EXISTS (
    SELECT 1 FROM public.tournaments x
     WHERE x.name = spec.label AND x.status IN ('ANNOUNCED','REGISTERING')
);

DO $$
DECLARE
    n integer;
BEGIN
    SELECT count(*) INTO n
      FROM public.tournaments
     WHERE tournament_type = 'MTT'
       AND status IN ('ANNOUNCED','REGISTERING')
       AND start_time > now();
    IF n = 0 THEN
        RAISE EXCEPTION 'post-apply failed: still no upcoming MTT for the ticker to announce';
    END IF;
    RAISE NOTICE 'upcoming MTTs now: %', n;
END $$;
