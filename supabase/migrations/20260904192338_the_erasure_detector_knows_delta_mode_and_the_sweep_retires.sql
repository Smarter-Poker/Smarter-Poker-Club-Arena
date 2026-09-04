-- ═══════════════════════════════════════════════════════════════════════════
-- THE ERASURE DETECTOR LEARNS THAT DELTA MODE CANNOT ERASE, AND THE SWEEP
-- RETIRES (chip standard, 2026-09-04 19:xx UTC).
--
-- What happened. fn_ca_find_erased_seat_credits was written against the
-- absolute era, where a credit that reached table_seats.stack between two
-- hands and was missing from the engine's memory was overwritten by the
-- next hand's write. Its evidence is the hand pair: same players, the felt
-- in hand_history moved by exactly -(rake + bbj), exactly one credit in
-- between. In DELTA mode that evidence no longer means erased. hand_history
-- shows the engine's memory, and when memory misses a credit the delta
-- write preserves it on the row (ca_seat_stack_rebases) and the engine
-- adopts it at the next deal - the felt in memory is quiet across the
-- boundary and the chips are still there. The hourly sweep kept running the
-- detector over delta-mode hours, and from 15:20 to 18:20 UTC it restored
-- 15 credits that had never been lost: 3,867.99 chips, minted from
-- issuance_reserve into 15 club wallets a second time. Each case was read
-- (rebase row or the next hand's stack carrying the credit; the boundary
-- hand's settlement row says mode = delta). The sweep never retired itself
-- because those false positives kept its "nothing to restore" condition
-- false.
--
-- What this does.
-- 1. The detector refuses a boundary whose hand was settled in delta mode:
--    if ca_settlements holds a delta-mode row for that hand, the write
--    could not have erased anything, whatever hand_history looks like.
-- 2. The sweep is unscheduled (done by hand at 19:14:51 UTC, six minutes
--    before its next run; repeated here so the migration is the record)
--    and its function dropped. The structural guarantee it was covering for
--    has been live since the 12:55 cutover: zero absolute-mode hand writes
--    since. Dan's standard: no crons where a structural guarantee exists.
-- 3. The 15 double credits stay with the players. CLAUDE.md 10.9 rule 3:
--    an overpay our defect caused is absorbed by the house, reported and
--    left alone. They are already in the mint register as issuance (that is
--    what they are); this migration files the incident with the amount and
--    every transaction id, resolved with this migration as the correction.
-- 4. Every number is asserted, so the migration aborts if the board moved.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. The detector.
CREATE OR REPLACE FUNCTION public.fn_ca_find_erased_seat_credits(p_since timestamp with time zone, p_until timestamp with time zone DEFAULT now())
 RETURNS TABLE(restore_key text, source text, source_id uuid, table_id uuid, user_id uuid, club_id uuid, amount numeric, credited_at timestamp with time zone, prev_hand bigint, next_hand bigint, is_horse boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (current_user IN ('postgres', 'service_role')) THEN
    RAISE EXCEPTION 'fn_ca_find_erased_seat_credits is operator/service only';
  END IF;
  RETURN QUERY
  WITH h AS (
    SELECT hh.id, hh.table_id, hh.hand_number, hh.created_at, hh.rake_amount, COALESCE(hh.bbj_amount, 0) AS bbj,
           (SELECT sum((q->>'stack')::numeric) FROM jsonb_array_elements(hh.players) q) AS felt,
           (SELECT array_agg((q->>'userId')::uuid ORDER BY q->>'userId') FROM jsonb_array_elements(hh.players) q) AS ids
      FROM public.hand_history hh
     WHERE hh.tournament_id IS NULL
       AND hh.created_at > p_since - interval '30 minutes' AND hh.created_at <= p_until + interval '30 minutes'
  ), pairs AS (
    SELECT h.*, lag(h.felt) OVER w AS prev_felt, lag(h.created_at) OVER w AS prev_at,
           lag(h.hand_number) OVER w AS prev_hand_number, (h.ids = lag(h.ids) OVER w) AS same_players
      FROM h WINDOW w AS (PARTITION BY h.table_id ORDER BY h.hand_number)
  ), quiet AS (
    -- a boundary whose felt moved by exactly -(rake+bbj): nothing arrived IN MEMORY.
    -- Only an absolute-mode write turns that into a loss: a delta-mode write
    -- preserves what memory missed (ca_seat_stack_rebases), so a boundary whose
    -- hand was settled in delta mode is excluded here, whatever memory shows.
    SELECT p.table_id, p.prev_at, p.created_at, p.prev_hand_number, p.hand_number, p.ids
      FROM pairs p
     WHERE p.same_players AND p.prev_felt IS NOT NULL
       AND round(p.felt - p.prev_felt + p.rake_amount + p.bbj, 2) = 0
       AND NOT EXISTS (SELECT 1 FROM public.ca_settlements s
                        WHERE s.settlement_type = 'hand_stacks' AND s.table_id = p.table_id
                          AND s.hand_id = md5('ca-hand:' || p.table_id::text || ':' || p.hand_number::text)::uuid
                          AND s.totals->>'mode' = 'delta')
  ), credits AS (
    SELECT 'pending_addon'::text AS source, pa.id AS source_id, pa.table_id, pa.user_id,
           round(pa.applied_to_stack, 2) AS amount, pa.resolved_at AS credited_at,
           (SELECT l.club_id FROM public.chip_ledger l
             WHERE l.category = 'addon' AND l.from_entity_id = pa.user_id AND l.to_entity_id = pa.table_id
               AND round(l.amount, 2) = round(pa.amount, 2)
               AND l.created_at BETWEEN pa.created_at - interval '5 seconds' AND pa.created_at + interval '5 seconds'
             ORDER BY abs(extract(epoch FROM (l.created_at - pa.created_at))) LIMIT 1) AS debited_club
      FROM public.table_pending_addons pa
     WHERE pa.resolved_at > p_since AND pa.resolved_at <= p_until AND pa.applied_to_stack > 0
    UNION ALL
    SELECT 'addon_leg', l.id, l.to_entity_id, l.from_entity_id, round(l.amount, 2), l.created_at, l.club_id
      FROM public.chip_ledger l
     WHERE l.category = 'addon' AND l.to_type = 'table_stack' AND l.from_type = 'player_wallet'
       AND l.created_at > p_since AND l.created_at <= p_until
       AND NOT EXISTS (SELECT 1 FROM public.table_pending_addons q
                        WHERE q.user_id = l.from_entity_id AND q.table_id = l.to_entity_id
                          AND round(q.amount, 2) = round(l.amount, 2)
                          AND q.created_at BETWEEN l.created_at - interval '5 seconds' AND l.created_at + interval '5 seconds')
  )
  SELECT ('seat_credit_erased:' || c.source || ':' || c.source_id::text) AS restore_key,
         c.source, c.source_id, c.table_id, c.user_id,
         COALESCE(c.debited_club,
                  (SELECT ts.club_id FROM public.table_seats ts
                    WHERE ts.table_id = c.table_id AND ts.user_id = c.user_id
                    ORDER BY ts.joined_at DESC LIMIT 1),
                  (SELECT t.club_id FROM public.tables t WHERE t.id = c.table_id)) AS club_id,
         c.amount, c.credited_at, q.prev_hand_number::bigint, q.hand_number::bigint,
         COALESCE((SELECT pr.is_horse FROM public.profiles pr WHERE pr.id = c.user_id), false) AS is_horse
    FROM credits c
    JOIN quiet q ON q.table_id = c.table_id AND c.user_id = ANY(q.ids)
                AND c.credited_at > q.prev_at AND c.credited_at <= q.created_at
   WHERE NOT EXISTS (   -- exactly one credit in the window, so the identity attributes it
           SELECT 1 FROM credits c2
            WHERE c2.table_id = c.table_id AND c2.source_id <> c.source_id
              AND c2.credited_at > q.prev_at AND c2.credited_at <= q.created_at)
     AND NOT EXISTS (   -- and no other seat movement on the table between the hands
           SELECT 1 FROM public.chip_ledger l
            WHERE l.created_at > q.prev_at AND l.created_at <= q.created_at
              AND l.category IN ('buyin', 'rebuy', 'horse_funding', 'table_cashout')
              AND (l.to_entity_id = c.table_id OR l.from_entity_id = c.table_id OR l.table_id = c.table_id))
     AND NOT EXISTS (SELECT 1 FROM public.wallet_credit_idempotency k
                      WHERE k.key = 'seat_credit_erased:' || c.source || ':' || c.source_id::text)
   ORDER BY c.credited_at;
END;
$function$;
COMMENT ON FUNCTION public.fn_ca_find_erased_seat_credits(timestamptz, timestamptz) IS
  'Lists seat credits erased by an ABSOLUTE-mode hand-stack write (same players, felt in memory moved by exactly -(rake+bbj), one credit in the window, no other seat movement). A boundary settled in delta mode is never reported: the delta write preserves what memory missed (20260904 detector correction).';

-- 2. The sweep retires. cron.unschedule was run by hand at 19:14:51 UTC so
--    the 19:20 run could not fire; repeated here for the record.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-erased-seat-credit-sweep') THEN
    PERFORM cron.unschedule('ca-erased-seat-credit-sweep');
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.fn_ca_erased_seat_credit_sweep();

-- 3 + 4. The fifteen double credits, read and asserted, filed and resolved.
DO $$
DECLARE
  v_n int; v_sum numeric; v_ids uuid[]; v_wallets uuid[]; v_live int; v_inc uuid;
BEGIN
  WITH r AS (
    SELECT t.id tx, t.amount, t.to_user_id uid, t.club_id,
           split_part(t.metadata->>'restore_key', ':', 2) src,
           split_part(t.metadata->>'restore_key', ':', 3)::uuid ref
      FROM public.chip_transactions t
     WHERE t.transaction_type = 'seat_credit_restored' AND t.created_at > '2026-09-04 12:00:00+00'
  ), c AS (
    SELECT r.*, COALESCE(a.resolved_at, l.created_at) credit_at, COALESCE(a.table_id, l.to_entity_id) tbl
      FROM r LEFT JOIN public.table_pending_addons a ON r.src = 'pending_addon' AND a.id = r.ref
             LEFT JOIN public.chip_ledger l ON r.src = 'addon_leg' AND l.id = r.ref
  ), fp AS (
    SELECT c.* FROM c
     WHERE (SELECT s.totals->>'mode' FROM public.ca_settlements s
             WHERE s.table_id = c.tbl AND s.settlement_type = 'hand_stacks' AND s.created_at > c.credit_at
             ORDER BY s.created_at LIMIT 1) = 'delta'
  )
  SELECT count(*), sum(amount), array_agg(tx), array_agg(DISTINCT uid) INTO v_n, v_sum, v_ids, v_wallets FROM fp;

  IF v_n <> 15 OR v_sum <> 3867.99 THEN
    RAISE EXCEPTION 'expected 15 double restorations / 3867.99, found % / %', v_n, v_sum;
  END IF;

  -- With the corrected detector, the delta era is clean: nothing to restore
  -- since 14:00 UTC (the last absolute-mode boundaries were restored at 13:20).
  SELECT count(*) INTO v_live FROM public.fn_ca_find_erased_seat_credits('2026-09-04 14:00:00+00', now() - interval '15 minutes');
  IF v_live <> 0 THEN
    RAISE EXCEPTION 'the corrected detector still reports % credit(s) in the delta era', v_live;
  END IF;

  v_inc := public.fn_ca_raise_drift_incident(
    'fn_ca_erased_seat_credit_sweep', 'ledger_imbalance', 'warning',
    'erased-seat-credit-sweep-false-positives:2026-09-04',
    v_sum, 0, v_sum, 'ledger', 'table_seats', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    v_wallets, v_ids,
    'the erasure detector treated delta-mode hand boundaries as absolute ones; 15 credits that delta mode had preserved (rebased or adopted at the next deal) were restored a second time, 15:20-18:20 UTC',
    true, jsonb_build_object('count', v_n, 'total', v_sum, 'transaction_ids', to_jsonb(v_ids)));

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration the_erasure_detector_knows_delta_mode_and_the_sweep_retires',
         root_cause = 'fn_ca_find_erased_seat_credits read hand_history (engine memory) as the felt; in delta mode memory can miss a credit the row keeps',
         resolution = 'detector excludes delta-mode boundaries; sweep unscheduled and dropped; the 3,867.99 stays with the 15 players (CLAUDE.md 10.9 rule 3: our defect, absorbed, not clawed back) and is already registered as issuance in ca_mint_ledger'
   WHERE dedupe_key = 'erased-seat-credit-sweep-false-positives:2026-09-04';

  UPDATE public.ca_drift_incidents
     SET status = 'resolved', resolved_at = now(),
         correction_ref = 'migration the_erasure_detector_knows_delta_mode_and_the_sweep_retires',
         root_cause = 'seat credits erased by the pre-delta engine (defect 0) restored hourly by the deploy-gap sweep; runs from 15:20 UTC on were false positives of the detector in delta mode',
         resolution = CASE WHEN detected_at >= '2026-09-04 15:00:00+00'
                           THEN 'this run restored credits delta mode had preserved - see erased-seat-credit-sweep-false-positives:2026-09-04'
                           ELSE 'genuine absolute-era restorations; sweep retired in this migration' END
   WHERE source = 'fn_ca_erased_seat_credit_sweep' AND status = 'open'
     AND dedupe_key <> 'erased-seat-credit-sweep-false-positives:2026-09-04';

  IF to_regprocedure('public.fn_ca_erased_seat_credit_sweep()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ca-erased-seat-credit-sweep') THEN
    RAISE EXCEPTION 'the sweep did not retire';
  END IF;
END $$;
