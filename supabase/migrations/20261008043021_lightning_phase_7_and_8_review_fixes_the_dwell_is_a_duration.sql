-- 20261008043021_lightning_phase_7_and_8_review_fixes_the_dwell_is_a_duration.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASES 7 AND 8: THE ADVERSARIAL REVIEW FINDINGS ARE CLOSED.
--
-- Production applied 20261007212735 (Phase 8: per-platform multi-table
-- limits, session statistics, pool status and recent hands) and
-- 20261007222717 (the Phase 7 remediation: the PENDING_OFF dwell and its
-- durable first sighting). Adversarial review found six defects across the
-- two; each is fixed here at its root, as an asserted substitution into the
-- body production carries (read with pg_get_functiondef, p.prokind = 'f').
--
-- 1. (P1) THE DWELL NEVER ENFORCED ITS DURATION.
--    fn_cash_cluster_begin_pending_off recorded a first sighting and returned
--    off_condition_dwell only while lightning_off_condition_since was NULL;
--    ANY later call proceeded unconditionally, so a seat-change wake ~500ms
--    after the first sighting opened PENDING_OFF and pending_off_dwell_ms was
--    dead configuration. The non-NULL branch now requires
--    clock_timestamp() >= lightning_off_condition_since + the configured
--    dwell, and refuses with the STANDING first_seen_at until then. A dwell
--    of 0 keeps the old two-sighting behaviour (record, then proceed), and a
--    disabled Cluster or game still drains at once.
--
-- 2. (P2) A STALE SIGHTING SURVIVED FREEZE/UNFREEZE AND RE-CONVERSION.
--    Neither fn_cash_cluster_unfreeze nor fn_cash_cluster_commit_lightning
--    cleared lightning_off_condition_since, so the next Lightning epoch could
--    open PENDING_OFF on one observation against a sighting from a dead
--    epoch. Both now NULL it in the same UPDATE that moves cluster_mode.
--
-- 3. (P2) THE MULTI-TABLE LIMIT COULD BE EXCEEDED BY K.
--    fn_lightning_player_legality counts committed reservations, but
--    fn_lightning_match_and_form serialises only per Cluster, so k Clusters
--    forming in the same instant could each admit the same player: a mobile
--    limit of 2 could end with 4 live hands. fn_lightning_form_hand (which
--    gains p_player_platforms from match_and_form) now takes one transaction
--    advisory lock per participant in sorted player-id order AFTER the
--    committed reservations are written, recounts each participant's live
--    committed reservations across every Cluster against that participant's
--    platform limit, and refuses the whole formation as a normal retryable
--    refusal (SQLSTATE 40001 rolls the atomic block back, releasing its
--    reservations) when anyone is over. Two racing barriers queue on the
--    player's lock and the second counts the first one's committed rows, so
--    exactly one wins.
--
-- 4. (P3) RECENT HANDS GUESSED FROM AN ABSENT WINNERS RECORD.
--    With the hand_history row pruned (or winners missing), net 0 and
--    not-listed read 'split', and a 0-net chop whose recorded userId differed
--    in case or type read 'lost'. When no winners record exists the result is
--    now the net alone (>0 won, <0 lost, 0 and folded folded, else won), and
--    the winners' userId is compared case- and type-normalised.
--
-- 5. (P3) POOL STATUS LEAKED RAW cluster_mode (frozen, paused, pending
--    states) to players. The cluster_mode key is dropped; the client contract
--    is {players, status, joinable}, and the SAME payload now carries
--    multi_table_limit ({desktop, tablet, mobile} from fn_lightning_config)
--    so the client entry door can enforce the configured limits.
--
-- 6. (P3) AN UNREPORTED PLATFORM BOUGHT THE WIDEST LIMIT. The legality
--    platform lookup defaulted a missing or unknown platform to desktop
--    (limit 4). It now defaults to the NARROWEST limit, mobile (2), so not
--    reporting a platform can never widen what the client would enforce.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No
-- table is created or altered and neither tables nor table_seats is locked by
-- DDL. Every change to an existing body is an asserted substitution into the
-- body production carries: each anchor must appear exactly as often as stated
-- or the file refuses, and a body already carrying the change is left alone,
-- so the file is re-appliable. fn_lightning_form_hand changes signature; the
-- old function is dropped in this same transaction and the new one carries,
-- semantically, exactly what each request role could execute and the old
-- comment (asserted with has_function_privilege, which is stable under
-- production's default function ACLs and its autorevoke event trigger).
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. A horse's dwell, limit
-- recount, result classification and pool status are a human's exactly.
--
-- @live-proof: (SELECT s ~ 'make_interval\(secs => v_dwell / 1000\.0\)' AND s ~ 'ELSIF clock_timestamp\(\) <' AND s ~ '''off_condition_dwell''' FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure) AS s) q)
-- @live-proof: (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure) ~ 'cluster_epoch = v_epoch, lightning_off_condition_since = NULL')
-- @live-proof: (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure) ~ 'cluster_epoch = v_epoch, lightning_off_condition_since = NULL')
-- @live-proof: (SELECT to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)') IS NULL AND to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)') IS NOT NULL)
-- @live-proof: (SELECT s ~ 'LIGHTNING_MULTI_TABLE_LIMIT' AND s ~ 'pg_advisory_xact_lock' AND s ~ 'ERRCODE = ''40001''' AND position('SET state = ''committed''' in s) < position('LIGHTNING_MULTI_TABLE_LIMIT' in s) FROM (SELECT pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure) AS s) q)
-- @live-proof: (SELECT pg_get_functiondef('public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure) ~ 'v_req,[[:space:]]+p_player_platforms\);')
-- @live-proof: (SELECT s ~ 'AS available' AND s ~ 'lower\(btrim\(' AND s ~ 'WHEN NOT w\.available THEN' FROM (SELECT pg_get_functiondef('public.fn_lightning_recent_hands(integer,uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT s ~ '''joinable''' AND s ~ '''multi_table_limit'', v_cfg -> ''multi_table_limit''' AND s !~ '''cluster_mode'', g\.cluster_mode' FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure) AS s) q)
-- @live-proof: (SELECT (SELECT count(*) FROM regexp_matches(s, 'ELSE ''mobile'' END', 'g')) = 2 AND s !~ 'ELSE ''desktop'' END' FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q)
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_cash_cluster_begin_pending_off', 'fn_cash_cluster_unfreeze', 'fn_cash_cluster_commit_lightning', 'fn_lightning_form_hand', 'fn_lightning_match_and_form', 'fn_lightning_recent_hands', 'fn_lightning_pool_status', 'fn_lightning_player_legality') AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id'))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 0. THE REWRITER, in the shape 20261007212735 cut it: an asserted
--    substitution into the body production carries. Every anchor must appear
--    exactly as often as stated or the file refuses. Where the signature
--    changes the old function is dropped and the new one created carrying
--    what each request role could execute and the old comment, both asserted
--    semantically with has_function_privilege. A function already carrying
--    the change (the marker) is left alone, so the file is re-appliable.
-- ===========================================================================
CREATE OR REPLACE FUNCTION pg_temp.lp78_rewrite(p_old text, p_new text, p_marker text,
                                    p_from text[], p_to text[], p_counts integer[])
RETURNS void LANGUAGE plpgsql AS $rw$
DECLARE
  v_same    boolean := p_old = p_new;
  v_src     text;
  v_new     text;
  v_n       integer;
  k         integer;
  v_roles   constant text[] := ARRAY['anon', 'authenticated', 'service_role'];
  v_had     boolean[];
  v_bad     text;
  v_comment text;
BEGIN
  IF NOT v_same AND to_regprocedure(p_new) IS NOT NULL THEN
    IF to_regprocedure(p_old) IS NOT NULL THEN
      RAISE EXCEPTION '% and % both exist; refusing to guess which one callers reach', p_old, p_new;
    END IF;
    IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
      RAISE EXCEPTION '% exists without %', p_new, p_marker;
    END IF;
    RETURN;
  END IF;
  v_src := pg_get_functiondef(p_old::regprocedure);
  IF v_same AND position(p_marker in v_src) > 0 THEN
    RETURN;
  END IF;
  v_new := v_src;
  FOR k IN 1 .. array_length(p_from, 1) LOOP
    v_n := (length(v_new) - length(replace(v_new, p_from[k], ''))) / length(p_from[k]);
    IF v_n IS DISTINCT FROM p_counts[k] THEN
      RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', p_old, k, v_n, p_counts[k];
    END IF;
    v_new := replace(v_new, p_from[k], p_to[k]);
  END LOOP;
  SELECT array_agg(has_function_privilege(t.r, p_old::regprocedure, 'EXECUTE') ORDER BY t.ord)
    INTO v_had FROM unnest(v_roles) WITH ORDINALITY t(r, ord);
  v_comment := obj_description(p_old::regprocedure, 'pg_proc');
  IF NOT v_same THEN
    EXECUTE format('DROP FUNCTION %s', p_old);
  END IF;
  EXECUTE v_new;
  IF NOT v_same THEN
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', p_new);
    FOR k IN 1 .. array_length(v_roles, 1) LOOP
      IF v_had[k] THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', p_new, v_roles[k]);
      END IF;
    END LOOP;
    IF v_comment IS NOT NULL THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', p_new, v_comment);
    END IF;
    SELECT string_agg(t.r || ': had ' || v_had[t.ord] || ', has '
                      || has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE'), '; ')
      INTO v_bad
      FROM unnest(v_roles) WITH ORDINALITY t(r, ord)
     WHERE has_function_privilege(t.r, p_new::regprocedure, 'EXECUTE') IS DISTINCT FROM v_had[t.ord];
    IF v_bad IS NOT NULL
       OR obj_description(p_new::regprocedure, 'pg_proc') IS DISTINCT FROM v_comment THEN
      RAISE EXCEPTION '% did not keep who may execute (%) and the comment of %', p_new, coalesce(v_bad, 'comment'), p_old;
    END IF;
  END IF;
  IF position(p_marker in pg_get_functiondef(p_new::regprocedure)) = 0 THEN
    RAISE EXCEPTION '% does not read back carrying %', p_new, p_marker;
  END IF;
END
$rw$;

-- ===========================================================================
-- 1. FINDING 1 (P1): fn_cash_cluster_begin_pending_off - the dwell is a
--    duration. The non-NULL branch refuses until the standing sighting has
--    stood for pending_off_dwell_ms; dwell 0 keeps the two-sighting rule.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
  'public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
  'make_interval(secs => v_dwell / 1000.0)',
  ARRAY[$a$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717): THE OFF CONDITION MUST
  -- DWELL. A population hovering at the OFF threshold used to open a
  -- conversion, void every reserved formation, and abort, on every
  -- oscillation. The population trigger now holds until the condition has
  -- been seen on two consecutive sightings - the first is recorded durably on
  -- the Cluster row this call already holds FOR UPDATE, and a drive pass that
  -- does not see the condition clears it - or has stood for the configured
  -- pending_off_dwell_ms (default 10000; 0 disables the dwell). A disabled
  -- Cluster or game always drains at once: the dwell gates only the
  -- population trigger.
$a$,
        $a$    IF v_dwell > 0 AND g.lightning_off_condition_since IS NULL THEN
      UPDATE public.cash_games
         SET lightning_off_condition_since = clock_timestamp(), updated_at = now()
       WHERE id = g.id;
      RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'off_condition_dwell',
        'why', v_why, 'first_seen_at', clock_timestamp(), 'dwell_ms', v_dwell,
        'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
    END IF;
$a$],
  ARRAY[$b$  -- LIGHTNING PHASE 7 REMEDIATION (20261007222717), TIGHTENED BY
  -- 20261008043021: THE OFF CONDITION MUST DWELL, AND THE DWELL IS A
  -- DURATION, NOT A COUNT OF CALLS. A population hovering at the OFF
  -- threshold used to open a conversion, void every reserved formation, and
  -- abort, on every oscillation; and a seat-change wake half a second after
  -- the first sighting used to open PENDING_OFF anyway, because any second
  -- call proceeded. The first sighting is recorded durably on the Cluster
  -- row this call already holds FOR UPDATE, and a drive pass that does not
  -- see the condition clears it; every later sighting is refused, with the
  -- STANDING first_seen_at, until the recorded sighting has stood for the
  -- configured pending_off_dwell_ms (default 10000; 0 keeps the two-sighting
  -- rule with no minimum duration). A disabled Cluster or game always drains
  -- at once: the dwell gates only the population trigger.
$b$,
        $b$    IF g.lightning_off_condition_since IS NULL THEN
      UPDATE public.cash_games
         SET lightning_off_condition_since = clock_timestamp(), updated_at = now()
       WHERE id = g.id;
      RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'off_condition_dwell',
        'why', v_why, 'first_seen_at', clock_timestamp(), 'dwell_ms', v_dwell,
        'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
    ELSIF clock_timestamp() < g.lightning_off_condition_since + make_interval(secs => v_dwell / 1000.0) THEN
      RETURN jsonb_build_object('ok', false, 'pending', false, 'reason', 'off_condition_dwell',
        'why', v_why, 'first_seen_at', g.lightning_off_condition_since, 'dwell_ms', v_dwell,
        'verdict', v_state -> 'verdict', 'thresholds', v_state -> 'thresholds');
    END IF;
$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 2. FINDING 2 (P2): a stale dwell sighting dies with the mode change, in
--    both functions that end a Lightning life without passing through the
--    drive's own clearing - the unfreeze and the ON commit.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_cash_cluster_unfreeze(uuid,uuid,text)',
  'public.fn_cash_cluster_unfreeze(uuid,uuid,text)',
  'cluster_epoch = v_epoch, lightning_off_condition_since = NULL',
  ARRAY[$a$  UPDATE public.cash_games SET cluster_mode = 'must_move', cluster_epoch = v_epoch, updated_at = now()
   WHERE id = g.id;
$a$],
  ARRAY[$b$  -- 20261008043021: A STALE DWELL SIGHTING DOES NOT SURVIVE AN UNFREEZE.
  -- Cleared beside the halt clearing above, in the same UPDATE that moves the
  -- mode, so the next Lightning epoch cannot open PENDING_OFF on a single
  -- observation against a sighting recorded before the freeze.
  UPDATE public.cash_games SET cluster_mode = 'must_move', cluster_epoch = v_epoch, lightning_off_condition_since = NULL, updated_at = now()
   WHERE id = g.id;
$b$],
  ARRAY[1]);

SELECT pg_temp.lp78_rewrite(
  'public.fn_cash_cluster_commit_lightning(uuid,uuid)',
  'public.fn_cash_cluster_commit_lightning(uuid,uuid)',
  'cluster_epoch = v_epoch, lightning_off_condition_since = NULL',
  ARRAY[$a$  UPDATE public.cash_games
     SET cluster_mode = 'lightning', cluster_epoch = v_epoch, updated_at = now()
   WHERE id = g.id;
$a$],
  ARRAY[$b$  -- 20261008043021: A STALE DWELL SIGHTING DOES NOT SURVIVE RE-CONVERSION.
  -- A sighting recorded in a previous Lightning epoch would otherwise let the
  -- new epoch open PENDING_OFF on one observation.
  UPDATE public.cash_games
     SET cluster_mode = 'lightning', cluster_epoch = v_epoch, lightning_off_condition_since = NULL, updated_at = now()
   WHERE id = g.id;
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 3. FINDING 3 (P2): fn_lightning_form_hand - the multi-table limit holds
--    across Clusters at the moment it matters. The barrier gains
--    p_player_platforms (the matcher passes its own map through), so its
--    signature changes: the substituted text is created as the
--    eleven-argument overload and the ten-argument one is dropped in this
--    same transaction, with who-may-execute and the comment carried over.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)',
  'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)',
  'LIGHTNING_MULTI_TABLE_LIMIT',
  ARRAY[
-- 1. the signature
$a$p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid)$a$,
-- 2. the barrier's own version literal names the signature it is
$a$timestamp with time zone,text,uuid)'::regprocedure$a$,
-- 3. the declarations
$a$  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');$a$,
-- 4. the recount, after the reservations are committed
$a$    UPDATE public.lightning_reservation r
       SET state = 'committed', resolved_at = p_now
     WHERE r.lightning_instance_id = v_instance AND r.state = 'pending';
$a$],
  ARRAY[
-- 1
$b$p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)$b$,
-- 2
$b$timestamp with time zone,text,uuid,jsonb)'::regprocedure$b$,
-- 3
$b$  -- 20261008043021: the cross-Cluster multi-table recount.
  v_mtl       jsonb;
  v_mtl_pid   uuid;
  v_mtl_row   record;
  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');$b$,
