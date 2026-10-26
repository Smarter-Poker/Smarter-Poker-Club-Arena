-- 20261026110858_a_lightning_game_stays_in_its_mode_long_enough_to_play_it.sql
-- @install-window: daily-maintenance
-- @live-proof: (SELECT count(*) = 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'cash_games' AND column_name = 'lightning_on_condition_since' AND data_type = 'timestamp with time zone' AND is_nullable = 'YES')
-- @live-proof: position('''pending_on_dwell_ms'', 60000, 0, 3600000, true' in pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))>0 AND position('''min_mode_dwell_ms'', 900000, 0, 86400000, true' in pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))>0 AND position('''on_condition_dwell''' in pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))>0 AND position('''min_mode_dwell''' in pg_get_functiondef('public.fn_cash_cluster_lightning_drive(uuid)'::regprocedure))>0
-- @live-proof: position('''pending_off_dwell_ms'', 120000, 0, 3600000, true' in pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure))>0 AND position('''pending_off_dwell_ms'', 10000,' in pg_get_functiondef('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)'::regprocedure))=0
-- @live-proof: position('''pending_off_dwell_ms'', 120000, 0, 3600000, true' in pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure))>0 AND position('''pending_on_dwell_ms'', v_on_dwell' in pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure))>0 AND position('''min_mode_dwell_ms'', v_min_mode' in pg_get_functiondef('public.fn_lightning_config(uuid)'::regprocedure))>0
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING TRANSITION, PHASE 5 OF 5: A GAME STAYS IN ITS MODE LONG ENOUGH TO
-- PLAY IT.
--
-- WHAT PRODUCTION SHOWED. Before always_on was set, pilot cluster 681eb9e8
-- switched modes 19 times in 5 days; the quickest return into Lightning after
-- it ended was 48 s, and 3 of the 19 returns came within 15 minutes. The only
-- protection was the ON/OFF threshold gap and a 10 s wait before turning OFF
-- (pending_off_dwell_ms, 20261007222717 / 20261008043021). Nothing made the
-- ON side wait, and nothing held a game in a mode for any minimum time.
--
-- WHAT THIS CHANGES. Three numbers, each configurable in
-- ruleset_snapshot.lightning exactly the way pending_off_dwell_ms is
-- (fn_lightning_config_number, clamped, an unusable value falls back to the
-- default), and each reported by fn_lightning_config:
--   1. pending_on_dwell_ms, default 60000 (60 s), range 0..3600000. The ON
--      threshold must hold CONTINUOUSLY for this long before the drive opens
--      pending_on. The first sighting is recorded on the new nullable column
--      cash_games.lightning_on_condition_since, the mirror of the existing
--      lightning_off_condition_since; any drive pass that does not see the
--      ON condition clears it, so an oscillating population never accumulates
--      a sighting. 0 turns the ON dwell off.
--   2. pending_off_dwell_ms: the default rises from 10000 (10 s) to 120000
--      (120 s), in fn_cash_cluster_begin_pending_off where it is enforced and
--      in fn_lightning_config where it is reported. The mechanism is unchanged.
--   3. min_mode_dwell_ms, default 900000 (15 min), range 0..86400000. An
--      AUTOMATIC switch (the drive's population-triggered begin_pending_on in
--      must_move, or its population-triggered begin_pending_off in lightning)
--      waits until this long has passed since the game's last AUTOMATIC mode
--      change (the closed_at of its latest committed conversion). The floor
--      does not apply when that latest change was an operator drain (from_mode
--      'draining', or named by lightning_cluster_drain.conversion_id), nor
--      when an operator enable_lightning / resume / unfreeze / drain has
--      answered ok since it. The ON dwell starts counting once the floor has
--      passed, and the OFF dwell likewise, so the two never overlap.
--
-- WHAT THIS DOES NOT CHANGE.
--   * always_on games. The always_on policy (20261023230807) is evaluated
--     exactly as before: an always_on must_move game opens pending_on on the
--     first pass, and an always_on Lightning game never sees the OFF trigger.
--     Neither the ON dwell nor the floor is consulted for them, and their
--     lightning_on_condition_since is never written. All 11 live Lightning
--     games read always_on true when this was written (2026-10-26 11:09 UTC);
--     the two must_move games with Lightning on and no always_on are both
--     disabled (enabled false), so the drive cannot turn them on either.
--   * Operator doors. fn_lightning_operator_control is not touched. A drain
--     still turns Lightning off at once and the drive still opens pending_off
--     for it on the next pass (NOT v_live_ok is never held by the floor or by
--     the OFF dwell, which already gated only the population trigger), and
--     fn_lightning_drain_advance still calls begin_pending_off with
--     'lightning_drain', which the population dwell never reaches.
--   * A disabled game or Lightning switched off always drains at once.
--   * pending_on and pending_off themselves: commit and abort are unchanged.
--   * The engine, the 3-second five-player wait, and every always_on flag.
-- Horses and humans are not distinguished anywhere here.
--
-- WHY THE DAILY WINDOW (CLAUDE.md section 2, rules 9 and 10). Adding a column
-- takes ACCESS EXCLUSIVE on cash_games, which every lobby read, every join and
-- every drive pass touches. It is metadata only (nullable, no default, no
-- rewrite) and held for milliseconds, but it is a lock on a hot table, so it
-- waits for the 04:00 freeze and the installer's 1 s lock_timeout. Until it
-- lands, production keeps today's behaviour (10 s OFF dwell, no ON dwell, no
-- floor), which is inert for the always_on games.
--
-- HOW IT PATCHES. Each function is patched only at unique anchors in its
-- catalog-measured installed image, read from production 2026-10-26 with
-- SELECT pg_get_functiondef / md5 (no DDL):
--   fn_cash_cluster_lightning_drive(uuid)              e4e4813b063e5f738cab2a12e67b5c2e
--     (the postimage of 20261023230807's always_on substitution; no later
--     file on main touches it)
--   fn_cash_cluster_begin_pending_off(uuid,uuid,text)  d146e9c6ab3d051d9b871b70e4b10116
--     (the postimage of 20261009235505; no later file on main touches it)
--   fn_lightning_config(uuid)                          85c851a53fe15425be958144836d5f75
--     (the postimage of 20261024195059)
-- A drifted preimage, a missing or repeated anchor, or a changed owner, ACL,
-- security mode, config, volatility or signature aborts the whole transaction.

BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- The ON-side sighting, the mirror of lightning_off_condition_since.
ALTER TABLE public.cash_games ADD COLUMN lightning_on_condition_since timestamptz;
COMMENT ON COLUMN public.cash_games.lightning_on_condition_since IS
  'First continuous sighting of the Lightning ON condition by fn_cash_cluster_lightning_drive (20261026110858); cleared by any pass that does not see it. Never written for always_on games.';

DO $patch$
DECLARE
  v_sig text; v_expected text; v_anchors text[]; v_news text[];
  v_def text; v_new text; v_meta jsonb; v_after text; i integer;
BEGIN
  FOR v_sig, v_expected, v_anchors, v_news IN SELECT * FROM (VALUES
  ('public.fn_cash_cluster_lightning_drive(uuid)',
   'e4e4813b063e5f738cab2a12e67b5c2e',
   ARRAY[
$a1$  v_drain    jsonb;
BEGIN
$a1$,
$a2$  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled, cg.enabled, cg.must_move
    INTO g FROM public.cash_games cg WHERE cg.id = p_game_id;
$a2$,
$a3$  v_live_ok := coalesce(g.lightning_enabled, false) AND g.enabled IS NOT DISTINCT FROM true;
$a3$,
$a4$  IF g.cluster_mode = 'must_move' THEN
    IF v_on_ok AND coalesce(g.must_move, false) THEN
      v_action := 'begin_pending_on';
$a4$,
$a5$        md5(format('lightning-drive:%s:%s:lightning:%s', g.id, g.cluster_epoch, v_n))::uuid);
    ELSE
      v_action := 'hold';
    END IF;
$a5$,
$a6$  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok OR NOT v_live_ok THEN
$a6$,
$a7$  -- LIGHTNING PHASE 13 (20261009235505): THE EMERGENCY DRAIN ADVANCES HERE,
$a7$,
$a8$    || CASE WHEN v_drain IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('drain', v_drain) END;
$a8$],
   ARRAY[
$n1$  v_drain    jsonb;
  -- 20261026110858: THE MODE-SWITCH DWELL.
  v_always   boolean;
  v_cfg      jsonb;
  v_on_dwell integer;
  v_min_mode integer;
  v_last     record;
  v_floor_until timestamptz;
  v_keep_on  boolean := false;
  v_dwell_info jsonb;
BEGIN
$n1$,
$n2$  SELECT cg.id, cg.cluster_mode, cg.cluster_epoch, cg.lightning_enabled, cg.enabled, cg.must_move,
         cg.ruleset_snapshot, cg.lightning_on_condition_since
    INTO g FROM public.cash_games cg WHERE cg.id = p_game_id;
$n2$,
$n3$  v_live_ok := coalesce(g.lightning_enabled, false) AND g.enabled IS NOT DISTINCT FROM true;

  -- 20261026110858: A GAME STAYS IN ITS MODE LONG ENOUGH TO PLAY IT. Before
  -- always_on, pilot 681eb9e8 switched 19 times in 5 days, back into
  -- Lightning 48 s after leaving it. Two waits now gate the POPULATION
  -- trigger only; the always_on policy, a disabled game and Lightning switched
  -- off are never held by either:
  --   pending_on_dwell_ms (default 60000): the ON condition must stand
  --     continuously, recorded on lightning_on_condition_since and cleared by
  --     any pass that does not see it;
  --   min_mode_dwell_ms (default 900000): no automatic switch until this long
  --     after the last automatic mode change (the latest committed
  --     conversion), unless that change was an operator drain or an operator
  --     enable_lightning / resume / unfreeze / drain has answered ok since.
  -- The OFF side's own wait stays in fn_cash_cluster_begin_pending_off
  -- (pending_off_dwell_ms, default 120000 from this file).
  v_always := EXISTS(SELECT 1 FROM public.cash_games policy
 WHERE policy.id=g.id AND policy.enabled AND policy.closed_at IS NULL
 AND policy.must_move AND policy.lightning_enabled AND policy.handedness=6
 AND policy.template_name IN ('action','madness')
 AND policy.ruleset_snapshot#>'{lightning,always_on}'='true'::jsonb
 AND NOT EXISTS(SELECT 1 FROM public.lightning_cluster_drain d
   WHERE d.cluster_id=policy.id AND d.completed_at IS NULL));
  v_cfg := CASE WHEN jsonb_typeof(g.ruleset_snapshot -> 'lightning') = 'object'
                THEN g.ruleset_snapshot -> 'lightning' ELSE '{}'::jsonb END;
  v_on_dwell := (public.fn_lightning_config_number(v_cfg, 'pending_on_dwell_ms', 60000, 0, 3600000, true) ->> 'value')::integer;
  v_min_mode := (public.fn_lightning_config_number(v_cfg, 'min_mode_dwell_ms', 900000, 0, 86400000, true) ->> 'value')::integer;
  IF v_min_mode > 0
     AND ((g.cluster_mode = 'must_move' AND v_on_ok AND NOT v_always)
          OR (g.cluster_mode = 'lightning' AND v_off_ok AND v_live_ok)) THEN
    SELECT cc.id, cc.from_mode, cc.closed_at INTO v_last
      FROM public.cash_cluster_conversion cc
     WHERE cc.cluster_id = g.id AND cc.status = 'committed'
     ORDER BY cc.opened_at DESC
     LIMIT 1;
    IF v_last.id IS NOT NULL AND v_last.closed_at IS NOT NULL
       AND v_last.from_mode IS DISTINCT FROM 'draining'
       AND NOT EXISTS (SELECT 1 FROM public.lightning_cluster_drain d
                        WHERE d.conversion_id = v_last.id)
       AND NOT EXISTS (SELECT 1 FROM public.lightning_operator_request r
                        WHERE r.cluster_id = g.id AND r.created_at > v_last.closed_at
                          AND r.action IN ('enable_lightning', 'resume', 'unfreeze', 'drain')
                          AND (r.answer ->> 'ok') = 'true') THEN
      v_floor_until := v_last.closed_at + make_interval(secs => v_min_mode / 1000.0);
      IF clock_timestamp() >= v_floor_until THEN
        v_floor_until := NULL;
      END IF;
    END IF;
  END IF;
$n3$,
$n4$  IF g.cluster_mode = 'must_move' THEN
    IF v_on_ok AND coalesce(g.must_move, false) AND NOT v_always AND v_floor_until IS NOT NULL THEN
      -- 20261026110858: too soon after the last automatic switch.
      v_action := 'min_mode_dwell';
      v_dwell_info := jsonb_build_object('reason', 'min_mode_dwell', 'min_mode_dwell_ms', v_min_mode,
        'last_change_at', v_last.closed_at, 'until', v_floor_until);
    ELSIF v_on_ok AND coalesce(g.must_move, false) AND NOT v_always AND v_on_dwell > 0
          AND (g.lightning_on_condition_since IS NULL
               OR clock_timestamp() < g.lightning_on_condition_since + make_interval(secs => v_on_dwell / 1000.0)) THEN
      -- 20261026110858: the ON condition has not yet stood for pending_on_dwell_ms.
      v_action := 'on_condition_dwell';
      v_keep_on := true;
      IF g.lightning_on_condition_since IS NULL THEN
        UPDATE public.cash_games cg SET lightning_on_condition_since = clock_timestamp()
         WHERE cg.id = g.id AND cg.lightning_on_condition_since IS NULL;
      END IF;
      v_dwell_info := jsonb_build_object('reason', 'on_condition_dwell', 'pending_on_dwell_ms', v_on_dwell,
        'first_seen_at', coalesce(g.lightning_on_condition_since, clock_timestamp()));
    ELSIF v_on_ok AND coalesce(g.must_move, false) THEN
      v_action := 'begin_pending_on';
$n4$,
$n5$        md5(format('lightning-drive:%s:%s:lightning:%s', g.id, g.cluster_epoch, v_n))::uuid);
      -- 20261026110858: a refused begin (the game is still must_move) keeps
      -- the standing sighting, so the next pass asks again at once, as before.
      v_keep_on := NOT v_always AND v_on_dwell > 0
        AND EXISTS (SELECT 1 FROM public.cash_games cg WHERE cg.id = g.id AND cg.cluster_mode = 'must_move');
    ELSE
      v_action := 'hold';
    END IF;
$n5$,
$n6$  ELSIF g.cluster_mode = 'lightning' THEN
    IF v_off_ok AND v_live_ok AND v_floor_until IS NOT NULL THEN
      -- 20261026110858: too soon after the last automatic switch. Lightning
      -- switched off or a disabled game (NOT v_live_ok) is never held here.
      v_action := 'min_mode_dwell';
      v_dwell_info := jsonb_build_object('reason', 'min_mode_dwell', 'min_mode_dwell_ms', v_min_mode,
        'last_change_at', v_last.closed_at, 'until', v_floor_until);
    ELSIF v_off_ok OR NOT v_live_ok THEN
$n6$,
$n7$  -- 20261026110858: THE ON SIGHTING IS CONSECUTIVE-PASS STATE, as the OFF
  -- sighting is. Every pass that did not keep it clears it.
  IF NOT v_keep_on AND g.lightning_on_condition_since IS NOT NULL THEN
    UPDATE public.cash_games cg SET lightning_on_condition_since = NULL
     WHERE cg.id = g.id AND cg.lightning_on_condition_since IS NOT NULL;
  END IF;

  -- LIGHTNING PHASE 13 (20261009235505): THE EMERGENCY DRAIN ADVANCES HERE,
$n7$,
$n8$    || CASE WHEN v_drain IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('drain', v_drain) END
    || CASE WHEN v_dwell_info IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('dwell', v_dwell_info) END;
$n8$]),
  ('public.fn_cash_cluster_begin_pending_off(uuid,uuid,text)',
   'd146e9c6ab3d051d9b871b70e4b10116',
   ARRAY[
$b1$  -- configured pending_off_dwell_ms (default 10000; 0 keeps the two-sighting
$b1$,
$b2$                  'pending_off_dwell_ms', 10000, 0, 3600000, true) ->> 'value')::integer;
$b2$],
   ARRAY[
$m1$  -- configured pending_off_dwell_ms (default 120000 since 20261026110858,
  -- 10000 before it; 0 keeps the two-sighting
$m1$,
$m2$                  'pending_off_dwell_ms', 120000, 0, 3600000, true) ->> 'value')::integer;
$m2$]),
  ('public.fn_lightning_config(uuid)',
   '85c851a53fe15425be958144836d5f75',
   ARRAY[
$c1$  v_dwell    integer;
$c1$,
$c2$  r := public.fn_lightning_config_number(v_cfg, 'pending_off_dwell_ms', 10000, 0, 3600000, true);
  v_dwell := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$c2$,
$c3$    'quality_weights', v_qw);
$c3$],
   ARRAY[
$k1$  v_dwell    integer;
  v_on_dwell integer;
  v_min_mode integer;
$k1$,
$k2$  -- 20261026110858: the default rises from 10000 to 120000.
  r := public.fn_lightning_config_number(v_cfg, 'pending_off_dwell_ms', 120000, 0, 3600000, true);
  v_dwell := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  -- 20261026110858: how long the ON condition must stand before a
  -- population-triggered PENDING_ON opens (0 disables it), and the minimum
  -- time a game stays in a mode after an automatic switch before the next
  -- automatic one (0 disables it). Neither holds always_on, an operator
  -- door, or a disabled game.
  r := public.fn_lightning_config_number(v_cfg, 'pending_on_dwell_ms', 60000, 0, 3600000, true);
  v_on_dwell := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
  r := public.fn_lightning_config_number(v_cfg, 'min_mode_dwell_ms', 900000, 0, 86400000, true);
  v_min_mode := (r ->> 'value')::integer; IF r ? 'invalid' THEN v_inv := v_inv || (r -> 'invalid'); END IF;
$k2$,
$k3$    'quality_weights', v_qw,
    'pending_on_dwell_ms', v_on_dwell,
    'min_mode_dwell_ms', v_min_mode);
