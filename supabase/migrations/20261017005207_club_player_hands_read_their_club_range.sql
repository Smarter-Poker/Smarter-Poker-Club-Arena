-- 20261017005207_club_player_hands_read_their_club_range
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-17 00:52:07 UTC.
--
-- WHAT WAS WRONG
--
-- The Club Data Players page (ca_club_player_page -> its core
-- ca_club_player_page_core_20261006) and the player summary
-- (ca_club_player_breakdown) timed out on about 21% of production calls in the
-- 24 hours to 2026-10-17 00:15 UTC: edge logs 96 and 95 HTTP 500 against 365
-- and 331 HTTP 200, and 123 SQLSTATE 57014 "canceling statement due to
-- statement timeout" each under the authenticated role's 8s limit, clustered
-- on the minutes after every hourly break (22:05, 23:04).
--
-- Measured 2026-10-17 00:43 UTC on live data (Shark Club, 575 home-attributed
-- players in Midway Union, 14-day default window): 2.6 s for the page and
-- 2.3 s for the summary when the database was quiet; the 92-day window took
-- 12.8 s for the hands step alone. EXPLAIN (ANALYZE, BUFFERS) put 2.82 s of
-- the 3.08 s in one CTE: `hands` joined club_member_daily_stats to att_club
-- and hand_clubs, so the planner ran 2,300 parameterised scans of
-- idx_cmds_club_user (club_id, user_id), each filtering stat_date in the heap
-- (870,515 rows kept, 429 discarded per loop, 1,638,996 buffer hits).
-- club_member_daily_stats holds one row per club, table, player and day, and
-- Midway's Lightning tables wrote 988,816 of them in 14 days.
--
-- An index carrying hands_played is not available:
-- 20261003031000_the_write_path_keeps_only_the_indexes_it_reads removed those
-- on purpose (every hand updates hands_played, and an indexed per-hand column
-- makes the per-hand upsert non-HOT) and asserts none may come back.
--
-- WHAT THIS CHANGES
--
-- Only the `hands` CTE of the three player readers (summary, page core and
-- the immutable CSV export, which carries the identical fragment). It now
-- reads the scoped clubs' date range once through idx_cmds_club_date_hot
-- (club_id, stat_date) INCLUDE (user_id), sums by player, and is
-- MATERIALIZED so the planner cannot fold att_club back in and return to the
-- per-player loop. The att_club join leaves the CTE: `hands` is read only by
-- `merged`, as `att_club a LEFT JOIN hands h ON h.user_id=a.user_id`, so a
-- player outside att_club can never reach a row, and hand_clubs is a UNION
-- (deduplicated) set, so `IN (hand_clubs)` counts exactly the rows the join
-- counted. Attribution, money, rake, cursor order, horse masking, ownership,
-- ACLs, volatility, config and every export guard are byte-for-byte outside
-- the patched fragment.
--
-- PROOF OF IDENTICAL RESULTS (production, one REPEATABLE READ snapshot,
-- 2026-10-17 00:50 UTC). Old and new `hands`, intersected with att_club, were
-- compared row by row (EXCEPT ALL both ways) for Shark, Club JAQK, the Midway
-- root and a standalone club over 1-, 14- and 93-day windows: 12 of 12 cases
-- had zero differing rows and identical totals (Shark 93 days: 571 players,
-- 82,273,473 hands both ways). Time for the hands step, serial: Shark 14 days
-- 2,054 ms -> 1,015 ms, Shark 93 days 12,773 ms -> 987 ms, Midway root 93
-- days 4,059 ms -> 2,031 ms.
--
-- PRODUCTION PREIMAGE, 2026-10-17 UTC
--
--   ca_club_player_breakdown:          121a71892c21a33fcccde7099337d2c0
--   ca_club_player_page_core_20261006: a9cb30a01d41b5b5d1d6c4b815229933
--   ca_club_player_export_start:       ce83a312514da0262ecead6ef1d49da8
--
-- (Postimages eeae15ae895151d2194c5962f2247b1d / 4c5af1a0f2c251df57e02d18a048b9fc were later
-- patched by 20261017160101, which keeps this range read, so the proofs read the range itself.)
-- @live-proof: position('WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)' in pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure)) > 0
-- @live-proof: position('WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)' in pg_get_functiondef('public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure)) > 0
-- @live-proof: md5(pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure)) = 'a16b4b91e70e7bdd9df55dd5c605022f'

BEGIN;

-- Function replacement takes only catalogue locks. Refuse instead of waiting
-- behind unrelated DDL; all three replacements remain one atomic change.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

DO $player_hands_range$
DECLARE
  v_row record;
  v_definition text;
  v_rewritten text;
  v_actual_md5 text;
  v_owner name;
  v_security_definer boolean;
  v_volatility "char";
  v_config text;
  v_acl text;
  v_language name;
  v_return_type regtype;
  v_returns_set boolean;
  v_kind "char";
  v_old constant text := $old_hands$  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
      JOIN att_club a ON a.user_id=s.user_id
      JOIN hand_clubs hc ON hc.club_id=s.club_id
     WHERE s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old_hands$;
  v_new constant text := $new_hands$  ), hands AS MATERIALIZED (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
     WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)
       AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$new_hands$;