-- 4
$b$    UPDATE public.lightning_reservation r
       SET state = 'committed', resolved_at = p_now
     WHERE r.lightning_instance_id = v_instance AND r.state = 'pending';

    -- 20261008043021: THE MULTI-TABLE LIMIT HOLDS ACROSS CLUSTERS AT THE
    -- MOMENT IT MATTERS. P0 (fn_lightning_player_legality) counts a player's
    -- live committed reservations, but each Cluster's pass serialises only on
    -- its own Cluster, so k Clusters forming in the same instant could each
    -- admit the same player and a mobile limit of 2 could end with 4 live
    -- hands. The barrier therefore takes one transaction advisory lock per
    -- participant, in sorted player-id order, AFTER the committed
    -- reservations above are written, and recounts each participant's live
    -- committed reservations across every Cluster against that participant's
    -- platform limit (p_player_platforms as the matcher passes it; an
    -- unreported platform is the NARROWEST limit, mobile, exactly as P0 now
    -- defaults it). Two barriers racing for one player queue on the player's
    -- lock, and the one that waited counts the winner's committed rows in a
    -- fresh statement snapshot, so exactly one wins.
    --
    -- LOCK ORDER, AND WHY THIS CANNOT DEADLOCK AGAINST THE ANCHOR-SEAT
    -- LOCKING. These advisory locks are taken AFTER every row lock this
    -- function holds, always in sorted player-id order. Two formations in the
    -- SAME Cluster are serialised by the cash_games row taken FOR UPDATE
    -- before any seat, slot or session lock, so they never hold these locks
    -- concurrently. Two formations in DIFFERENT Clusters share no row lock at
    -- all - the Cluster row, the anchor seats, the slots, the pool sessions,
    -- the instance and the events they touch are rows of their own Cluster -
    -- so the only resource two of them can both want is this one advisory
    -- lock class, and a fixed sorted order within one lock class cannot
    -- cycle.
    FOR v_mtl_pid IN
      SELECT DISTINCT (x ->> 'player_id')::uuid FROM jsonb_array_elements(v_seats) x ORDER BY 1
    LOOP
      PERFORM pg_advisory_xact_lock(hashtextextended('lightning_player:' || v_mtl_pid::text, 0));
    END LOOP;
    v_mtl := public.fn_lightning_config(g.id) -> 'multi_table_limit';
    SELECT q.pid, q.live, q.platform, q.limit_n INTO v_mtl_row FROM (
      SELECT p.pid,
             (SELECT count(DISTINCT r.cluster_id)
                FROM public.lightning_reservation r
                JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
               WHERE r.player_id = p.pid AND r.state = 'committed'
                 AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) AS live,
             p.platform,
             coalesce((v_mtl ->> p.platform)::integer, 2) AS limit_n
        FROM (SELECT DISTINCT (x ->> 'player_id')::uuid AS pid,
                     CASE WHEN (p_player_platforms ->> (x ->> 'player_id')) IN ('desktop', 'tablet', 'mobile')
                          THEN p_player_platforms ->> (x ->> 'player_id') ELSE 'mobile' END AS platform
                FROM jsonb_array_elements(v_seats) x) p) q
     WHERE q.live > q.limit_n
     ORDER BY q.pid LIMIT 1;
    IF FOUND THEN
      -- A NORMAL RETRYABLE REFUSAL: 40001 is in this block's retry class, so
      -- the whole formation rolls back - the instance, the hand and every
      -- reservation it wrote cease to exist, which is how its reservations
      -- are released - and the matcher replans, where P0 now sees the winning
      -- Cluster's committed reservation and refuses the player as
      -- MULTI_TABLE_LIMIT.
      RAISE EXCEPTION 'LIGHTNING_MULTI_TABLE_LIMIT: player % would hold % live Lightning hands against a % limit of %',
        v_mtl_row.pid, v_mtl_row.live, v_mtl_row.platform, v_mtl_row.limit_n
        USING ERRCODE = '40001';
    END IF;
