-- Exact production function bodies captured 2026-10-31, native fixture only.
-- form bcffeef6366e53a35e656759a18ec051; matcher 8e06bde427b2b38939194c4ebb16c7de;
-- planner 37ad3bca64b5f487f874ba12ec9b9b7d. Real P6 financial writers stay intact.
-- P6 estate predates these two schema additions; empty intent relation models
-- no pending top-up. Its maintained config is set explicitly by each case.
ALTER TABLE public.lightning_pool_session ADD COLUMN IF NOT EXISTS stop_requested_at timestamptz;
CREATE TABLE smarter_private.lightning_top_up_intents(anchor_seat_id uuid,status text);
CREATE OR REPLACE FUNCTION public.fn_lightning_table_size_allowed(p_handedness integer)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(p_handedness = 6, false) $function$
;

CREATE OR REPLACE FUNCTION public.fn_lightning_template_allowed(p_template text, p_rules jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(p_template IN ('action','madness') AND p_rules->>'template'=p_template,false) $function$
;

CREATE OR REPLACE FUNCTION public.fn_lightning_variant_allowed(p_variant text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog'
AS $function$ SELECT coalesce(lower(p_variant) NOT IN
  ('short_deck','shortdeck','flo8','plo8','omaha8','o8','pineapple','pineapple_holdem'), false) $function$
;

CREATE OR REPLACE FUNCTION smarter_private.lightning_top_up_pending(p_anchor uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'smarter_private', 'pg_temp'
AS $function$
 SELECT EXISTS (SELECT 1 FROM smarter_private.lightning_top_up_intents
   WHERE anchor_seat_id=p_anchor AND status='pending');
$function$
;


CREATE OR REPLACE FUNCTION public.fn_lightning_player_legality(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS TABLE(player_id uuid, pool_session_id uuid, pool_slot_id uuid, legal boolean, reason_code text, detail jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- MATERIALIZED, twice: an inlined CTE substitutes its expressions into
  -- every reference, which would ask the configuration once per player and
  -- run the whole reason chain once per use of its answer.
  WITH g AS MATERIALIZED (
    SELECT cg.id AS cluster_id, cg.cluster_mode, coalesce(cg.lightning_enabled, false) AS enabled,
           cg.cluster_epoch,
           EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                    WHERE e.cluster_id = cg.id AND e.epoch = cg.cluster_epoch AND e.ended_at IS NULL) AS epoch_open,
           public.fn_platform_frozen() AS platform_frozen,
           -- THE SEAT DOOR'S GATE: fn_ca_refuse_restricted_entry refuses only
           -- when the operator policy enforces restrictions, and otherwise
           -- only observes. The matcher follows the door.
           coalesce((SELECT op.restrictions_enforced FROM public.ca_operator_policy op LIMIT 1), false) AS restrictions_enforced,
           public.fn_lightning_config(cg.id) AS lcfg
      FROM public.cash_games cg
     WHERE cg.id = p_cluster_id
  ), f AS (
    SELECT g.cluster_id, g.cluster_mode, g.enabled, g.cluster_epoch, g.epoch_open, g.platform_frozen,
           g.restrictions_enforced,
           -- LIGHTNING PHASE 8 (20261007212735), TIGHTENED BY 20261008043021:
           -- the caller names each player's platform; missing or anything
           -- else is the NARROWEST limit (mobile), so an unreported platform
           -- can never buy a wider limit than the client would enforce.
           CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                THEN p_player_platforms ->> ps.player_id::text ELSE 'mobile' END AS platform,
           coalesce(((g.lcfg -> 'multi_table_limit') ->> CASE WHEN (p_player_platforms ->> ps.player_id::text) IN ('desktop', 'tablet', 'mobile')
                                                    THEN p_player_platforms ->> ps.player_id::text ELSE 'mobile' END)::integer,
                    2) AS multi_table_limit,
           ps.player_id, ps.id AS pool_session_id, ps.state AS pool_state, ps.cluster_epoch AS pool_epoch,
           ps.anchor_seat_id,
           ps.stop_requested_at,
           -- LIGHTNING PHASE 13 (20261009235505): when the pool closed to
           -- newcomers, and when this session entered it.
           ps.entered_at AS pool_entered_at,
           CASE WHEN (g.lcfg ->> 'lightning_joins_enabled')::boolean IS FALSE
                THEN (g.lcfg ->> 'lightning_joins_disabled_at')::timestamptz END AS joins_closed_at,
           sl.id AS slot_id, sl.cluster_epoch AS slot_epoch, sl.pool_session_id AS slot_session_id,
           cps.id AS cash_session_id, cps.closed_at AS cash_session_closed_at,
           ts.id AS seat_id, ts.left_at AS seat_left_at, ts.user_id AS seat_user_id,
           coalesce(ts.is_sitting_out, false) AS seat_sitting_out,
           coalesce(ts.leave_pending, false) AS seat_leave_pending,
           tb.cluster_id AS seat_cluster_id, coalesce(tb.is_deleted, false) AS table_deleted,
           coalesce(tb.lifecycle, '') AS table_lifecycle
      FROM g
      JOIN public.lightning_pool_session ps
        ON ps.cluster_id = g.cluster_id AND ps.exited_at IS NULL
      LEFT JOIN public.lightning_pool_slot sl
        ON sl.cluster_id = ps.cluster_id AND sl.player_id = ps.player_id AND sl.closed_at IS NULL
      LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
      LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
      LEFT JOIN public.tables tb ON tb.id = ts.table_id
  ), c AS MATERIALIZED (
    SELECT f.*, CASE
        WHEN coalesce(f.cluster_mode, '') NOT IN ('lightning', 'frozen', 'paused') THEN 'CLUSTER_NOT_LIGHTNING'
        WHEN f.cluster_mode IN ('frozen', 'paused') THEN 'CLUSTER_FROZEN'
        WHEN NOT f.enabled THEN 'LIGHTNING_DISABLED'
        WHEN f.platform_frozen THEN 'PLATFORM_FROZEN'
        WHEN f.pool_epoch IS DISTINCT FROM f.cluster_epoch OR NOT f.epoch_open THEN 'WRONG_EPOCH'
        WHEN f.cash_session_id IS NULL OR f.cash_session_closed_at IS NOT NULL
             OR f.pool_state = 'closed' THEN 'SESSION_CLOSED'
        WHEN f.pool_state IN ('joining', 'eligibility_check') THEN 'POOL_SESSION_NOT_ACTIVE'
        WHEN f.pool_state = 'leaving' OR f.seat_leave_pending THEN 'CASHOUT_PENDING'
        WHEN f.seat_id IS NULL OR f.seat_left_at IS NOT NULL
             OR f.seat_user_id IS DISTINCT FROM f.player_id
             OR f.seat_cluster_id IS DISTINCT FROM f.cluster_id
             OR f.table_deleted OR f.table_lifecycle = 'closed' THEN 'ANCHOR_LEFT'
        WHEN f.pool_state = 'sit_out' OR f.seat_sitting_out THEN 'SITTING_OUT'
        WHEN smarter_private.lightning_top_up_pending(f.anchor_seat_id) THEN 'TOP_UP_PENDING'
        WHEN coalesce(public.fn_lightning_pool_stack(f.pool_session_id), 0) <= 0 THEN 'NO_STACK'
        -- THE POPULATION'S PREDICATE HAS THE LAST WORD ON THE ANCHOR: anything
        -- it refuses that the four arms above did not name is still refused.
        WHEN NOT public.fn_lightning_anchor_is_live_eligible(f.anchor_seat_id, f.cluster_id, f.player_id) THEN 'ANCHOR_LEFT'
        WHEN f.restrictions_enforced AND public.fn_ca_player_restricted(f.player_id, 'cash') THEN 'RESTRICTED'
        WHEN (public.fn_rg_require_not_excluded(f.player_id) ->> 'ok')::boolean IS DISTINCT FROM true THEN 'RG_EXCLUDED'
        WHEN f.pool_state = 'disconnected'
             OR f.player_id = ANY (coalesce(p_disconnected, ARRAY[]::uuid[])) THEN 'DISCONNECTED'
        WHEN f.pool_state IS DISTINCT FROM 'active' THEN 'POOL_SESSION_NOT_ACTIVE'
        WHEN EXISTS (SELECT 1 FROM public.lightning_reservation r
                      WHERE r.cluster_id = f.cluster_id AND r.player_id = f.player_id
                        AND r.state IN ('pending', 'committed'))
             AND NOT public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'ALREADY_RESERVED'
        WHEN public.fn_lightning_player_in_hand(f.player_id, f.cluster_id) THEN 'IN_HAND'
        -- LIGHTNING PHASE 10 (20261008111425): a player who pressed Stop
        -- Playing is never matched into another hand. After the hand arms,
        -- so a stopper still playing reads IN_HAND until the hand lets go.
        -- LIGHTNING PHASE 13 (20261009235505): a session that entered after
        -- an operator closed joins is held; everyone already in plays on.
        WHEN f.joins_closed_at IS NOT NULL AND f.pool_entered_at >= f.joins_closed_at THEN 'LIGHTNING_JOINS_DISABLED'
        WHEN f.stop_requested_at IS NOT NULL THEN 'STOP_REQUESTED'
        WHEN f.slot_id IS NULL OR f.slot_epoch IS DISTINCT FROM f.cluster_epoch
             OR f.slot_session_id IS DISTINCT FROM f.pool_session_id THEN 'SLOT_NOT_OPEN'
        WHEN (SELECT count(DISTINCT r.cluster_id)
                FROM public.lightning_reservation r
                JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
               WHERE r.player_id = f.player_id AND r.cluster_id <> f.cluster_id
                 AND r.state = 'committed'
                 AND i.state IN ('forming', 'reserved', 'dealing', 'settling')) >= f.multi_table_limit THEN 'MULTI_TABLE_LIMIT'
      END AS code
      FROM f
  )
  SELECT c.player_id, c.pool_session_id, c.slot_id,
         c.code IS NULL,
         c.code,
         jsonb_strip_nulls(jsonb_build_object(
           'cluster_mode', c.cluster_mode, 'cluster_epoch', c.cluster_epoch,
           'pool_epoch', c.pool_epoch, 'slot_epoch', c.slot_epoch, 'pool_state', c.pool_state,
           'anchor_seat_id', c.anchor_seat_id))
         || CASE c.code
              WHEN 'RG_EXCLUDED' THEN jsonb_build_object('responsible_gaming', public.fn_rg_require_not_excluded(c.player_id))
              WHEN 'RESTRICTED' THEN jsonb_build_object('restriction_scope', 'cash',
                'restriction_reason', (public.fn_ca_player_restriction_for(c.player_id, 'cash')).reason_code)
              WHEN 'MULTI_TABLE_LIMIT' THEN jsonb_build_object('multi_table_limit', c.multi_table_limit, 'platform', c.platform,
                'live_hands_elsewhere', (SELECT count(DISTINCT r.cluster_id)
                                           FROM public.lightning_reservation r
                                           JOIN public.lightning_instance i ON i.id = r.lightning_instance_id
                                          WHERE r.player_id = c.player_id AND r.cluster_id <> c.cluster_id
                                            AND r.state = 'committed'
                                            AND i.state IN ('forming', 'reserved', 'dealing', 'settling')))
              WHEN 'LIGHTNING_JOINS_DISABLED' THEN jsonb_build_object('joins_disabled_at', c.joins_closed_at)
              WHEN 'STOP_REQUESTED' THEN jsonb_build_object('stop_requested_at', c.stop_requested_at)
              WHEN 'DISCONNECTED' THEN jsonb_build_object('reported_disconnected',
                c.player_id = ANY (coalesce(p_disconnected, ARRAY[]::uuid[])))
              ELSE '{}'::jsonb
            END
    FROM c
   ORDER BY c.player_id;
$function$
;


CREATE OR REPLACE FUNCTION public.fn_lightning_diversity_assign(p_groups jsonb, p_rest uuid[], p_capacity integer[], p_encounters jsonb, p_recent_sets jsonb, p_weight numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_grp      jsonb := coalesce(p_groups, '[]'::jsonb);
  v_g        integer := jsonb_array_length(coalesce(p_groups, '[]'::jsonb));
  v_cap      integer[] := coalesce(p_capacity, ARRAY[]::integer[]);
  v_enc      jsonb := coalesce(p_encounters, '{}'::jsonb);
  v_sets     jsonb := coalesce(p_recent_sets, '{}'::jsonb);
  v_moved    integer[];
  v_active   boolean;
  v_default  integer;
  v_best     integer;
  v_def_pen  integer;
  v_best_pen integer;
  v_pen      integer;
  v_key      text;
  pen        record;
  p          uuid;
  j          integer;
BEGIN
  v_moved := CASE WHEN v_g > 0 THEN array_fill(0, ARRAY[v_g]) ELSE ARRAY[]::integer[] END;
  v_active := coalesce(p_weight, 0) > 0 AND (v_enc <> '{}'::jsonb OR v_sets <> '{}'::jsonb);
  FOREACH p IN ARRAY coalesce(p_rest, ARRAY[]::uuid[]) LOOP
    v_default := NULL;
    FOR j IN 1 .. v_g LOOP
      IF v_cap[j] > 0 THEN v_default := j; EXIT; END IF;
    END LOOP;
    IF v_default IS NULL THEN
      RAISE EXCEPTION 'fn_lightning_diversity_assign: % players for fewer seats', cardinality(p_rest);
    END IF;
    v_best := v_default;
    IF v_active THEN
      v_def_pen := NULL;
      v_best_pen := NULL;
      FOR pen IN
        SELECT t.j::integer AS j, jsonb_array_length(t.arr) AS size,
               coalesce(sum(coalesce((v_enc ->> (LEAST(p, m.pid::uuid)::text || '/' || GREATEST(p, m.pid::uuid)::text))::integer, 0)), 0)::integer AS n
          FROM jsonb_array_elements(v_grp) WITH ORDINALITY t(arr, j)
          CROSS JOIN LATERAL jsonb_array_elements_text(t.arr) m(pid)
         GROUP BY t.j, t.arr
         ORDER BY t.j
      LOOP
        IF v_cap[pen.j] > 0 THEN
          v_pen := pen.n;
          IF v_cap[pen.j] = 1 AND v_sets <> '{}'::jsonb THEN
            SELECT string_agg(z.x::text, ',' ORDER BY z.x) INTO v_key
              FROM (SELECT m.pid::uuid AS x FROM jsonb_array_elements_text(v_grp -> (pen.j - 1)) m(pid)
                    UNION ALL SELECT p) z;
            IF v_sets ? v_key THEN
              v_pen := v_pen + ((pen.size + 1) * pen.size) / 2;
            END IF;
          END IF;
          IF pen.j = v_default THEN v_def_pen := v_pen; END IF;
          IF v_best_pen IS NULL OR v_pen < v_best_pen THEN
            v_best_pen := v_pen;
            v_best := pen.j;
          END IF;
        END IF;
      END LOOP;
      IF NOT (p_weight * (v_def_pen - v_best_pen) >= 1) THEN
        v_best := v_default;
      END IF;
    END IF;
    v_grp := jsonb_set(v_grp, ARRAY[(v_best - 1)::text], (v_grp -> (v_best - 1)) || to_jsonb(p));
    v_cap[v_best] := v_cap[v_best] - 1;
    IF v_best <> v_default THEN v_moved[v_best] := v_moved[v_best] + 1; END IF;
  END LOOP;
  RETURN jsonb_build_object('groups', v_grp, 'moved', to_jsonb(v_moved));
END
$function$
;

CREATE OR REPLACE FUNCTION public.fn_lightning_formation_sizes(p_legal integer, p_min integer, p_target integer, p_max integer, p_oldest_idle timestamp with time zone, p_now timestamp with time zone)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n integer:=GREATEST(coalesce(p_legal,0),0); result integer[];
BEGIN
 result:=ARRAY(SELECT 6 FROM generate_series(1,n/6));
 -- Direct sizing callers supply the fifth-ready time. The matcher asks for
 -- potential groups and enforces the deadline on their actual selected members.
 IF n%6=5 AND p_oldest_idle IS NOT NULL AND p_now-p_oldest_idle>=interval '1 second' THEN
  result:=array_append(result,5);
 END IF;
 RETURN result;
END $function$
;


CREATE OR REPLACE FUNCTION public.fn_lightning_match_plan(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_matcher_version text, p_max_groups integer, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now       timestamptz := coalesce(p_now, now());
  v_cfg       jsonb;
  v_version   text;
  v_epoch     integer;
  v_min       integer;
  v_target    integer;
  v_max       integer;
  v_cap       integer;
  v_rule      text;
  v_p3        boolean;
  v_rows      jsonb;
  v_info      jsonb := '{}'::jsonb;
  v_legal     uuid[] := ARRAY[]::uuid[];
  v_newcomer  uuid[] := ARRAY[]::uuid[];
  v_seatable  uuid[];
  v_next      uuid[];
  v_held      uuid[] := ARRAY[]::uuid[];
  v_entry     uuid[] := ARRAY[]::uuid[];
  v_entry_on  boolean := false;
  v_sizes     integer[];
  v_sizes2    integer[];
  v_g         integer;
  v_g2        integer;
  v_bbs       uuid[];
  v_rest_all  uuid[];
  v_rest      uuid[];
  v_sbs       uuid[];
  v_wait      uuid[];
  v_need      integer;
  v_sizing_left integer;
  v_n         integer;
  v_band      text;
  v_w         numeric;
  v_enc       jsonb := '{}'::jsonb;
  v_recent_sets jsonb := '{}'::jsonb;
  v_grp       jsonb;
  v_capleft   integer[];
  v_moved     integer[];
  v_assign    jsonb;
  v_last      jsonb := '{}'::jsonb;
  v_glast     integer;
  j           integer;
  v_members   uuid[];
  v_bb        uuid;
  v_sb        uuid;
  v_order     uuid[];
  v_left      uuid[];
  v_pick      uuid;
  v_label     text;
  v_size      integer;
  v_seat_no   integer;
  v_groups    jsonb := '[]'::jsonb;
  v_diag      jsonb;
  v_pairs     integer := 0;
  v_repeat_pairs integer := 0;
  v_gpairs    integer;
  v_grepeat   integer;
  v_genc      integer;
  v_matched   uuid[] := ARRAY[]::uuid[];
  v_capacity_reason text;
  v_win_h     integer;
  v_win_s     integer;
  v_variant   text;
BEGIN
  v_cfg := public.fn_lightning_config(p_cluster_id);
  v_version := coalesce(nullif(btrim(coalesce(p_matcher_version, '')), ''), v_cfg ->> 'matcher_version', 'm1');
  SELECT cg.cluster_epoch INTO v_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true OR v_epoch IS NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'diagnosis', '[]'::jsonb, 'pool_diversity_score', 1);
  END IF;
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): ONLY A VARIANT THE
  -- LIGHTNING HOST CAN DEAL IS MATCHED. Pineapple's discard round needs the
  -- physical discard pipeline, which the host does not run (it abandons such
  -- a hand at begin: LightningHandHost.checkVariant), so every hand formed
  -- would be abandoned and the pool would churn. The Cluster's variant and
  -- its front table's rules (the host's) are read; every open-pool player
  -- is diagnosed BLOCKED_WITH_REASON VARIANT_NOT_SUPPORTED.
  SELECT CASE WHEN cg.variant = 'pineapple' THEN cg.variant
              WHEN tb.game_variant = 'pineapple' THEN tb.game_variant
              WHEN coalesce(tb.pineapple_holdem, false) THEN 'pineapple_holdem' END
    INTO v_variant
    FROM public.cash_games cg
    LEFT JOIN public.tables tb ON tb.id = public.fn_cash_cluster_front_table(cg.id)
   WHERE cg.id = p_cluster_id;
  IF v_variant IS NOT NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'refused', true, 'reason', 'variant_not_supported',
                              'variant', v_variant,
                              'diagnosis', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                                                     'player_id', l.player_id, 'state', 'BLOCKED_WITH_REASON',
                                                     'reason_code', 'VARIANT_NOT_SUPPORTED') ORDER BY l.player_id), '[]'::jsonb)
                                              FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms) l),
                              'pool_diversity_score', 1);
  END IF;
  v_min    := (v_cfg ->> 'instance_min')::integer;
  v_target := (v_cfg ->> 'instance_target')::integer;
  v_max    := (v_cfg ->> 'instance_max')::integer;
  v_rule   := 'big_blind';  -- always (20261024195059); never read as a switch
  v_p3     := (v_cfg ->> 'position_fairness')::boolean;
  v_win_h  := (v_cfg ->> 'recent_opponent_window_hands')::integer;
  v_win_s  := (v_cfg ->> 'recent_opponent_window_seconds')::integer;
  v_cap    := LEAST(GREATEST(coalesce(p_max_groups, (v_cfg ->> 'admission_batch_hands')::integer), 0),
                    (v_cfg ->> 'admission_batch_hands')::integer);

  -- P0, once. Every open-pool player, ordered by player_id.
  SELECT coalesce(jsonb_agg(jsonb_build_object('player_id', l.player_id, 'legal', l.legal,
                                               'reason_code', l.reason_code) ORDER BY l.player_id), '[]'::jsonb)
    INTO v_rows
    FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected, p_player_platforms) l;

  -- THE KEYS OF EVERY LEGAL PLAYER. P2 is the barrier's own order; P4 is
  -- idle_since, pool entry, Cluster join, player_id.
  WITH lg AS (
    SELECT (x ->> 'player_id')::uuid AS pid
      FROM jsonb_array_elements(v_rows) x
     WHERE (x ->> 'legal')::boolean
  ), bo AS (
    SELECT b.* FROM public.fn_lightning_blind_order(p_cluster_id, v_epoch,
                      coalesce((SELECT array_agg(lg.pid) FROM lg), ARRAY[]::uuid[])) b
  ), k AS (
    SELECT bo.p2_rank, bo.player_id, bo.pool_slot_id, bo.bb_unresolved, bo.last_bb_at, bo.debt_age,
           sl.idle_since, ps.entered_at, cps.opened_at AS joined_at,
           -- A NEWCOMER (20261024213844): never the big blind, and not a seat the
           -- epoch's conversion made for a player already at the tables.
           (sl.last_bb_at IS NULL AND NOT coalesce((
             -- LIGHTNING_CONVERSION_SEAT (20261024213844): the epoch's conversion
             -- entered this seat for a player already at the tables.
             SELECT cs_cps.opened_at < cs_ep.started_at
                    AND cs_ps.entered_at < cs_ep.started_at + interval '5 seconds'
                    AND sl.opened_at < cs_ep.started_at + interval '5 seconds'
               FROM public.lightning_pool_session cs_ps
               JOIN public.cash_player_session cs_cps ON cs_cps.id = cs_ps.cash_player_session_id
               JOIN public.cash_cluster_epoch cs_ep ON cs_ep.cluster_id = sl.cluster_id AND cs_ep.epoch = sl.cluster_epoch
              WHERE cs_ps.id = sl.pool_session_id), false)) AS newcomer,
           coalesce(bl.btn_count, 0) AS btn, coalesce(bl.co_count, 0) AS co,
           coalesce(bl.hj_count, 0) AS hj, coalesce(bl.utg_count, 0) AS utg,
           row_number() OVER (ORDER BY sl.idle_since, ps.entered_at, cps.opened_at, bo.player_id) AS p4
      FROM bo
      JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
      LEFT JOIN public.cash_player_session cps ON cps.id = ps.cash_player_session_id
      LEFT JOIN public.lightning_blind_ledger bl ON bl.cluster_id = sl.cluster_id AND bl.player_id = sl.player_id
  )
  SELECT coalesce(array_agg(k.player_id ORDER BY k.p2_rank), ARRAY[]::uuid[]),
         coalesce(array_agg(k.player_id ORDER BY k.p2_rank) FILTER (WHERE k.newcomer), ARRAY[]::uuid[]),
         coalesce(jsonb_object_agg(k.player_id::text, jsonb_build_object(
           'p2', k.p2_rank, 'p4', k.p4, 'slot', k.pool_slot_id,
           'bb_unresolved', k.bb_unresolved, 'last_bb_at', k.last_bb_at, 'debt_age', k.debt_age,
           'idle_since', k.idle_since, 'entered_at', k.entered_at, 'joined_at', k.joined_at,
           'btn', k.btn, 'co', k.co, 'hj', k.hj, 'utg', k.utg)), '{}'::jsonb)
    INTO v_legal, v_newcomer, v_info
    FROM k;

  v_n := cardinality(v_legal);

  -- P5's band, by the legal count.
  v_band := CASE WHEN v_n >= (v_cfg ->> 'diversity_large_min')::integer THEN 'large'
                 WHEN v_n >= (v_cfg ->> 'diversity_medium_min')::integer THEN 'medium'
                 WHEN v_n >= (v_cfg ->> 'diversity_thin_min')::integer THEN 'thin'
                 ELSE 'tiny' END;
  v_w := CASE v_band WHEN 'large' THEN (v_cfg ->> 'diversity_weight_large')::numeric
                     WHEN 'medium' THEN (v_cfg ->> 'diversity_weight_medium')::numeric
                     ELSE 0 END;

  -- P1: sizes from the legal count. P2: the first g legal players in P2
  -- order are the g big blinds.
  v_seatable := v_legal;
  v_sizes := public.fn_lightning_formation_sizes(cardinality(v_seatable), v_min, v_target, v_max, v_now - interval '1 second', v_now);
  v_g := LEAST(cardinality(v_sizes), v_cap);

  -- NEW PLAYERS ARE ALWAYS THE BIG BLIND FIRST (Dan 2026-10-24: "NEW PLAYERS
  -- SHOULD ALWAYS BE BB FIRST"; 20261024195059). A newcomer - a pool slot that
  -- has never been the big blind - who is not one of this pass's big blinds is
  -- held, even when holding costs the pass a hand. Holding shrinks the pass,
  -- so its big blinds are taken again, and a newcomer pushed out of them is
  -- held too, until nothing changes. The one exception: a hold that would
  -- leave the pass no hand at all is not taken, so a pool of only newcomers
  -- still deals and never deadlocks. A held newcomer ranks first in P2
  -- (last_bb_at NULLS FIRST), so they are the next pass's big blind.
  LOOP
    EXIT WHEN v_g = 0;
    v_bbs := v_seatable[1:v_g];
    v_next := ARRAY(SELECT u.pid FROM unnest(v_seatable) WITH ORDINALITY u(pid, ord)
                     WHERE NOT (u.pid = ANY (v_newcomer)) OR u.pid = ANY (v_bbs)
                     ORDER BY u.ord);
    EXIT WHEN cardinality(v_next) = cardinality(v_seatable);
    v_sizes2 := public.fn_lightning_formation_sizes(cardinality(v_next), v_min, v_target, v_max, v_now - interval '1 second', v_now);
    v_g2 := LEAST(cardinality(v_sizes2), v_cap);
    EXIT WHEN v_g2 = 0;
    v_seatable := v_next;
    v_sizes := v_sizes2;
    v_g := v_g2;
  END LOOP;
  v_held := ARRAY(SELECT u.pid FROM unnest(v_legal) WITH ORDINALITY u(pid, ord)
                   WHERE NOT (u.pid = ANY (v_seatable)) ORDER BY u.ord);

  v_bbs := CASE WHEN v_g > 0 THEN v_seatable[1:v_g] ELSE ARRAY[]::uuid[] END;

  -- P4: the non-blind seats of this pass go to the non-blind seatable
  -- players in queue order; the rest wait for formation.
  v_rest_all := ARRAY(SELECT u.pid FROM unnest(v_seatable) u(pid)
                       WHERE NOT (u.pid = ANY (v_bbs))
                       ORDER BY (v_info -> u.pid::text ->> 'p4')::integer);
  v_need := coalesce((SELECT sum(s) FROM unnest(v_sizes[1:v_g]) s), 0)::integer - v_g;
  v_rest := v_rest_all[1:v_need];
  v_wait := coalesce(v_rest_all[v_need + 1:cardinality(v_rest_all)], ARRAY[]::uuid[]);

  -- ENTRY BIG BLIND (Dan 2026-10-24: "NEW PLAYERS SHOULD ALWAYS BE BB FIRST";
  -- 20261025050528). The hold loop above seats a newcomer outside the big
  -- blinds only when holding would leave the pass no hand. Each such newcomer
  -- the pass seats posts a LIVE ENTRY BIG BLIND: one big blind, counted toward
  -- their call, with the option, exactly as the big blind plays. Only when the
  -- calling engine posts it and the participant row can record it (the
  -- gate); otherwise the set is empty and the plan is the plan before this
  -- change.
  -- THE ENTRY BIG BLIND GATE (20261025050528). Open only when the calling
  -- engine posts the entry big blind (PostgREST request.headers carries
  -- x-smarter-lightning-entry-bb: 1, which LightningSupervisor sends) AND
  -- lightning_hand_player can record it (20261025050534 admits 'entry_bb').
  -- Either missing, nothing here emits 'entry_bb' and this is the function
  -- it was before.
  BEGIN
    v_entry_on := coalesce(nullif(current_setting('request.headers', true), '')::jsonb
                             ->> 'x-smarter-lightning-entry-bb', '') = '1'
                  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                               WHERE c.conrelid = 'public.lightning_hand_player'::regclass
                                 AND c.conname = 'lightning_hand_player_blind_role_check'
                                 AND position('''entry_bb''' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0);
  EXCEPTION WHEN invalid_text_representation THEN
    v_entry_on := false;
  END;
  IF v_entry_on THEN
    v_entry := ARRAY(SELECT u.pid FROM unnest(v_rest) WITH ORDINALITY u(pid, ord)
                      WHERE u.pid = ANY (v_newcomer) ORDER BY u.ord);
  END IF;
  v_sizing_left := cardinality(v_seatable) - coalesce((SELECT sum(s) FROM unnest(v_sizes) s), 0)::integer;

  -- P5's MEMORY: pair encounters among this pass's seated players in the
  -- Cluster's most recent hands, and the recent full-table compositions.
  IF v_g > 0 THEN
    WITH recent AS (
      SELECT h.hand_id
        FROM public.lightning_hand h
       WHERE h.cluster_id = p_cluster_id AND h.cluster_epoch = v_epoch
         AND h.formed_at <= v_now
         AND h.formed_at > v_now - make_interval(secs => v_win_s)
       ORDER BY h.formed_at DESC, h.hand_id
       LIMIT v_win_h
    ), hp AS (
      SELECT hp.hand_id, hp.player_id, h.formed_at
        FROM recent
        JOIN public.lightning_hand h ON h.hand_id = recent.hand_id
        JOIN public.lightning_hand_player hp ON hp.hand_id = recent.hand_id
    ), last_hand AS (
      SELECT DISTINCT ON (hp.player_id) hp.player_id, hp.hand_id
        FROM hp ORDER BY hp.player_id, hp.formed_at DESC, hp.hand_id
    )
    SELECT coalesce((SELECT jsonb_object_agg(q.pair, q.n)
                       FROM (SELECT a.player_id::text || '/' || b.player_id::text AS pair, count(*)::integer AS n
                               FROM hp a JOIN hp b ON b.hand_id = a.hand_id AND a.player_id < b.player_id
                              WHERE a.player_id = ANY (v_bbs || v_rest) AND b.player_id = ANY (v_bbs || v_rest)
                              GROUP BY a.player_id, b.player_id) q), '{}'::jsonb),
           coalesce((SELECT jsonb_object_agg(s.members, true)
                       FROM (SELECT DISTINCT string_agg(hp.player_id::text, ',' ORDER BY hp.player_id) AS members
                               FROM hp GROUP BY hp.hand_id) s), '{}'::jsonb),
           -- Ordered pairs a/b: b sat in a's most recent hand (an immediate repeat).
           coalesce((SELECT jsonb_object_agg(l.player_id::text || '/' || o.player_id::text, true)
                       FROM last_hand l JOIN hp o ON o.hand_id = l.hand_id AND o.player_id <> l.player_id
                      WHERE l.player_id = ANY (v_bbs || v_rest)), '{}'::jsonb)
      INTO v_enc, v_recent_sets, v_last;
  END IF;

  -- P2 FOR THE SMALL BLIND: of the players seated this pass, the next g in
  -- P2 order are the small blinds, one to a group - the classical orbit, in
  -- which the small blind is the player next due for the big blind. Every one
  -- of them is seated this pass either way, so which group each sits in is a
  -- choice among P4-equivalents; and each ranks above every other non-blind
  -- member of its group, so the barrier's own P2-second is this player.
  v_sbs := ARRAY(SELECT u.pid FROM unnest(v_rest) u(pid)
                  ORDER BY (u.pid = ANY (v_entry)), (v_info -> u.pid::text ->> 'p2')::integer LIMIT v_g);
  v_rest := ARRAY(SELECT u.pid FROM unnest(v_rest) WITH ORDINALITY u(pid, ord)
                   WHERE NOT (u.pid = ANY (v_sbs)) ORDER BY u.ord);

  -- THE ASSIGNMENT. Each group starts with its big and small blinds; each
  -- other seated player, in P4 order, goes to the first group with room
  -- (plain P4) unless P5 saves weight x (encounters, and a repeated full
  -- table) >= 1 elsewhere: fn_lightning_diversity_assign, pure.
  v_grp := '[]'::jsonb;
  v_capleft := ARRAY[]::integer[];
  FOR j IN 1 .. v_g LOOP
    v_grp := v_grp || jsonb_build_array(jsonb_build_array(v_bbs[j], v_sbs[j]));
    v_capleft := v_capleft || (v_sizes[j] - 2);
  END LOOP;
  v_assign := public.fn_lightning_diversity_assign(v_grp, v_rest, v_capleft, v_enc, v_recent_sets, v_w);
  v_grp := v_assign -> 'groups';
  v_moved := ARRAY(SELECT x::integer FROM jsonb_array_elements_text(v_assign -> 'moved') WITH ORDINALITY t(x, o) ORDER BY o);

  -- EACH GROUP: P3's advisory order of the non-blind seats, and the evidence.
  FOR j IN 1 .. v_g LOOP
    v_bb := v_bbs[j];
    v_members := ARRAY(SELECT m.pid::uuid FROM jsonb_array_elements_text(v_grp -> (j - 1)) m(pid));
    -- The small blind, placed above; the barrier's own P2-second in the group.
    v_sb := v_sbs[j];
    -- P3, ADVISORY, AND ONLY THE ORDER OF THE NON-BLIND SEATS. The barrier
    -- seats the caller's order from seat 3 onward and names the positions by
    -- seat (the last is the button, then the cut-off, the hijack, and seat 3
    -- under-the-gun). Filled from the button backward, each seat goes to the
    -- remaining member who has held that position least; a tie - and every
    -- seat when P3 is off - keeps queue order.
    v_left := ARRAY(SELECT m FROM unnest(v_members) m
                     WHERE m <> v_bb AND m IS DISTINCT FROM v_sb
                     ORDER BY (v_info -> m::text ->> 'p4')::integer);
    v_order := ARRAY[]::uuid[];

    v_size := cardinality(v_members);
    IF v_size = 5 AND (SELECT max((v_info -> m::text ->> 'idle_since')::timestamptz)
                       FROM unnest(v_members) m) > v_now - interval '1 second' THEN
      CONTINUE;
    END IF;
    FOR v_seat_no IN REVERSE v_size .. 3 LOOP
      v_label := CASE WHEN v_seat_no = v_size THEN 'btn'
                      WHEN v_seat_no = v_size - 1 THEN 'co'
                      WHEN v_seat_no = v_size - 2 THEN 'hj'
                      WHEN v_seat_no = 3 THEN 'utg'
                      ELSE NULL END;
      SELECT u.m INTO v_pick FROM unnest(v_left) WITH ORDINALITY u(m, o)
       ORDER BY CASE WHEN v_p3 AND v_label IS NOT NULL THEN (v_info -> u.m::text ->> v_label)::integer ELSE 0 END,
                u.o DESC
       LIMIT 1;
      v_order := v_pick || v_order;
      v_left := array_remove(v_left, v_pick);
    END LOOP;
    SELECT count(*)::integer,
           coalesce(sum(CASE WHEN coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0) > 0 THEN 1 ELSE 0 END), 0)::integer,
           coalesce(sum(coalesce((v_enc ->> (a.m::text || '/' || b.m::text))::integer, 0)), 0)::integer
      INTO v_gpairs, v_grepeat, v_genc
      FROM unnest(v_members) a(m) JOIN unnest(v_members) b(m) ON a.m < b.m;
    SELECT count(*)::integer INTO v_glast
      FROM unnest(v_members) a(m) JOIN unnest(v_members) b(m) ON a.m <> b.m
     WHERE v_last ? (a.m::text || '/' || b.m::text);
    v_pairs := v_pairs + v_gpairs;
    v_repeat_pairs := v_repeat_pairs + v_grepeat;
    v_matched := v_matched || v_members;
    v_groups := v_groups || jsonb_build_array(jsonb_build_object(
      'players', to_jsonb(ARRAY[v_bb] || CASE WHEN v_sb IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_sb] END || v_order),
      'bb', v_bb,
      'entry_bb', to_jsonb(ARRAY(SELECT m FROM unnest(ARRAY[v_bb] || CASE WHEN v_sb IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_sb] END || v_order)
                                         WITH ORDINALITY q(m, o)
                                  WHERE m = ANY (v_entry) ORDER BY o)),
      'keys', jsonb_build_object(
        'size', cardinality(v_members),
        'instance', jsonb_build_object('min', v_min, 'target', v_target, 'max', v_max),
        'p2', jsonb_build_object('bb', v_bb, 'bb_p2_rank', (v_info -> v_bb::text -> 'p2'),
                                 'bb_unresolved', (v_info -> v_bb::text -> 'bb_unresolved'),
                                 'bb_last_bb_at', (v_info -> v_bb::text -> 'last_bb_at'),
                                 'bb_debt_age', (v_info -> v_bb::text -> 'debt_age'),
                                 'sb', v_sb, 'sb_p2_rank', (v_info -> v_sb::text -> 'p2')),
        -- Heads-up, the small blind is the button (the barrier's own rule).
        'p3', jsonb_build_object('applied', v_p3,
                                 'btn', coalesce(v_order[cardinality(v_order)], v_sb),
                                 'btn_count_before', (v_info -> (coalesce(v_order[cardinality(v_order)], v_sb))::text -> 'btn'),
                                 'order', to_jsonb(v_order)),
        'p4', jsonb_build_object('ranks', (SELECT jsonb_agg((v_info -> m::text -> 'p4') ORDER BY (v_info -> m::text ->> 'p4')::integer)
                                             FROM unnest(v_members) m WHERE m <> v_bb),
                                 'oldest_idle_since', (SELECT min((v_info -> m::text ->> 'idle_since')::timestamptz)
                                                         FROM unnest(v_members) m)),
        'p5', jsonb_build_object('band', v_band, 'weight', v_w, 'pairs', v_gpairs,
                                 'repeat_pairs', v_grepeat, 'pair_encounters', v_genc,
                                 'moved_here', v_moved[j],
                                 'repeat_full_table', v_recent_sets ? (SELECT string_agg(m::text, ',' ORDER BY m) FROM unnest(v_members) m),
                                 -- The specification's diversity measures, for this hand:
                                 -- pairings in it nobody met in the window, those per player,
                                 -- the share of pairings that are repeats, and the share of
                                 -- (player, opponent) pairs where the opponent sat in the
                                 -- player's most recent hand.
                                 'unique_opponents', v_gpairs - v_grepeat,
                                 'new_opponents_per_hand', CASE WHEN cardinality(v_members) = 0 THEN 0
                                   ELSE round(2 * (v_gpairs - v_grepeat)::numeric / cardinality(v_members), 4) END,
                                 'repeat_pair_rate', CASE WHEN v_gpairs = 0 THEN 0
                                   ELSE round(v_grepeat::numeric / v_gpairs, 4) END,
                                 'repeat_opponent_rate', CASE WHEN cardinality(v_members) < 2 THEN 0
                                   ELSE round(v_glast::numeric / (cardinality(v_members) * (cardinality(v_members) - 1)), 4) END),
        'p6', jsonb_build_object('new_instance', true, 'merged_into_committed_hand', false))));
  END LOOP;

  -- THE DIAGNOSIS: every open-pool player, exactly once.
  v_capacity_reason := CASE WHEN v_g < cardinality(v_sizes) THEN 'PASS_CAPACITY' ELSE 'GROUP_SIZING' END;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'player_id', d.pid,
           'state', CASE
             WHEN d.pid = ANY (v_matched) THEN 'MATCHED'
             WHEN d.code = 'DISCONNECTED' THEN 'WAITING_FOR_RECONNECT'
             WHEN d.code IS NOT NULL THEN 'BLOCKED_WITH_REASON'
             WHEN d.pid = ANY (v_held) THEN 'WAITING_FOR_BB'
             WHEN v_n < v_min THEN 'WAITING_FOR_PLAYERS'
             ELSE 'WAITING_FOR_FORMATION' END,
           'reason_code', CASE
             WHEN d.pid = ANY (v_matched) THEN NULL
             WHEN d.code IS NOT NULL THEN d.code
             WHEN d.pid = ANY (v_held) THEN 'FIRST_ENTRY_WAITS_FOR_BB'
             WHEN v_n < v_min THEN 'NOT_ENOUGH_LEGAL_PLAYERS'
             -- The sizing leftovers are the last in queue order.
             WHEN v_sizing_left > 0
                  AND array_position(v_wait, d.pid) > cardinality(v_wait) - v_sizing_left THEN 'GROUP_SIZING'
             ELSE v_capacity_reason END) ORDER BY d.pid), '[]'::jsonb)
    INTO v_diag
    FROM (SELECT (x ->> 'player_id')::uuid AS pid, x ->> 'reason_code' AS code
            FROM jsonb_array_elements(v_rows) x) d;

  RETURN jsonb_build_object(
    'matcher_version', v_version,
    'generated_at', v_now,
    'legal_count', v_n,
    'entry_big_blind', v_entry_on,
    'groups', v_groups,
    'diagnosis', v_diag,
    'pool_diversity_score', CASE WHEN v_pairs = 0 THEN 1
                                 ELSE round(1 - v_repeat_pairs::numeric / v_pairs, 4) END);
