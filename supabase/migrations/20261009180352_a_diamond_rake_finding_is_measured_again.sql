-- a_diamond_rake_finding_is_measured_again
--
-- A DIAMOND RAKE FINDING IS MEASURED AGAIN (2026-10-09). Full account:
-- docs/changelog/2026-10-09-the-chip-felt-counts-no-diamond-seat.md.
--
-- Until 2026-10-08 the rake law priced Diamond hands by the chip spec, where a
-- Diamond table's rake_percent and rake_cap_bb are zero by rule, so every raked
-- Diamond hand read as over_spec. fn_rake_law_violations now judges a Diamond
-- hand by its settlement receipt (diamond_rake_unsettled), and 29 of the 30
-- open ledger_reconcile_log rake findings are those Diamond hands: 568 Diamonds
-- of rake, every hand with a receipt that accepted exactly that rake.
--
-- fn_ca_escalate_reconcile_criticals re-measures a stored critical before it
-- files it, but fn_ca_remeasure_entity could only measure a club treasury, so a
-- rake_law row was "unavailable" and re-filed every hour for 36 hours after
-- the fix. This gives it the Diamond rake law: for a rake_law finding on a
-- Diamond cash table, the table is measured again exactly as
-- fn_rake_law_violations measures a Diamond hand (the recorded rake of every
-- hand of the last 48 hours against the rake its receipt accepted). Any hand
-- that disagrees keeps it critical. A rake_law finding on a chip table is still
-- "cannot measure" and still files on its history.
--
-- @live-proof: (SELECT position('A DIAMOND RAKE FINDING IS MEASURED AGAIN' IN pg_get_functiondef('public.fn_ca_remeasure_entity(text,uuid)'::regprocedure)) > 0)

BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION pg_temp.ca_swap_once(p_src text, p_anchor text, p_new text, p_what text)
RETURNS text LANGUAGE plpgsql AS $swap$
DECLARE v_n integer;
BEGIN
  v_n := (length(p_src) - length(replace(p_src, p_anchor, ''))) / length(p_anchor);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'DIAMOND_REMEASURE_ANCHOR_CHANGED: % found % times', p_what, v_n;
  END IF;
  RETURN replace(p_src, p_anchor, p_new);
END
$swap$;

DO $patch$
DECLARE
  v_src text := pg_get_functiondef('public.fn_ca_remeasure_entity(text,uuid)'::regprocedure);
BEGIN
  IF position('A DIAMOND RAKE FINDING IS MEASURED AGAIN' IN v_src) > 0 THEN
    RAISE NOTICE 'DIAMOND_REMEASURE already applied';
    RETURN;
  END IF;
  IF md5(v_src) IS DISTINCT FROM '1330499b7f4837ad80da293472226694' THEN
    RAISE EXCEPTION 'DIAMOND_REMEASURE_PREIMAGE_CHANGED';
  END IF;
  v_src := pg_temp.ca_swap_once(v_src,
$a$  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$a$,
$a$  /* A DIAMOND RAKE FINDING IS MEASURED AGAIN (2026-10-09): on a Diamond cash
     table the rake law is the settler's recompute, so measure every hand of
     the last 48 hours the way fn_rake_law_violations does (recorded rake
     against the rake its receipt accepted). ledger_balance is the accepted
     rake, stored_balance the recorded rake. */
  IF p_entity_type = 'rake_law' AND p_entity_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.tables t JOIN public.clubs c ON c.id = t.club_id
                  WHERE t.id = p_entity_id AND t.tournament_id IS NULL AND c.asset = 'diamonds') THEN
    RETURN QUERY
      WITH hd AS (
        SELECT COALESCE(hh.rake_amount, 0) AS rake,
               (SELECT (r.receipt->>'rake')::numeric
                  FROM public.poker_diamond_hand_receipts r
                 WHERE r.table_id = hh.table_id AND r.hand_number = hh.hand_number) AS settled_rake
          FROM public.hand_history hh
         WHERE hh.table_id = p_entity_id
           AND hh.tournament_id IS NULL
           AND hh.created_at > now() - interval '48 hours'
           AND hh.created_at < now() - interval '5 minutes'
      )
      SELECT true,
             COALESCE(sum(hd.settled_rake), 0),
             COALESCE(sum(hd.rake), 0),
             CASE WHEN bool_or(hd.settled_rake IS DISTINCT FROM hd.rake
                               AND (hd.settled_rake IS NOT NULL OR hd.rake > 0.005))
                  THEN 'critical' ELSE 'ok' END
        FROM hd;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::numeric, NULL::numeric, NULL::text;
$a$, 'unmeasurable');
  EXECUTE v_src;
END
$patch$;

DO $prove$
DECLARE m record; c record;
BEGIN
  IF position('A DIAMOND RAKE FINDING IS MEASURED AGAIN' IN pg_get_functiondef('public.fn_ca_remeasure_entity(text,uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'DIAMOND_REMEASURE_RESULT_CHANGED: not live';
  END IF;
  -- A chip rake_law entity is still "cannot measure".
  SELECT * INTO c FROM public.fn_ca_remeasure_entity('rake_law',
    (SELECT t.id FROM public.tables t JOIN public.clubs cl ON cl.id = t.club_id
      WHERE t.tournament_id IS NULL AND cl.asset IS DISTINCT FROM 'diamonds' LIMIT 1));
  IF c.measurable THEN
    RAISE EXCEPTION 'DIAMOND_REMEASURE_RESULT_CHANGED: a chip rake_law entity was measured';
  END IF;
END
$prove$;

COMMIT;