$b$],
  ARRAY[1, 1, 1, 1]);

-- ===========================================================================
-- 4. fn_lightning_match_and_form passes its platform map through to the
--    barrier, so the recount judges the platform the matcher was told.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)',
  'v_req,
        p_player_platforms);',
  ARRAY[$a$        v_group_now,
        v_version,
        v_req);
$a$],
  ARRAY[$b$        v_group_now,
        v_version,
        v_req,
        p_player_platforms);
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 5. FINDING 4 (P3): fn_lightning_recent_hands - no winners record, no
--    guessing from its absence, and the recorded userId is compared case-
--    and type-normalised.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_lightning_recent_hands(integer,uuid)',
  'public.fn_lightning_recent_hands(integer,uuid)',
  'WHEN NOT w.available THEN',
  ARRAY[$a$               CASE
                 WHEN hp.fold_type <> 'none' THEN 'folded'
                 WHEN w.mine AND w.shared THEN 'split'
                 WHEN w.mine THEN 'won'
                 WHEN hp.net_result > 0 THEN 'won'
                 WHEN hp.net_result = 0 AND NOT w.listed THEN 'split'
                 ELSE 'lost' END AS result
$a$,
        $a$          CROSS JOIN LATERAL (
            SELECT coalesce(bool_or(x.uid = hp.player_id::text), false) AS mine,
                   coalesce(bool_or(x.uid = hp.player_id::text AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) y
                      WHERE y ->> 'userId' IS DISTINCT FROM hp.player_id::text
                        AND coalesce(y ->> 'potIndex', '0') = x.pot)), false) AS shared,
                   count(*) > 0 AS listed
              FROM (SELECT e ->> 'userId' AS uid, coalesce(e ->> 'potIndex', '0') AS pot
                      FROM jsonb_array_elements(
                             CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) e) x
          ) w