END
$function$
;


CREATE OR REPLACE FUNCTION public.fn_lightning_form_hand(p_cluster_id uuid, p_players uuid[], p_target_size smallint DEFAULT NULL::smallint, p_max_size smallint DEFAULT NULL::smallint, p_bb_player uuid DEFAULT NULL::uuid, p_reservation_ttl interval DEFAULT '00:00:20'::interval, p_form_window interval DEFAULT '00:00:45'::interval, p_now timestamp with time zone DEFAULT clock_timestamp(), p_matcher_version text DEFAULT NULL::text, p_request_id uuid DEFAULT NULL::uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  g           record;
  v_epoch     integer;
  v_cand      uuid[];
  v_legal     uuid[];
  v_pool      jsonb;
  v_seats     jsonb;
  v_n         integer;
  v_target    smallint;
  v_max       smallint;
  v_bb        uuid;
  v_sb        uuid;
  v_btn       uuid;
  -- 20261025050528: the candidates who post a live entry big blind.
  v_entry     uuid[] := ARRAY[]::uuid[];
  v_entry_on  boolean := false;
  v_ok        boolean;
  v_instance  uuid;
  v_hand      uuid;
  v_before    numeric;
  v_after     numeric;
  v_sqlstate  text;
  v_msg       text;
  -- 2026-09-26: the participants' money under the FOR SHARE lock, and the
  -- versions the hand is stamped with at step 7.
  v_money_before      text;
  v_money_after       text;
  v_rules_version     text;
  v_rake_version      text;
  v_blind_version     text;
  v_lightning_version text;
  -- 2026-09-26: the replayed hand, the constraint a refusal names, and
  -- nothing else.
  v_replay    record;
  v_constraint text;
  v_alert_id  uuid;
  v_alert_error text;
  -- 20261008043021: the cross-Cluster multi-table recount.
  v_mtl       jsonb;
  v_mtl_pid   uuid;
  v_mtl_row   record;
  v_ttl       interval := GREATEST(coalesce(p_reservation_ttl, interval '20 seconds'), interval '5 seconds');
  v_window    interval := GREATEST(coalesce(p_form_window, interval '45 seconds'), interval '5 seconds');
BEGIN
  IF p_cluster_id IS NULL OR p_players IS NULL OR coalesce(array_length(p_players, 1), 0) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'no_candidate_set');
  END IF;

  -- SPECIFICATION 2139 (2026-09-26). Every hand records its matcher_version,
  -- and the matcher is the one component the database cannot see, so only the
  -- caller can say which one it is. Refused before anything is locked, read or
  -- written.
  IF p_matcher_version IS NULL OR length(btrim(p_matcher_version)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'matcher_version_required');
  END IF;

  -- A RETRY IS ANSWERED WITH THE HAND IT ALREADY FORMED (2026-09-26). A
  -- matcher that lost the answer to a formation - a timeout, a dropped
  -- connection - retries with the same p_request_id and is told what happened
  -- instead of forming a second hand out of the same players. Answered before
  -- the freeze, because reading what already happened is not forming a hand;
  -- two racing calls with one request id are decided by
  -- lightning_hand_one_per_request, whose violation is a retry, and the retry
  -- lands here.
  IF p_request_id IS NOT NULL THEN
    SELECT lh.hand_id, lh.cluster_id, lh.cluster_epoch, lh.lightning_instance_id, lh.player_count
      INTO v_replay FROM public.lightning_hand lh WHERE lh.request_id = p_request_id;
    IF FOUND THEN
      IF v_replay.cluster_id IS DISTINCT FROM p_cluster_id THEN
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                  'reason', 'request_id_belongs_to_another_cluster',
                                  'request_id', p_request_id);
      END IF;
      RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false, 'replayed', true,
        'hand_id', v_replay.hand_id, 'instance_id', v_replay.lightning_instance_id,
        'cluster_id', v_replay.cluster_id, 'cluster_epoch', v_replay.cluster_epoch,
        'players', v_replay.player_count,
        'bb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id AND hp.blind_role = 'bb'),
        'sb', (SELECT hp.player_id FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_replay.hand_id
                  AND (hp.blind_role = 'sb' OR (hp.seat = 1 AND hp.blind_role = 'entry_bb'))),
        'btn', (SELECT hp.player_id FROM public.lightning_hand_player hp
                 WHERE hp.hand_id = v_replay.hand_id AND hp."position" = 'btn'),
        'seats', (SELECT jsonb_agg(jsonb_build_object(
                           'player_id', hp.player_id, 'pool_slot_id', hp.pool_slot_id,
                           'pool_session_id', sl.pool_session_id, 'stack_before', hp.stack_before,
                           'seat', hp.seat, 'position', hp."position", 'blind_role', hp.blind_role)
                         ORDER BY hp.seat)
                    FROM public.lightning_hand_player hp
                    JOIN public.lightning_pool_slot sl ON sl.id = hp.pool_slot_id
                   WHERE hp.hand_id = v_replay.hand_id),
        'state', (SELECT li.state FROM public.lightning_instance li
                   WHERE li.id = v_replay.lightning_instance_id),
        'request_id', p_request_id);
    END IF;
  END IF;

  -- theFreezeIsTotal. Forming a hand during the maintenance break is exactly
  -- what the freeze forbids; releasing one is not, which is why
  -- fn_lightning_reap_formations and fn_lightning_instance_abandon are not
  -- gated and this is.
  IF public.fn_platform_frozen() THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                              'reason', 'platform_frozen');
  END IF;

  -- CONTENTION IS A RETRY, NOT A CRASH (2026-09-26). From here to the end of
  -- the function the barrier waits on locks - the Cluster row, the slots, the
  -- participants' pool sessions, the reap - and the estate sets lock_timeout.
  -- This sub-block catches lock_not_available, deadlock_detected and
  -- serialization_failure, and only those, rolls the whole formation back and
  -- answers formation_contended with a matcher_retry. It does NOT catch
  -- query_canceled: a cancel belongs to whoever asked for it, and the header of
  -- 20260926023047 says why.
  BEGIN

  -- THE CLUSTER ROW IS TAKEN FOR UPDATE BEFORE THE EPOCH IS READ, which
  -- serialises formation against fn_cash_cluster_commit_lightning's own
  -- FOR UPDATE on the same row. Without it "the epoch I bound is the epoch the
  -- Cluster is in" is likely rather than true, and a conversion landing
  -- between the read and the INSERT would bind a hand to an epoch that no
  -- longer exists.
  SELECT id, cluster_mode, lightning_enabled, cluster_epoch, handedness
    INTO g FROM public.cash_games WHERE id = p_cluster_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'reason', 'not_found');
  END IF;
  IF g.cluster_mode IS DISTINCT FROM 'lightning'
     OR coalesce(g.lightning_enabled, false) = false THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'cluster_is_not_lightning',
                              'cluster_mode', g.cluster_mode,
                              'lightning_enabled', coalesce(g.lightning_enabled, false));
  END IF;
  IF NOT public.fn_lightning_template_allowed((SELECT cg.template_name FROM public.cash_games cg WHERE cg.id=g.id),(SELECT cg.ruleset_snapshot FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'retry',false,'reason','lightning_template_not_allowed');
  END IF;
  IF NOT public.fn_lightning_table_size_allowed((SELECT cg.handedness FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'retry',false,'reason','lightning_table_size_not_allowed');
  END IF;
  IF NOT public.fn_lightning_variant_allowed((SELECT cg.variant FROM public.cash_games cg WHERE cg.id=g.id)) THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'retry',false,'reason','lightning_variant_not_allowed');
  END IF;
  v_epoch := g.cluster_epoch;
  IF NOT EXISTS (SELECT 1 FROM public.cash_cluster_epoch e
                  WHERE e.cluster_id = g.id AND e.epoch = v_epoch AND e.ended_at IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                              'reason', 'epoch_is_not_open', 'cluster_epoch', v_epoch);
  END IF;

  -- THE NEXT FORMATION BURIES THE LAST ONE'S CORPSE (2026-09-26). DECISION 2 of
  -- 20260925215731 said this and put it in fn_lightning_instance_open, which no
  -- formation path calls. It is here now, under the Cluster row lock and before
  -- the INSERT below, so a player it hands back is a legal candidate in this
  -- same call. The reaper clamps its clock to clock_timestamp().
  PERFORM public.fn_lightning_reap_formations(p_now, 200, g.id);

  -- SPECIFICATION 2137-2143: THE VERSIONS THIS HAND IS FORMED UNDER, read now,
  -- under the same Cluster row lock that binds its epoch. The header of
  -- 20260926023047 says why each comes from where it does.
  SELECT 'ruleset:' || md5(coalesce(cg.ruleset_snapshot, '{}'::jsonb)::text),
         'rake:' || md5(coalesce(cg.ruleset_snapshot -> 'rake', 'null'::jsonb)::text)
    INTO v_rules_version, v_rake_version
    FROM public.cash_games cg WHERE cg.id = g.id;
  SELECT 'fn_lightning_blind_order:' || md5(p.prosrc) INTO v_blind_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_blind_order(uuid,integer,uuid[])'::regprocedure;
  SELECT 'fn_lightning_form_hand:' || md5(p.prosrc) INTO v_lightning_version
    FROM pg_catalog.pg_proc p
   WHERE p.oid = 'public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamp with time zone,text,uuid,jsonb)'::regprocedure;

  -- THE MONEY GUARD NO LONGER MEASURES THE WHOLE POOL (2026-09-26). It read
  -- every pool session of the Cluster in two READ COMMITTED statements under no
  -- lock, so any commit anywhere in the Cluster between them looked like this
  -- formation moving money. It measures the participants now, under the
  -- FOR SHARE lock step 1 takes; see v_money_before below.

  -- The caller's order is the matcher's order and is preserved exactly;
  -- duplicates are collapsed to their first mention rather than silently
  -- seating somebody twice.
  v_cand := ARRAY(SELECT x.pid FROM (
              SELECT u.pid, min(u.ord) AS ord
                FROM unnest(p_players) WITH ORDINALITY AS u(pid, ord)
               WHERE u.pid IS NOT NULL
               GROUP BY u.pid) x ORDER BY x.ord);

  -- THE ANCHOR SEATS, FOR SHARE, FIRST (2026-09-26). The seat is the economic
  -- anchor and fn_lightning_pool_stack reads it, so from here to commit
  -- nothing may change a candidate's seat stack, departure or occupant - and
  -- they are taken BEFORE the slots and the pool sessions, because the
  -- deferred table_seats trigger that exits a departing anchor holds that seat
  -- and then writes its session and slot: a formation that already held those
  -- and waited on the seat would close the cycle. In seat id order, so two
  -- matchers queue rather than deadlock.
  PERFORM 1 FROM public.table_seats ts
   WHERE ts.id IN (SELECT ps.anchor_seat_id
                     FROM public.lightning_pool_slot sl
                     JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ts.id
   FOR SHARE;

  -- A stale plan is checked under the same anchor locks as its stack.
  -- A funded request is not needed here: this is an uncharged original intent.
  IF EXISTS (SELECT 1 FROM public.lightning_pool_session ps
      WHERE ps.cluster_id=g.id AND ps.player_id=ANY(v_cand)
        AND ps.exited_at IS NULL AND smarter_private.lightning_top_up_pending(ps.anchor_seat_id)) THEN
    RETURN jsonb_build_object('ok',true,'formed',false,'retry',true,'reason','top_up_pending');
  END IF;

  -- BARRIER STEP 1, AND THE LOCK THAT MAKES IT MEAN SOMETHING. The slots are
  -- taken FOR UPDATE in player_id order - a fixed order, so two matchers
  -- racing for an overlapping candidate set queue rather than deadlock.
  PERFORM 1 FROM public.lightning_pool_slot sl
   WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
     AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand)
   ORDER BY sl.player_id
   FOR UPDATE;

  -- AND THEIR POOL SESSIONS, FOR SHARE (2026-09-26), in pool session id order
  -- and BEFORE a single stack is read. From here to commit no other
  -- transaction can change a candidate's starting_stack, net_result,
  -- ending_stack or exited_at, so the stack_before snapshotted below is the
  -- stack that is still there when the hand commits, and the money guard at the
  -- end measures what THIS transaction did and nothing else. A settlement
  -- writing to one of these players waits for the formation, which is
  -- milliseconds.
  PERFORM 1 FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT sl.pool_session_id FROM public.lightning_pool_slot sl
                    WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch
                      AND sl.closed_at IS NULL AND sl.player_id = ANY (v_cand))
   ORDER BY ps.id
   FOR SHARE;

  -- P0 LEGALITY, and there is no is_horse in it. Law 10.5: a horse is a
  -- player. A candidate is legal when they hold an open pool slot at THIS
  -- Cluster and THIS epoch, an open and active pool session, a strictly
  -- positive stack - a player who cannot post is not a legal candidate - and
  -- no reservation anybody else is already holding.
  SELECT coalesce(array_agg(q.pid), ARRAY[]::uuid[]) INTO v_legal FROM (
    SELECT sl.player_id AS pid
      FROM public.lightning_pool_slot sl
      JOIN public.lightning_pool_session ps ON ps.id = sl.pool_session_id
     WHERE sl.cluster_id = g.id AND sl.cluster_epoch = v_epoch AND sl.closed_at IS NULL
       AND sl.player_id = ANY (v_cand)
       AND ps.cluster_id = g.id AND ps.cluster_epoch = v_epoch
       AND ps.exited_at IS NULL AND ps.state = 'active'
       AND public.fn_lightning_pool_stack(ps.id) > 0
       -- THE SAME QUESTION THE POPULATION ASKS (2026-09-26): the anchor seat is
       -- live eligible - not left, not sitting out, not leaving, chips on it,
       -- at a live table of this Cluster, held by this player - and the cash
       -- session the pool session is subordinate to is still open.
       AND public.fn_lightning_anchor_is_live_eligible(ps.anchor_seat_id, g.id, ps.player_id)
       AND NOT smarter_private.lightning_top_up_pending(ps.anchor_seat_id)
       AND EXISTS (SELECT 1 FROM public.cash_player_session cps
                    WHERE cps.id = ps.cash_player_session_id AND cps.closed_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_reservation r
                        WHERE r.cluster_id = sl.cluster_id AND r.player_id = sl.player_id
                          AND r.state IN ('pending', 'committed'))
  ) q;

  -- AND THE P2 ORDER COMES FROM THE ONE FUNCTION THAT OWNS THE KEY. An earlier
  -- cut of this file wrote the ordering out a second time here, and the two
  -- copies were then two places for the key to drift - which a mutation run
  -- caught by changing one of them and watching nothing go red, because the
  -- other was the one that mattered. fn_lightning_blind_order is now the only
  -- expression of specification 601-608 in the database, and this is its
  -- caller.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       bo.player_id,
           'pool_slot_id',    bo.pool_slot_id,
           'pool_session_id', sl.pool_session_id,
           'stack',           public.fn_lightning_pool_stack(sl.pool_session_id),
           'bb_unresolved',   bo.bb_unresolved,
           'last_bb_at',      bo.last_bb_at,
           'newcomer',        (sl.last_bb_at IS NULL AND NOT coalesce((
             -- LIGHTNING_CONVERSION_SEAT (20261024213844): the epoch's conversion
             -- entered this seat for a player already at the tables.
             SELECT cs_cps.opened_at < cs_ep.started_at
                    AND cs_ps.entered_at < cs_ep.started_at + interval '5 seconds'
                    AND sl.opened_at < cs_ep.started_at + interval '5 seconds'
               FROM public.lightning_pool_session cs_ps
               JOIN public.cash_player_session cs_cps ON cs_cps.id = cs_ps.cash_player_session_id
               JOIN public.cash_cluster_epoch cs_ep ON cs_ep.cluster_id = sl.cluster_id AND cs_ep.epoch = sl.cluster_epoch
              WHERE cs_ps.id = sl.pool_session_id), false)),
           'debt_age',        bo.debt_age,
           'entered_pool',    bo.entered_pool,
           'caller_rank',     o.ord)
         ORDER BY bo.p2_rank)
    INTO v_pool
    FROM public.fn_lightning_blind_order(g.id, v_epoch, v_legal) bo
    JOIN public.lightning_pool_slot sl ON sl.id = bo.pool_slot_id
    JOIN unnest(v_cand) WITH ORDINALITY AS o(pid, ord) ON o.pid = bo.player_id;

  v_n      := coalesce(jsonb_array_length(v_pool), 0);
  v_target := GREATEST(5, LEAST(6, coalesce(p_target_size, 6)))::smallint;
  v_max := 6;
  IF v_max < v_target THEN v_max := v_target; END IF;
  IF v_target < 2 THEN v_target := 2; END IF;
  IF v_max > 9 THEN v_max := 9; END IF;


  -- Direct formation callers obey the same wait as the matcher. The latest
  -- eligible arrival starts the one second; an old first arrival cannot
  -- prematurely release a newly ready fifth player.
  IF v_n = 5 AND v_target = 5 AND coalesce((
    SELECT max(sl.idle_since) FROM public.lightning_pool_slot sl
     WHERE sl.cluster_id=g.id AND sl.id IN (SELECT (x->>'pool_slot_id')::uuid FROM jsonb_array_elements(v_pool) x) AND sl.closed_at IS NULL
  ), coalesce(p_now,clock_timestamp())) > coalesce(p_now,clock_timestamp()) - interval '1 second' THEN
    RETURN jsonb_build_object('ok',false,'formed',false,'reason','WAITING_FOR_SIXTH_PLAYER');
  END IF;
  IF v_n < v_target THEN
    -- SPECIFICATION 733. Nothing was taken, so there is nothing to release -
    -- but the retry still has to be VISIBLE, or a matcher spinning on a pool
    -- that can never fill leaves no trace anywhere.
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
      'reason', 'insufficient_legal_candidates', 'offered', array_length(v_cand, 1),
      'legal', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
    RETURN jsonb_build_object('ok', true, 'formed', false, 'retry', true,
                              'reason', 'insufficient_legal_candidates',
                              'offered', array_length(v_cand, 1), 'legal', v_n,
                              'target_size', v_target);
  END IF;

  -- OVER-SUPPLY IS TRIMMED ALONG THE P2 KEY, not along the caller's order, so
  -- the player most owed a big blind is never the one dropped.
  IF v_n > v_max THEN
    SELECT jsonb_agg(z.e ORDER BY z.ord) INTO v_pool
      FROM (SELECT e, ord FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)) z
     WHERE z.ord <= v_max;
    v_n := v_max;
  END IF;

  -- BARRIER STEP 5, FIRST HALF, AND THE ONE P2 RULE THAT HAS TO LIVE DOWN
  -- HERE. The barrier's own choice is the P2-maximal candidate. A matcher may
  -- override it, and may not override it with somebody P2 could never have
  -- chosen: p_bb_player is accepted only if it ties on the WHOLE key -
  -- unresolved obligation, last_bb_at, blind-debt age - with the candidate the
  -- barrier would have taken.
  v_bb := (v_pool -> 0 ->> 'player_id')::uuid;
  IF p_bb_player IS NOT NULL AND p_bb_player IS DISTINCT FROM v_bb THEN
    -- AND POOL ENTRY (2026-09-26), P2 tie-break 3. Without it a matcher could
    -- name a player who loses on pool entry. The only freedom left is among
    -- players P2 cannot tell apart except by id, and the id is a tie-break for
    -- determinism, not a fairness rule.
    SELECT ((e -> 'bb_unresolved'), (e -> 'last_bb_at'), (e -> 'debt_age'), (e -> 'entered_pool'))
           IS NOT DISTINCT FROM
           ((v_pool -> 0 -> 'bb_unresolved'), (v_pool -> 0 -> 'last_bb_at'), (v_pool -> 0 -> 'debt_age'),
            (v_pool -> 0 -> 'entered_pool'))
      INTO v_ok
      FROM jsonb_array_elements(v_pool) e
     WHERE (e ->> 'player_id')::uuid = p_bb_player;
    IF NOT coalesce(v_ok, false) THEN
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false,
                                'reason', 'bb_choice_is_not_p2_legal',
                                'asked_for', p_bb_player, 'p2_would_choose', v_bb);
    END IF;
    v_bb := p_bb_player;
  END IF;

  -- ENTRY BIG BLIND (20261025050528). A candidate who has never been the
  -- big blind (last_bb_at NULL on the barrier's own locked P2 row), is not a
  -- conversion seat and is not this hand's big blind posts a live entry big
  -- blind from their seat. Only
  -- when the calling engine posts it and the row can record it (the gate);
  -- otherwise the set is empty and the barrier is the barrier before this
  -- change. The small blind is taken from the others first; a hand with
  -- nobody else gives seat 1 to an entry poster, whose small blind is then
  -- dead.
  -- THE ENTRY BIG BLIND GATE (20261025050528). Open only when the calling
  -- engine posts the entry big blind (PostgREST request.headers carries
  -- x-smarter-lightning-entry-bb: 1, which LightningSupervisor sends) AND
  -- lightning_hand_player can record it (20261025050534 admits 'entry_bb').
  -- Either missing, nothing here emits 'entry_bb' and this is the function
  -- it was before.
  BEGIN
    v_entry_on := coalesce(nullif(current_setting('request.headers', true), '')::jsonb
                             ->> 'x-smarter-lightning-entry-bb', '') = '1'
                  AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                               WHERE c.conrelid = 'public.lightning_hand_player'::regclass
                                 AND c.conname = 'lightning_hand_player_blind_role_check'
                                 AND position('''entry_bb''' IN pg_catalog.pg_get_constraintdef(c.oid)) > 0);
  EXCEPTION WHEN invalid_text_representation THEN
    v_entry_on := false;
  END;
  IF v_entry_on THEN
    v_entry := ARRAY(SELECT (t.e ->> 'player_id')::uuid
                       FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
                      WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
                        AND coalesce((t.e ->> 'newcomer')::boolean, false)
                      ORDER BY t.ord);
  END IF;
  SELECT (t.e ->> 'player_id')::uuid INTO v_sb
    FROM jsonb_array_elements(v_pool) WITH ORDINALITY t(e, ord)
   WHERE (t.e ->> 'player_id')::uuid IS DISTINCT FROM v_bb
   ORDER BY ((t.e ->> 'player_id')::uuid = ANY (v_entry)), t.ord LIMIT 1;

  -- BARRIER STEPS 3, 4, 5 AND 6 AS ONE MAP. Seat 1 is the small blind, seat 2
  -- the big blind, and seats 3..n are filled IN THE ORDER THE CALLER GAVE
  -- THEM: P3 position fairness is advisory and the matcher's, and a barrier
  -- that re-sorted those seats would be quietly overruling it. Heads-up, seat
  -- 1 is the button and posts the small blind, which is why blind_role and
  -- position are separate columns.
  SELECT jsonb_agg(jsonb_build_object(
           'player_id',       s.pid,
           'pool_slot_id',    (s.e ->> 'pool_slot_id')::uuid,
           'pool_session_id', (s.e ->> 'pool_session_id')::uuid,
           'stack_before',    (s.e ->> 'stack')::numeric,
           'seat',            s.seat,
           'position', CASE WHEN v_n = 2 AND s.seat = 1 THEN 'btn'
                            WHEN v_n = 2                THEN 'bb'
                            WHEN s.seat = 1             THEN 'sb'
                            WHEN s.seat = 2             THEN 'bb'
                            WHEN s.seat = v_n           THEN 'btn'
                            WHEN s.seat = v_n - 1       THEN 'co'
                            WHEN s.seat = v_n - 2       THEN 'hj'
                            -- SEVEN, EIGHT AND NINE HANDED (2026-09-26). Every
                            -- seat below the hijack used to be utg, so an
                            -- eight-handed hand had three players under the
                            -- gun and three utg_counts moved. Exactly one now.
                            WHEN s.seat = 3             THEN 'utg'
                            WHEN s.seat = v_n - 3       THEN 'lj'
                            WHEN s.seat = 4             THEN 'utg1'
                            ELSE 'utg2' END,
           'blind_role', CASE WHEN s.pid = ANY (v_entry) THEN 'entry_bb'
                              WHEN s.seat = 1 THEN 'sb'
                              WHEN s.seat = 2 THEN 'bb'
                              ELSE 'none' END)
         ORDER BY s.seat)
    INTO v_seats
    FROM (
      SELECT r.e, r.pid,
             (CASE WHEN r.pid = v_bb THEN 2
                   WHEN r.pid = v_sb THEN 1
                   ELSE 2 + row_number() OVER (PARTITION BY (r.pid IN (v_bb, v_sb))
                                               ORDER BY r.crank) END)::smallint AS seat
        FROM (SELECT t.e, (t.e ->> 'player_id')::uuid AS pid, (t.e ->> 'caller_rank')::integer AS crank
                FROM jsonb_array_elements(v_pool) t(e)) r
    ) s;

  SELECT (x ->> 'player_id')::uuid INTO v_btn
    FROM jsonb_array_elements(v_seats) x WHERE x ->> 'position' = 'btn';

  -- F12'S SHAPE, MEASURED OVER THE PARTICIPANTS (2026-09-26). Every money
  -- column of every participant's pool session, ordered, as text - not a sum,
  -- so two stacks that swapped are a difference too. These rows are held
  -- FOR SHARE since step 1, so nothing but this transaction can change them
  -- before the comparison at the end.
  SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                    || ':' || coalesce(ps.net_result::text, 'null')
                    || ':' || coalesce(ps.ending_stack::text, 'null')
                    || ':' || coalesce(ps.exited_at::text, 'open')
                    || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                          || '@' || coalesce(ts.user_id::text, 'empty')
                                          FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                    '|' ORDER BY ps.id)
    INTO v_money_before
    FROM public.lightning_pool_session ps
   WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);

  v_hand := gen_random_uuid();

  -- =========================================================================
  -- THE ATOMIC BLOCK. Everything below either all happens or none of it does.
  -- An exception here rolls back to this block's implicit savepoint, and the
  -- instance, the reservations, the hand and the participants cease to have
  -- ever existed - which is a stronger form of specification 728-731 than
  -- releasing them would be, because there is nothing left to release, nothing
  -- to reap, and the players' pool state is restored by never having changed.
  -- The exception list is CLOSED: anything that is not one of these eight
  -- classes propagates and aborts the caller, because a barrier that swallows
  -- every error is a pool that silently stops dealing with no row saying why.
  -- =========================================================================
  BEGIN
    INSERT INTO public.lightning_instance
      (cluster_id, cluster_epoch, state, target_size, max_size, created_at, deadline_at)
    VALUES (g.id, v_epoch, 'forming', v_target, v_max, p_now, p_now + v_window)
    RETURNING id INTO v_instance;

    -- STEPS 2 AND 3: the player reservation and the seat reservation are one
    -- row, because they are one claim. lightning_reservation_one_active_per_-
    -- player is what refuses a second matcher holding the same person;
    -- lightning_reservation_one_seat_per_instance is what refuses two people
    -- holding the same seat. Both are indexes, so both are decided by the
    -- database at INSERT time rather than by a read anybody can lose a race to.
    INSERT INTO public.lightning_reservation
      (cluster_id, cluster_epoch, player_id, pool_slot_id, lightning_instance_id,
       seat_number, state, created_at, expires_at)
    SELECT g.id, v_epoch, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           v_instance, (x ->> 'seat')::smallint, 'pending', p_now, p_now + v_ttl
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 7: the immutable hand id, and STEPS 8 AND 9: the instance and the
    -- epoch it is bound to. The hand is born UNLOCKED - the latch goes on
    -- after the participants are in, which is what makes step 10 a step.
    INSERT INTO public.lightning_hand
      (hand_id, cluster_id, cluster_epoch, lightning_instance_id, formed_at,
       rules_version, matcher_version, blind_algorithm_version, lightning_version, rake_version,
       request_id)
    VALUES (v_hand, g.id, v_epoch, v_instance, p_now,
            v_rules_version, btrim(p_matcher_version), v_blind_version, v_lightning_version, v_rake_version,
            p_request_id);

    -- STEPS 4, 5 AND 6: positions, blind roles and the stack snapshot.
    INSERT INTO public.lightning_hand_player
      (hand_id, player_id, pool_slot_id, seat, "position", blind_role, stack_before,
       fold_type, cluster_id, cluster_epoch)
    SELECT v_hand, (x ->> 'player_id')::uuid, (x ->> 'pool_slot_id')::uuid,
           (x ->> 'seat')::smallint, (x ->> 'position'), (x ->> 'blind_role'),
           (x ->> 'stack_before')::numeric, 'none', g.id, v_epoch
      FROM jsonb_array_elements(v_seats) x;

    -- STEP 10. The latch and its count move in one statement, and
    -- trg_lightning_hand_is_immutable refuses the statement unless the count
    -- matches the rows that are actually there.
    UPDATE public.lightning_hand h
       SET participants_locked_at = p_now, player_count = v_n::smallint
     WHERE h.hand_id = v_hand;

    UPDATE public.lightning_reservation r
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

    UPDATE public.lightning_instance li
       SET hand_id = v_hand, state = 'reserved', deadline_at = p_now + v_window
     WHERE li.id = v_instance;

    -- P2 BOOKKEEPING, AND NOT ONE COLUMN OF IT IS MONEY. last_bb_at is what
    -- makes the next formation pick somebody else; without this stamp the same
    -- player is the big blind of every hand for ever. missed_bb_debt, bb_owed
    -- and sb_owed are obligations created when a blind is DUE and discharged
    -- when it is POSTED, and posting is barrier step 12, which is the engine's.
    UPDATE public.lightning_pool_slot sl
       SET last_bb_at     = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN p_now ELSE sl.last_bb_at END,
           last_sb_at     = CASE WHEN sl.player_id = v_sb AND NOT (sl.player_id = ANY (v_entry)) THEN p_now ELSE sl.last_sb_at END,
           last_button_at = CASE WHEN sl.player_id = v_btn THEN p_now ELSE sl.last_button_at END,
           hands_since_bb = CASE WHEN sl.player_id = v_bb OR sl.player_id = ANY (v_entry) THEN 0 ELSE sl.hands_since_bb + 1 END,
           hands_since_sb = CASE WHEN sl.player_id = v_sb AND NOT (sl.player_id = ANY (v_entry)) THEN 0 ELSE sl.hands_since_sb + 1 END,
           updated_at     = p_now
     WHERE sl.id IN (SELECT hp.pool_slot_id FROM public.lightning_hand_player hp
                      WHERE hp.hand_id = v_hand);

    INSERT INTO public.lightning_blind_ledger
      (cluster_id, player_id, bb_count, sb_count, btn_count, utg_count, hj_count, co_count,
       first_seen_at, updated_at)
    SELECT g.id, hp.player_id,
           (coalesce(hp.blind_role, 'none') IN ('bb', 'entry_bb'))::integer,
           (coalesce(hp.blind_role, 'none') = 'sb')::integer,
           (coalesce(hp."position", '') = 'btn')::integer,
           (coalesce(hp."position", '') = 'utg')::integer,
           (coalesce(hp."position", '') = 'hj')::integer,
           (coalesce(hp."position", '') = 'co')::integer,
           p_now, p_now
      FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand
    ON CONFLICT (cluster_id, player_id) DO UPDATE SET
      bb_count   = public.lightning_blind_ledger.bb_count   + EXCLUDED.bb_count,
      sb_count   = public.lightning_blind_ledger.sb_count   + EXCLUDED.sb_count,
      btn_count  = public.lightning_blind_ledger.btn_count  + EXCLUDED.btn_count,
      utg_count  = public.lightning_blind_ledger.utg_count  + EXCLUDED.utg_count,
      hj_count   = public.lightning_blind_ledger.hj_count   + EXCLUDED.hj_count,
      co_count   = public.lightning_blind_ledger.co_count   + EXCLUDED.co_count,
      updated_at = EXCLUDED.updated_at;

    -- THE BARRIER'S OWN PRE-COMMIT RE-CHECKS. Each is a state the locks above
    -- make impossible, so each raises PLT02, LIGHTNING_FORMATION_INVARIANT
    -- (2026-09-26), which the handler below does NOT retry: it rolls the block
    -- back, freezes the Cluster and writes the evidence.
    IF (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand) <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % was formed for % players and holds %',
        v_hand, v_n, (SELECT count(*) FROM public.lightning_hand_player hp WHERE hp.hand_id = v_hand)
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_reservation r
         WHERE r.lightning_instance_id = v_instance AND r.state = 'committed') <> v_n THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % has % committed reservations for % seats',
        v_hand, (SELECT count(*) FROM public.lightning_reservation r
                  WHERE r.lightning_instance_id = v_instance AND r.state = 'committed'), v_n
        USING ERRCODE = 'PLT02';
    END IF;
    IF (SELECT count(*) FROM public.lightning_hand_player hp
         WHERE hp.hand_id = v_hand AND hp.blind_role = 'bb') <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand
              AND (hp.blind_role = 'sb' OR (hp.seat = 1 AND hp.blind_role = 'entry_bb'))) <> 1
       OR (SELECT count(*) FROM public.lightning_hand_player hp
            WHERE hp.hand_id = v_hand AND hp."position" = 'btn') <> 1 THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % does not have exactly one big blind, one small blind and one button',
        v_hand USING ERRCODE = 'PLT02';
    END IF;
    IF EXISTS (SELECT 1 FROM public.lightning_hand_player hp
                WHERE hp.hand_id = v_hand
                  AND (hp.stack_before IS NULL OR hp.stack_before <= 0)) THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_SET_IS_WRONG: hand % seated a player with no stack to post from',
        v_hand USING ERRCODE = 'PLT02';
    END IF;

    -- F12'S SHAPE, ONE PHASE ON (moved inside the block 2026-09-26). Every
    -- money column of every participant's pool session AND its anchor seat,
    -- which are held FOR SHARE, compared with the snapshot taken before the
    -- first write.
    SELECT string_agg(ps.id || ':' || coalesce(ps.starting_stack::text, 'null')
                      || ':' || coalesce(ps.net_result::text, 'null')
                      || ':' || coalesce(ps.ending_stack::text, 'null')
                      || ':' || coalesce(ps.exited_at::text, 'open')
                      || ':' || coalesce((SELECT ts.stack::text || '@' || coalesce(ts.left_at::text, 'seated')
                                            || '@' || coalesce(ts.user_id::text, 'empty')
                                            FROM public.table_seats ts WHERE ts.id = ps.anchor_seat_id), 'no_anchor'),
                      '|' ORDER BY ps.id)
      INTO v_money_after
      FROM public.lightning_pool_session ps
     WHERE ps.id IN (SELECT (x ->> 'pool_session_id')::uuid FROM jsonb_array_elements(v_seats) x);
    IF v_money_after IS DISTINCT FROM v_money_before THEN
      RAISE EXCEPTION 'LIGHTNING_FORMATION_MOVED_MONEY: the pool sessions or anchor seats of the % participants of hand % in Cluster % were rewritten while it was formed (% became %), and forming a hand is a seating transition, not an economic transaction',
        v_n, v_hand, g.id, v_money_before, v_money_after USING ERRCODE = 'PLT02';
    END IF;

  EXCEPTION
    WHEN unique_violation OR check_violation OR foreign_key_violation OR not_null_violation OR SQLSTATE 'PLT02'
      OR exclusion_violation
      -- THE RETRYABLE CLASSES (2026-09-26). A lock wait past lock_timeout, a
      -- deadlock victim and a serialization failure are exactly what
      -- specification 732-733 means by "retry where safe": this block is
      -- rolled back whole and the caller retries in a fresh transaction.
      OR lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT,
                              v_constraint = CONSTRAINT_NAME;
      -- ONLY A RACE IS RETRIED (2026-09-26). A lock timeout, a deadlock victim,
      -- a serialization failure, and a unique violation on one of the indexes
      -- two matchers can genuinely race for, are what specification 732-733
      -- means by "retry where safe". Everything else that lands here - the
      -- barrier's own PLT02 re-checks, the immutability and discipline
      -- triggers, a CHECK, a foreign key, a unique index nobody races for - is
      -- a state the locks this function holds make impossible. Retrying it
      -- would form the same wrong hand again, so it is not retried: the block
      -- is already rolled back, the Cluster is frozen through its own
      -- cluster_mode (the row is held FOR UPDATE since the start, and every
      -- formation, opening and deal refuses a Cluster that is not lightning),
      -- and the evidence is written in the two events an operator will look
      -- for.
      IF NOT (v_sqlstate IN ('55P03', '40P01', '40001')
              OR (v_sqlstate = '23505' AND v_constraint IN (
                    'lightning_reservation_one_active_per_player',
                    'lightning_reservation_one_pending_per_slot',
                    'lightning_reservation_one_seat_per_instance',
                    'lightning_reservation_one_seat_per_player_instance',
                    'lightning_pool_slot_one_open',
                    'lightning_pool_slot_one_open_per_player',
                    'lightning_hand_one_per_request'))) THEN
        UPDATE public.cash_games cg
           SET cluster_mode = 'frozen', updated_at = now()
         WHERE cg.id = g.id AND cg.cluster_mode = 'lightning';
        -- THE PAGE. The estate's operator alert path: a critical
        -- financial_alerts row, which the incident trigger turns into an
        -- incident, deduplicated per Cluster. In its own sub-block, so that an
        -- alert that cannot be written costs the page and never the freeze;
        -- its failure is recorded in the freeze's own evidence instead.
        BEGIN
          v_alert_id := public.fn_raise_server_financial_alert(
            'critical', 'lightning_formation',
            format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze at epoch %s on %s: %s', g.id, v_epoch, v_sqlstate, v_msg),
            jsonb_build_object('cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand,
                               'sqlstate', v_sqlstate, 'constraint', v_constraint,
                               'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
            'lightning_cluster_frozen:' || g.id, g.id::text);
        EXCEPTION WHEN OTHERS THEN
          GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
        END;
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES
          (g.id, 'stack_invariant_failed', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch,
             'hand_id', v_hand, 'instance_id', v_instance,
             'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
             'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                           FROM jsonb_array_elements(v_seats) x),
             'seats', v_seats, 'money_before', v_money_before, 'money_after', v_money_after,
             'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id),
          (g.id, 'cluster_frozen', jsonb_build_object(
             'cluster_id', g.id, 'cluster_epoch', v_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
             'reason', 'stack_invariant_failed', 'sqlstate', v_sqlstate, 'message', v_msg,
             'hand_id', v_hand, 'instance_id', v_instance, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
             'at', clock_timestamp()), v_epoch, p_request_id);
        RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', false, 'frozen', true,
                                  'reason', 'formation_invariant_failed',
                                  'sqlstate', v_sqlstate, 'message', v_msg, 'constraint', v_constraint,
                                  'cluster_id', g.id, 'cluster_epoch', v_epoch,
                                  'alerted', v_alert_id IS NOT NULL);
      END IF;
      -- Everything above is now rolled back. This INSERT is in the OUTER
      -- block, after the rollback, and is the only thing that survives it:
      -- specification 733's matcher_retry, carrying what refused and why.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (g.id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_refused', 'sqlstate', v_sqlstate, 'message', v_msg,
        'players', v_n, 'target_size', v_target, 'at', p_now), v_epoch, p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_refused',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;

  -- F12'S SHAPE, ONE PHASE ON, is measured INSIDE the atomic block since
  -- 2026-09-26, so that money moving during a formation is caught as the
  -- impossible state it is: rolled back, the Cluster frozen and the evidence
  -- written, rather than an uncaught error that leaves no row saying why.

  -- THE EVENTS OF A FORMED HAND (2026-09-26): the instance that was created,
  -- ONE reservation event carrying every player it holds, and the hand with
  -- every participant's seat, position and blind role. hand_created replaces
  -- the kind 20260925215731 wrote here, which nothing outside the Phase 9
  -- harness read.
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (g.id, 'instance_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'target_size', v_target, 'max_size', v_max, 'via', 'fn_lightning_form_hand', 'at', p_now),
     v_epoch, p_request_id),
    (g.id, 'pool_player_reserved', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'instance_id', v_instance, 'hand_id', v_hand,
       'players', (SELECT jsonb_agg(x -> 'player_id' ORDER BY (x ->> 'seat')::integer)
                     FROM jsonb_array_elements(v_seats) x),
       'at', p_now), v_epoch, p_request_id),
    (g.id, 'hand_created', jsonb_build_object(
       'cluster_id', g.id, 'cluster_epoch', v_epoch, 'hand_id', v_hand, 'instance_id', v_instance,
       'players', v_n, 'target_size', v_target, 'max_size', v_max,
       'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
       'participants', (SELECT jsonb_agg(jsonb_build_object(
                                 'player_id', x -> 'player_id', 'seat', x -> 'seat',
                                 'position', x -> 'position', 'blind_role', x -> 'blind_role',
                                 'stack_before', x -> 'stack_before')
                               ORDER BY (x ->> 'seat')::integer)
                          FROM jsonb_array_elements(v_seats) x),
       'matcher_version', btrim(p_matcher_version), 'at', p_now), v_epoch, p_request_id);

  RETURN jsonb_build_object('ok', true, 'formed', true, 'retry', false,
                            'hand_id', v_hand, 'instance_id', v_instance,
                            'cluster_id', g.id, 'cluster_epoch', v_epoch,
                            'players', v_n, 'bb', v_bb, 'sb', v_sb, 'btn', v_btn,
                            'seats', v_seats, 'entry_bb', to_jsonb(v_entry),
                            'state', 'reserved', 'request_id', p_request_id);

  EXCEPTION
    WHEN lock_not_available OR deadlock_detected OR serialization_failure THEN
      GET STACKED DIAGNOSTICS v_sqlstate = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      -- Everything since the sub-block opened is rolled back: the reap, the
      -- formation, every lock taken after the Cluster row. The evidence is
      -- written here, after the rollback, and is the one thing that survives
      -- it. cluster_epoch 0 lets trg_cash_cluster_events_take_the_clusters_epoch
      -- fill in the Cluster's epoch when the lock that failed was the one
      -- taken before the epoch was read.
      INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
      VALUES (p_cluster_id, 'lightning_matcher_retry', jsonb_build_object(
        'reason', 'formation_contended', 'sqlstate', v_sqlstate, 'message', v_msg,
        'at', p_now), coalesce(v_epoch, 0), p_request_id);
      RETURN jsonb_build_object('ok', false, 'formed', false, 'retry', true,
                                'reason', 'formation_contended',
                                'sqlstate', v_sqlstate, 'message', v_msg);
  END;
