-- Club membership is an explicit user action, never a wallet side effect.
-- These real-time RPCs count every legitimate member equally and never rely on
-- stale denormalised or browser-cached totals.

BEGIN;

CREATE OR REPLACE FUNCTION public.fn_batch_club_realtime_member_counts(p_club_ids uuid[])
RETURNS TABLE(club_id uuid, member_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.club_id, count(cm.user_id)::bigint
    FROM unnest(p_club_ids) requested(club_id)
    LEFT JOIN public.club_members cm ON cm.club_id = requested.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
   GROUP BY requested.club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_get_club_realtime_member_count(p_club_id uuid)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT count(*)::bigint
    FROM public.club_members cm
   WHERE cm.club_id = p_club_id
     AND (cm.status IS NULL OR cm.status IN ('active', 'approved'));
$function$;

CREATE OR REPLACE FUNCTION public.fn_batch_club_realtime_active_counts(p_club_ids uuid[])
RETURNS TABLE(club_id uuid, active_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.club_id,
         count(DISTINCT ts.user_id) FILTER (WHERE t.id IS NOT NULL)::bigint
    FROM unnest(p_club_ids) requested(club_id)
    LEFT JOIN public.club_members cm ON cm.club_id = requested.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
    LEFT JOIN public.table_seats ts ON ts.user_id = cm.user_id
      AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
    LEFT JOIN public.tables t ON t.id = ts.table_id
      AND t.club_id = requested.club_id
      AND lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   GROUP BY requested.club_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_member_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, member_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.union_id, count(cm.user_id)::bigint
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN public.union_clubs uc ON uc.union_id = requested.union_id
    LEFT JOIN public.club_members cm ON cm.club_id = uc.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
   GROUP BY requested.union_id;
$function$;

CREATE OR REPLACE FUNCTION public.fn_batch_union_realtime_active_counts(p_union_ids uuid[])
RETURNS TABLE(union_id uuid, active_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
  SELECT requested.union_id,
         count(DISTINCT ts.user_id) FILTER (WHERE t.id IS NOT NULL)::bigint
    FROM unnest(p_union_ids) requested(union_id)
    LEFT JOIN public.union_clubs uc ON uc.union_id = requested.union_id
    LEFT JOIN public.club_members cm ON cm.club_id = uc.club_id
      AND (cm.status IS NULL OR cm.status IN ('active', 'approved'))
    LEFT JOIN public.table_seats ts ON ts.user_id = cm.user_id
      AND ts.left_at IS NULL AND COALESCE(ts.is_away, false) = false
    LEFT JOIN public.tables t ON t.id = ts.table_id
      AND t.club_id = uc.club_id
      AND lower(COALESCE(t.status, '')) NOT IN ('closed','completed','cancelled','finished')
   GROUP BY requested.union_id;
$function$;

REVOKE ALL ON FUNCTION public.fn_batch_club_realtime_member_counts(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_get_club_realtime_member_count(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_member_counts(uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_batch_club_realtime_member_counts(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_get_club_realtime_member_count(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_batch_club_realtime_active_counts(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_member_counts(uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_batch_union_realtime_active_counts(uuid[]) TO authenticated, service_role;

-- Keep the denormalised column synchronized to approved membership rows only.
CREATE OR REPLACE FUNCTION public.fn_sync_club_member_count()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_club uuid; v_count bigint;
BEGIN
  v_club := COALESCE(NEW.club_id, OLD.club_id);
  IF v_club IS NOT NULL THEN
    SELECT public.fn_get_club_realtime_member_count(v_club) INTO v_count;
    UPDATE public.clubs c
       SET member_count = v_count,
           level = public.fn_club_level_for_members(v_count::integer),
           updated_at = now()
     WHERE c.id = v_club;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.club_id IS DISTINCT FROM NEW.club_id AND OLD.club_id IS NOT NULL THEN
    SELECT public.fn_get_club_realtime_member_count(OLD.club_id) INTO v_count;
    UPDATE public.clubs c
       SET member_count = v_count,
           level = public.fn_club_level_for_members(v_count::integer),
           updated_at = now()
     WHERE c.id = OLD.club_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- A wallet helper is not a membership workflow. The old implementation
-- silently INSERTed a player row whenever gameplay needed a wallet; that is
-- the precise path that enrolled Spin horses in Deep Stack Society.
CREATE OR REPLACE FUNCTION public.fn_ensure_club_wallet(p_user_id uuid, p_club_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_id
       AND cm.status IN ('active', 'approved')
  );
$function$;

-- A seat may identify which club owns a game; it may not make that club the
-- player's home unless the player explicitly joined it.
CREATE OR REPLACE FUNCTION public.fn_player_home_club(p_user_id uuid, p_club_hint uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_club uuid;
BEGIN
  IF p_user_id IS NULL THEN RETURN NULL; END IF;
  IF p_club_hint IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.user_id = p_user_id AND cm.club_id = p_club_hint
       AND cm.status IN ('active','approved')
  ) THEN RETURN p_club_hint; END IF;
  SELECT cm.club_id INTO v_club
    FROM public.club_members cm
   WHERE cm.user_id = p_user_id AND cm.status IN ('active','approved')
   ORDER BY cm.joined_at ASC NULLS LAST, cm.club_id
   LIMIT 1;
  RETURN v_club;
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_ensure_club_wallet(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_player_home_club(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ensure_club_wallet(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_player_home_club(uuid,uuid) TO authenticated, service_role;

DO $clone$
DECLARE v_def text;
BEGIN
  IF to_regprocedure('public.fn_seat_club_for_user_membership_unchecked(uuid,uuid,uuid)') IS NULL THEN
    SELECT pg_get_functiondef('public.fn_seat_club_for_user(uuid,uuid,uuid)'::regprocedure) INTO v_def;
    v_def := regexp_replace(
      v_def,
      'FUNCTION public\.fn_seat_club_for_user\(',
      'FUNCTION public.fn_seat_club_for_user_membership_unchecked(',
      1, 1
    );
    EXECUTE v_def;
  END IF;
END;
$clone$;

CREATE OR REPLACE FUNCTION public.fn_seat_club_for_user(
  p_user_id uuid, p_table_id uuid, p_preferred_club uuid DEFAULT NULL
)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_union uuid; v_table_club uuid;
BEGIN
  SELECT t.union_id, t.club_id INTO v_union, v_table_club
    FROM public.tables t WHERE t.id = p_table_id;
  IF v_union IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.club_members cm
       WHERE cm.user_id = p_user_id AND cm.club_id = v_table_club
         AND cm.status IN ('active','approved')
    ) THEN RETURN v_table_club; END IF;
    RETURN public.fn_player_home_club(p_user_id, p_preferred_club);
  END IF;
  RETURN public.fn_seat_club_for_user_membership_unchecked(
    p_user_id, p_table_id, p_preferred_club
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.fn_seat_club_for_user(uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_seat_club_for_user(uuid,uuid,uuid) TO authenticated, service_role;

-- Membership INSERTs are provenance-controlled. Clone the two approved entry
-- points, wrap them with a transaction-local source marker, then reject every
-- other direct or side-effect insert at the table boundary.
DO $clone$
DECLARE v_def text;
BEGIN
  IF to_regprocedure('public.fn_join_club_membership_impl(uuid)') IS NULL THEN
    SELECT pg_get_functiondef('public.fn_join_club(uuid)'::regprocedure) INTO v_def;
    v_def := regexp_replace(v_def, 'FUNCTION public\.fn_join_club\(',
      'FUNCTION public.fn_join_club_membership_impl(', 1, 1);
    EXECUTE v_def;
  END IF;
  IF to_regprocedure('public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text)') IS NULL THEN
    SELECT pg_get_functiondef(
      'public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text)'::regprocedure
    ) INTO v_def;
    v_def := regexp_replace(v_def, 'FUNCTION public\.fn_create_club_atomic\(',
      'FUNCTION public.fn_create_club_atomic_membership_impl(', 1, 1);
    EXECUTE v_def;
  END IF;
END;
$clone$;

CREATE OR REPLACE FUNCTION public.fn_join_club(p_club_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_result jsonb; v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  PERFORM set_config('app.club_membership_source', 'join_club', true);
  BEGIN
    v_result := public.fn_join_club_membership_impl(p_club_id);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_previous, true);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_create_club_atomic(
  p_request_id uuid, p_name text, p_description text DEFAULT NULL,
  p_color_theme text DEFAULT 'royal-blue', p_is_public boolean DEFAULT true,
  p_requires_approval boolean DEFAULT false, p_logo_url text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public', 'extensions'
AS $function$
DECLARE v_result jsonb; v_previous text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  PERFORM set_config('app.club_membership_source', 'club_owner_create', true);
  BEGIN
    v_result := public.fn_create_club_atomic_membership_impl(
      p_request_id, p_name, p_description, p_color_theme,
      p_is_public, p_requires_approval, p_logo_url
    );
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('app.club_membership_source', v_previous, true);
    RAISE;
  END;
  PERFORM set_config('app.club_membership_source', v_previous, true);
  RETURN v_result;
END;
$function$;

CREATE OR REPLACE FUNCTION public.fn_require_explicit_club_membership_source()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE v_source text := COALESCE(current_setting('app.club_membership_source', true), '');
BEGIN
  IF v_source NOT IN ('join_club', 'club_owner_create') THEN
    RAISE EXCEPTION 'MEMBERSHIP_REQUIRES_JOIN: Club Members Can Only Be Added Through Join A Club'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_club_members_require_explicit_join ON public.club_members;
CREATE TRIGGER trg_club_members_require_explicit_join
BEFORE INSERT ON public.club_members
FOR EACH ROW EXECUTE FUNCTION public.fn_require_explicit_club_membership_source();

-- Supersede the narrow incident guard after the universal provenance gate is live.
DROP TRIGGER IF EXISTS trg_emergency_block_deep_stack_horses ON public.club_members;

REVOKE ALL ON FUNCTION public.fn_join_club_membership_impl(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_join_club(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_join_club_membership_impl(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_create_club_atomic_membership_impl(uuid,text,text,text,boolean,boolean,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.fn_join_club(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_create_club_atomic(uuid,text,text,text,boolean,boolean,text) TO authenticated, service_role;

-- Sensitive Player Command access is evaluated inside the current club only.
-- Union membership or membership in a different club never grants access to
-- this club's wallets, fees, hierarchy, notes, or activity.
CREATE OR REPLACE FUNCTION public.ca_club_roster_access(p_club_id uuid, p_target_user_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_service boolean := COALESCE(auth.role(), 'service_role') = 'service_role';
BEGIN
  IF p_club_id IS NULL OR p_target_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.club_members target
     WHERE target.user_id = p_target_user_id AND target.club_id = p_club_id
       AND COALESCE(target.status, 'approved') IN ('active', 'approved')
  ) THEN RETURN 'none'; END IF;
  IF v_service THEN RETURN 'service'; END IF;
  IF v_actor IS NULL THEN RETURN 'none'; END IF;
  IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_actor AND COALESCE(p.is_admin, false))
     OR COALESCE(public.fn_is_union_overseer(p_club_id, v_actor), false)
  THEN RETURN 'staff'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND actor.role IN ('owner','co_owner','admin')
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN RETURN 'staff'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND actor.role IN ('super_agent','agent','sub_agent')
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN
    IF p_target_user_id = v_actor THEN RETURN 'downline'; END IF;
    IF EXISTS (
      WITH RECURSIVE edges AS (
        SELECT cm.agent_id parent, cm.user_id child
          FROM public.club_members cm
         WHERE cm.club_id = p_club_id AND cm.agent_id IS NOT NULL
           AND cm.agent_id <> cm.user_id
           AND COALESCE(cm.status, 'approved') IN ('active','approved')
      ), tree AS (
        SELECT e.child, 1 depth FROM edges e WHERE e.parent = v_actor
        UNION ALL
        SELECT e.child, t.depth + 1 FROM tree t JOIN edges e ON e.parent = t.child
         WHERE t.depth < 20
      ) SELECT 1 FROM tree WHERE child = p_target_user_id
    ) THEN RETURN 'downline'; END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members actor
     WHERE actor.user_id = v_actor AND actor.club_id = p_club_id
       AND COALESCE(actor.status, 'approved') IN ('active','approved')
  ) THEN RETURN 'identity'; END IF;
  RETURN 'none';
END;
$function$;

-- Keep the reviewed roster shape and redaction logic, but scope every
-- membership/wallet/seat/hierarchy read to this club and source fees from
-- club-attributed hand facts instead of an account-lifetime projection.
DO $club_specific_roster$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_def;
  v_def := replace(v_def, '= ANY(v_scope)', '= p_club_id');
  v_old := E'  fees AS MATERIALIZED (\n'
    '    SELECT r.user_id AS uid,\n'
    '           r.fees AS fee_total,\n'
    '           r.hands AS hand_total\n'
    '      FROM public.member_fee_lifetime r\n'
    '      JOIN base b ON b.m_user_id = r.user_id\n'
    '      JOIN access ac ON ac.uid = r.user_id AND ac.sensitive\n'
    '  ),';
  v_new := E'  fees AS MATERIALIZED (\n'
    '    SELECT r.user_id AS uid,\n'
    '           sum(COALESCE(r.rake_paid, 0)) AS fee_total,\n'
    '           count(DISTINCT r.hand_id)::bigint AS hand_total\n'
    '      FROM public.ca_hand_facts r\n'
    '      JOIN base b ON b.m_user_id = r.user_id\n'
    '      JOIN access ac ON ac.uid = r.user_id AND ac.sensitive\n'
    '     WHERE r.club_id = p_club_id\n'
    '     GROUP BY r.user_id\n'
    '  ),';
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF position('public.ca_hand_facts' IN v_def) = 0
     OR position('r.club_id = p_club_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Player Command fee source drifted; refusing an unscoped patch';
  END IF;
END;
$club_specific_roster$;

-- The detailed member view uses the same current-club access decision. Its
-- financial aggregates come only from current-club hand facts and transfers.
DO $club_specific_detail$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure)
    INTO v_def;
  v_def := replace(v_def, '= ANY(v_scope)', '= p_club_id');
  v_old := E'  ), roll AS MATERIALIZED (\n'
    '    SELECT coalesce(sum(r.hands) FILTER (WHERE NOT r.is_mtt), 0)::bigint AS hands,\n'
    '           coalesce(sum(r.hands) FILTER (WHERE r.is_mtt), 0)::bigint AS mtt_hands,\n'
    '           coalesce(sum(r.fees) FILTER (WHERE NOT r.is_mtt), 0) AS fees,\n'
    '           coalesce(sum(r.fees) FILTER (WHERE r.is_mtt), 0) AS mtt_fees,\n'
    '           coalesce(sum(r.won - r.contributed) FILTER (WHERE NOT r.is_mtt), 0) AS net,\n'
    '           coalesce(sum(r.won - r.contributed) FILTER (WHERE r.is_mtt), 0) AS mtt_net\n'
    '      FROM public.member_fee_rollup r\n'
    '     WHERE v_sensitive AND r.user_id = p_user_id\n'
    '       AND (p_from IS NULL OR r.day >= p_from) AND (p_to IS NULL OR r.day <= p_to)\n'
    '  ), txn AS MATERIALIZED (\n'
    '    SELECT coalesce(sum(wt.amount) FILTER (\n'
    '             WHERE wt.amount > 0 AND lower(coalesce(wt.type, '''')) NOT IN (''debit'', ''withdrawal'')\n'
    '               AND lower(coalesce(wt.category, '''') || '' '' || coalesce(wt.type, ''''))\n'
    '                   ~ ''(rakeback|rake_back|rake back|commission)''\n'
    '           ), 0) AS claimed_back,\n'
    '           coalesce(sum(abs(wt.amount)) FILTER (\n'
    '             WHERE (wt.amount < 0 OR lower(coalesce(wt.type, '''')) IN (''debit'', ''withdrawal'', ''send'', ''transfer_out''))\n'
    '               AND lower(coalesce(wt.category, '''') || '' '' || coalesce(wt.type, ''''))\n'
    '                   ~ ''(transfer|send|distribute)''\n'
    '           ), 0) AS sent_out\n'
    '      FROM public.wallet_transactions wt\n'
    '     WHERE v_sensitive AND wt.user_id = p_user_id\n'
    '       AND (v_ts_from IS NULL OR wt.created_at >= v_ts_from)\n'
    '       AND (v_ts_to IS NULL OR wt.created_at < v_ts_to)\n'
    '  )';
  v_new := E'  ), roll AS MATERIALIZED (\n'
    '    SELECT count(DISTINCT r.hand_id) FILTER (WHERE r.tournament_id IS NULL)::bigint AS hands,\n'
    '           count(DISTINCT r.hand_id) FILTER (WHERE r.tournament_id IS NOT NULL)::bigint AS mtt_hands,\n'
    '           coalesce(sum(r.rake_paid) FILTER (WHERE r.tournament_id IS NULL), 0) AS fees,\n'
    '           coalesce(sum(r.rake_paid) FILTER (WHERE r.tournament_id IS NOT NULL), 0) AS mtt_fees,\n'
    '           coalesce(sum(r.net) FILTER (WHERE r.tournament_id IS NULL), 0) AS net,\n'
    '           coalesce(sum(r.net) FILTER (WHERE r.tournament_id IS NOT NULL), 0) AS mtt_net\n'
    '      FROM public.ca_hand_facts r\n'
    '     WHERE v_sensitive AND r.user_id = p_user_id AND r.club_id = p_club_id\n'
    '       AND (v_ts_from IS NULL OR r.played_at >= v_ts_from)\n'
    '       AND (v_ts_to IS NULL OR r.played_at < v_ts_to)\n'
    '  ), txn AS MATERIALIZED (\n'
    '    SELECT coalesce(sum(ct.amount) FILTER (WHERE ct.to_user_id = p_user_id\n'
    '             AND lower(coalesce(ct.transaction_type, '''')) ~ ''(rakeback|commission)''), 0) AS claimed_back,\n'
    '           coalesce(sum(abs(ct.amount)) FILTER (WHERE ct.from_user_id = p_user_id\n'
    '             AND lower(coalesce(ct.transaction_type, '''')) ~ ''(transfer|send|distribute)''), 0) AS sent_out\n'
    '      FROM public.chip_transactions ct\n'
    '     WHERE v_sensitive AND ct.club_id = p_club_id\n'
    '       AND (v_ts_from IS NULL OR ct.created_at >= v_ts_from)\n'
    '       AND (v_ts_to IS NULL OR ct.created_at < v_ts_to)\n'
    '  )';
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF position('public.ca_hand_facts' IN v_def) = 0
     OR position('public.chip_transactions' IN v_def) = 0
     OR position('r.club_id = p_club_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Member detail financial source drifted; refusing an unscoped patch';
  END IF;
END;
$club_specific_detail$;

-- Downline lists are club-local and use club-attributed rake only.
DO $club_specific_downline$
DECLARE v_def text; v_old text; v_new text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_member_downline(uuid,uuid)'::regprocedure) INTO v_def;
  v_def := replace(v_def, '= ANY(v_scope)', '= p_club_id');
  v_old := E'  ), fees AS MATERIALIZED (\n'
    '    SELECT r.user_id AS uid, sum(r.fees) AS fee_total FROM public.member_fee_rollup r\n'
    '     WHERE r.user_id IN (SELECT f.uid FROM flat f) GROUP BY r.user_id\n'
    '  )';
  v_new := E'  ), fees AS MATERIALIZED (\n'
    '    SELECT r.user_id AS uid, sum(COALESCE(r.rake_paid, 0)) AS fee_total\n'
    '      FROM public.ca_hand_facts r\n'
    '     WHERE r.club_id = p_club_id AND r.user_id IN (SELECT f.uid FROM flat f)\n'
    '     GROUP BY r.user_id\n'
    '  )';
  IF position(v_old IN v_def) > 0 THEN
    EXECUTE replace(v_def, v_old, v_new);
  ELSIF position('public.ca_hand_facts' IN v_def) = 0
     OR position('r.club_id = p_club_id' IN v_def) = 0 THEN
    RAISE EXCEPTION 'Downline fee source drifted; refusing an unscoped patch';
  END IF;
END;
$club_specific_downline$;

-- Statistics are likewise derived from the selected club's hand facts.
CREATE OR REPLACE FUNCTION public.ca_club_member_statistics(
  p_club_id uuid, p_user_id uuid, p_variant text DEFAULT NULL,
  p_from date DEFAULT NULL, p_to date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_access text := public.ca_club_roster_access(p_club_id, p_user_id);
  v_variant text := NULLIF(lower(btrim(COALESCE(p_variant, ''))), '');
  v_from timestamptz := CASE WHEN p_from IS NULL THEN NULL ELSE p_from::timestamp AT TIME ZONE 'UTC' END;
  v_to timestamptz := CASE WHEN p_to IS NULL THEN NULL ELSE (p_to + 1)::timestamp AT TIME ZONE 'UTC' END;
  v_out jsonb;
BEGIN
  IF v_access NOT IN ('staff','downline','service') THEN
    RETURN jsonb_build_object('authorized', false);
  END IF;
  WITH agg AS (
    SELECT count(DISTINCT f.hand_id)::bigint hands,
           count(DISTINCT f.hand_id) FILTER (WHERE f.net > 0)::bigint wins,
           count(*) FILTER (WHERE f.vpip)::bigint vpip_hands,
           count(*) FILTER (WHERE f.pfr)::bigint pfr_hands,
           count(*) FILTER (WHERE f.three_bet)::bigint tb_hands,
           count(*) FILTER (WHERE f.faced_three_bet)::bigint tb_opps,
           count(*) FILTER (WHERE f.cbet_flop)::bigint cb_hands,
           count(*) FILTER (WHERE f.had_cbet_flop_opp)::bigint cb_opps,
           COALESCE(sum(f.net),0) net, COALESCE(sum(f.rake_paid),0) fees
      FROM public.ca_hand_facts f
     WHERE f.club_id = p_club_id AND f.user_id = p_user_id
       AND (v_variant IS NULL OR v_variant = 'all' OR lower(f.game_variant) = v_variant)
       AND (v_from IS NULL OR f.played_at >= v_from) AND (v_to IS NULL OR f.played_at < v_to)
  ), vars AS (
    SELECT COALESCE(jsonb_agg(v.game_variant ORDER BY v.game_variant), '[]'::jsonb) list
      FROM (SELECT DISTINCT lower(f.game_variant) game_variant FROM public.ca_hand_facts f
             WHERE f.club_id = p_club_id AND f.user_id = p_user_id
               AND f.game_variant IS NOT NULL) v
  )
  SELECT jsonb_build_object(
    'authorized',true,'variant',COALESCE(v_variant,'all'),'variants',vars.list,
    'total_games',a.hands,'total_hands',a.hands,'wins',a.wins,'winner',a.wins,
    'vpip',COALESCE(round(100.0*a.vpip_hands/NULLIF(a.hands,0),2),0),
    'pfr',COALESCE(round(100.0*a.pfr_hands/NULLIF(a.hands,0),2),0),
    'three_bet',COALESCE(round(100.0*a.tb_hands/NULLIF(a.tb_opps,0),2),0),
    'cbet',COALESCE(round(100.0*a.cb_hands/NULLIF(a.cb_opps,0),2),0),
    'net',round(a.net,2),'fees',round(a.fees,2),
    'from',p_from,'to',p_to,'is_overall',p_from IS NULL AND p_to IS NULL
  ) INTO v_out FROM agg a CROSS JOIN vars;
  RETURN v_out;
END;
$function$;

REVOKE ALL ON FUNCTION public.ca_club_member_statistics(uuid,uuid,text,date,date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ca_club_member_statistics(uuid,uuid,text,date,date) TO authenticated, service_role;

DO $privacy_assert$
DECLARE v_rows text; v_detail text; v_downline text; v_stats text;
BEGIN
  SELECT pg_get_functiondef('public.ca_club_roster_rows(uuid)'::regprocedure) INTO v_rows;
  SELECT pg_get_functiondef('public.ca_club_member_detail(uuid,uuid,date,date)'::regprocedure) INTO v_detail;
  SELECT pg_get_functiondef('public.ca_club_member_downline(uuid,uuid)'::regprocedure) INTO v_downline;
  SELECT pg_get_functiondef('public.ca_club_member_statistics(uuid,uuid,text,date,date)'::regprocedure) INTO v_stats;
  IF v_rows LIKE '%member_fee_lifetime%' OR v_detail LIKE '%member_fee_rollup%'
     OR v_downline LIKE '%member_fee_rollup%' OR v_stats LIKE '%member_fee_rollup%'
     OR v_rows NOT LIKE '%r.club_id = p_club_id%'
  THEN RAISE EXCEPTION 'Player Command still exposes an unscoped financial source'; END IF;
END;
$privacy_assert$;

-- Repair the incident club immediately; subsequent membership changes stay
-- synchronized through fn_sync_club_member_count.
UPDATE public.clubs c
   SET member_count = public.fn_get_club_realtime_member_count(c.id),
       level = public.fn_club_level_for_members(
         public.fn_get_club_realtime_member_count(c.id)::integer
       ),
       updated_at = now()
 WHERE c.id = '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'::uuid;

-- The pre-hardening creator briefly placed the promised opening 100,000 in
-- the owner's per-club player wallet.  The correct destination is the Club
-- Bank.  Reverse only the exact, untouched legacy signature: one owner, no
-- owner transactions or seats, and one 100,000 auto-audit credit.  This makes
-- the correction safe to re-run and impossible to apply to an active wallet.
DO $repair_opening_wallet_destination$
DECLARE
  v record;
BEGIN
  FOR v IN
    SELECT c.id, c.club_id, c.owner_id, COALESCE(c.chip_treasury, 0) AS treasury
      FROM public.clubs c
      JOIN public.club_members cm
        ON cm.club_id = c.id AND cm.user_id = c.owner_id AND cm.role = 'owner'
     WHERE c.created_at >= '2026-08-31 00:00:00+00'::timestamptz
       AND NOT COALESCE(c.is_union, false)
       AND cm.status = 'active'
       AND COALESCE(cm.chip_balance, 0) = 100000
       AND (SELECT count(*) FROM public.club_members x WHERE x.club_id = c.id) = 1
       AND NOT EXISTS (
         SELECT 1 FROM public.chip_transactions t
          WHERE t.club_id = c.id
            AND (t.from_user_id = c.owner_id OR t.to_user_id = c.owner_id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.table_seats s
          WHERE s.club_id = c.id AND s.user_id = c.owner_id
       )
       AND (SELECT count(*) FROM public.chip_ledger l
             WHERE l.club_id = c.id
               AND l.to_type = 'player_wallet'
               AND l.to_entity_id = c.owner_id
               AND l.amount = 100000
               AND l.description LIKE 'auto-audited club_members.chip_balance delta 100000%') = 1
       AND NOT EXISTS (
         SELECT 1 FROM public.chip_ledger l
          WHERE l.club_id = c.id
            AND l.from_type = 'player_wallet'
            AND l.from_entity_id = c.owner_id
       )
  LOOP
    PERFORM set_config('app.ledger_category', 'correction', true);
    PERFORM set_config('app.ledger_counterparty', 'system_burn', true);
    PERFORM set_config('app.ledger_counterparty_entity', '', true);
    UPDATE public.club_members
       SET chip_balance = 0, updated_at = now()
     WHERE club_id = v.id AND user_id = v.owner_id AND chip_balance = 100000;

    IF v.treasury = 0 THEN
      PERFORM set_config('app.ledger_category', 'mint', true);
      PERFORM set_config('app.ledger_counterparty', 'system_mint', true);
      PERFORM set_config('app.ledger_counterparty_entity', '', true);
      UPDATE public.clubs SET chip_treasury = 100000 WHERE id = v.id AND chip_treasury = 0;

      INSERT INTO public.chip_transactions
        (club_id, amount, transaction_type, notes, balance_after, metadata)
      SELECT v.id, 100000, 'club_opening_grant',
             'New Club Opening Bank — Legacy Destination Repair', 100000,
             jsonb_build_object('source','system','destination','club_bank',
               'club_owner_id',v.owner_id,'club_code',v.club_id,
               'opening_balance',100000,'repair','legacy_owner_wallet_destination')
       WHERE NOT EXISTS (
         SELECT 1 FROM public.chip_transactions t
          WHERE t.club_id = v.id AND t.transaction_type = 'club_opening_grant'
       );
    END IF;
  END LOOP;

  -- Production certification fixtures must never appear in the public Club
  -- Arena when an append-only financial record prevents their hard deletion.
  UPDATE public.clubs
     SET is_public = false, status = 'inactive', updated_at = now()
   WHERE (name LIKE 'Crest Cert %' OR name LIKE 'Preset Crest Cert %')
     AND created_at >= '2026-08-31 00:00:00+00'::timestamptz;
END;
$repair_opening_wallet_destination$;

DO $assert$
DECLARE v_club uuid := '2a1132b9-5ba2-42e6-9f01-30a7fcffebe3'; v_n bigint; v_stored bigint; v_level integer;
BEGIN
  SELECT public.fn_get_club_realtime_member_count(v_club) INTO v_n;
  SELECT member_count, level INTO v_stored, v_level FROM public.clubs WHERE id = v_club;
  IF FOUND AND (v_n IS DISTINCT FROM v_stored
     OR v_level IS DISTINCT FROM public.fn_club_level_for_members(v_n::integer)) THEN
    RAISE EXCEPTION 'Deep Stack Society stored count/level %/% disagrees with real-time %/%',
      v_stored, v_level, v_n, public.fn_club_level_for_members(v_n::integer);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.club_members'::regclass
       AND tgname = 'trg_club_members_require_explicit_join'
       AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'Club membership provenance trigger is not active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = v_club
       AND cm.user_id = (SELECT owner_id FROM public.clubs WHERE id = v_club)
       AND COALESCE(cm.chip_balance, 0) <> 0
  ) THEN
    RAISE EXCEPTION 'Deep Stack Society still has a duplicate opening owner-wallet grant';
  END IF;
END;
$assert$;

COMMIT;
