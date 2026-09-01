-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260831135710; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET LOCAL statement_timeout = '600s';

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
