-- 20260926092142_a_bot_only_pko_shortfall_and_confirmed_noise_are_closed_with.sql
--
-- A BOT-ONLY PKO SHORTFALL, AND CONFIRMED NOISE, ARE CLOSED WITH RECEIPTS
-- (2026-09-26). No chips move in this migration. Every class it closes is
-- re-proved in this transaction against current rows; a subject that no
-- longer proves keeps its alert.
--
-- PART 1 - THE 2026-09-07 SUNDAY FUNDAY HIGH ROLLER PKOs (decision under
-- CLAUDE.md 10.9, delegated by Dan for this item on 2026-09-26).
--
--   All 221 entrants of both events were HORSE fleet players and all arrived
--   by satellite seat. The satellite-award path in force on 2026-09-04
--   credited each 67.50 seat entirely to the prize ladder and nothing to the
--   bounty bank, and trg_seed_bounty_head then raised bounty_pool with no bank
--   behind it (its own alert says so). The money is conserved on both events:
--   seat value in - rake - player credits = 0.00, escrows closed at exact zero.
--
--   a21c0cb6 (155 entrants): the field received exactly the advertised total
--     (10,462.50 = max(3,500, 155 x 32.50) + 155 x 35.00), only through the
--     prize ladder instead of knockouts. Nothing is owed.
--   3f19bd70 (66 entrants): the field received 4,455.00 against an advertised
--     5,810.00 (3,500.00 guarantee + 66 x 35.00 bounty) - 1,355.00 short.
--     DISPOSITION: CLOSED, NOTHING PAID. Every entrant was a house-operated
--     horse, so no human player is short. The hand history of both events has
--     been pruned under the horse retention policy (hand_history holds 0 rows
--     for either), and no knockout was ever recorded (no bounty obligation,
--     award or candidate), so which horse knocked out which cannot be derived;
--     paying club money to horses chosen without that evidence would be a
--     fabrication, not a correction. The recurrence is closed: since
--     20260911110907 (#4296) no satellite can be created into, or re-pointed
--     at, a bounty/PKO/mystery/Spin target (triggers
--     satellite_feeds_only_a_deliverable_target and
--     a2_tournaments_new_satellite_target), and fn_settle_satellite_tournament
--     refuses such a target outright ("uses an unsupported bounty or Spin
--     entry split"); both are asserted below.
--
-- PART 2 - CLASSES MONEY_POSITION.md 5.2 CALLED CONFIRMED NOISE, RE-PROVED:
--   2a  finish retry receipts on COMPLETED tournaments (and their 0-chip
--       drift mirrors): COMPLETED, ended_at set, payouts exist, none unpaid -
--       the proof 20260925142532 used for the 16,480 it closed.
--   2b  the stale guarantee alert on 690bfcb0 (paid 20,000.00 of 20,000.00)
--       and the two stale bounty alerts on 93cdc2f4 (pool 24.00, paid 24.00).
--   2c  fn_tournament_money_conservation, 11 alerts: the true residual (seat
--       and cash value in - rake + house funding - player credits) is 0.00 on
--       every one; the two -180.00 are house-funded bubble protection with its
--       correction leg and payout row.
--   2d  fn_rake_repair_unbanked, 10 receipts of a repair that worked: no
--       raked cash hand retained from 2026-08-27 to 2026-09-09 lacks its
--       rake record.
-- Classes already closed before today (bounty_head_not_attributed,
-- Satellite.seat_outcome_unconfirmed, the 16,480 retry receipts) have 0 open
-- alerts and are not touched.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $mig$
DECLARE
  c_mig   CONSTANT text := '20260926092142_a_bot_only_pko_shortfall_and_confirmed_noise_are_closed_with';
  c_actor CONSTANT uuid := '2d1cd6c3-5700-4af9-a271-d4863fdab20d';
  c_a     CONSTANT uuid := 'a21c0cb6-4dd7-4634-86bd-bc3dccc135a7';
  c_b     CONSTANT uuid := '3f19bd70-d88c-420a-bc6a-8d4a6d9b11f6';
  v_probe boolean := COALESCE(current_setting('ca.money7_probe', true), '') = 'on';
  v_n int; v_total int := 0; v_report jsonb := '{}'::jsonb; v_disp jsonb;
BEGIN
  ---------------------------------------------------------------------------
  -- PART 1. Re-prove the facts the disposition stands on.
  ---------------------------------------------------------------------------
  IF (SELECT count(*) FROM public.tournament_players tp JOIN public.profiles p ON p.id = tp.user_id
       WHERE tp.tournament_id = c_b AND p.is_horse IS TRUE) <> 66
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = c_b) <> 66
     OR (SELECT count(*) FROM public.tournament_players tp JOIN public.profiles p ON p.id = tp.user_id
       WHERE tp.tournament_id = c_a AND p.is_horse IS TRUE) <> 155
     OR (SELECT count(*) FROM public.tournament_players WHERE tournament_id = c_a) <> 155 THEN
    RAISE EXCEPTION 'PKO disposition: the fields are no longer 66 and 155 horses';
  END IF;
  IF EXISTS (SELECT 1 FROM public.hand_history WHERE tournament_id IN (c_a, c_b))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_obligations WHERE tournament_id IN (c_a, c_b))
     OR EXISTS (SELECT 1 FROM public.tournament_bounty_awards WHERE tournament_id IN (c_a, c_b)) THEN
    RAISE EXCEPTION 'PKO disposition: knockout evidence exists after all - attribute it instead of closing';
  END IF;
  IF (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id = c_b AND type = 'credit') <> 4455.00
     OR (SELECT sum(amount) FROM public.wallet_transactions WHERE related_entity_id = c_a AND type = 'credit') <> 10462.50 THEN
    RAISE EXCEPTION 'PKO disposition: the player credits are no longer 4,455.00 and 10,462.50';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tournament_escrow WHERE tournament_id IN (c_a, c_b)
              AND (prize_balance <> 0 OR bounty_balance <> 0 OR fee_balance <> 0)) THEN
    RAISE EXCEPTION 'PKO disposition: an escrow no longer reads zero';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'satellite_feeds_only_a_deliverable_target'
                  AND tgrelid = 'public.tournaments'::regclass AND tgenabled <> 'D')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'a2_tournaments_new_satellite_target'
                  AND tgrelid = 'public.tournaments'::regclass AND tgenabled <> 'D')
     OR position('uses an unsupported bounty or Spin entry split' IN
          (SELECT prosrc FROM pg_proc WHERE oid = 'public.fn_settle_satellite_tournament_pre_money_path_gate(uuid,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PKO disposition: the recurrence guard is not in place';
  END IF;

  v_disp := jsonb_build_object('migration', c_mig, 'decision', 'closed_no_payment',
    'shortfall', 1355.00, 'tournament_id', c_b, 'field', '66 horses, 0 humans',
    'attribution', 'unavailable: hand history pruned under the horse retention policy, no knockout recorded',
    'recurrence', 'closed by 20260911110907 (#4296): satellites cannot feed a bounty/PKO target; fn_settle_satellite_tournament refuses one',
    'companion_event', jsonb_build_object('tournament_id', c_a, 'field', '155 horses', 'shortfall', 0.00));

  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         context = context || jsonb_build_object('disposition', v_disp),
         resolution = CASE (context->>'tournament_id')::uuid
           WHEN c_b THEN
             'Disposition recorded, nothing paid (CLAUDE.md 10.9, decided 2026-09-26). Sunday Funday High Roller PKO 3f19bd70 paid its field 4,455.00 against an advertised 5,810.00 (3,500.00 guarantee + 66 x 35.00 bounty): 1,355.00 short, because the 2026-09-04 satellite-award path put each 67.50 seat entirely into the prize ladder and trg_seed_bounty_head raised a bounty pool with no bank behind it. All 66 entrants were house-operated horses, so no human is short. The hand history is pruned under the horse retention policy and no knockout was ever recorded, so per-player attribution is impossible and paying club money to arbitrarily chosen horses would be fabrication. Money is conserved (seat value in - rake - credits = 0.00; escrow closed at zero). Recurrence closed by 20260911110907 (#4296): no satellite may feed a bounty/PKO target and the satellite settlement refuses one. Migration ' || c_mig || '.'
           ELSE
             'Closed, nothing owed. Sunday Funday High Roller PKO a21c0cb6 (155 entrants, all horses, all by satellite seat) paid its field exactly the advertised 10,462.50 (max(3,500, 155 x 32.50) + 155 x 35.00), through the prize ladder instead of knockouts: the 2026-09-04 satellite-award path put each 67.50 seat entirely into the prize ladder, so the bounty pool the seed trigger raised had no bank and the residual sweep was rightly refused (escrow_short). Conserved to the cent; escrow closed at zero. Recurrence closed by 20260911110907 (#4296). Migration ' || c_mig || '.'
         END
   WHERE resolved IS NOT TRUE
     AND source IN ('fn_payout_guarantee_check', 'fn_backpay_unfinalised_bounty_pools', 'trg_seed_bounty_head')
     AND (context->>'tournament_id')::uuid IN (c_a, c_b);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 6 THEN RAISE EXCEPTION 'PKO disposition: expected 6 alerts, closed %', v_n; END IF;
  v_report := v_report || jsonb_build_object('pko_disposition', v_n); v_total := v_total + v_n;

  ---------------------------------------------------------------------------
  -- 2a. Finish retry receipts on COMPLETED tournaments, and their mirrors.
  ---------------------------------------------------------------------------
  UPDATE public.financial_alerts fa
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = 'Settled. The finish refusal or unknown outcome was retried and the tournament is COMPLETED with an ended_at, payout rows exist and none is waiting on paid_at: the pool was paid through the platform''s own idempotent paths and nothing is owed. Same proof as 20260925142532. Re-verified by migration ' || c_mig || '.'
   WHERE fa.resolved IS NOT TRUE
     AND fa.source IN ('Tournament.atomic_finish_refused', 'Tournament.atomic_finish_outcome_unknown',
                       'Tournament.atomic_satellite_finish_refused', 'Tournament.atomic_satellite_finish_outcome_unknown',
                       'Satellite.stuck_completing_unawarded',
                       'drift_incident:financial_alerts:Tournament.atomic_finish_refused',
                       'drift_incident:financial_alerts:Tournament.atomic_finish_outcome_unknown')
     AND (fa.source NOT LIKE 'drift_incident:%' OR COALESCE(fa.message, '') LIKE '%drift 0 chips%')
     AND EXISTS (
       SELECT 1 FROM public.tournaments t
        WHERE t.id = (fa.context->>'tournament_id')::uuid
          AND t.status = 'COMPLETED' AND t.ended_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id = t.id)
          AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts tp WHERE tp.tournament_id = t.id AND tp.paid_at IS NULL));
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || jsonb_build_object('retry_receipts_completed', v_n); v_total := v_total + v_n;

  ---------------------------------------------------------------------------
  -- 2b. Stale guarantee / bounty alerts, re-measured.
  ---------------------------------------------------------------------------
  IF (SELECT COALESCE(sum(amount), 0) FROM public.wallet_transactions
       WHERE related_entity_id = '690bfcb0-2dca-44f6-8773-b052b49f5603' AND type = 'credit' AND category = 'prize') < 20000.00
     OR (SELECT COALESCE(sum(amount), 0) FROM public.wallet_transactions
       WHERE related_entity_id = '93cdc2f4-ac4f-4989-9cb4-d5fba627e14d' AND type = 'credit' AND category = 'bounty') <> 24.00
     OR (SELECT bounty_pool_paid FROM public.tournaments WHERE id = '93cdc2f4-ac4f-4989-9cb4-d5fba627e14d') <> 24.00 THEN
    RAISE EXCEPTION 'stale alerts: 690bfcb0 or 93cdc2f4 no longer re-measure as satisfied';
  END IF;
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = CASE id
           WHEN '5621ad5b-488b-4cfc-ad48-6b5c1f23f191' THEN
             'Stale: fired mid-settlement. Re-measured: 690bfcb0 guaranteed 20,000.00 and credited 20,000.00 of prizes, with its overlay funded. Nothing owed. Migration ' || c_mig || '.'
           ELSE
             'Stale: Midnight Bounty (NLH) 93cdc2f4 has since paid its whole 24.00 bounty pool (bounty_pool_paid 24.00, 24.00 of bounty credits). Nothing reached no player; nothing owed. Migration ' || c_mig || '.'
         END
   WHERE resolved IS NOT TRUE
     AND id IN ('5621ad5b-488b-4cfc-ad48-6b5c1f23f191', '7ea8fa53-b96f-430e-8cbe-80a9457979ec', '8d36da3d-8591-4f3e-9e9b-165b9f82949c');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 3 THEN RAISE EXCEPTION 'stale alerts: expected 3, closed %', v_n; END IF;
  v_report := v_report || jsonb_build_object('stale', v_n); v_total := v_total + v_n;

  ---------------------------------------------------------------------------
  -- 2c. Conservation alerts whose true residual is 0.00.
  ---------------------------------------------------------------------------
  CREATE TEMP TABLE zz_cons ON COMMIT DROP AS
  SELECT a.id, (a.context->>'tournament_id')::uuid AS tid, (a.context->>'delta')::numeric AS delta,
         (SELECT COALESCE(sum(pot_size), 0) FROM public.rake_records rr WHERE rr.tournament_id = (a.context->>'tournament_id')::uuid) AS pot,
         (SELECT COALESCE(sum(rake_amount), 0) FROM public.rake_records rr WHERE rr.tournament_id = (a.context->>'tournament_id')::uuid) AS rake,
         (SELECT COALESCE(sum(amount), 0) FROM public.chip_ledger l WHERE l.to_type = 'prize_liability'
             AND l.to_entity_id = (a.context->>'tournament_id')::uuid AND l.category IN ('overlay', 'correction')) AS house,
         (SELECT COALESCE(sum(CASE WHEN w.type = 'credit' THEN w.amount ELSE -w.amount END), 0) FROM public.wallet_transactions w
           WHERE w.related_entity_id = (a.context->>'tournament_id')::uuid
             AND w.category IN ('prize', 'bounty', 'refund', 'tournament_refund', 'prize_reversal')) AS credits
    FROM public.financial_alerts a
   WHERE a.source = 'fn_tournament_money_conservation' AND a.resolved IS NOT TRUE;
  -- the two bubble-protection events: seat + rebuy value is not all in pot_size,
  -- so they are proved by their house-funded bubble leg and payout row instead.
  IF EXISTS (SELECT 1 FROM zz_cons c
              WHERE c.tid NOT IN ('f7412940-5644-4194-8d57-4a97c182bf04', 'a449e853-4ee1-4e36-bd38-8fe904664d7c')
                AND round(c.pot - c.rake + c.house - c.credits, 2) <> 0) THEN
    RAISE EXCEPTION 'conservation: an alerting event does not close to 0.00: %',
      (SELECT jsonb_agg(to_jsonb(c)) FROM zz_cons c WHERE round(c.pot - c.rake + c.house - c.credits, 2) <> 0);
  END IF;
  IF (SELECT count(*) FROM public.tournament_payouts tp
       WHERE tp.tournament_id IN ('f7412940-5644-4194-8d57-4a97c182bf04', 'a449e853-4ee1-4e36-bd38-8fe904664d7c')
         AND tp.source = 'bubble_protection' AND tp.amount = 180.00) <> 2
     OR (SELECT count(*) FROM public.chip_ledger l
       WHERE l.to_entity_id IN ('f7412940-5644-4194-8d57-4a97c182bf04', 'a449e853-4ee1-4e36-bd38-8fe904664d7c')
         AND l.to_type = 'prize_liability' AND l.category = 'correction' AND l.amount = 180.00) <> 2 THEN
    RAISE EXCEPTION 'conservation: the bubble-protection legs of the two -180.00 events are not both present';
  END IF;
  UPDATE public.financial_alerts a
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = CASE WHEN c.delta = -180.00 THEN
             'Not missing money. The -180.00 is bubble protection the house funded on purpose (tournament_payouts source bubble_protection 180.00, chip_ledger correction 180.00 into prize_liability); the detector counts only category overlay as house funding. Full reconciliation (seats + cash + rebuys - rake + house - prizes) is 0.00. Migration ' || c_mig || '.'
           ELSE format('Not money. True residual re-measured 0.00: value in %s (rake_records.pot_size, which counts seat arrivals) - rake %s + house funding %s - player credits %s = 0.00. The +%s is fn_tournament_conservation_delta''s seat_income term over-crediting a recurring event from satellite payout rows that name it. Migration %s.',
                       c.pot, c.rake, c.house, c.credits, c.delta, c_mig)
         END
    FROM zz_cons c
   WHERE a.id = c.id AND a.resolved IS NOT TRUE;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || jsonb_build_object('conservation', v_n); v_total := v_total + v_n;

  ---------------------------------------------------------------------------
  -- 2d. Rake-repair success receipts.
  ---------------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM public.hand_history hh
              WHERE hh.tournament_id IS NULL AND hh.rake_amount > 0
                AND hh.created_at BETWEEN '2026-08-27' AND '2026-09-09'
                AND NOT EXISTS (SELECT 1 FROM public.rake_records rr WHERE rr.hand_id = hh.id)) THEN
    RAISE EXCEPTION 'rake repair: a retained raked cash hand still has no rake record';
  END IF;
  UPDATE public.financial_alerts
     SET resolved = true, resolved_at = now(), resolved_by = c_actor,
         resolution = 'A receipt of a repair that worked, not an open item: fn_rake_repair_unbanked banked these hands through atomic_distribute_rake (journaled). Re-verified: no raked cash hand retained from 2026-08-27 to 2026-09-09 lacks its rake record. The repair itself now self-resolves receipts of 50 chips or less. Migration ' || c_mig || '.'
   WHERE source = 'fn_rake_repair_unbanked' AND resolved IS NOT TRUE
     AND created_at < '2026-09-09';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_report := v_report || jsonb_build_object('rake_repair', v_n); v_total := v_total + v_n;

  RAISE NOTICE 'closed % alerts: %', v_total, v_report;
  IF v_probe THEN
    RAISE EXCEPTION 'PROBE OK (rolled back): closed % alerts: %', v_total, v_report;
  END IF;
END
$mig$;

COMMIT;
