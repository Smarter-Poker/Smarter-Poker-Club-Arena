-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260819235759 "ca_player_stats_full_v12_window_and_lifetime"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 c84deba33d75f4d57cdfcaa65aead3a1 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- v12: two additions, both aimed at the same problem — the page could only
-- describe a fixed, capped slice of a player's history and presented it as if
-- it were everything.
--
-- 1. p_days (optional): analyse only hands newer than N days, so the UI can
--    offer 7d / 30d / all instead of one immovable window. NULL = no time
--    bound (previous behaviour), so existing callers are unaffected.
-- 2. lifetime{}: TRUE lifetime hand count + first/last hand, read as an
--    index-only scan of ca_hand_player_idx — 23ms for a 71,700-hand account
--    after VACUUM ANALYZE (2,365ms before it, because the freshly bulk-loaded
--    table had no visibility map). This lets the headline volume be exact even
--    though the behavioural stats stay sampled at c_cap hands.
--    indexed_complete says whether the backfill has reached this player's
--    oldest hands, so the UI never calls a still-growing number "lifetime".
--
-- The 1-arg signature is dropped and replaced by (uuid, int DEFAULT NULL) so a
-- call passing only p_user still resolves — no client change required, and no
-- ambiguous overload left behind.
DO $mig$
DECLARE
  src text;
  old_decl text := $d$  c_cap  constant int := 750;
  v_ids  uuid[];
  v_floor timestamptz;
  v_ceil  timestamptz;
  v_need int;
BEGIN$d$;
  new_decl text := $d2$  c_cap  constant int := 750;
  v_ids  uuid[];
  v_floor timestamptz;
  v_ceil  timestamptz;
  v_need int;
  v_since timestamptz := CASE WHEN p_days IS NULL OR p_days <= 0
                              THEN NULL ELSE now() - make_interval(days => p_days) END;
  v_life_hands int := 0;
  v_life_first timestamptz;
  v_life_last  timestamptz;
BEGIN
  SELECT count(*)::int, min(created_at), max(created_at)
  INTO v_life_hands, v_life_first, v_life_last
  FROM ca_hand_player_idx WHERE user_id = p_user;$d2$;

  old_a text := $a$  FROM (SELECT hand_id, created_at FROM ca_hand_player_idx
        WHERE user_id = p_user ORDER BY created_at DESC LIMIT c_cap) q;$a$;
  new_a text := $a2$  FROM (SELECT hand_id, created_at FROM ca_hand_player_idx
        WHERE user_id = p_user
          AND (v_since IS NULL OR created_at >= v_since)
        ORDER BY created_at DESC LIMIT c_cap) q;$a2$;

  old_b text := $b$          WHERE h.created_at > v_ceil
            AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))$b$;
  new_b text := $b2$          WHERE h.created_at > v_ceil
            AND (v_since IS NULL OR h.created_at >= v_since)
            AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))$b2$;

  old_c text := $c$            WHERE h.created_at < v_floor
              AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))$c$;
  new_c text := $c2$            WHERE h.created_at < v_floor
              AND (v_since IS NULL OR h.created_at >= v_since)
              AND h.players @> jsonb_build_array(jsonb_build_object('userId', p_user::text))$c2$;

  old_gen text := $g$  'generated_at', now(),$g$;
  new_gen text := $g2$  'generated_at', now(),
  'window_days', p_days,
  'lifetime', jsonb_build_object(
    'hands', v_life_hands,
    'first_hand_at', v_life_first,
    'last_hand_at', v_life_last,
    'indexed_complete', (SELECT backfill_complete FROM ca_hand_player_idx_state WHERE id)
  ),$g2$;
BEGIN
  src := pg_get_functiondef('public.ca_player_stats_full(uuid)'::regprocedure);

  IF position('ca_player_stats_full(p_user uuid)' IN src) = 0 THEN
    RAISE EXCEPTION 'expected 1-arg signature'; END IF;
  IF position(old_decl IN src) = 0 THEN RAISE EXCEPTION 'declare block not found'; END IF;
  IF position(old_a IN src) = 0 THEN RAISE EXCEPTION 'index selection block not found'; END IF;
  IF position(old_b IN src) = 0 THEN RAISE EXCEPTION 'forward tail block not found'; END IF;
  IF position(old_c IN src) = 0 THEN RAISE EXCEPTION 'below-floor block not found'; END IF;
  IF position(old_gen IN src) = 0 THEN RAISE EXCEPTION 'generated_at not found'; END IF;

  src := replace(src, 'ca_player_stats_full(p_user uuid)',
                      'ca_player_stats_full(p_user uuid, p_days int DEFAULT NULL)');
  src := replace(src, old_decl, new_decl);
  src := replace(src, old_a, new_a);
  src := replace(src, old_b, new_b);
  src := replace(src, old_c, new_c);
  src := replace(src, old_gen, new_gen);

  EXECUTE src;
END $mig$;

DROP FUNCTION IF EXISTS public.ca_player_stats_full(uuid);

REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ca_player_stats_full(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ca_player_stats_full(uuid, int) TO service_role;
