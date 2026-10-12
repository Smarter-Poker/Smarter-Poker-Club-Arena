-- 20261006012714_union_player_hands_follow_shared_tables
--
-- Reserved by scripts/reserve-migration-version.sh on 2026-10-06 01:27:14 UTC.
--
-- CLAUDE.md 10.9: the reasoning goes in this header, not just the SQL.
-- Say what was wrong, what this changes, and what you measured. A
-- migration whose header is its own filename is the next agent's mystery.
--
-- WHAT WAS WRONG
--
-- The Club Data player summary, cursor page, and immutable CSV export all
-- attribute a union player to the first member club that player joined. Their
-- hand count nevertheless read club_member_daily_stats only where
-- stats.club_id = that member club. Shared union tables are owned by the union
-- root club row, so the post-commit projector correctly writes those hands to
-- the union root instead. The Midway/Shark production window 2026-09-23
-- through 2026-10-06 demonstrated the mismatch: Shark had 578 attributed
-- members and 637,312 table-day hands but zero player hand rows under Shark;
-- the Midway union root held the current player projection. The UI therefore
-- rendered every Shark player with zero hands and "Most Hands" sorted zeros.
--
-- WHAT THIS CHANGES
--
-- Patch only the hands CTE in the three measured production definitions. A
-- standalone club still reads only itself. A union member club reads one
-- deduplicated physical hand scope containing the union root and every member
-- club, then intersects those rows with the unchanged home-attributed player
-- set. Money attribution, membership ordering, cursor ordering, CSV
-- immutability, horse masking, and every export retention/concurrency guard
-- remain byte-for-byte outside that CTE.
--
-- PRODUCTION PREIMAGE, 2026-10-06 UTC
--
--   ca_club_player_breakdown: 283858d1274095f0a61103d745f7c34b
--   ca_club_player_page:      980556d672f194b1b190e379d75321bb
--   ca_club_player_export:    e095ebb3a4f0214110abb5e7cd79baf5
--
-- The same live data measured the replacement hand scope at 800.527 ms for
-- the 14-day Shark window (578 attributed members, three physical club ids,
-- 428,242 scoped aggregate rows, no temp spill). It returned 307,871 hands for
-- 11 home-attributed Shark players. The previous predicate returned zero.
--
-- @live-proof: md5(pg_get_functiondef('public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure)) = '121a71892c21a33fcccde7099337d2c0'
-- @live-proof: md5(pg_get_functiondef('public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure)) = '171060d16ed798d1a185080d1a9334cd'
-- @live-proof: md5(pg_get_functiondef('public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure)) = 'ce83a312514da0262ecead6ef1d49da8'

BEGIN;

-- Function replacement takes only catalogue locks. Refuse instead of waiting
-- behind unrelated DDL; all three replacements remain one atomic change.
SET LOCAL lock_timeout = '250ms';
SET LOCAL statement_timeout = '0';

DO $repair_union_player_hands$
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
BEGIN
  FOR v_row IN
    SELECT *
      FROM (VALUES
        (
          'public.ca_club_player_breakdown(uuid,date,date,integer)'::regprocedure,
          '283858d1274095f0a61103d745f7c34b'::text,
          '121a71892c21a33fcccde7099337d2c0'::text,
          's'::"char",
          '{search_path=public}'::text,
          $old_breakdown$  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands FROM public.club_member_daily_stats s
      JOIN att_club a ON a.user_id=s.user_id WHERE s.club_id=p_club_id
       AND s.stat_date BETWEEN v_start AND v_end GROUP BY s.user_id
$old_breakdown$::text
        ),
        (
          'public.ca_club_player_page(uuid,date,date,text,text,jsonb,integer)'::regprocedure,
          '980556d672f194b1b190e379d75321bb'::text,
          '171060d16ed798d1a185080d1a9334cd'::text,
          's'::"char",
          '{search_path=public}'::text,
          $old_common$  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.club_id=p_club_id AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old_common$::text
        ),
        (
          'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure,
          'e095ebb3a4f0214110abb5e7cd79baf5'::text,
          'ce83a312514da0262ecead6ef1d49da8'::text,
          'v'::"char",
          '{"search_path=public, pg_temp",statement_timeout=120s}'::text,
          $old_common$  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s JOIN att_club a ON a.user_id=s.user_id
     WHERE s.club_id=p_club_id AND s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$old_common$::text
        )
      ) AS expected(
        signature,
        preimage_md5,
        postimage_md5,
        volatility,
        config,
        old_fragment
      )
  LOOP
    SELECT pg_get_functiondef(p.oid),
           md5(pg_get_functiondef(p.oid)),
           owner_role.rolname,
           p.prosecdef,
           p.provolatile,
           p.proconfig::text,
           p.proacl::text,
           language_row.lanname,
           p.prorettype::regtype,
           p.proretset,
           p.prokind
      INTO v_definition,
           v_actual_md5,
           v_owner,
           v_security_definer,
           v_volatility,
           v_config,
           v_acl,
           v_language,
           v_return_type,
           v_returns_set,
           v_kind
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
       OR v_acl IS DISTINCT FROM
          '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_return_type IS DISTINCT FROM 'jsonb'::regtype
       OR v_returns_set IS DISTINCT FROM false
       OR v_kind IS DISTINCT FROM 'f'::"char" THEN
      RAISE EXCEPTION
        'UNION_PLAYER_HANDS_PREIMAGE: % moved (md5 %, owner %, definer %, volatility %, config %, acl %, language %, return %, set %, kind %)',
        v_row.signature, v_actual_md5, v_owner, v_security_definer,
        v_volatility, v_config, v_acl, v_language, v_return_type,
        v_returns_set, v_kind;
    END IF;

    IF (length(v_definition) - length(replace(v_definition, v_row.old_fragment, '')))
         / length(v_row.old_fragment) <> 1 THEN
      RAISE EXCEPTION
        'UNION_PLAYER_HANDS_PREIMAGE: hands anchor is not present exactly once in %',
        v_row.signature;
    END IF;

    v_rewritten := replace(
      v_definition,
      v_row.old_fragment,
      $new_hands$  ), hand_clubs AS MATERIALIZED (
    SELECT p_club_id AS club_id WHERE v_union IS NULL
    UNION
    SELECT v_union WHERE v_union IS NOT NULL
    UNION
    SELECT uc.club_id FROM public.union_clubs uc
     WHERE v_union IS NOT NULL AND uc.union_id=v_union
  ), hands AS (
    SELECT s.user_id,SUM(s.hands_played)::bigint hands
      FROM public.club_member_daily_stats s
      JOIN att_club a ON a.user_id=s.user_id
      JOIN hand_clubs hc ON hc.club_id=s.club_id
     WHERE s.stat_date BETWEEN v_start AND v_end
     GROUP BY s.user_id
$new_hands$
    );

    IF md5(v_rewritten) IS DISTINCT FROM v_row.postimage_md5 THEN
      RAISE EXCEPTION
        'UNION_PLAYER_HANDS_REWRITE: % produced unexpected definition %',
        v_row.signature, md5(v_rewritten);
    END IF;

    EXECUTE v_rewritten;

    SELECT md5(pg_get_functiondef(p.oid)),
           owner_role.rolname,
           p.prosecdef,
           p.provolatile,
           p.proconfig::text,
           p.proacl::text,
           language_row.lanname,
           p.prorettype::regtype,
           p.proretset,
           p.prokind,
           pg_get_functiondef(p.oid)
      INTO v_actual_md5,
           v_owner,
           v_security_definer,
           v_volatility,
           v_config,
           v_acl,
           v_language,
           v_return_type,
           v_returns_set,
           v_kind,
           v_definition
      FROM pg_proc p
      JOIN pg_roles owner_role ON owner_role.oid = p.proowner
      JOIN pg_language language_row ON language_row.oid = p.prolang
     WHERE p.oid = v_row.signature;

    IF v_actual_md5 IS DISTINCT FROM v_row.postimage_md5
       OR v_owner IS DISTINCT FROM 'postgres'
       OR v_security_definer IS DISTINCT FROM true
       OR v_volatility IS DISTINCT FROM v_row.volatility
       OR v_config IS DISTINCT FROM v_row.config
       OR v_acl IS DISTINCT FROM
          '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}'
       OR v_language IS DISTINCT FROM 'plpgsql'
       OR v_return_type IS DISTINCT FROM 'jsonb'::regtype
       OR v_returns_set IS DISTINCT FROM false
       OR v_kind IS DISTINCT FROM 'f'::"char"
       OR position('SELECT v_union WHERE v_union IS NOT NULL' IN v_definition) = 0
       OR position(
            'WHERE v_union IS NOT NULL AND uc.union_id=v_union' IN v_definition
          ) = 0
       OR position('JOIN hand_clubs hc ON hc.club_id=s.club_id' IN v_definition) = 0
       OR position('s.club_id=p_club_id' IN v_definition) > 0
       OR position('public.fn_can_see_horse_flag(p_club_id)' IN v_definition) = 0 THEN
      RAISE EXCEPTION
        'UNION_PLAYER_HANDS_POSTIMAGE: % did not retain its exact body/security contract (md5 %, owner %, definer %, volatility %, config %, acl %)',
        v_row.signature, v_actual_md5, v_owner, v_security_definer,
        v_volatility, v_config, v_acl;
    END IF;

    IF v_row.signature =
       'public.ca_club_player_export_start(uuid,date,date,text,uuid)'::regprocedure
       AND (
         position('pg_try_advisory_xact_lock' IN v_definition) = 0
         OR position('FOR UPDATE OF stale_row SKIP LOCKED' IN v_definition) = 0
         OR position('active_slot.user_id = v_user' IN v_definition) = 0
         OR position(
              'public.ca_prune_expired_club_data_exports(2000)' IN v_definition
            ) = 0
       ) THEN
      RAISE EXCEPTION
        'UNION_PLAYER_HANDS_POSTIMAGE: player export lost its bounded retention or concurrency guards';
    END IF;
  END LOOP;
END
$repair_union_player_hands$;

COMMIT;
