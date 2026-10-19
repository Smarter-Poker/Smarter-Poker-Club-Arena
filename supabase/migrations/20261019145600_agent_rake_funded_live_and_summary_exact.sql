-- 20261019145600_agent_rake_funded_live_and_summary_exact
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-19 14:56:00 UTC.
--
-- WHY (two reporting defects, no money moves).
-- 1. fn_agent_downline_rake read days not yet rolled up from rake_records
--    WHERE r.club_id = <member club>. Union play files the hand under the union
--    club (fade0000-...) while the rake is credited to the member club in
--    rake_attributions, so today read 0.00 for an agent whose downline had
--    already paid ~1,650 in cash rake (ca_club_rake_daily_user). Closed days
--    come from the nightly rollup, which already reads rake_attributions by the
--    credited club, so closed and live days disagreed.
-- 2. ca_club_members_summary chose the viewer's role across the whole union
--    (fn_club_scope_ids) while ca_club_roster_rows and the roster live channel
--    require membership of this exact club. A JAQK agent opening Midway Union
--    got viewer_role agent / can_view_financials true / total 267 while the
--    list returned 0 rows and live updates were refused.
--
-- WHAT.
-- 1. The live part of fn_agent_downline_rake (head, tail and un-rolled days)
--    reads rake_attributions under the credited club with the rollup's own
--    launch-accounting rule, so live == fee ledger and live == rollup. Display
--    only: no database function other than fn_agent_downline_rake_summary
--    calls it; commission calculation and payment are untouched. It remains
--    cash rake (tournament fees are not included) and "hands" are raked hands;
--    the panel now says so.
-- 2. The three viewer lookups in ca_club_members_summary use cm.club_id =
--    p_club_id. Platform admins and union overseers keep their existing paths.
--
-- PROOF (production, BEGIN ... ROLLBACK, 2026-10-19 15:10 UTC, agent Kicker Wes
-- in JAQK): today 0.00 -> 1,670.02 (fee ledger 1,670.02); last 7 days
-- 10,386.40 -> 12,056.42 (fee ledger 12,056.42); window starting mid-day
-- yesterday 0.00 -> 3,273.50 (attributions 3,273.50); ~260 ms. JAQK agent on
-- Midway Union: summary agent/true/267 -> NULL, list 0 (agrees). Union
-- overseer: owner 267, list 267 (unchanged). Plain player still refused.
-- @live-proof: position('edge_att AS MATERIALIZED' IN pg_get_functiondef('public.fn_agent_downline_rake(uuid,uuid,timestamp with time zone,timestamp with time zone,text,integer)'::regprocedure))>0 AND position('ANY(v_scope)' IN pg_get_functiondef('public.ca_club_members_summary(uuid)'::regprocedure))=0
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $patch$
DECLARE d text; i_start int; i_end int; new_live text;
BEGIN
 SELECT pg_get_functiondef('public.fn_agent_downline_rake(uuid,uuid,timestamp with time zone,timestamp with time zone,text,integer)'::regprocedure) INTO d;
 IF md5(d)<>'51b46bfa201859f130d3d0347ad90268' THEN
   RAISE EXCEPTION 'Downline rake preimage changed; qualify current definition';
 END IF;
 i_start:=strpos(d,'  edge_hands AS MATERIALIZED (');
 i_end:=strpos(d,'  earned AS MATERIALIZED (');
 IF i_start=0 OR i_end=0 OR i_end<=i_start THEN RAISE EXCEPTION 'Downline rake live-source block missing'; END IF;
 new_live:=$new$  -- FUNDED-CLUB LIVE RAKE (2026-10-19). Days not yet rolled up read the same
  -- rows the nightly rollup reads: rake_attributions under the club the rake
  -- is credited to, with the same launch-accounting rule. Union hands are
  -- filed under the union club in rake_records, so the old live read found
  -- none of them for a member club and today showed 0.00. Cash rake only.
  edge_att AS MATERIALIZED (
    SELECT a.player_id AS user_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM rake_attributions a
      JOIN in_scope_clubs c ON c.club_id = a.club_id
     WHERE a.created_at >= v_from AND a.created_at < v_head_end
       AND a.rake_amount > 0 AND a.player_id IS NOT NULL
    UNION ALL
    SELECT a.player_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM rake_attributions a
      JOIN in_scope_clubs c ON c.club_id = a.club_id
     WHERE a.created_at >= v_tail_start AND a.created_at < v_to
       AND a.rake_amount > 0 AND a.player_id IS NOT NULL
    UNION ALL
    SELECT a.player_id, a.club_id, a.created_at, a.rake_amount, a.rake_record_id
      FROM gap_days gd
      JOIN rake_attributions a
        ON a.club_id = gd.club_id
       AND a.created_at >= gd.day::timestamptz
       AND a.created_at <  (gd.day + 1)::timestamptz
     WHERE a.rake_amount > 0 AND a.player_id IS NOT NULL
  ),
  edge_split AS MATERIALIZED (
    SELECT ea.user_id, ea.club_id, ea.created_at,
           round(ea.rake_amount * 100)::bigint AS cents, ea.rake_record_id
      FROM edge_att ea
      JOIN everyone e ON e.player_id = ea.user_id AND e.club_id = ea.club_id
  ),
  from_live AS (
    SELECT s.user_id, s.club_id,
           SUM(s.cents)::numeric / 100 AS rake,
           count(*)::bigint AS hands,
           max(s.created_at) AS last_at
      FROM edge_split s
     WHERE public.fn_ca_launch_accounting_accepts(s.club_id,
             (SELECT rr.created_at FROM rake_records rr WHERE rr.id = s.rake_record_id))
     GROUP BY s.user_id, s.club_id
  ),
$new$;
 d:=substr(d,1,i_start-1)||new_live||substr(d,i_end);
 EXECUTE d;
END $patch$;
DO $patch$
DECLARE d text; original text;
BEGIN
 SELECT pg_get_functiondef('public.ca_club_members_summary(uuid)'::regprocedure) INTO original;
 IF md5(original)<>'b95e8d9454e1467883aa4eda854f99a8' THEN
   RAISE EXCEPTION 'Members summary preimage changed; qualify current definition';
 END IF;
 -- Exactly three viewer lookups read the union scope; the counts already use this club.
 IF (length(original)-length(replace(original,'cm.club_id = ANY(v_scope)','')))/length('cm.club_id = ANY(v_scope)')<>3 THEN
   RAISE EXCEPTION 'Members summary viewer-scope lookups changed';
 END IF;
 d:=replace(original,'cm.club_id = ANY(v_scope)','cm.club_id = p_club_id');
 EXECUTE d;
END $patch$;
COMMIT;
