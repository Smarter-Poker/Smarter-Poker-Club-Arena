-- 20261001201216_lightning_phase_6_remediation_a_frozen_cluster_settles_nothi.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- LIGHTNING PHASE 6 REMEDIATION: A FROZEN CLUSTER SETTLES NOTHING, THE FREEZE
-- FREEZES FROM EVERY LIVE MODE, THE SESSION NAMES ITS ANCHOR SEAT, AND THE
-- MATCHER FORMS NOTHING THE HOST CANNOT DEAL.
--
-- Review findings against 20261001154813 (Phase 6 settlement) and the matcher
-- (20260926080332). Every change is an asserted substitution into the body
-- production carries (read with pg_get_functiondef): each anchor must appear
-- exactly as often as stated or the file refuses, and a body that already
-- carries the change is left alone, so the file is re-appliable.
--
-- 1. (P0) fn_lightning_settlement_freeze froze only WHERE cluster_mode =
--    'lightning'. A conservation failure on a hand still settling after its
--    Cluster moved to pending_off or draining wrote stack_invariant_failed
--    and cluster_frozen and answered frozen:true, while freezing nothing. It
--    now locks the Cluster row, freezes from any mode but frozen and dead,
--    records the real from_mode in cluster_frozen and in the alert, and
--    answers frozen:true only when the row was frozen (by this call, or
--    already: already_frozen:true, with no second cluster_frozen and no
--    second alert). A dead Cluster is never reported frozen.
--
-- 2. (P0) fn_lightning_settle_hand refuses a hand of a FROZEN Cluster with
--    {ok:false, reason:'cluster_frozen', retry:false} before anything is
--    written: no marker, no seat, no hand row, no physical settlement. The
--    engine already abandons the instance on any refusal that is not frozen
--    (LightningHandHost: settlement_refused:<reason>), and
--    fn_lightning_instance_abandon is not gated on the freeze, so the hand
--    ends with every anchor stack exactly as it was. A hand settled before
--    the freeze still answers its stored receipt on retry (that check comes
--    first).
--
-- 3. (P1) fn_lightning_my_session also answers anchor_table_id, seat_number
--    and occupancy_id: the caller's anchor seat, by the table_seats columns
--    the physical leave path names (fn_cashout_seat_occupancy(user, table,
--    seat_number, occupancy_id)), so the client leaves or adds on through the
--    anchor table. Every existing key is kept.
--
-- 4. (P1) The matcher forms nothing the Lightning host cannot deal.
--    fn_lightning_match_plan (and so fn_lightning_match) answers a Cluster
--    whose variant is pineapple (cash_games.variant, or the front table's
--    game_variant or pineapple_holdem, which are the host's rules) with no
--    groups, refused:true, reason 'variant_not_supported', and every
--    open-pool player diagnosed BLOCKED_WITH_REASON / VARIANT_NOT_SUPPORTED.
--    fn_lightning_match_and_form refuses up front, before the pass lock and
--    unrecorded like worker_mode_is_not_form, with 'cluster_has_no_front_table'
--    when fn_cash_cluster_front_table is null (the front table hosts every
--    hand) and with 'variant_not_supported'.
--
-- 5. The anchor guard is NOT changed. Its trigger fires only when stack,
--    left_at or user_id change, so setting leave_pending on an anchor seat
--    whose player is in a live hand goes through, while a stack or departure
--    change is still refused PLT01 until the hand settles; the departure then
--    exits the pool through the unchanged pool-follows-seat trigger. The
--    harness proves all three.
--
-- LAW 10.5. Nothing here reads is_horse or horse_id. Horses are frozen,
-- refused, matched and diagnosed exactly as humans are.
--
-- HOUSE RULES OBSERVED. One BEGIN/COMMIT with SET LOCAL lock_timeout. No new
-- object, no grant change, no table touched. Replacing a function takes no
-- lock on any table.
--
-- @live-proof: (SELECT s ~ 'cg\.cluster_mode NOT IN \(''frozen'', ''dead''\)' AND s ~ 'FOR UPDATE' AND s ~ '''from_mode'', v_from' AND s ~ '''already_frozen''' AND s !~ 'cg\.cluster_mode = ''lightning''' AND p.prosecdef FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure)
-- @live-proof: (SELECT p.prosecdef AND position('''cluster_frozen''' in s) > 0 AND position('''cluster_frozen''' in s) < position('lightning_settlement_marker' in s) AND position('''instance_not_dealing''' in s) < position('''cluster_frozen''' in s) FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure)
-- @live-proof: (SELECT p.prosecdef AND s ~ 'auth\.uid\(\)' AND s ~ '''anchor_table_id'', s\.anchor_table_id' AND s ~ '''seat_number'', s\.seat_number' AND s ~ '''occupancy_id'', s\.occupancy_id' AND s ~ '''in_hand'', v_hand IS NOT NULL' AND s ~ '''pool_session_id'', s\.id' AND has_function_privilege('authenticated', p.oid, 'EXECUTE') AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)
-- @live-proof: (SELECT s ~ '''VARIANT_NOT_SUPPORTED''' AND s ~ '''variant_not_supported''' AND s ~ 'pineapple_holdem' AND NOT p.prosecdef FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)'::regprocedure)
-- @live-proof: (SELECT NOT p.prosecdef AND position('''cluster_has_no_front_table''' in s) > 0 AND position('''variant_not_supported''' in s) > 0 AND position('''cluster_has_no_front_table''' in s) < position('pg_try_advisory_xact_lock' in s) AND position('''variant_not_supported''' in s) < position('pg_try_advisory_xact_lock' in s) FROM pg_proc p, LATERAL (SELECT pg_get_functiondef(p.oid) AS s) q WHERE p.oid = 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)'::regprocedure)
-- @live-proof: (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE') AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE')) FROM unnest(ARRAY['public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)', 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)', 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)', 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)']) f)
-- @live-proof: (SELECT pg_get_triggerdef(t.oid) ~ 'WHEN \(\(\(old\.stack IS DISTINCT FROM new\.stack\) OR \(old\.left_at IS DISTINCT FROM new\.left_at\) OR \(old\.user_id IS DISTINCT FROM new\.user_id\)\)\)' FROM pg_trigger t WHERE t.tgrelid = 'public.table_seats'::regclass AND t.tgname = 'trg_table_seats_lightning_anchor_guard')
-- @live-proof: (SELECT NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname IN ('fn_lightning_settlement_freeze', 'fn_lightning_settle_hand', 'fn_lightning_my_session', 'fn_lightning_match_plan', 'fn_lightning_match_and_form') AND (regexp_replace(pg_get_functiondef(p.oid), '--[^' || chr(10) || ']*', '', 'g') ~ 'is_horse|horse_id' OR p.proconfig IS NULL)))