$k3$])
  ) p(sig, expected, anchors, news)
  LOOP
    SELECT jsonb_build_array(proowner, proacl::text, prosecdef, proconfig, provolatile, prorettype, proargtypes::text)
      INTO v_meta FROM pg_proc WHERE oid = v_sig::regprocedure;
    v_def := pg_get_functiondef(v_sig::regprocedure);
    IF md5(v_def) IS DISTINCT FROM v_expected THEN
      RAISE EXCEPTION 'Lightning mode dwell predecessor changed: % (%)', v_sig, md5(v_def);
    END IF;
    IF cardinality(v_anchors) IS DISTINCT FROM cardinality(v_news) THEN
      RAISE EXCEPTION 'Lightning mode dwell anchors and replacements disagree: %', v_sig;
    END IF;
    v_new := v_def;
    FOR i IN 1 .. cardinality(v_anchors) LOOP
      IF (length(v_new) - length(replace(v_new, v_anchors[i], ''))) <> length(v_anchors[i]) THEN
        RAISE EXCEPTION 'Lightning mode dwell anchor % not unique: %', i, v_sig;
      END IF;
      v_new := replace(v_new, v_anchors[i], v_news[i]);
    END LOOP;
    EXECUTE v_new;
    v_after := pg_get_functiondef(v_sig::regprocedure);
    IF v_after IS DISTINCT FROM v_new
       OR v_meta IS DISTINCT FROM (SELECT jsonb_build_array(proowner, proacl::text, prosecdef, proconfig, provolatile, prorettype, proargtypes::text)
                                     FROM pg_proc WHERE oid = v_sig::regprocedure) THEN
      RAISE EXCEPTION 'Lightning mode dwell postimage/security changed: %', v_sig;
    END IF;
  END LOOP;
END $patch$;

COMMIT;
