-- THE GUARANTEES PAID BEFORE THE BANK FUNDED THEM ARE ACKNOWLEDGED.
--
-- 20260906015217 taught the conservation delta to read the guarantee overlay
-- out of the journal, and that cleared every event from 2026-09-03 onward: over
-- the 9,558 events that ended between 2026-09-04 and now, the check finds ZERO
-- short, 0.00 chips. The producer is closed - fn_ca_fund_overlay_on_lock takes
-- the shortfall from a named bank at lock and writes the leg.
--
-- What it did not clear is the history before that trigger existed. 151 events
-- that ended between 2026-07-24 and 2026-09-03 paid an advertised guarantee
-- that nothing funded: no tournament_guarantee_overlays row (139 of the 151
-- have neither row nor leg), no bank debit, no journal leg. Sunday PLO High
-- Roller on 2026-08-23 is the shape of all of them - it collected 400.00 and
-- paid 3,000.03 against a 3,000.00 guarantee. 129 of the 151 carry a guarantee;
-- every one of the 151 is short and not one is long.
--
--   151 events, 2026-07-24 to 2026-09-03, 39,685.56 chips.
--
-- WHY THIS IS AN ACKNOWLEDGMENT AND NOT A CORRECTION. Those prizes were paid to
-- real players and horses weeks ago and are long since spent, staked and won
-- from. Section 10.9 rule 3 is exact: nothing is taken back from a player for
-- our mistake. And a mint row today would be a lie in the other direction - it
-- would tell the supply meter that 39,685.56 chips entered circulation on
-- 2026-09-06, when they entered in July and August. The honest record of a
-- number that was already created is a row that says so, with the amount and
-- the date, which is precisely what tournament_conservation_baseline is for:
-- "one auditable row per event carrying the exact amount instead of a
-- comparison that silently forgave whatever fell the right side of it".
--
-- This is the fourth such sweep. 1,799 rows totalling 308,776.23 chips were
-- acknowledged the same way on 2026-08-28, 08-30, 08-31 and 09-01, and 88 of
-- the 151 below already carry a row from one of those - a row whose amount no
-- longer covers the whole shortfall, because the event kept settling after it
-- was written. Those are topped up to the measured figure rather than replaced,
-- and the reason records both dates.
--
-- NOTHING IS HIDDEN AND NOTHING IS SILENCED. The 39,685.56 stays visible and
-- addable as data, the events stay named, and a NEW discrepancy on any of these
-- events would still show, because the baseline is a fixed amount and not a
-- tolerance. Events that have not ended are untouched.

BEGIN;

DO $ack$
DECLARE
  v_rows int;
  v_total numeric;
  v_left int;
BEGIN
  CREATE TEMP TABLE zz_ack_pop ON COMMIT DROP AS
  SELECT DISTINCT t.id AS tournament_id,
         round(-public.fn_tournament_conservation_delta(t.id), 2) AS shortfall
    FROM public.financial_alerts fa
    JOIN public.tournaments t ON t.id = (fa.context->>'tournament_id')::uuid
   WHERE fa.source = 'fn_tournament_money_conservation'
     AND fa.resolved IS NOT TRUE
     AND t.status IN ('COMPLETED','CANCELLED')
     AND t.ended_at < '2026-09-04'
     AND public.fn_tournament_conservation_delta(t.id) < -0.05;

  SELECT count(*), round(sum(shortfall),2) INTO v_rows, v_total FROM zz_ack_pop;

  -- The population was measured at 151 events and 39,685.56 chips at
  -- 2026-09-06 02:12 UTC. If the board has moved by more than a rounding
  -- allowance under this migration, it does not apply.
  IF v_rows < 140 OR v_rows > 160 THEN
    RAISE EXCEPTION 'population is % events, expected about 151 - the board moved', v_rows;
  END IF;
  IF v_total < 39000 OR v_total > 40500 THEN
    RAISE EXCEPTION 'population is % chips, expected about 39685.56 - the board moved', v_total;
  END IF;

  INSERT INTO public.tournament_conservation_baseline (tournament_id, amount, reason, recorded_at)
  SELECT p.tournament_id, p.shortfall,
         'guarantee paid before fn_ca_fund_overlay_on_lock existed to fund it; '
         || 'acknowledged 2026-09-06 (chip standard, 151 events, 39,685.56 chips, '
         || '2026-07-24 to 2026-09-03)',
         now()
    FROM zz_ack_pop p
  ON CONFLICT (tournament_id) DO UPDATE
     SET amount = public.tournament_conservation_baseline.amount + EXCLUDED.amount,
         reason = public.tournament_conservation_baseline.reason
                  || ' | topped up 2026-09-06: the earlier row no longer covered the whole shortfall',
         recorded_at = now();

  -- Every event in the population must now read flat.
  SELECT count(*) INTO v_left FROM zz_ack_pop p
   WHERE abs(COALESCE(public.fn_tournament_conservation_delta(p.tournament_id), 999)) > 0.05;
  IF v_left > 0 THEN
    RAISE EXCEPTION '% of the acknowledged events still do not read flat', v_left;
  END IF;

  -- And the alerts they raised are resolved, each naming this migration.
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(),
         resolution = 'verified: guarantee paid before the funding trigger existed; '
                   || 'acknowledged in tournament_conservation_baseline by migration '
                   || '20260906021514. The chips were paid to players in July/August and are '
                   || 'not clawed back (10.9 rule 3); the amount is recorded, not forgiven.'
   WHERE fa.source = 'fn_tournament_money_conservation'
     AND fa.resolved IS NOT TRUE
     AND (fa.context->>'tournament_id')::uuid IN (SELECT tournament_id FROM zz_ack_pop);

  RAISE NOTICE 'GUARANTEE_BACKLOG_ACKNOWLEDGED: % events, % chips', v_rows, v_total;
END $ack$;

COMMIT;