BEGIN;

SET LOCAL lock_timeout = '2s';

-- ===========================================================================
-- 1. fn_lightning_settlement_freeze: freezes from every live mode, says
--    frozen only when the Cluster is, records the mode it froze from.
-- ===========================================================================
DO $sub_freeze$
DECLARE
  v_sig constant text := 'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$DECLARE
  v_alert_id    uuid;
  v_alert_error text;
BEGIN
  UPDATE public.cash_games cg
     SET cluster_mode = 'frozen', updated_at = now()
   WHERE cg.id = p_cluster_id AND cg.cluster_mode = 'lightning';
  BEGIN
    v_alert_id := public.fn_raise_server_financial_alert(
      'critical', 'lightning_settlement',
      format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze at epoch %s settling hand %s: %s',
             p_cluster_id, p_cluster_epoch, p_hand_id, p_invariant),
      jsonb_build_object('cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
                         'instance_id', p_instance_id, 'invariant', p_invariant,
                         'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
      'lightning_cluster_frozen:' || p_cluster_id, p_cluster_id::text);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
  END;
  INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
  VALUES
    (p_cluster_id, 'stack_invariant_failed', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'stage', 'settlement', 'invariant', p_invariant,
       'evidence', p_evidence, 'at', clock_timestamp()), p_cluster_epoch, p_request_id),
    (p_cluster_id, 'cluster_frozen', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'from_mode', 'lightning', 'to_mode', 'frozen',
       'reason', 'stack_invariant_failed', 'invariant', p_invariant, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
       'at', clock_timestamp()), p_cluster_epoch, p_request_id);
  RETURN jsonb_build_object('ok', false, 'frozen', true, 'retry', false,
                            'reason', 'settlement_invariant_failed', 'invariant', p_invariant,
                            'hand_id', p_hand_id, 'cluster_id', p_cluster_id,
                            'alerted', v_alert_id IS NOT NULL);
