-- Exact live catalog captured 2026-10-25; the installed top-up patch reversed
-- once by its own closed-world pre/post hashes, for native fixture replay only.
CREATE OR REPLACE FUNCTION public.fn_table_seats_lightning_pool_follows_seat()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  ps      record;
  v_other uuid;
  v_now   timestamptz := clock_timestamp();
  v_lock_cluster uuid;
  v_old_table    uuid;
BEGIN
  -- A SEAT WAITS FOR THE MODE CHANGE IN FLIGHT (2026-10-15, Lightning Phase
  -- 12 load and chaos): the Cluster's mode lock, SHARED, before anything
  -- below reads the mode, the epoch or the pool. A conversion or reversion
  -- holds it EXCLUSIVE from just after its seat FOR SHARE to its commit, so
  -- this waits for one in flight and then reads what it committed; one that
  -- comes after waits for this commit and then sees this seat. Without it an
  -- arrival read 'pending_on', entered nothing, and the conversion that could
  -- not see the uncommitted seat left the player out of the pool for good.
  IF TG_OP = 'UPDATE' THEN v_old_table := OLD.table_id; END IF;
  FOR v_lock_cluster IN
    SELECT DISTINCT tb.cluster_id FROM public.tables tb
     WHERE tb.id IN (NEW.table_id, v_old_table) AND tb.cluster_id IS NOT NULL
     ORDER BY tb.cluster_id
  LOOP
    PERFORM pg_advisory_xact_lock_shared(
      pg_catalog.hashtextextended('lightning_cluster_mode:' || v_lock_cluster::text, 0));
  END LOOP;
  v_now := clock_timestamp();

  IF TG_OP = 'UPDATE'
     AND ((OLD.left_at IS NULL AND NEW.left_at IS NOT NULL)
          OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    FOR ps IN
      UPDATE public.lightning_pool_session s
         SET exited_at    = GREATEST(v_now, s.entered_at),
             exit_reason  = CASE WHEN NEW.user_id IS DISTINCT FROM OLD.user_id
                                 THEN 'anchor_seat_turned_over' ELSE 'anchor_seat_left' END,
             state        = 'closed',
             ending_stack = OLD.stack,
             updated_at   = v_now
       WHERE s.anchor_seat_id = OLD.id AND s.exited_at IS NULL
      RETURNING s.id, s.cluster_id, s.cluster_epoch, s.player_id, s.exit_reason, s.ending_stack
    LOOP
      UPDATE public.lightning_pool_slot sl
         SET closed_at = GREATEST(v_now, sl.opened_at),
             close_reason = 'pool_session_exited',
             updated_at = v_now
       WHERE sl.pool_session_id = ps.id AND sl.closed_at IS NULL;

      INSERT INTO public.cash_cluster_events (game_id, table_id, kind, payload, cluster_epoch)
      VALUES (ps.cluster_id, OLD.table_id, 'pool_player_left', jsonb_build_object(
        'cluster_id', ps.cluster_id, 'cluster_epoch', ps.cluster_epoch, 'player_id', ps.player_id,
        'pool_session_id', ps.id, 'anchor_seat_id', OLD.id, 'reason', ps.exit_reason,
        'ending_stack', ps.ending_stack, 'at', v_now), ps.cluster_epoch);

      SELECT ts.id INTO v_other
        FROM public.table_seats ts
        JOIN public.tables tb ON tb.id = ts.table_id
       WHERE tb.cluster_id = ps.cluster_id AND ts.user_id = ps.player_id AND ts.id <> OLD.id
         AND public.fn_lightning_anchor_is_live_eligible(ts.id, ps.cluster_id, ps.player_id)
       ORDER BY ts.joined_at, ts.id
       LIMIT 1;
      IF v_other IS NOT NULL THEN
        PERFORM public.fn_lightning_pool_enter(v_other, v_now);
      END IF;
    END LOOP;
  END IF;

  IF NEW.left_at IS NULL AND NEW.user_id IS NOT NULL
     AND coalesce(NEW.stack, 0) > 0
     AND coalesce(NEW.is_sitting_out, false) = false
     AND coalesce(NEW.leave_pending, false) = false
     AND EXISTS (SELECT 1 FROM public.tables tb
                   JOIN public.cash_games g ON g.id = tb.cluster_id
                  WHERE tb.id = NEW.table_id AND g.cluster_mode = 'lightning') THEN
    PERFORM public.fn_lightning_pool_enter(NEW.id, v_now);
  END IF;
  RETURN NULL;
END
$function$;

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
$function$;
