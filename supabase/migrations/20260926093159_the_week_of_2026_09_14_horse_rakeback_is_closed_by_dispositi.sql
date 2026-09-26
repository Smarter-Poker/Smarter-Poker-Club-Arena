-- 20260926093159_the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi.sql
--
-- THE WEEK OF 2026-09-14 HORSE RAKEBACK IS CLOSED BY DISPOSITION (2026-09-26)
--
-- DECISION (CLAUDE.md 10.9; the alert named Dan as decision owner and Dan
-- delegated it on 2026-09-26): the deferred cash rakeback for the week
-- 2026-09-14 07:00Z -> 2026-09-21 07:00Z is CLOSED WITHOUT PAYMENT. No chips
-- move. The facts, re-read today:
--
-- 1. EVERY RECIPIENT IS A HOUSE HORSE. The rakeback basis names 612 players
--    in the durable earning records (674 in the 09-21 attribution reading);
--    every one is profiles.is_horse. No human is owed rakeback for this week.
--    Its payers are the agents' commission (98.9% on the 09-21 reading), and
--    142 of the 144 active agents in the three clubs are horses too. The
--    commission for the same week is itself unpaid (the week sits below the
--    2026-09-20 settlement floor), so there is no human-held pool the
--    rakeback would come out of: paying it would move house treasury chips
--    into house horse wallets.
--
-- 2. THE 28.1% FIGURE IS OBSOLETE, AND SO IS THE 09-21 RESTATEMENT'S BASIS.
--    26,542.66 was a stalled legacy writer's partial sum (restated 09-21 by
--    20260921082544 to 134,439.33 observed / 138,303.43 upper bound). Since
--    then the hand-history pruner DELETED the rake_attributions of every
--    pruned hand (fixed 2026-09-25 by 20260925143224); the week's first three
--    days are now 102,494.31 of rake with no per-player attribution at all
--    (41,944 + 3,326 + 24,478 records), and 09-17 lost 630 more. The only
--    per-player records that survive are accounting_payable_earning_sources
--    (contracts captured at earning time, immutable): 441,623.03 of the
--    615,843.40 basis, 71.7%. The rest is no longer derivable per player.
--
-- 3. THE PLATFORM ITSELF REFUSES THE WEEK. fn_calculate_cash_rakeback_periods
--    returns historical_week_before_observed_source_cutover (cutover
--    2026-09-17 18:24:04Z), no certificate exists, and the settlement floor
--    stands. Paying it means a new one-off payer outside the certified path,
--    for a transfer between house accounts. That is risk with no player on
--    the other side of it.
--
-- For the record, the portion that IS derivable today, computed below from
-- the earning contracts at earning-time terms (deal, else agent offer, capped
-- at commission - 0.10; the few rows with neither priced at the lowest volume
-- tier, a lower bound, because the weekly volume that sets a higher tier
-- includes the destroyed days), is written into both obligation rows and the
-- alert. Should this ever need paying (for example if a human is found in
-- the basis), that figure and its source are the starting point.
--
-- The alert deferred_rakeback_basis_2026_09_14 is resolved with this
-- receipt; the two accounting_deferred_obligations rows for the week keep
-- their observed pending_amount (an observation is not rewritten) and carry
-- the disposition in their reason. The week of 2026-09-07 is untouched.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '240s';