$a$];
  b text[] := ARRAY[
$b$DECLARE
  v_alert_id    uuid;
  v_alert_error text;
  v_from        text;
  v_froze       boolean := false;
BEGIN
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): THE FREEZE FREEZES FROM
  -- EVERY LIVE MODE AND SAYS FROZEN ONLY WHEN THE CLUSTER IS. A hand dealt
  -- while the Cluster was lightning can fail its invariant after the Cluster
  -- moved to pending_off or draining; freezing only WHERE cluster_mode =
  -- 'lightning' wrote both events and answered frozen:true while freezing
  -- nothing. The row is locked first, so from_mode is the mode it froze
  -- from. Already frozen: frozen:true, already_frozen:true, and no second
  -- cluster_frozen or alert. Dead: never reported frozen.
  SELECT cg.cluster_mode INTO v_from FROM public.cash_games cg WHERE cg.id = p_cluster_id FOR UPDATE;
  IF v_from IS NOT NULL AND v_from NOT IN ('frozen', 'dead') THEN
    UPDATE public.cash_games cg
       SET cluster_mode = 'frozen', updated_at = now()
     WHERE cg.id = p_cluster_id AND cg.cluster_mode NOT IN ('frozen', 'dead');
    v_froze := FOUND;
  END IF;
  IF v_froze THEN
    BEGIN
      v_alert_id := public.fn_raise_server_financial_alert(
        'critical', 'lightning_settlement',
        format('LIGHTNING_CLUSTER_FROZEN: Cluster %s froze from %s at epoch %s settling hand %s: %s',
               p_cluster_id, v_from, p_cluster_epoch, p_hand_id, p_invariant),
        jsonb_build_object('cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
                           'instance_id', p_instance_id, 'invariant', p_invariant, 'from_mode', v_from,
                           'recovery', 'fn_cash_cluster_unfreeze(cluster_id, operator, reason)'),
        'lightning_cluster_frozen:' || p_cluster_id, p_cluster_id::text);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_alert_error = MESSAGE_TEXT;
    END;
  END IF;
  IF v_from IS NOT NULL THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (p_cluster_id, 'stack_invariant_failed', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'stage', 'settlement', 'invariant', p_invariant,
       'evidence', p_evidence, 'cluster_mode', v_from, 'at', clock_timestamp()), p_cluster_epoch, p_request_id);
  END IF;
  IF v_froze THEN
    INSERT INTO public.cash_cluster_events (game_id, kind, payload, cluster_epoch, request_id)
    VALUES (p_cluster_id, 'cluster_frozen', jsonb_build_object(
       'cluster_id', p_cluster_id, 'cluster_epoch', p_cluster_epoch, 'from_mode', v_from, 'to_mode', 'frozen',
       'reason', 'stack_invariant_failed', 'invariant', p_invariant, 'hand_id', p_hand_id,
       'instance_id', p_instance_id, 'alert_id', v_alert_id, 'alert_error', v_alert_error,
       'at', clock_timestamp()), p_cluster_epoch, p_request_id);
  END IF;
  RETURN jsonb_build_object('ok', false, 'frozen', v_froze OR v_from IS NOT DISTINCT FROM 'frozen',
                            'already_frozen', v_from IS NOT DISTINCT FROM 'frozen',
                            'from_mode', CASE WHEN v_froze THEN v_from END,
                            'cluster_mode', CASE WHEN v_froze THEN 'frozen' ELSE v_from END,
                            'retry', false,
                            'reason', 'settlement_invariant_failed', 'invariant', p_invariant,
                            'hand_id', p_hand_id, 'cluster_id', p_cluster_id,
                            'alerted', v_alert_id IS NOT NULL);