$a$],
  ARRAY[$b$               CASE
                 WHEN hp.fold_type <> 'none' THEN 'folded'
                 -- 20261008043021: NO WINNERS RECORD, NO GUESSING FROM ITS
                 -- ABSENCE. With the hand_history row pruned (the retention
                 -- policy prunes horse-only hands) or its winners missing,
                 -- the result is the net alone: ahead won, behind lost,
                 -- level and not folded won (a walk or a returned blind is
                 -- not a split).
                 WHEN NOT w.available THEN CASE WHEN hp.net_result > 0 THEN 'won'
                                                WHEN hp.net_result < 0 THEN 'lost'
                                                ELSE 'won' END
                 WHEN w.mine AND w.shared THEN 'split'
                 WHEN w.mine THEN 'won'
                 WHEN hp.net_result > 0 THEN 'won'
                 WHEN hp.net_result = 0 AND NOT w.listed THEN 'split'
                 ELSE 'lost' END AS result
$b$,
        $b$          -- 20261008043021: userId is compared case- and type-normalised
          -- (an engine row has carried uppercase and non-string ids), and
          -- `available` says whether a winners record exists at all.
          CROSS JOIN LATERAL (
            SELECT (CASE WHEN jsonb_typeof(hh.winners) = 'array'
                         THEN jsonb_array_length(hh.winners) > 0 ELSE false END) AS available,
                   coalesce(bool_or(x.uid = lower(hp.player_id::text)), false) AS mine,
                   coalesce(bool_or(x.uid = lower(hp.player_id::text) AND EXISTS (
                     SELECT 1 FROM jsonb_array_elements(
                              CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) y
                      WHERE lower(btrim(y ->> 'userId')) IS DISTINCT FROM lower(hp.player_id::text)
                        AND coalesce(y ->> 'potIndex', '0') = x.pot)), false) AS shared,
                   count(*) > 0 AS listed
              FROM (SELECT lower(btrim(e ->> 'userId')) AS uid, coalesce(e ->> 'potIndex', '0') AS pot
                      FROM jsonb_array_elements(
                             CASE WHEN jsonb_typeof(hh.winners) = 'array' THEN hh.winners ELSE '[]'::jsonb END) e) x
          ) w
$b$],
  ARRAY[1, 1]);

