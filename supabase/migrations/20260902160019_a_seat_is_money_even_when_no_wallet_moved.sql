-- BACKFILLED 2026-09-02 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260902160019; the .sql file was never committed at the
-- time (chip-std phase 1.5 mirror, docs/changelog/2026-09-02-chip-std-p1-mirror.md).
-- Content is byte-exact to what ran. Do NOT re-apply; it is already live.

-- A SEAT IS MONEY EVEN WHEN NO WALLET MOVED (2026-09-02, Phase 4 of 6).
-- See supabase/migrations/20260902155525_a_seat_is_money_even_when_no_wallet_moved.sql
-- for the full rationale; the bodies below are the contract.

CREATE OR REPLACE FUNCTION public.fn_tournament_conservation_delta(p_tournament_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH m AS (
    SELECT t.id, t.ended_at,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'debit'
           AND w.category IN ('tournament_buyin','rebuy','addon')), 0) AS money_in,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'refund'), 0) AS refunds,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'prize'), 0) AS prizes,
      COALESCE((SELECT sum(w.amount) FROM public.wallet_transactions w
         WHERE w.related_entity_id = t.id AND w.type = 'credit'
           AND w.category = 'bounty'), 0) AS bounties,
      COALESCE((SELECT sum(r.rake_amount) FROM public.rake_records r
         WHERE r.tournament_id = t.id AND r.is_tournament), 0) AS rake,
      COALESCE((SELECT o.amount FROM public.tournament_guarantee_overlays o
         WHERE o.tournament_id = t.id), 0) AS funded_overlay,
      -- ACKNOWLEDGED PRE-FUNDING MINTING. Replaces the 2026-08-27T12:00:00Z
      -- date literal that used to live here: same intent, but one auditable row
      -- per event carrying the exact amount instead of a comparison that
      -- silently forgave whatever fell the right side of it. An event with no
      -- baseline row is offset by nothing.
      COALESCE((SELECT b.amount FROM public.tournament_conservation_baseline b
         WHERE b.tournament_id = t.id), 0) AS acknowledged,

      -- A SEAT ARRIVING. The target's pool and rake were both credited by
      -- fn_award_satellite_seat with no wallet debit anywhere, so without this
      -- term the target is charged for a prize it was funded to pay. The seat
      -- names its target in metadata because the payout row belongs to the
      -- SATELLITE that paid it.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.metadata->>'satellite_target_id' = t.id::text), 0) AS seat_income,

      -- A SEAT LEAVING. The satellite really did pay this out; it simply paid
      -- it in a seat rather than in chips, so no 'prize' credit exists to find.
      COALESCE((SELECT sum(sp.amount) FROM public.tournament_payouts sp
         WHERE sp.source = 'satellite_seat'
           AND sp.tournament_id = t.id), 0) AS seat_paid_out
    FROM public.tournaments t WHERE t.id = p_tournament_id
  )
  SELECT round(
      m.money_in - m.refunds - m.rake - m.prizes - m.bounties
    + m.funded_overlay
    + m.acknowledged
    + m.seat_income
    - m.seat_paid_out
  , 2)
  FROM m;
$fn$;