$b$];
  c integer[] := ARRAY[1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''already_frozen''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(a[1] in v_src) > 0 THEN
    RAISE EXCEPTION '% does not read back freezing from every live mode', v_sig;
  END IF;
END
$sub_freeze$;

-- ===========================================================================
-- 2. fn_lightning_settle_hand: a frozen Cluster settles nothing.
-- ===========================================================================
DO $sub_settle$
DECLARE
  v_sig constant text := 'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_detail   text;
BEGIN
$a$,
$a$  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
$a$];
  b text[] := ARRAY[
$b$  v_detail   text;
  v_mode     text;
BEGIN
$b$,
$b$  IF i.state IS DISTINCT FROM 'dealing' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'instance_not_dealing', 'state', i.state);
  END IF;
  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): A FROZEN CLUSTER SETTLES
  -- NOTHING. A freeze answers an impossible state; a hand still dealing when
  -- it lands must not move a chip afterwards. Refused here, before the
  -- marker, a seat or the hand row is written, so the engine abandons the
  -- instance and every anchor stack stays as it was. A hand settled before
  -- the freeze is answered above with its receipt. Read without a row lock:
  -- a lock would queue every settlement behind the matcher's and the tick's
  -- holds on the Cluster row, and a hand that passes this while a freeze is
  -- still uncommitted is held to its own conservation check below.
  SELECT cg.cluster_mode INTO v_mode FROM public.cash_games cg WHERE cg.id = i.cluster_id;
  IF v_mode IS NOT DISTINCT FROM 'frozen' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cluster_frozen', 'retry', false,
                              'hand_id', p_hand_id, 'cluster_id', i.cluster_id);
  END IF;
$b$];
  c integer[] := ARRAY[1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''cluster_frozen''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0
     OR position('''cluster_frozen''' in v_src) > position('lightning_settlement_marker' in v_src)
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back refusing a frozen Cluster before any write', v_sig;
  END IF;
END
$sub_settle$;

-- ===========================================================================
-- 3. fn_lightning_my_session: the anchor seat, by the leave path's columns.
-- ===========================================================================
DO $sub_session$
DECLARE
  v_sig constant text := 'public.fn_lightning_my_session(uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  SELECT ps.id, ps.state, cg.cluster_mode
    INTO s
    FROM public.lightning_pool_session ps
    JOIN public.cash_games cg ON cg.id = ps.cluster_id
$a$,
$a$                            'in_hand', v_hand IS NOT NULL)
$a$];
  b text[] := ARRAY[
$b$  -- LIGHTNING PHASE 6 REMEDIATION (20261001201216): the anchor seat, named
  -- by the columns the physical leave path takes (table, seat_number,
  -- occupancy_id), so the client leaves and adds on through the anchor table.
  SELECT ps.id, ps.state, cg.cluster_mode,
         ts.table_id AS anchor_table_id, ts.seat_number, ts.occupancy_id
    INTO s
    FROM public.lightning_pool_session ps
    JOIN public.cash_games cg ON cg.id = ps.cluster_id
    LEFT JOIN public.table_seats ts ON ts.id = ps.anchor_seat_id
$b$,
$b$                            'in_hand', v_hand IS NOT NULL,
                            'anchor_table_id', s.anchor_table_id, 'seat_number', s.seat_number,
                            'occupancy_id', s.occupancy_id)
$b$];
  c integer[] := ARRAY[1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''occupancy_id''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0
     OR position(a[1] in v_src) > 0 OR position(a[2] in v_src) > 0
     OR position('auth.uid()' in v_src) = 0
     OR NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = v_sig::regprocedure) THEN
    RAISE EXCEPTION '% does not read back naming the anchor seat', v_sig;
  END IF;
END
$sub_session$;

-- ===========================================================================
-- 4a. fn_lightning_match_plan: a variant the host cannot deal is not matched.
-- ===========================================================================
DO $sub_plan$
DECLARE
  v_sig constant text := 'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_win_s     integer;
BEGIN
$a$,
$a$  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true OR v_epoch IS NULL THEN
    RETURN jsonb_build_object('matcher_version', v_version, 'generated_at', v_now, 'legal_count', 0,
                              'groups', '[]'::jsonb, 'diagnosis', '[]'::jsonb, 'pool_diversity_score', 1);
  END IF;
$a$];
  b text[] := ARRAY[
$b$  v_win_s     integer;
  v_variant   text;
BEGIN
$b$,
$b$  IF coalesce((v_cfg ->> 'ok')::boolean, false) IS DISTINCT FROM true OR v_epoch IS NULL THEN
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
                                              FROM public.fn_lightning_player_legality(p_cluster_id, v_now, p_disconnected) l),
                              'pool_diversity_score', 1);
  END IF;