-- ===========================================================================
-- 6. FINDING 5 (P3): fn_lightning_pool_status - the client contract is
--    {players, status, joinable, multi_table_limit}. cluster_mode leaked the
--    matcher's internals (frozen, paused, pending states) to players.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_lightning_pool_status(uuid)',
  'public.fn_lightning_pool_status(uuid)',
  '''joinable'',',
  ARRAY[$a$  SELECT cg.id, cg.cluster_mode INTO g
$a$,
        $a$  RETURN jsonb_build_object('cluster_mode', g.cluster_mode, 'players', v_live, 'status', v_status);
$a$],
  ARRAY[$b$  SELECT cg.id, cg.cluster_mode, cg.enabled, cg.lightning_enabled INTO g
$b$,
        $b$  -- 20261008043021: THE CLIENT CONTRACT IS {players, status, joinable,
  -- multi_table_limit}. cluster_mode leaked frozen, paused and the pending
  -- states to players; the lobby-facing facts are whether the pool can be
  -- entered right now and the per-platform limits the entry door enforces.
  RETURN jsonb_build_object('players', v_live, 'status', v_status,
    'joinable', (g.cluster_mode = 'lightning' AND coalesce(g.lightning_enabled, false) AND g.enabled IS TRUE),
    'multi_table_limit', v_cfg -> 'multi_table_limit');
$b$],
  ARRAY[1, 1]);

COMMENT ON FUNCTION public.fn_lightning_pool_status(uuid) IS
  'Lightning Phase 8, contract tightened by 20261008043021. Player-facing pool status {players, status, joinable, multi_table_limit}: players is the live eligible count; status is lightning at or above the large diversity band HOT, at or above the medium band ACTIVE, below it or pending_off THIN, every other mode BUILDING; joinable is true only for an enabled Lightning Cluster in lightning mode; multi_table_limit is the configured {desktop, tablet, mobile} object the client entry door enforces. Never the raw cluster_mode. Visible to whoever the lobby policy cash_games_read shows the Cluster to.';

-- ===========================================================================
-- 7. FINDING 6 (P3): fn_lightning_player_legality - an unreported platform
--    is the NARROWEST limit (mobile), never the widest.
-- ===========================================================================
SELECT pg_temp.lp78_rewrite(
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)',
  'ELSE ''mobile'' END AS platform',
  ARRAY[$a$           -- LIGHTNING PHASE 8 (20261007212735): the caller names each player's
           -- platform; missing or anything else is desktop.
           CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                THEN p_player_platforms ->> ps.player_id::text ELSE 'desktop' END AS platform,
           coalesce((g.multi_table_limits ->> CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                                                    THEN p_player_platforms ->> ps.player_id::text ELSE 'desktop' END)::integer,
                    4) AS multi_table_limit,
$a$],
  ARRAY[$b$           -- LIGHTNING PHASE 8 (20261007212735), TIGHTENED BY 20261008043021:
           -- the caller names each player's platform; missing or anything
           -- else is the NARROWEST limit (mobile), so an unreported platform
           -- can never buy a wider limit than the client would enforce.
           CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                THEN p_player_platforms ->> ps.player_id::text ELSE 'mobile' END AS platform,
           coalesce((g.multi_table_limits ->> CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                                                    THEN p_player_platforms ->> ps.player_id::text ELSE 'mobile' END)::integer,
                    2) AS multi_table_limit,
$b$],
  ARRAY[1]);

-- ===========================================================================
-- 8. READ BACK.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('the dwell is a duration', (SELECT s ~ 'make_interval\(secs => v_dwell / 1000\.0\)' AND s ~ 'ELSIF clock_timestamp\(\) <'
       FROM (SELECT pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure) AS s) q2)),
    ('the unfreeze clears the sighting', (SELECT pg_get_functiondef('public.fn_cash_cluster_unfreeze(uuid,uuid,text)'::regprocedure)
       ~ 'cluster_epoch = v_epoch, lightning_off_condition_since = NULL')),
    ('the ON commit clears the sighting', (SELECT pg_get_functiondef('public.fn_cash_cluster_commit_lightning(uuid,uuid)'::regprocedure)
       ~ 'cluster_epoch = v_epoch, lightning_off_condition_since = NULL')),
    ('the ten-argument barrier is gone', (SELECT to_regprocedure('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid)') IS NULL)),
    ('the barrier recounts under the player lock', (SELECT s ~ 'pg_advisory_xact_lock' AND s ~ 'LIGHTNING_MULTI_TABLE_LIMIT'
       AND s ~ 'ERRCODE = ''40001''' AND position('SET state = ''committed''' in s) < position('LIGHTNING_MULTI_TABLE_LIMIT' in s)
       AND s ~ 'ELSE ''mobile'' END AS platform'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure) AS s) q2)),
    ('service_role alone forms hands', (SELECT has_function_privilege('service_role', 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('anon', 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure, 'EXECUTE'))),
    ('the matcher passes the map through', (SELECT pg_get_functiondef('public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid,jsonb)'::regprocedure)
       ~ 'v_req,[[:space:]]+p_player_platforms\);')),
    ('recent hands classify an absent record on net', (SELECT s ~ 'AS available' AND s ~ 'lower\(btrim\(' AND s ~ 'WHEN NOT w\.available THEN'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_recent_hands(integer,uuid)'::regprocedure) AS s) q2)),
    ('pool status carries the client contract', (SELECT s ~ '''joinable''' AND s ~ '''multi_table_limit'', v_cfg -> ''multi_table_limit'''
       AND s !~ '''cluster_mode'', g\.cluster_mode'
       FROM (SELECT pg_get_functiondef('public.fn_lightning_pool_status(uuid)'::regprocedure) AS s) q2)),
    ('an unreported platform is mobile', (SELECT (SELECT count(*) FROM regexp_matches(s, 'ELSE ''mobile'' END', 'g')) = 2 AND s !~ 'ELSE ''desktop'' END'
       FROM (SELECT regexp_replace(pg_get_functiondef('public.fn_lightning_player_legality(uuid,timestamp with time zone,uuid[],jsonb)'::regprocedure), '--[^' || chr(10) || ']*', '', 'g') AS s) q2)),
    ('no horse is singled out', (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prokind = 'f'
         AND p.proname IN ('fn_cash_cluster_begin_pending_off', 'fn_cash_cluster_unfreeze', 'fn_cash_cluster_commit_lightning',
                           'fn_lightning_form_hand', 'fn_lightning_match_and_form', 'fn_lightning_recent_hands',
                           'fn_lightning_pool_status', 'fn_lightning_player_legality')
         AND regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id')))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_P78_REVIEW_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
