-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827010813; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- ═══════════════════════════════════════════════════════════════════════════
-- BASELINE THE UNLEDGERED GAP
-- ═══════════════════════════════════════════════════════════════════════════
-- 1,496 of 1,502 live-pool rows have NO chip_ledger history at all, because
-- the ledger stopped on 2026-05-03 and club_members only became the live pool
-- on 2026-08-21. That history cannot be reconstructed -- the movements were
-- never recorded, and inventing them would be fabricating an audit trail,
-- which is worse than admitting the gap.
--
-- So the gap is DRAWN A LINE UNDER instead. Each member's balance at this
-- moment is recorded as an opening position. From here, the invariant that
-- can actually be checked is:
--
--     opening_balance + (ledger movements since baseline) == chip_balance
--
-- Anything else is drift that happened ON OUR WATCH, and is real. The
-- pre-baseline gap is preserved as a number rather than smeared into the
-- ledger, so nobody later mistakes reconstructed history for the real thing.
--
-- This moves no chips. It only writes down what is already true.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.ca_chip_baseline (
  club_id          uuid        NOT NULL,
  user_id          uuid        NOT NULL,
  opening_balance  numeric     NOT NULL,
  ledger_at_baseline numeric   NOT NULL,
  unledgered_gap   numeric     NOT NULL,
  taken_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, user_id)
);
COMMENT ON TABLE public.ca_chip_baseline IS
  'Opening chip positions at 2026-08-26, the moment auditing was restored. The ledger had been silent since 2026-05-03, so pre-baseline history does not exist and is recorded here as unledgered_gap rather than fabricated. Forward reconciliation is opening_balance + ledger since taken_at vs current chip_balance.';
ALTER TABLE public.ca_chip_baseline ENABLE ROW LEVEL SECURITY;

INSERT INTO public.ca_chip_baseline (club_id, user_id, opening_balance, ledger_at_baseline, unledgered_gap)
SELECT cm.club_id,
       cm.user_id,
       COALESCE(cm.chip_balance, 0),
       COALESCE(l.net, 0),
       COALESCE(cm.chip_balance, 0) - COALESCE(l.net, 0)
FROM public.club_members cm
LEFT JOIN (
  SELECT COALESCE(to_entity_id, from_entity_id) AS uid, club_id,
         SUM(CASE WHEN to_type   = 'player_wallet' THEN amount ELSE 0 END)
       - SUM(CASE WHEN from_type = 'player_wallet' THEN amount ELSE 0 END) AS net
  FROM public.chip_ledger
  WHERE club_id IS NOT NULL
  GROUP BY 1, 2
) l ON l.uid = cm.user_id AND l.club_id = cm.club_id
ON CONFLICT (club_id, user_id) DO NOTHING;

-- Forward reconciliation: only drift that happened after the line is real.
CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
RETURNS TABLE (
  club_id uuid, user_id uuid,
  opening_balance numeric, movements_since numeric,
  expected numeric, actual numeric, drift numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT b.club_id, b.user_id, b.opening_balance,
         COALESCE(m.net, 0)                                   AS movements_since,
         b.opening_balance + COALESCE(m.net, 0)               AS expected,
         COALESCE(cm.chip_balance, 0)                         AS actual,
         COALESCE(cm.chip_balance, 0) - (b.opening_balance + COALESCE(m.net, 0)) AS drift
  FROM public.ca_chip_baseline b
  JOIN public.club_members cm
    ON cm.club_id = b.club_id AND cm.user_id = b.user_id
  LEFT JOIN LATERAL (
    SELECT SUM(CASE WHEN cl.to_type   = 'player_wallet' THEN cl.amount ELSE 0 END)
         - SUM(CASE WHEN cl.from_type = 'player_wallet' THEN cl.amount ELSE 0 END) AS net
    FROM public.chip_ledger cl
    WHERE cl.club_id = b.club_id
      AND COALESCE(cl.to_entity_id, cl.from_entity_id) = b.user_id
      AND cl.created_at >= b.taken_at
  ) m ON TRUE;
$$;

COMMENT ON FUNCTION public.fn_chip_drift_since_baseline() IS
  'Drift that happened AFTER auditing was restored on 2026-08-26. Non-zero means chips moved without a ledger row, on our watch. The pre-baseline gap is deliberately excluded: it is unknowable, not zero.';

REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role, authenticated;

DO $$
DECLARE v_rows int; v_gap numeric;
BEGIN
  SELECT count(*), round(SUM(unledgered_gap), 2) INTO v_rows, v_gap FROM public.ca_chip_baseline;
  IF v_rows = 0 THEN RAISE EXCEPTION 'baseline captured nothing'; END IF;
  RAISE NOTICE 'baseline: % members, unledgered gap %', v_rows, v_gap;
END $$;
