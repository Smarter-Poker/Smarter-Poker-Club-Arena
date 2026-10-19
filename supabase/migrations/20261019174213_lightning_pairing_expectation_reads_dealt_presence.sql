-- 20261019174213_lightning_pairing_expectation_reads_dealt_presence.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- WHAT THIS CHANGES, AND WHY:
--
-- fn_lightning_integrity_scan's PAIRING_CONCENTRATION expectation sized the
-- pool at each hand by counting OPEN lightning_pool_session rows, and counted
-- player B as "present" for A's hand whenever B merely had an open session.
-- An open session is not playability: a busted anchor (zero stack), a
-- sitting-out player or a pending leave keeps its session and is dealt
-- nothing. That is the miscount already fixed for the population count
-- (docs/changelog/2026-10-18-lightning-funded-eligible-population.md).
--
-- Measured on the private Action pilot (cluster 56d5d6f0), 2026-10-18 window:
-- during the busted-horse stall ~38 sessions were open while only 8-10
-- distinct players were dealt, so (n-1)/(present-1) was about four times too
-- small. The eight open high findings (12, 14, 38, 41, 49, 69, 77, 110)
-- reproduce exactly under the old method (expected 6.53-39.33, ratios
-- 3.51-7.17). Under the method installed here, on that same window, they
-- measure 0.83-1.03 (and 0.79-1.05 for 12, 14, 38, 41 and 49 on the
-- 2026-10-17 window where they were first detected).
-- Across every Action and Madness daily window from 2026-10-17 to now, no
-- pair with 30+ shared hands reaches the unchanged 2.0 floor (largest 1.63).
--
-- THE FIX reads presence from the hands the Cluster actually dealt. The
-- window is cut into ten-minute strata (date_bin from the window start); a
-- player is present in a stratum exactly when dealt a hand in it, and a
-- pair's expectation is, summed over the strata where both were dealt,
-- (A's hands x B's hands / the stratum's hands): what they would share if
-- each was dealt their own share of the stratum independently of the other.
-- A pair that is matched together far more often than chance while the
-- playable pool is healthy is still flagged (proven natively below).
--
-- Everything else is byte-identical: the thresholds (30 hands, ratio 2.0),
-- the score, the other five patterns, extend-never-duplicate, the budgets,
-- the advisory lock and the CHIP_FLOW mirror. Only the evidence label
-- 'expectation' and thresholds.pairing_expectation now read 'dealt_presence_10m'.
-- The change is applied as exact old/new substitutions on the exact
-- production preimage, so a definition changed since 2026-10-19 refuses the
-- whole transaction; owner, SECURITY DEFINER, volatility, search_path and
-- grants are asserted unchanged. No row is written, no existing finding is
-- edited, and no horse flag is read: horses are scanned as players (10.5).
-- Native proof: scripts/ci/test-lightning-pairing-expectation-reads-dealt-presence.py.
--
-- @live-proof: (SELECT md5(pg_get_functiondef('public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure))='5454a3674ac80ebd920507464d224de5')

BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='20s';
DO $guard$ BEGIN
 IF current_user<>'postgres' OR session_user<>'postgres'
    OR NULLIF(current_setting('request.jwt.claims',true),'') IS NOT NULL THEN
   RAISE EXCEPTION 'lightning_pairing_expectation_operator_refused';
 END IF;
 IF NULLIF(current_setting('ca.break_window_migration_override',true),'') IS NOT NULL
    OR public.fn_platform_frozen() IS DISTINCT FROM false
    OR public.fn_active_maintenance_release_boundary() IS NOT NULL THEN
   RAISE EXCEPTION 'lightning_pairing_expectation_freeze_or_override_refused';
 END IF;
 IF EXISTS(SELECT FROM supabase_migrations.schema_migrations WHERE version='20261019174213') THEN
   RAISE EXCEPTION 'lightning_pairing_expectation_migration_replay_refused';
 END IF;
END $guard$;
CREATE FUNCTION pg_temp.lightning_pairing_expectation_patch(sig regprocedure, pre text, post text,
                                                            old text[], new text[])
RETURNS void LANGUAGE plpgsql AS $body$
DECLARE before text:=pg_get_functiondef(sig); after text; security_before jsonb; k integer;
BEGIN
 IF md5(before)<>pre THEN RAISE EXCEPTION 'lightning_pairing_expectation_preimage_refused: %',sig; END IF;
 SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
   INTO security_before FROM pg_proc WHERE oid=sig;
 IF cardinality(old) IS DISTINCT FROM cardinality(new) THEN
   RAISE EXCEPTION 'lightning_pairing_expectation_patch_shape_refused';
 END IF;
 after:=before;
 FOR k IN 1..cardinality(old) LOOP
   IF (length(after)-length(replace(after,old[k],'')))/length(old[k])<>1 THEN
     RAISE EXCEPTION 'lightning_pairing_expectation_anchor_refused: %',k;
   END IF;
   after:=replace(after,old[k],new[k]);
 END LOOP;
 IF md5(after)<>post THEN RAISE EXCEPTION 'lightning_pairing_expectation_derived_postimage_refused'; END IF;
 EXECUTE after;
 IF md5(pg_get_functiondef(sig))<>post OR
    (SELECT jsonb_build_array(proowner,prosecdef,provolatile,proconfig,proacl)
       FROM pg_proc WHERE oid=sig) IS DISTINCT FROM security_before THEN
   RAISE EXCEPTION 'lightning_pairing_expectation_postimage_or_security_refused';
 END IF;
END $body$;
SELECT pg_temp.lightning_pairing_expectation_patch(
 'public.fn_lightning_integrity_scan(uuid,timestamp with time zone,timestamp with time zone)'::regprocedure,
 '342b9ff5021fe5e0df25c18dc5641149','5454a3674ac80ebd920507464d224de5',
 ARRAY[
  $a$  c_pair_min_ratio constant numeric := 2.0;
$a$,
  $a$    ), pres AS MATERIALIZED (
      -- WHO WAS IN THE POOL, AND WHEN: every pool session of the Cluster
      -- open at some moment of the window (bounded like the session scan).
      SELECT ps.player_id, ps.entered_at, ps.exited_at
        FROM public.lightning_pool_session ps
       WHERE ps.cluster_id = v_cluster
         AND ps.entered_at < v_to AND ps.entered_at >= v_from - interval '7 days'
         AND (ps.exited_at IS NULL OR ps.exited_at > v_from)
       ORDER BY ps.entered_at DESC, ps.id
       LIMIT c_max_sessions
    ), pool AS (
      -- THE POOL'S SIZE AT EACH HAND, by one ordered sweep: an entry adds
      -- one, an exit takes one away, and a hand reads the running total
      -- after every entry and exit at or before its formation.
      SELECT q.hand_id, q.present FROM (
        SELECT e.hand_id, sum(e.d) OVER (ORDER BY e.t, e.k ROWS UNBOUNDED PRECEDING) AS present
          FROM (SELECT pr_.entered_at AS t, 1 AS d, 0 AS k, NULL::uuid AS hand_id FROM pres pr_
                UNION ALL
                SELECT pr_.exited_at, -1, 0, NULL::uuid FROM pres pr_ WHERE pr_.exited_at IS NOT NULL
                UNION ALL
                SELECT h.formed_at, 0, 1, h.hand_id FROM h) e) q
       WHERE q.hand_id IS NOT NULL
    ), hw AS MATERIALIZED (
      -- THE CHANCE A RANDOM SEATING PUTS A GIVEN OTHER PLAYER OF THE POOL
      -- IN THIS HAND: (players in the hand - 1) / (players in the pool - 1).
      SELECT hp.hand_id, hp.player_id, hp.formed_at,
             (sz.n - 1)::numeric / GREATEST(GREATEST(pl.present, sz.n) - 1, 1) AS w
        FROM hp
        JOIN (SELECT hp2.hand_id, count(*) AS n FROM hp hp2 GROUP BY 1) sz ON sz.hand_id = hp.hand_id
        JOIN pool pl ON pl.hand_id = hp.hand_id
    ), ex AS (
      -- THE CO-PRESENCE EXPECTATION of a candidate pair: over A's hands
      -- formed while B was in the pool, and B's while A was, averaged.
      SELECT d.pa, d.pb, sum(hw.w) / 2 AS expected,
             count(*) FILTER (WHERE d.x = d.pa) AS hands_a_copresent,
             count(*) FILTER (WHERE d.x = d.pb) AS hands_b_copresent
        FROM (SELECT pr.pa AS x, pr.pb AS y, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands
              UNION ALL
              SELECT pr.pb, pr.pa, pr.pa, pr.pb FROM pairs pr WHERE pr.together >= c_pair_min_hands) d
        JOIN hw ON hw.player_id = d.x
        JOIN pres s ON s.player_id = d.y AND s.entered_at <= hw.formed_at
                   AND (s.exited_at IS NULL OR s.exited_at > hw.formed_at)
       GROUP BY d.pa, d.pb
$a$,
  $a$CASE WHEN ex.expected IS NOT NULL THEN 'co_presence' ELSE 'whole_window' END$a$,
  $a$'pairing_expectation', 'co_presence'$a$],
 ARRAY[
  $b$  c_pair_min_ratio constant numeric := 2.0;
  c_pair_stratum   constant interval := interval '10 minutes';
$b$,
  $b$    ), dealt AS MATERIALIZED (
      -- WHO COULD BE DEALT, AND WHEN (2026-10-19): presence is read from the
      -- hands the Cluster actually dealt, in ten-minute strata of the window.
      -- An open pool session is not presence: a busted, sitting-out or
      -- otherwise unplayable anchor keeps one and is dealt nothing. Counting
      -- those sessions made the pool look four times larger than the players
      -- who could be dealt during the 2026-10-17 busted-anchor stall, so
      -- every pair of the few playable players looked concentrated.
      SELECT hp.player_id, date_bin(c_pair_stratum, hp.formed_at, v_from) AS b, count(*) AS k
        FROM hp GROUP BY 1, 2
    ), stratum AS (
      SELECT date_bin(c_pair_stratum, h.formed_at, v_from) AS b, count(*) AS n FROM h GROUP BY 1
    ), ex AS (
      -- THE CO-PRESENCE EXPECTATION of a candidate pair: in every stratum
      -- where both were dealt, the hands they would share if each was dealt
      -- their own share of that stratum's hands independently of the other
      -- (A's hands x B's hands / the stratum's hands), summed.
      SELECT pr.pa, pr.pb, sum(x.k::numeric * y.k / st.n) AS expected,
             sum(x.k) AS hands_a_copresent, sum(y.k) AS hands_b_copresent
        FROM pairs pr
        JOIN dealt x ON x.player_id = pr.pa
        JOIN dealt y ON y.player_id = pr.pb AND y.b = x.b
        JOIN stratum st ON st.b = x.b
       WHERE pr.together >= c_pair_min_hands
       GROUP BY pr.pa, pr.pb
$b$,
  $b$CASE WHEN ex.expected IS NOT NULL THEN 'dealt_presence_10m' ELSE 'whole_window' END$b$,
  $b$'pairing_expectation', 'dealt_presence_10m'$b$]);
COMMIT;