$b$];
  c integer[] := ARRAY[1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''VARIANT_NOT_SUPPORTED''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0 THEN
    RAISE EXCEPTION '% does not read back refusing a variant the host cannot deal', v_sig;
  END IF;
END
$sub_plan$;

-- ===========================================================================
-- 4b. fn_lightning_match_and_form: nothing is formed that cannot be hosted.
-- ===========================================================================
DO $sub_form$
DECLARE
  v_sig constant text := 'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)';
  v_src text; v_new text; k integer; v_n integer;
  a text[] := ARRAY[
$a$  v_pruned    integer := 0;
BEGIN
$a$,
$a$  IF (v_cfg ->> 'worker_mode') IS DISTINCT FROM 'form' THEN
    RETURN jsonb_build_object('ok', false, 'formed', 0, 'reason', 'worker_mode_is_not_form',
                              'worker_mode', v_cfg ->> 'worker_mode', 'cluster_id', p_cluster_id);
  END IF;
$a$];
  b text[] := ARRAY[
$b$  v_pruned    integer := 0;
  v_variant   text;
BEGIN
$b$,
$b$  IF (v_cfg ->> 'worker_mode') IS DISTINCT FROM 'form' THEN
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
$b$];
  c integer[] := ARRAY[1, 1];
BEGIN
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position('''cluster_has_no_front_table''' in v_src) = 0 THEN
    v_new := v_src;
    FOR k IN 1 .. array_length(a, 1) LOOP
      v_n := (length(v_new) - length(replace(v_new, a[k], ''))) / length(a[k]);
      IF v_n IS DISTINCT FROM c[k] THEN
        RAISE EXCEPTION '% carries anchor % % time(s) rather than %; refusing to substitute blind', v_sig, k, v_n, c[k];
      END IF;
      v_new := replace(v_new, a[k], b[k]);
    END LOOP;
    EXECUTE v_new;
  END IF;
  v_src := pg_get_functiondef(v_sig::regprocedure);
  IF position(b[1] in v_src) = 0 OR position(b[2] in v_src) = 0
     OR position('''cluster_has_no_front_table''' in v_src) > position('pg_try_advisory_xact_lock' in v_src) THEN
    RAISE EXCEPTION '% does not read back refusing what cannot be hosted before the pass lock', v_sig;
  END IF;
END
$sub_form$;

-- ===========================================================================
-- 5. READ BACK: the grants and definers this file must not have moved.
-- ===========================================================================
DO $readback$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(q.what, '; ') INTO v_bad FROM (VALUES
    ('service_role doors', (SELECT bool_and(has_function_privilege('service_role', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('anon', f::regprocedure, 'EXECUTE')
       AND NOT has_function_privilege('authenticated', f::regprocedure, 'EXECUTE'))
       FROM unnest(ARRAY['public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)',
                         'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)',
                         'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)',
                         'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)']) f)),
    ('the browser door', (SELECT p.prosecdef AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
       AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') FROM pg_proc p WHERE p.oid = 'public.fn_lightning_my_session(uuid)'::regprocedure)),
    ('definers', (SELECT bool_and(p.prosecdef) FROM pg_proc p WHERE p.oid IN (
       'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure,
       'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure))),
    ('invokers', (SELECT bool_and(NOT p.prosecdef) FROM pg_proc p WHERE p.oid IN (
       'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)'::regprocedure,
       'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)'::regprocedure))),
    ('pinned search paths', (SELECT bool_and(p.proconfig IS NOT NULL AND p.proconfig::text ~ 'search_path')
       FROM pg_proc p WHERE p.oid IN (
         'public.fn_lightning_settlement_freeze(uuid,integer,uuid,uuid,uuid,text,jsonb)'::regprocedure,
         'public.fn_lightning_settle_hand(uuid,uuid,uuid,text,uuid,jsonb,numeric,numeric,jsonb)'::regprocedure,
         'public.fn_lightning_my_session(uuid)'::regprocedure,
         'public.fn_lightning_match_plan(uuid,timestamp with time zone,uuid[],text,integer)'::regprocedure,
         'public.fn_lightning_match_and_form(uuid,timestamp with time zone,uuid[],integer,uuid)'::regprocedure)))
  ) q(what, ok) WHERE q.ok IS DISTINCT FROM true;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'LIGHTNING_PHASE_6_REMEDIATION_READBACK: the catalogue does not carry: %', v_bad;
  END IF;
END
$readback$;

COMMIT;
