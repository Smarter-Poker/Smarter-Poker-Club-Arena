-- 2026-08-31 — MTT Phase 3: the back catalogue gets its evidence.
--
-- 44,091 completed tournaments were paid with no record of the payment beyond
-- two mutable columns. Going forward fn_credit_and_log writes one. This
-- migration reconstructs the history, and it can do so honestly because the
-- evidence was never actually lost — it was in wallet_credit_idempotency the
-- whole time. Every credit this platform has ever made passed through
-- fn_credit_player_wallet_once, which insists on a key, and the key encodes
-- the tournament and (for most shapes) the finishing place.
--
-- TWO SOURCES, IN ORDER OF QUALITY
--
-- 1. wallet_credit_idempotency — 70,478 rows from 2026-07-24 onward, when the
--    keyed credit path began. The key gives the place and the kind of payment,
--    parsed by fn_tournament_payout_shape (the same function the live writer
--    uses, so the two cannot drift).
--
-- 2. wallet_transactions — 1,191 rows from 2026-04-14 to 2026-07-29, for
--    events that predate the keyed path entirely and therefore have no key at
--    all. Place comes from the ledger description, which is machine-written
--    and has exactly two shapes ('Tournament winner prize: 1st place' and
--    'Tournament prize: position N'). These carry a synthetic key
--    `ledger:{wallet_transaction_id}` so they remain unique and are visibly
--    NOT a real credit key, and `recorded_by = 'backfill_ledger_2026_08_31'`
--    so no reader can mistake the weaker source for the stronger one.
--
--    Source 2 is applied ONLY to tournaments with no keyed evidence at all.
--    Mixing the two on one event would double-count it.
--
-- DELIBERATELY EXCLUDED: addon, rebuy, cancelrefund, bubbleprotection. Those
-- are entry-side money — a buy-in returned is not a prize won, and putting it
-- in the payout record would make every reconciliation that sums this table
-- read high.
--
-- WHAT IS DELIBERATELY LEFT NULL, AND WHY
--
-- `payout_structure` is NULL on every backfilled row. A snapshot means "the
-- structure as it stood when this place was priced"; the structure sitting on
-- the row today is not that, and writing it would produce a record that looks
-- like evidence and is not. An empty column is honest; a plausible wrong one
-- is worse than nothing. `prize_pool` and `field_size` ARE filled, but only
-- for events in a terminal state, where those numbers can no longer move.
--
-- IDEMPOTENT. Every INSERT is ON CONFLICT DO NOTHING against the unique
-- idempotency_key, and both arms are anti-joined against what is already
-- recorded. Re-running this file inserts nothing.
--
-- RESULT, MEASURED AFTER APPLYING:
--   backfill_2026_08_31         70,478 rows  43,325 tournaments  $3,283,772.48
--   backfill_ledger_2026_08_31   1,191 rows     980 tournaments  $    9,185.90
--   completed events with a prize pool and still no record:  6
--   ...and all six are satellites, which award seats rather than cash.
--
-- TIER: 3 (writes 71k rows to a money-adjacent table). ROLLBACK at the bottom,
-- and it is exact: every row this migration creates carries its marker.

BEGIN;

SET LOCAL statement_timeout = '600s';

-- ---------------------------------------------------------------------------
-- ARM 1 — the keyed era (2026-07-24 onward)
-- ---------------------------------------------------------------------------
WITH candidate AS (
  SELECT w.key, w.user_id, w.amount, w.created_at,
         split_part(w.key, ':', 2)::uuid AS tid
    FROM public.wallet_credit_idempotency w
   WHERE (w.key LIKE 'tourney:%' OR w.key LIKE 'mb:%'
          OR w.key LIKE 'mb-residual:%' OR w.key LIKE 'spin:%')
     AND w.user_id IS NOT NULL
     AND w.amount  IS NOT NULL
     AND split_part(w.key, ':', 2) ~ '^[0-9a-f]{8}-'
     AND NOT EXISTS (SELECT 1 FROM public.tournament_payouts p
                      WHERE p.idempotency_key = w.key)
),
shaped AS (
  SELECT c.*, s.source, s.place
    FROM candidate c, LATERAL public.fn_tournament_payout_shape(c.key) s
   WHERE s.source IS NOT NULL
),
field AS (
  SELECT tp.tournament_id, count(*)::integer AS field_size
    FROM public.tournament_players tp
   WHERE tp.tournament_id IN (SELECT tid FROM shaped)
   GROUP BY tp.tournament_id
)
INSERT INTO public.tournament_payouts
  (tournament_id, user_id, "position", amount, source, idempotency_key,
   paid_at, tournament_type, field_size, prize_pool, payout_structure,
   recorded_by)
SELECT s.tid, s.user_id, s.place, s.amount, s.source, s.key, s.created_at,
       t.tournament_type,
       CASE WHEN t.status IN ('COMPLETED','CANCELLED') THEN f.field_size END,
       CASE WHEN t.status IN ('COMPLETED','CANCELLED') THEN t.prize_pool  END,
       NULL, 'backfill_2026_08_31'
  FROM shaped s
  JOIN public.tournaments t ON t.id = s.tid
  LEFT JOIN field f ON f.tournament_id = s.tid
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

-- ---------------------------------------------------------------------------
-- ARM 2 — the pre-key era (2026-04-14 to 2026-07-29), from the ledger
-- ---------------------------------------------------------------------------
WITH uncovered AS (
  SELECT t.id, t.tournament_type, t.status, t.prize_pool
    FROM public.tournaments t
   WHERE NOT EXISTS (SELECT 1 FROM public.tournament_payouts p
                      WHERE p.tournament_id = t.id)
),
led AS (
  SELECT w.id AS wt_id, w.user_id, w.amount, w.created_at,
         u.id AS tid, u.tournament_type, u.status, u.prize_pool,
         CASE
           WHEN w.description ~* 'winner prize' THEN 1
           ELSE NULLIF((regexp_match(w.description, 'position ([0-9]+)'))[1], '')::int
         END AS place,
         CASE WHEN w.description ~* 'back-pay' THEN 'spin_backpay'
              ELSE 'structure' END AS source
    FROM public.wallet_transactions w
    JOIN uncovered u ON u.id = w.related_entity_id
   WHERE w.category = 'prize'
)
INSERT INTO public.tournament_payouts
  (tournament_id, user_id, "position", amount, source, idempotency_key,
   paid_at, tournament_type, field_size, prize_pool, payout_structure,
   recorded_by)
SELECT led.tid, led.user_id, led.place, led.amount, led.source,
       'ledger:' || led.wt_id::text,
       led.created_at, led.tournament_type,
       CASE WHEN led.status IN ('COMPLETED','CANCELLED')
            THEN (SELECT count(*)::int FROM public.tournament_players tp
                   WHERE tp.tournament_id = led.tid) END,
       CASE WHEN led.status IN ('COMPLETED','CANCELLED') THEN led.prize_pool END,
       NULL, 'backfill_ledger_2026_08_31'
  FROM led
ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

COMMIT;

-- ===========================================================================
-- ROLLBACK (exact — the marker column makes it so)
-- ===========================================================================
-- BEGIN;
-- SET LOCAL app.payout_record_correction = 'i_am_correcting_the_record';
-- DELETE FROM public.tournament_payouts
--  WHERE recorded_by IN ('backfill_2026_08_31', 'backfill_ledger_2026_08_31');
-- COMMIT;