BEGIN
  FOR v_row IN
    SELECT *
      FROM (VALUES
        (
          'public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure,
          '121a71892c21a33fcccde7099337d2c0'::text,
          'eeae15ae895151d2194c5962f2247b1d'::text,
          's'::"char",
          '{search_path=public}'::text,
          '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::text
        ),
        (
          'public.ca_club_player_page_core_20261006(uuid,date,date,text,text,jsonb,integer)'::regprocedure,
          'a9cb30a01d41b5b5d1d6c4b815229933'::text,
          '4c5af1a0f2c251df57e02d18a048b9fc'::text,
          's'::"char",
          '{search_path=public}'::text,
          '{postgres=X/postgres}'::text
        ),
        (
          'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure,
          'ce83a312514da0262ecead6ef1d49da8'::text,
          'a16b4b91e70e7bdd9df55dd5c605022f'::text,
          'v'::"char",
          '{"search_path=public, pg_temp",statement_timeout=120s}'::text,
          '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'::text
        )
      ) AS expected(signature, preimage_md5, postimage_md5, volatility, config, acl)
  LOOP
    SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), owner_role.rolname,
           p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
           language_row.lanname, p.prorettype::regtype, p.proretset, p.prokind
      INTO v_definition, v_actual_md5, v_owner, v_security_definer, v_volatility, v_config,
           v_acl, v_language, v_return_type, v_returns_set, v_kind
      FROM pg_proc p
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
      JOIN pg_language language_row ON language_row.oid = p.prolang
     WHERE p.oid = v_row.signature;

    IF v_definition IS NULL
       OR v_actual_md5 IS DISTINCT FROM v_row.preimage_md5
       OR v_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_volatility IS DISTINCT FROM v_row.volatility
       OR v_config IS DISTINCT FROM v_row.config
       OR v_acl IS DISTINCT FROM v_row.acl
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_return_type IS DISTINCT FROM 'jsonb'::regtype
       OR v_returns_set IS DISTINCT FROM false
       OR v_kind IS DISTINCT FROM 'f'::"char" THEN
      RAISE EXCEPTION
        'PLAYER_HANDS_RANGE_PREIMAGE: % moved (md5 %, owner %, definer %, volatility %, config %, acl %)',
        v_row.signature, v_actual_md5, v_owner, v_security_definer, v_volatility, v_config, v_acl;
    END IF;

    IF (length(v_definition) - length(replace(v_definition, v_old, ''))) / length(v_old) <> 1 THEN
      RAISE EXCEPTION 'PLAYER_HANDS_RANGE_PREIMAGE: hands anchor is not present exactly once in %',
        v_row.signature;
    END IF;

    v_rewritten := replace(v_definition, v_old, v_new);
    IF md5(v_rewritten) IS DISTINCT FROM v_row.postimage_md5 THEN
      RAISE EXCEPTION 'PLAYER_HANDS_RANGE_REWRITE: % produced unexpected definition %',
        v_row.signature, md5(v_rewritten);
    END IF;

    EXECUTE v_rewritten;

    SELECT pg_get_functiondef(p.oid), md5(pg_get_functiondef(p.oid)), owner_role.rolname,
           p.prosecdef, p.provolatile, p.proconfig::text, p.proacl::text,
           language_row.lanname, p.prorettype::regtype, p.proretset, p.prokind
      INTO v_definition, v_actual_md5, v_owner, v_security_definer, v_volatility, v_config,
           v_acl, v_language, v_return_type, v_returns_set, v_kind
      FROM pg_proc p
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
      JOIN pg_language language_row ON language_row.oid = p.prolang
     WHERE p.oid = v_row.signature;

    IF v_actual_md5 IS DISTINCT FROM v_row.postimage_md5
       OR v_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_volatility IS DISTINCT FROM v_row.volatility
       OR v_config IS DISTINCT FROM v_row.config
       OR v_acl IS DISTINCT FROM v_row.acl
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_return_type IS DISTINCT FROM 'jsonb'::regtype
       OR v_returns_set IS DISTINCT FROM false
       OR v_kind IS DISTINCT FROM 'f'::"char"
       OR position('hands AS MATERIALIZED (' IN v_definition) = 0
       OR position('WHERE s.club_id IN (SELECT hc.club_id FROM hand_clubs hc)' IN v_definition) = 0
       OR position('JOIN att_club a ON a.user_id=s.user_id' IN v_definition) > 0
       OR position('LEFT JOIN hands h ON h.user_id=a.user_id' IN v_definition) = 0
       OR position('public.fn_can_see_horse_flag(p_club_id)' IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'PLAYER_HANDS_RANGE_POSTIMAGE: % did not keep its exact body/security contract (md5 %)',
        v_row.signature, v_actual_md5;
    END IF;

    IF v_row.signature =
       'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure
       AND (
         position('pg_try_advisory_xact_lock' IN v_definition) = 0
         OR position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_definition) = 0
         OR position('active_slot.user_id = v_user' IN v_definition) = 0
         OR position('public.ca_prune_expired_club_data_exports(2000)' IN v_definition) = 0
       ) THEN
      RAISE EXCEPTION
        'PLAYER_HANDS_RANGE_POSTIMAGE: player export lost its bounded retention or concurrency guards';
    END IF;
  END LOOP;
END
$player_hands_range$;

COMMIT;
