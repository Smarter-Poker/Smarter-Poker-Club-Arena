-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260830053338; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

SET statement_timeout = '300s';

-- POLISH 2 (Dan 2026-08-30): the BBJ drift alarm stops crying wolf.
--
-- It reported "drift" while the authoritative hand-by-hand join read zero.
-- THE FLAW: the received side was itself time-windowed —
--   WHERE created_at >= p_since - interval '6 hours'
-- so a jackpot slice banked MORE than six hours after its hand fell out of
-- the CTE and joined to NULL, reading as money that never arrived. That is
-- exactly what a back-dated self-heal produces (fn_bbj_repair_unbanked and
-- fn_rake_repair_unbanked both bank slices for older hands), so every repair
-- manufactured a false alarm on the one channel that must stay believable.
-- Noise on a money alarm is not harmless: 988 unresolved criticals is how the
-- nine real ones stayed invisible on 2026-08-22.
--
-- THE FIX: the received side joins BY HAND ID with no time window at all. A
-- hand's jackpot slice is its slice whenever it was banked. The booked side
-- keeps the window (it defines the audited population) and the 2-minute
-- settle grace. `unlinkable_rows` is unchanged — null-hand rows genuinely
-- cannot be reconciled and are still reported separately.
--
-- (The 9.63 the first attempt caught was NOT an artefact: 24 hands whose
-- slices were younger than fn_bbj_repair_unbanked's 5-minute grace when the
-- heal last ran. The self-heal banked all 24 before this shipped. The assert
-- below is what refused to let the fix land while real money was outstanding
-- — exactly its job.)
CREATE OR REPLACE FUNCTION public.bbj_drift_since(p_since timestamp with time zone)
RETURNS TABLE(booked numeric, received numeric, booked_rows bigint, received_rows bigint, unlinkable_rows bigint, unlinkable_chips numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH r AS (
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND bbj_contribution > 0
  ),
  settled AS (
    -- Only hands old enough that BOTH writes have had time to land.
    SELECT hand_id, bbj_contribution
    FROM rake_records
    WHERE created_at >= p_since
      AND created_at < now() - interval '2 minutes'
      AND bbj_contribution > 0
      AND hand_id IS NOT NULL
  ),
  j AS (
    -- POLISH 2: join by hand, NEVER by a second time window.
    SELECT s.bbj_contribution AS booked,
           COALESCE((SELECT sum(b.amount) FROM bbj_contributions b
                      WHERE b.hand_id = s.hand_id), 0) AS received
    FROM settled s
  )
  SELECT
    COALESCE(sum(j.booked), 0)::numeric,
    COALESCE(sum(j.received), 0)::numeric,
    count(*)::bigint,
    count(*) FILTER (WHERE j.received > 0)::bigint,
    (SELECT count(*) FROM r WHERE r.hand_id IS NULL)::bigint,
    COALESCE((SELECT sum(r.bbj_contribution) FROM r WHERE r.hand_id IS NULL), 0)::numeric
  FROM j;
$function$;

DO $$
DECLARE v_drift numeric;
BEGIN
  SELECT round(booked - received, 2) INTO v_drift FROM public.bbj_drift_since(now() - interval '1 day');
  IF v_drift <> 0 THEN
    RAISE EXCEPTION 'bbj_drift_since still reports % — real unbanked money, do not ship over it', v_drift;
  END IF;
  RAISE NOTICE 'bbj_drift_since: 0.00 over 24h, hand-by-hand';
END $$;