END
$function$

;
CREATE OR REPLACE FUNCTION public.fn_lightning_match_and_form(p_cluster_id uuid, p_now timestamp with time zone, p_disconnected uuid[], p_max_hands integer, p_request_id uuid, p_player_platforms jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_started   timestamptz := clock_timestamp();
  v_form_started timestamptz;
  v_now       timestamptz := coalesce(p_now, clock_timestamp());
  v_group_now timestamptz;
  v_prev      record;
  v_cfg       jsonb;
  v_version   text;
  v_epoch     integer;
  v_budget    interval;
  v_max_hands integer;
  v_replans   integer := 0;
  v_max_replans integer;
  v_plan      jsonb;
  v_first     jsonb;
  v_group     jsonb;
  v_r         jsonb;
  v_req       uuid;
  v_ordinal   integer := 0;
  v_hands     jsonb := '[]'::jsonb;
  v_formed    integer := 0;
  v_retries   jsonb := '[]'::jsonb;
  v_retry     boolean;
  v_stopped   text;
  v_frozen    boolean := false;
  v_result    jsonb;
  v_skip      text;
  v_saved_lt  text;
  v_last      jsonb;
  v_record    boolean;
  v_pruned    integer := 0;
  v_variant   text;
BEGIN
  IF p_cluster_id IS NULL OR p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'cluster_and_request_id_required');
  END IF;

  -- A RETRIED REQUEST IS ANSWERED WITH THE PASS IT RAN.
  SELECT mp.cluster_id, mp.result INTO v_prev
    FROM public.cash_cluster_matcher_pass mp WHERE mp.request_id = p_request_id;
  IF FOUND THEN
    IF v_prev.cluster_id IS DISTINCT FROM p_cluster_id THEN
      RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'request_id_belongs_to_another_cluster',
                                'request_id', p_request_id);
    END IF;
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  v_cfg := public.fn_lightning_config(p_cluster_id);
  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'not_found', 'cluster_id', p_cluster_id);
  END IF;
  -- DARK BY DEFAULT: only a Cluster whose ruleset says form is formed by the
  -- worker. shadow plans through fn_lightning_match and forms nothing.
  IF (v_cfg ->> 'worker_mode') IS DISTINCT FROM 'form' THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'worker_mode_is_not_form',
                              'worker_mode', v_cfg ->> 'worker_mode', 'cluster_id', p_cluster_id);
  END IF;
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): NOTHING IS FORMED THAT
  -- CANNOT BE HOSTED. The front table hosts every hand (the bind records it
  -- as host_table_id), so a Cluster with none forms hands nobody can deal;
  -- and a variant the host cannot deal is refused for the reason
  -- fn_lightning_match_plan gives. Both before the pass lock, unrecorded,
  -- like worker_mode_is_not_form.
  IF public.fn_cash_cluster_front_table(p_cluster_id) IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'cluster_has_no_front_table',
                              'cluster_id', p_cluster_id);
  END IF;
  SELECT CASE WHEN cg.variant = 'pineapple' THEN cg.variant
              WHEN tb.game_variant = 'pineapple' THEN tb.game_variant
              WHEN coalesce(tb.pineapple_holdem, false) THEN 'pineapple_holdem' END
    INTO v_variant
    FROM public.cash_games cg
    LEFT JOIN public.tables tb ON tb.id = public.fn_cash_cluster_front_table(cg.id)
   WHERE cg.id = p_cluster_id;
  IF v_variant IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'variant_not_supported',
                              'variant', v_variant, 'cluster_id', p_cluster_id);
  END IF;

  -- ONE PASS PER CLUSTER AT A TIME: a transaction advisory lock on the
  -- Cluster, so a second pass answers pass_in_progress and waits for nothing.
  -- Only THEN the Cluster row, which the barrier takes FOR UPDATE first (the
  -- lock order is unchanged: the Cluster, then the anchors, then the slots) -
  -- and which the tick and a conversion also update. Anything else holding
  -- it is waited for cluster_row_wait_ms, not mistaken for a pass: a row that
  -- stays busy answers cluster_row_busy.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('lightning_matcher:' || p_cluster_id::text, 0)) THEN
    v_skip := 'pass_in_progress';
  ELSE
    v_saved_lt := current_setting('lock_timeout');
    PERFORM set_config('lock_timeout', (v_cfg ->> 'cluster_row_wait_ms') || 'ms', true);
    BEGIN
      PERFORM 1 FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
    EXCEPTION WHEN lock_not_available THEN
      v_skip := 'cluster_row_busy';
    END;
    PERFORM set_config('lock_timeout', v_saved_lt, true);
  END IF;
  IF v_skip IS NOT NULL THEN
    v_result := jsonb_build_object('ok', true, 'formed', 0, 'skipped', true, 'reason', v_skip,
                                   'stopped_reason', v_skip, 'cluster_id', p_cluster_id,
                                   'request_id', p_request_id, 'matcher_version', v_cfg ->> 'matcher_version');
    -- A SKIP IS RECORDED ONLY WHEN IT IS NEWS: when the Cluster's last
    -- recorded pass did not end the same way. In the pass record only, under
    -- an id derived from the request (so a retry of the same request still
    -- runs): an event's key to cash_games would wait on the very row lock
    -- that caused the skip.
    SELECT mp.result INTO v_last FROM public.cash_cluster_matcher_pass mp
     WHERE mp.cluster_id = p_cluster_id ORDER BY mp.started_at DESC, mp.request_id DESC LIMIT 1;
    v_record := (v_last ->> 'stopped_reason') IS DISTINCT FROM v_skip;
    v_result := v_result || jsonb_build_object('recorded', v_record);
    IF v_record THEN
      INSERT INTO public.cash_cluster_matcher_pass
        (request_id, cluster_id, cluster_epoch, matcher_version, started_at, finished_at, hands_formed, result)
      VALUES (md5(p_request_id::text || '/skipped')::uuid, p_cluster_id,
              coalesce((SELECT cg.cluster_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id), 0),
              v_cfg ->> 'matcher_version', v_started, clock_timestamp(), 0, v_result)
      ON CONFLICT (request_id) DO NOTHING;
    END IF;
    RETURN v_result;
  END IF;
  -- The same request may have finished while this one waited for nothing.
  SELECT mp.cluster_id, mp.result INTO v_prev
    FROM public.cash_cluster_matcher_pass mp WHERE mp.request_id = p_request_id;
  IF FOUND THEN
    RETURN v_prev.result || jsonb_build_object('replayed', true);
  END IF;

  SELECT cg.cluster_epoch INTO v_epoch FROM public.cash_games cg WHERE cg.id = p_cluster_id;
  v_version := v_cfg ->> 'matcher_version';
  v_budget := make_interval(secs => (v_cfg ->> 'pass_time_budget_ms')::numeric / 1000);
  v_max_replans := (v_cfg ->> 'max_replans')::integer;
  v_max_hands := LEAST(GREATEST(coalesce(p_max_hands, (v_cfg ->> 'admission_batch_hands')::integer), 0),
                       (v_cfg ->> 'admission_batch_hands')::integer);

  <<pass>>
  LOOP
    IF v_formed >= v_max_hands THEN
      v_stopped := coalesce(v_stopped, 'max_hands');
      EXIT pass;
    END IF;
    v_plan := public.fn_lightning_match_plan(p_cluster_id, v_now, p_disconnected, v_version, v_max_hands - v_formed, p_player_platforms);
    -- THE BUDGET BOUNDS THE FORMING, NOT THE PLAN (2026-10-09, Phase 12 load
    -- and chaos): it runs from the end of the first plan. A plan that alone
    -- outlasted the budget (about 3,000 eligible players and up) used to end
    -- every pass at its first group with nothing formed, so a big pool was
    -- never dealt; now every pass forms what its budget allows after it has
    -- planned, replans included.
    IF v_first IS NULL THEN v_first := v_plan; v_form_started := clock_timestamp(); END IF;
    IF jsonb_array_length(v_plan -> 'groups') = 0 THEN
      v_stopped := coalesce(v_stopped, 'plan_exhausted');
      EXIT pass;
    END IF;
    v_retry := false;
    FOR v_group IN SELECT x FROM jsonb_array_elements(v_plan -> 'groups') x LOOP
      IF clock_timestamp() - v_form_started >= v_budget THEN
        v_stopped := 'time_budget';
        EXIT pass;
      END IF;
      v_ordinal := v_ordinal + 1;
      -- THE GROUP'S REQUEST ID, derived from the pass's: the same pass
      -- replayed asks the barrier for the same hands.
      v_req := md5(p_request_id::text || '/matcher_group/' || v_ordinal)::uuid;
      -- EACH GROUP IS FORMED ITS OWN MICROSECOND LATER. The barrier stamps
      -- last_bb_at with this time, and P2 orders by it; if every big blind of
      -- a pass shared one instant, the next tie-breaks (the slot's open, then
      -- player_id) would re-sort each batch by id, and the low ids would come
      -- round again first - measured at 60 rounds of fifty players, a stable
      -- cohort on 12 big blinds against another on 10. Stamped in the order
      -- they were chosen, the big blinds queue as they were served: a strict
      -- rotation.
      v_group_now := v_now + (v_ordinal - 1) * interval '1 microsecond';
      v_r := public.fn_lightning_form_hand(
        p_cluster_id,
        ARRAY(SELECT e.pid::uuid FROM jsonb_array_elements_text(v_group -> 'players') WITH ORDINALITY e(pid, ord)
               ORDER BY e.ord),
        (v_group -> 'keys' ->> 'size')::smallint,
        ((v_group -> 'keys' -> 'instance') ->> 'max')::smallint,
        (v_group ->> 'bb')::uuid,
        make_interval(secs => (v_cfg ->> 'reservation_ttl_ms')::numeric / 1000),
        make_interval(secs => (v_cfg ->> 'form_window_ms')::numeric / 1000),
        v_group_now,
        v_version,
        v_req,
        p_player_platforms);
      IF coalesce((v_r ->> 'formed')::boolean, false) THEN
        v_formed := v_formed + 1;
        v_hands := v_hands || jsonb_build_array(jsonb_build_object(
          'hand_id', v_r -> 'hand_id', 'instance_id', v_r -> 'instance_id', 'request_id', v_req,
          'bb', v_r -> 'bb', 'sb', v_r -> 'sb', 'btn', v_r -> 'btn', 'players', v_group -> 'players'));
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES (p_cluster_id, 'matcher_assignment', jsonb_build_object(
          'cluster_id', p_cluster_id, 'cluster_epoch', v_r -> 'cluster_epoch',
          'hand_id', v_r -> 'hand_id', 'instance_id', v_r -> 'instance_id',
          'players', v_group -> 'players', 'bb', v_r -> 'bb', 'sb', v_r -> 'sb', 'btn', v_r -> 'btn',
          'keys', v_group -> 'keys', 'matcher_version', v_version,
          'request_id', v_req, 'pass_request_id', p_request_id, 'at', v_group_now),
          coalesce((v_r ->> 'cluster_epoch')::integer, v_epoch), v_req);
        IF v_formed >= v_max_hands THEN
          v_stopped := 'max_hands';
          EXIT pass;
        END IF;
      ELSIF (v_r ->> 'reason') = 'formation_invariant_failed' OR coalesce((v_r ->> 'frozen')::boolean, false) THEN
        -- THE BARRIER FROZE THE CLUSTER. Nothing more is attempted.
        v_frozen := true;
        v_stopped := 'frozen';
        v_retries := v_retries || jsonb_build_array(v_r || jsonb_build_object('request_id', v_req));
        EXIT pass;
      ELSIF coalesce((v_r ->> 'retry')::boolean, false) THEN
        -- A RACE: the world moved between the plan and the barrier. Plan again.
        v_retries := v_retries || jsonb_build_array(jsonb_build_object(
          'reason', v_r ->> 'reason', 'sqlstate', v_r ->> 'sqlstate', 'request_id', v_req));
        v_retry := true;
        -- STALE GROUPS KEEP DISJOINT PROGRESS. The real barrier revalidates
        -- every remaining group; no failed group is formed or reordered.
        IF (v_r ->> 'reason') = 'insufficient_legal_candidates' THEN
          CONTINUE;
        END IF;
        EXIT;
      ELSE
        -- A refusal no retry can cure (the Cluster is not Lightning, or the
        -- plan disagreed with the barrier). Stop, and say so.
        v_stopped := 'refused:' || coalesce(v_r ->> 'reason', 'unknown');
        v_retries := v_retries || jsonb_build_array(v_r || jsonb_build_object('request_id', v_req));
        INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
        VALUES (p_cluster_id, 'matcher_failure', jsonb_build_object(
          'cluster_id', p_cluster_id, 'reason', v_r ->> 'reason', 'answer', v_r,
          'players', v_group -> 'players', 'bb', v_group -> 'bb',
          'matcher_version', v_version, 'request_id', v_req, 'pass_request_id', p_request_id, 'at', v_now),
          v_epoch, v_req);
        EXIT pass;
      END IF;
    END LOOP;
    EXIT pass WHEN NOT v_retry;
    v_replans := v_replans + 1;
    IF v_replans > v_max_replans THEN
      v_stopped := 'max_replans';
      EXIT pass;
    END IF;
  END LOOP;

  v_result := jsonb_build_object(
    'ok', NOT v_frozen AND coalesce(v_stopped, '') NOT LIKE 'refused:%',
    'replayed', false,
    'cluster_id', p_cluster_id,
    'cluster_epoch', v_epoch,
    'request_id', p_request_id,
    'matcher_version', v_version,
    'formed', v_formed,
    'hands', v_hands,
    'planned_groups', jsonb_array_length(coalesce(v_first -> 'groups', '[]'::jsonb)),
    'legal_count', coalesce((v_first ->> 'legal_count')::integer, 0),
    'replans', v_replans,
    'retries', v_retries,
    'stopped_reason', coalesce(v_stopped, 'plan_exhausted'),
    'frozen', v_frozen,
    'max_hands', v_max_hands,
    'states', coalesce((SELECT jsonb_object_agg(s.state, s.n)
                          FROM (SELECT d ->> 'state' AS state, count(*) AS n
                                  FROM jsonb_array_elements(v_first -> 'diagnosis') d GROUP BY 1) s), '{}'::jsonb),
    'reasons', coalesce((SELECT jsonb_object_agg(s.code, s.n)
                           FROM (SELECT d ->> 'reason_code' AS code, count(*) AS n
                                   FROM jsonb_array_elements(v_first -> 'diagnosis') d
                                  WHERE d ->> 'reason_code' IS NOT NULL GROUP BY 1) s), '{}'::jsonb),
    'pool_diversity_score', v_first -> 'pool_diversity_score',
    'duration_ms', round(extract(epoch FROM clock_timestamp() - v_started) * 1000, 1));

  -- A PASS IS RECORDED ONLY WHEN SOMETHING HAPPENED: a hand formed, a race was
  -- retried, a refusal or a freeze, a different ending, or a diagnosis whose
  -- counts per state or per reason differ from the Cluster's last recorded
  -- pass. A pass that formed nothing and saw what the last one saw is safe to
  -- run again, so it needs no idempotency row and writes nothing: at one pass
  -- a second, an idle Cluster writes nothing all day.
  SELECT mp.result INTO v_last FROM public.cash_cluster_matcher_pass mp
   WHERE mp.cluster_id = p_cluster_id ORDER BY mp.started_at DESC, mp.request_id DESC LIMIT 1;
  v_record := v_formed > 0 OR jsonb_array_length(v_retries) > 0 OR v_frozen
              OR v_last IS NULL
              OR (v_last ->> 'stopped_reason') IS DISTINCT FROM (v_result ->> 'stopped_reason')
              OR (v_last -> 'states') IS DISTINCT FROM (v_result -> 'states')
              OR (v_last -> 'reasons') IS DISTINCT FROM (v_result -> 'reasons');
  IF v_record THEN
    -- RETENTION, in the writer: this Cluster's pass records older than the
    -- configured age, a bounded batch at a time, through the one function
    -- that may delete them.
    v_pruned := public.fn_cash_cluster_matcher_pass_prune(
      p_cluster_id, clock_timestamp() - make_interval(hours => (v_cfg ->> 'pass_record_retention_hours')::integer),
      (v_cfg ->> 'pass_record_prune_batch')::integer);
  END IF;
  v_result := v_result || jsonb_build_object('recorded', v_record, 'pruned', v_pruned);
  IF v_record THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (p_cluster_id, 'matcher_pass', v_result || jsonb_build_object('at', v_now), v_epoch, p_request_id);

    INSERT INTO public.cash_cluster_matcher_pass
      (request_id, cluster_id, cluster_epoch, matcher_version, started_at, finished_at, hands_formed, result)
    VALUES (p_request_id, p_cluster_id, v_epoch, v_version, v_started, clock_timestamp(), v_formed, v_result)
    ON CONFLICT (request_id) DO NOTHING;
  END IF;

  RETURN v_result;
END
$function$

;

DO $$BEGIN
 IF (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_form_hand(uuid,uuid[],smallint,smallint,uuid,interval,interval,timestamptz,text,uuid,jsonb)'::regprocedure)<>'bcffeef6366e53a35e656759a18ec051'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_match_and_form(uuid,timestamptz,uuid[],integer,uuid,jsonb)'::regprocedure)<>'8e06bde427b2b38939194c4ebb16c7de'
 OR (SELECT md5(prosrc) FROM pg_proc WHERE oid='public.fn_lightning_match_plan(uuid,timestamptz,uuid[],text,integer,jsonb)'::regprocedure)<>'37ad3bca64b5f487f874ba12ec9b9b7d' THEN RAISE EXCEPTION 'actual production matcher fixture source changed';END IF;
END$$;