REVOKE ALL ON FUNCTION public.fn_tournament_conservation_delta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_conservation_delta(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_tournament_money_conservation(
  p_since_days integer DEFAULT 7,
  p_tolerance  numeric DEFAULT 0.05,
  p_limit      integer DEFAULT 25
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row       record;
  v_flagged   integer := 0;
  v_scanned   integer := 0;
  v_reported  integer := 0;
  v_resolved  integer := 0;
  v_retained  numeric := 0;
  v_unfunded  numeric := 0;
  v_worst     numeric := 0;
  v_delta     numeric;
  v_ins       integer;
  v_tol       numeric := GREATEST(p_tolerance, 0);
  v_days      integer := GREATEST(p_since_days, 1);
  v_cap       integer := GREATEST(p_limit, 1);
  v_started   timestamptz := clock_timestamp();
BEGIN
  ---------------------------------------------------------------------------
  -- Pass 1: auto-resolve open alerts that have come back inside tolerance.
  -- Unchanged from the original.
  ---------------------------------------------------------------------------
  FOR v_row IN
    SELECT fa.id, (fa.context->>'tournament_id')::uuid AS tid
      FROM public.financial_alerts fa
     WHERE fa.source = 'fn_tournament_money_conservation'
       AND fa.resolved IS NOT TRUE
       AND fa.context->>'tournament_id' IS NOT NULL
     ORDER BY fa.created_at ASC
     LIMIT 1000
  LOOP
    v_delta := public.fn_tournament_conservation_delta(v_row.tid);
    IF v_delta IS NOT NULL AND abs(v_delta) <= v_tol THEN
      UPDATE public.financial_alerts
         SET resolved = true, resolved_at = now()
       WHERE id = v_row.id;
      v_resolved := v_resolved + 1;
    END IF;
  END LOOP;

  ---------------------------------------------------------------------------
  -- Pass 2: scan the FULL p_since_days window. No LIMIT here -- that was the
  -- defect. Deltas are computed once in the CTE and the offenders are visited
  -- worst-first so that a report truncated by p_limit is still the top of the
  -- problem.
  --
  -- SATELLITES ARE IN THE SCAN NOW (2026-09-02, Phase 4). They were excluded
  -- because they could never balance, which is circular: they could never
  -- balance only because the seat a satellite pays was invisible to the delta.
  -- 'spin' stays out - its pool is funded by the Reserve Pool rather than by
  -- its own collections, and it has its own check.
  ---------------------------------------------------------------------------
  FOR v_row IN
    WITH scan AS (
      SELECT t.id, t.name, t.variant, t.ended_at,
             public.fn_tournament_conservation_delta(t.id) AS delta
        FROM public.tournaments t
       WHERE t.status IN ('COMPLETED','CANCELLED')
         AND t.ended_at > now() - make_interval(days => v_days)
         AND t.ended_at < now() - interval '30 minutes'
         AND COALESCE(t.variant, '') NOT IN ('spin')
         AND COALESCE(t.buy_in_amount, 0) + COALESCE(t.buy_in_fee, 0) > 0
    )
    SELECT s.id, s.name, s.variant, s.delta
      FROM scan s
     ORDER BY abs(s.delta) DESC NULLS LAST, s.ended_at DESC
  LOOP
    v_scanned := v_scanned + 1;
    v_delta := v_row.delta;

    IF v_delta IS NULL OR abs(v_delta) <= v_tol THEN CONTINUE; END IF;

    IF v_delta > 0 THEN v_retained := v_retained + v_delta;
    ELSE                v_unfunded := v_unfunded - v_delta; END IF;
    v_flagged := v_flagged + 1;
    v_worst := GREATEST(v_worst, abs(v_delta));

    -- p_limit caps how many NEW alerts one run may raise. Detection above is
    -- already complete and unconditional; this only throttles the write side.
    IF v_reported < v_cap THEN
      INSERT INTO public.financial_alerts (severity, source, message, context)
      SELECT 'warning', 'fn_tournament_money_conservation',
             CASE WHEN v_delta > 0
                  THEN 'Tournament retained money it never paid out: '
                  ELSE 'Tournament paid out money it never collected: ' END
               || COALESCE(v_row.name, v_row.id::text),
             jsonb_build_object('tournament_id', v_row.id, 'variant', v_row.variant,
                                'delta', v_delta)
       WHERE NOT EXISTS (
         SELECT 1 FROM public.financial_alerts
          WHERE source = 'fn_tournament_money_conservation'
            AND resolved IS NOT TRUE
            AND context->>'tournament_id' = v_row.id::text);
      GET DIAGNOSTICS v_ins = ROW_COUNT;
      v_reported := v_reported + v_ins;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'ok',               (v_flagged = 0),
    'check_ran',        true,
    'scanned',          v_scanned,
    'flagged',          v_flagged,
    'reported',         v_reported,
    'report_truncated', (v_reported >= v_cap AND v_flagged > v_reported),
    'window_days',      v_days,
    'tolerance',        v_tol,
    'report_limit',     v_cap,
    'auto_resolved',    v_resolved,
    'retained_chips',   round(v_retained, 2),
    'unfunded_chips',   round(v_unfunded, 2),
    'worst_abs_delta',  round(v_worst, 2),
    'duration_ms',      round(extract(epoch FROM clock_timestamp() - v_started) * 1000)
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_tournament_money_conservation(integer, numeric, integer) TO service_role;

DO $assert$
DECLARE
  v_income_seen   numeric;
  v_blind_sats    integer;
  v_seat_rows     integer;
  v_orphan_target integer;
  v_still_excl    integer;
BEGIN
  -- (a) THE TERM ACTUALLY MATCHES ROWS. A wrong metadata key would leave
  --     seat_income at 0 everywhere, every other assertion would still pass,
  --     and the migration would have changed nothing while reporting a fix.
  SELECT COALESCE(sum(sp.amount), 0) INTO v_income_seen
    FROM public.tournament_payouts sp
   WHERE sp.source = 'satellite_seat'
     AND sp.metadata->>'satellite_target_id' IS NOT NULL;
  IF v_income_seen <= 0 THEN
    RAISE EXCEPTION
      'seat income term matched nothing: no satellite_seat payout names a target';
  END IF;

  -- (b) EVERY SEAT NAMES A TARGET THAT EXISTS.
  SELECT count(*) INTO v_orphan_target
    FROM public.tournament_payouts sp
   WHERE sp.source = 'satellite_seat'
     AND (sp.metadata->>'satellite_target_id' IS NULL
          OR NOT EXISTS (SELECT 1 FROM public.tournaments t
                          WHERE t.id = (sp.metadata->>'satellite_target_id')::uuid));
  IF v_orphan_target > 0 THEN
    RAISE EXCEPTION 'seats whose target is missing or unnamed: %', v_orphan_target;
  END IF;

  -- (c) THE BLINDNESS SIGNATURE IS GONE. A satellite whose delta equalled the
  --     seat value it paid was the fingerprint, 11 times out of 11.
  SELECT count(*) INTO v_blind_sats
    FROM public.tournaments t
   WHERE COALESCE(t.variant, '') = 'satellite'
     AND EXISTS (SELECT 1 FROM public.tournament_payouts sp
                  WHERE sp.source = 'satellite_seat' AND sp.tournament_id = t.id)
     AND abs(COALESCE(public.fn_tournament_conservation_delta(t.id), 0)) > 0.05;
  IF v_blind_sats > 0 THEN
    RAISE EXCEPTION
      'satellites that paid seats and still do not balance: % (expected 0)', v_blind_sats;
  END IF;

  -- (d) THE SCAN NO LONGER SKIPS SATELLITES. Matched on the CODE form, not the
  --     bare word - the word appears throughout the commentary and an
  --     assertion against the bare word would refuse its own migration.
  SELECT count(*) INTO v_still_excl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'fn_tournament_money_conservation'
     AND p.prosrc LIKE '%NOT IN (''spin'', ''satellite'')%';
  IF v_still_excl > 0 THEN
    RAISE EXCEPTION 'the scan still excludes satellites';
  END IF;

  -- (e) The seat witness still holds every seat ever awarded.
  SELECT count(*) INTO v_seat_rows
    FROM public.tournament_payouts WHERE source = 'satellite_seat';
  IF v_seat_rows < 23 THEN
    RAISE EXCEPTION
      'expected at least the 23 back-filled seat payouts, found %', v_seat_rows;
  END IF;

  RAISE NOTICE 'phase 4: seat income visible = %, seat payout rows = %',
    v_income_seen, v_seat_rows;
END;
$assert$;
