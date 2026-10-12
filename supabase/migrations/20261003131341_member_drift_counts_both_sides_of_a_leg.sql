-- 20261003131341_member_drift_counts_both_sides_of_a_leg.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- MEMBER DRIFT COUNTS BOTH SIDES OF A LEG (phase 6 of 9: money edges).
-- Full account: docs/changelog/2026-10-03-member-drift-counts-both-sides-of-a-leg.md.
--
-- fn_chip_integrity_report has read CRITICAL since 2026-10-01: "670 member(s)
-- drifting, worst 103747.97". fn_ca_conservation_sweep re-files it every hour
-- (57 sightings). Read from production on 2026-10-03: the 670 drifts sum to
-- exactly 0.00 (gross 645,215.28; 664 up, 6 down, the six all paying horses).
-- fn_chip_drift_since_baseline grouped each journal leg under ONE player, the
-- to side when it was a player_wallet, and summed both sides there. Since
-- 2026-09-29 rakeback and commission are paid wallet to wallet (1,905 legs,
-- 1,022,959.37 chips), so each such leg netted to zero for the receiver and
-- never reached the payer.
--
-- Counting each side for the member it names, every one of the 1,502 baseline
-- memberships reconciles to the cent: 0 drifting. No chip moved and no
-- balance was wrong; the reading was.
--
-- Refuses to run if the function is not the text measured or its grants
-- differ; refuses to commit unless the installed text, the grants and a
-- zero-drift reading all hold. No job is added. No chips move.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_chip_drift_since_baseline()'::regprocedure)) = '6e7f006fb462ab5e008f94a6d6df63e8')

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $pre$
BEGIN
  IF md5(pg_get_functiondef('public.fn_chip_drift_since_baseline()'::regprocedure)) IS DISTINCT FROM 'd0f1d4f355477669a4bc0427de757581' THEN
    RAISE EXCEPTION 'MEMBER_DRIFT_PREIMAGE_CHANGED';
  END IF;
  IF (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_chip_drift_since_baseline()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'MEMBER_DRIFT_AUTHORITY_CHANGED';
  END IF;
END
$pre$;

CREATE OR REPLACE FUNCTION public.fn_chip_drift_since_baseline()
 RETURNS TABLE(club_id uuid, user_id uuid, opening_balance numeric, movements_since numeric, expected numeric, actual numeric, drift numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH span AS (SELECT MIN(taken_at) AS t0 FROM public.ca_chip_baseline),
  /* EVERY SIDE OF A LEG IS ITS OWN MOVEMENT (2026-10-03). A leg moves chips
     out of its from side and into its to side, and each side is counted for
     the member it names. The reading this replaces grouped a leg under ONE
     player - the to side when it was a player_wallet - and summed both sides
     there, so a leg between two player wallets (rakeback and commission paid
     wallet to wallet since 2026-09-29: 1,905 legs, 1,022,959.37 chips) netted
     to zero for the receiver and never reached the payer. 670 members read
     as drifting by 645,215.28 in all and exactly 0.00 net, worst -103,747.97,
     every chip of it accounted for in the journal. */
  sides AS (
    SELECT cl.club_id AS c_id, cl.to_entity_id AS u_id, cl.amount AS amt
      FROM public.chip_ledger cl, span
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= span.t0
       AND cl.to_type = 'player_wallet'
    UNION ALL
    SELECT cl.club_id, cl.from_entity_id, -cl.amount
      FROM public.chip_ledger cl, span
     WHERE cl.club_id IS NOT NULL
       AND cl.created_at >= span.t0
       AND cl.from_type = 'player_wallet'
  ),
  moves AS (
    SELECT s.c_id, s.u_id, sum(s.amt) AS net
      FROM sides s
     GROUP BY 1, 2
  )
  SELECT b.club_id, b.user_id, b.opening_balance,
         COALESCE(m.net, 0)                              AS movements_since,
         b.opening_balance + COALESCE(m.net, 0)          AS expected,
         COALESCE(cm.chip_balance, 0)                    AS actual,
         COALESCE(cm.chip_balance, 0) - (b.opening_balance + COALESCE(m.net, 0)) AS drift
  FROM public.ca_chip_baseline b
  JOIN public.club_members cm
    ON cm.club_id = b.club_id AND cm.user_id = b.user_id
  LEFT JOIN moves m
    ON m.c_id = b.club_id AND m.u_id = b.user_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_chip_drift_since_baseline() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_chip_drift_since_baseline() TO service_role;

COMMENT ON FUNCTION public.fn_chip_drift_since_baseline() IS 'Drift that happened AFTER auditing was restored on 2026-08-26. Non-zero means chips moved without a ledger row, on our watch. Each side of a leg is counted for the member it names - out of the from side, into the to side - so a leg between two player wallets moves both. The pre-baseline gap is excluded: it is unknowable, not zero.';

DO $post$
DECLARE
  v_drifting bigint;
  v_worst numeric;
BEGIN
  IF md5(pg_get_functiondef('public.fn_chip_drift_since_baseline()'::regprocedure)) IS DISTINCT FROM '6e7f006fb462ab5e008f94a6d6df63e8'
     OR (SELECT proacl::text FROM pg_proc WHERE oid = 'public.fn_chip_drift_since_baseline()'::regprocedure) IS DISTINCT FROM '{postgres=X/postgres,service_role=X/postgres}' THEN
    RAISE EXCEPTION 'MEMBER_DRIFT_RESULT_CHANGED';
  END IF;
  SELECT count(*) FILTER (WHERE abs(d.drift) > 0.01), COALESCE(max(abs(d.drift)), 0)
    INTO v_drifting, v_worst
    FROM public.fn_chip_drift_since_baseline() d;
  IF v_drifting <> 0 THEN
    RAISE EXCEPTION 'MEMBER_DRIFT_RESULT_CHANGED: % member(s) still drift, worst %', v_drifting, v_worst;
  END IF;
END
$post$;

COMMIT;