DO $mig$
DECLARE
  c_mig   CONSTANT text := '20260926093159_the_week_of_2026_09_14_horse_rakeback_is_closed_by_dispositi';
  c_actor CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_from  CONSTANT timestamptz := '2026-09-14 07:00:00+00';
  c_to    CONSTANT timestamptz := '2026-09-21 07:00:00+00';
  v_probe boolean := COALESCE(current_setting('ca.money7_probe', true), '') = 'on';
  v_players int; v_horses int; v_basis numeric; v_rb numeric; v_rb_termed numeric; v_rb_tier numeric;
  v_week_rake numeric; v_unattr numeric; v_paid bigint; v_note text; v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.financial_alerts
                  WHERE source = 'deferred_rakeback_basis_2026_09_14' AND resolved IS NOT TRUE) THEN
    RAISE EXCEPTION 'rakeback disposition: the alert is not open';
  END IF;
  SELECT count(*) INTO v_paid FROM public.rakeback_period_payouts pp
    JOIN public.rakeback_periods rp ON rp.id = pp.rakeback_period_id
   WHERE rp.period_start = '2026-09-14';
  IF v_paid <> 0 THEN RAISE EXCEPTION 'rakeback disposition: the week already has % payouts', v_paid; END IF;

  SELECT round(sum(r.rake_amount), 2),
         round(COALESCE(sum(r.rake_amount) FILTER (WHERE NOT EXISTS (
           SELECT 1 FROM public.rake_attributions a WHERE a.rake_record_id = r.id)), 0), 2)
    INTO v_week_rake, v_unattr
    FROM public.rake_records r
   WHERE r.created_at >= c_from AND r.created_at < c_to
     AND r.is_tournament IS NOT TRUE AND r.tournament_id IS NULL AND r.rake_amount > 0;

  CREATE TEMP TABLE zz_rb ON COMMIT DROP AS
  SELECT s.player_id, s.club_id, s.rake_credit,
         COALESCE((s.contract->'membership'->'terms'->>'player_rakeback_pct')::numeric, 0) AS deal,
         COALESCE((s.contract->'tiers'->0->'agreement'->'terms'->>'player_rakeback_rate')::numeric, 0) AS offer,
         (s.contract->'tiers'->0->'agreement'->'terms'->>'commission_rate')::numeric AS cap
    FROM public.accounting_payable_earning_sources s
   WHERE s.earned_at >= c_from AND s.earned_at < c_to AND s.tournament_id IS NULL;

  SELECT count(DISTINCT z.player_id), count(DISTINCT z.player_id) FILTER (WHERE p.is_horse IS TRUE),
         round(sum(z.rake_credit), 2)
    INTO v_players, v_horses, v_basis
    FROM zz_rb z JOIN public.profiles p ON p.id = z.player_id;
  IF v_players <> v_horses THEN
    RAISE EXCEPTION 'rakeback disposition: % of % recipients are human - a human is owed and this disposition does not apply', v_players - v_horses, v_players;
  END IF;

  SELECT round(COALESCE(sum(z.rake_credit * LEAST(CASE WHEN z.deal > 0 THEN z.deal ELSE z.offer END,
                                                  CASE WHEN z.cap > 0 THEN GREATEST(z.cap - 0.10, 0) ELSE 1 END))
                        FILTER (WHERE z.deal > 0 OR z.offer > 0), 0), 2),
         round(COALESCE(sum(z.rake_credit * 0.05) FILTER (WHERE z.deal = 0 AND z.offer = 0), 0), 2)
    INTO v_rb_termed, v_rb_tier
    FROM zz_rb z;
  v_rb := v_rb_termed + v_rb_tier;

  v_note := format(
    E'\n\nDISPOSITION 2026-09-26 (migration %s): CLOSED WITHOUT PAYMENT under CLAUDE.md 10.9, decision delegated by Dan. '
    || 'All %s recipients in the surviving per-player records are house horses (no human is owed); 142 of the 144 active agents who would fund it are horses and the week''s commission is itself unpaid; '
    || 'the platform''s own calculator refuses the week (historical_week_before_observed_source_cutover); and the hand-history pruner deleted the week''s pre-cutover rake_attributions before its 2026-09-25 fix, '
    || 'so %s of the week''s %s cash rake now has no per-player record. Derivable today from immutable earning contracts: basis %s, rakeback %s (%s at earning-time terms + %s lower-bound tier). No chips moved.',
    c_mig, v_players, v_unattr, v_week_rake, v_basis, v_rb, v_rb_termed, v_rb_tier);

  UPDATE public.accounting_deferred_obligations
     SET reason = reason || v_note
   WHERE period_start = c_from AND period_end = c_to
     AND ((scope_kind = 'club' AND scope_id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3')
       OR (scope_kind = 'union' AND scope_id = 'fade0000-0000-0000-0000-000000000001'))
     AND position('DISPOSITION 2026-09-26' IN reason) = 0;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 2 THEN RAISE EXCEPTION 'rakeback disposition: expected the two obligation rows, updated %', v_n; END IF;

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         context = context || jsonb_build_object('disposition', jsonb_build_object(
           'decision', 'closed_without_payment', 'migration', c_mig, 'decided_under', 'CLAUDE.md 10.9, delegated by Dan 2026-09-26',
           'recipients', v_players, 'human_recipients', 0, 'week_cash_rake', v_week_rake,
           'rake_without_per_player_record', v_unattr, 'derivable_basis', v_basis,
           'derivable_rakeback', v_rb, 'derivable_at_terms', v_rb_termed, 'derivable_lower_bound_tier', v_rb_tier,
           'chips_moved', 0)),
         resolution = 'Decided: closed without payment. ' || btrim(v_note)
   WHERE source = 'deferred_rakeback_basis_2026_09_14' AND resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'rakeback disposition: expected one alert, resolved %', v_n; END IF;

  RAISE NOTICE 'rakeback 09-14: recipients % (horses %), week rake %, no per-player record %, derivable basis %, rakeback % (% + %)',
    v_players, v_horses, v_week_rake, v_unattr, v_basis, v_rb, v_rb_termed, v_rb_tier;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): recipients % (horses %), week rake %, unattributed %, derivable basis %, rakeback % (% + %)',
      v_players, v_horses, v_week_rake, v_unattr, v_basis, v_rb, v_rb_termed, v_rb_tier;
  END IF;
END
$mig$;

COMMIT;
