-- a_diamond_house_fee_is_not_an_attribution_gap
--
-- A DIAMOND HOUSE FEE IS NOT AN ATTRIBUTION GAP (2026-10-17). RakeAttributionBacklog
-- (poker_rake_attribution_gaps > 100, fn_spin_metrics counting
-- v_tournament_rake_attribution_gaps) fired with 142 to 144 rows. Read on
-- production 2026-10-17 10:50 UTC: every one of them is a Diamond Arena event
-- (club 002c2d27 diamond-arena), tournament_rake_settlements.destination =
-- 'diamond_house', verdict credited_nobody, settled 2026-10-07 to now. Every chip
-- settlement in the last 30 days (508,227 rows across the union, two club
-- treasuries and chip retirement) is attributed; zero chip gaps.
--
-- The Diamond Arena is diamonds only (Phase 9, 2026-09-29: "remove every
-- inherited union/agent distribution"). fn_settle_tournament_rake pays a
-- Diamond event's fee to ca_diamond_house and writes no chip fee source, so no
-- VIP points, chip rakeback or agent commission is owed on it
-- (20261012113542_a_chip_week_reads_no_diamond_event says the same of the chip
-- week). "Credited nobody" is the designed outcome there, so counting it made
-- a permanent alarm that also hid any real chip gap behind it.
--
-- The view keeps every row it counted EXCEPT destination = 'diamond_house'.
-- Columns, owner, grants and every chip verdict are unchanged.
--
-- @live-proof: (SELECT position('diamond_house' IN pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF position('diamond_house' IN pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) > 0 THEN
    RAISE NOTICE 'DIAMOND_HOUSE_GAP already applied';
  ELSIF md5(pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) IS DISTINCT FROM '316450d4ce44fa135965716cce6ab8e4' THEN
    RAISE EXCEPTION 'DIAMOND_HOUSE_GAP_PREIMAGE_CHANGED: %', md5(pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass));
  END IF;
END
$guard$;

CREATE OR REPLACE VIEW public.v_tournament_rake_attribution_gaps AS
 SELECT r.tournament_id,
    r.club_id,
    r.amount,
    r.source,
    r.settled_at,
    r.attributed_at,
    r.attributed_users,
    r.attribution_error,
    t.tournament_type,
    t.variant,
    t.name,
    t.buy_in_amount,
        CASE
            WHEN (r.attributed_users IS NULL) THEN 'never_measured'::text
            WHEN (r.attributed_users = '-1'::integer) THEN 'attribution_threw'::text
            WHEN (r.attributed_users = 0) THEN 'credited_nobody'::text
            ELSE 'ok'::text
        END AS verdict
   FROM (tournament_rake_settlements r
     LEFT JOIN tournaments t ON ((t.id = r.tournament_id)))
  WHERE ((r.settled_at IS NOT NULL) AND (r.amount > (0)::numeric) AND ((r.attributed_users IS NULL) OR (r.attributed_users <= 0))
    AND (r.destination IS DISTINCT FROM 'diamond_house'::text));

COMMENT ON VIEW public.v_tournament_rake_attribution_gaps IS
  'Settled CHIP rake that reached nobody. Before 2026-08-31 this shape was invisible: fn_settle_tournament_rake stamped attributed_at whenever attribution returned ok, including when it credited zero players, so the repair sweep (which selects attributed_at IS NULL) could never see it. Since 2026-10-17 a Diamond Arena fee (destination diamond_house) is left out: it pays the Diamond house and owes no VIP points, chip rakeback or commission, so crediting nobody is its designed outcome.';

DO $verify$
DECLARE v_left bigint; v_chip_gaps bigint;
BEGIN
  SELECT count(*) INTO v_left FROM public.v_tournament_rake_attribution_gaps WHERE club_id = '002c2d27-9584-4e52-835a-bb2be148fc81';
  IF v_left <> 0 THEN
    RAISE EXCEPTION 'DIAMOND_HOUSE_GAP: % Diamond Arena rows still counted', v_left;
  END IF;
  SELECT count(*) INTO v_chip_gaps
    FROM public.tournament_rake_settlements r
   WHERE r.settled_at IS NOT NULL AND r.amount > 0
     AND (r.attributed_users IS NULL OR r.attributed_users <= 0)
     AND r.destination IS DISTINCT FROM 'diamond_house';
  IF v_chip_gaps <> (SELECT count(*) FROM public.v_tournament_rake_attribution_gaps) THEN
    RAISE EXCEPTION 'DIAMOND_HOUSE_GAP: the view drops a chip gap';
  END IF;
  IF position('diamond_house' IN pg_get_viewdef('public.v_tournament_rake_attribution_gaps'::regclass)) = 0 THEN
    RAISE EXCEPTION 'DIAMOND_HOUSE_GAP: postimage missing';
  END IF;
END
$verify$;

COMMIT;
