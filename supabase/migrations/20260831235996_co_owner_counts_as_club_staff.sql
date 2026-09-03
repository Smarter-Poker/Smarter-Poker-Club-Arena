-- =============================================================================
-- CO OWNER COUNTS AS CLUB STAFF
-- =============================================================================
-- 2026-08-31. Audit of the player promotion system.
--
-- THE BUG. `co_owner` was added to club_members.role, to the CHECK constraint,
-- to fn_club_grantable_roles and to the promote screen. It was never added to
-- anything that ASKS whether you are staff. So the promotion succeeded and
-- bought the person nothing:
--
--   fn_role_rank('co_owner')                 -> 0   (a player scores 1)
--   is_club_admin / fn_is_club_admin_uid     -> false
--   ca_can_view_club_finances                -> false
--   fn_actor_can_manage_club_treasury        -> false
--   fn_can_create_games                      -> false
--   fn_can_message_in_club                   -> treated as a plain player
--   fn_register_for_tournament (staff path)  -> false
--   18 club-scoped RLS policies              -> denied
--
-- ROLE_DESCRIPTION.co_owner says "Everything an owner can do except appoint
-- another co owner". What shipped was closer to "everything a stranger can do".
-- src/types/clubRoles.ts opens by naming this exact failure - "how co_owner
-- would have arrived as a role that unlocked nothing" - and it arrived anyway,
-- because the seven-role vocabulary was only ever taught to the WRITE path.
--
-- THE FIX. Every club-role staff gate that already said owner-or-admin now
-- says owner-or-co_owner-or-admin. The patch is applied by rewriting each
-- definition through a regular expression rather than by retyping it, so each
-- body is byte-identical apart from the added role, and every target is
-- asserted afterwards. Nothing else about any of these functions changes.
--
-- Applied to production 2026-08-31: 24 functions and 18 policies rewritten,
-- verified by counting how many of each now contain the word.
--
-- WHAT IS DELIBERATELY NOT TOUCHED:
--   * profiles.role gates ('admin','owner','super_agent') - platform staff,
--     a different vocabulary that has no co_owner.
--   * commander_*, commander_home_members, messenger_participants, crew_members
--     - other products with their own owner/admin roles.
--   * fn_union_can_manage_wallets - already lists co_owner.
--
-- ROLLBACK. No data is written by this migration, so a rollback loses nothing.
-- For each function and policy listed below, replace
--     'owner','co_owner','admin'  ->  'owner','admin'
--     'admin','co_owner','owner'  ->  'admin','owner'
-- and restore fn_role_rank / fn_audit_actor_role from the bodies quoted at the
-- bottom of this file.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The canonical question, so the next role is one edit rather than twenty-four
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_club_is_staff(
  p_club_id uuid,
  p_user_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.clubs c
     WHERE c.id = p_club_id
       AND c.owner_id = COALESCE(p_user_id, auth.uid())
  ) OR EXISTS (
    SELECT 1 FROM public.club_members cm
     WHERE cm.club_id = p_club_id
       AND cm.user_id = COALESCE(p_user_id, auth.uid())
       AND cm.role IN ('owner', 'co_owner', 'admin')
       AND COALESCE(cm.status, 'active') IN ('active', 'approved')
  );
$$;

COMMENT ON FUNCTION public.fn_club_is_staff(uuid, uuid) IS
  'Owner, co-owner or admin of this club. The mirror of isClubStaff() in '
  'src/types/clubRoles.ts. Ask this instead of spelling out a role list: '
  'co_owner was missed by twenty-four hand-rolled lists precisely because they '
  'were hand-rolled.';

GRANT EXECUTE ON FUNCTION public.fn_club_is_staff(uuid, uuid) TO authenticated, anon, service_role;

-- -----------------------------------------------------------------------------
-- 2. Teach every existing club-role staff gate the word co_owner
-- -----------------------------------------------------------------------------
DO $mig$
DECLARE
  r         record;
  v_new     text;
  v_patched int := 0;
  v_missing text[];
  v_targets text[] := ARRAY[
    'atomic_table_buyin',
    'ca_can_view_club_finances',
    'ca_club_my_downline',
    'fn_actor_can_manage_club_treasury',
    'fn_apply_credit_payment',
    'fn_can_create_games',
    'fn_can_message_in_club',
    'fn_club_money_panel',
    'fn_generate_all_credit_invoices',
    'fn_generate_credit_invoice',
    'fn_is_any_union_overseer',
    'fn_is_club_admin_uid',
    'fn_is_union_overseer',
    'fn_launch_table_from_template',
    'fn_list_my_post_targets',
    'fn_register_for_tournament',
    'fn_sync_mfa_required_on_club_role',
    'fn_union_issue_weekly_invoices',
    'fn_union_law_extra_breaches',
    'fn_union_reconciliation_report',
    'fn_union_send_club_message',
    'is_club_admin',
    'recompute_club_levels'
  ];
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_functiondef(p.oid) AS def
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_language  l ON l.oid = p.prolang
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND l.lanname IN ('plpgsql', 'sql')
       AND p.proname = ANY (v_targets)
  LOOP
    -- Idempotent: a second run of this migration finds nothing left to do.
    CONTINUE WHEN r.def ~ '''co_owner''';

    v_new := regexp_replace(
      r.def,
      '''owner''(\s*,\s*)''admin''',
      '''owner''\1''co_owner''\1''admin''',
      'g');

    IF v_new = r.def THEN
      RAISE EXCEPTION
        'public.% was listed for the co_owner patch but contains no owner/admin role list',
        r.proname;
    END IF;

    EXECUTE v_new;
    v_patched := v_patched + 1;
  END LOOP;

  -- Assert the outcome rather than the attempt: every target must now know the word.
  SELECT array_agg(DISTINCT p.proname ORDER BY p.proname) INTO v_missing
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = ANY (v_targets)
     AND pg_get_functiondef(p.oid) !~ '''co_owner''';

  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'these functions still do not recognise co_owner: %', v_missing;
  END IF;

  RAISE NOTICE 'co_owner staff patch: % function(s) rewritten', v_patched;
END
$mig$;

-- -----------------------------------------------------------------------------
-- 3. The same for the club-scoped row level security policies
-- -----------------------------------------------------------------------------
DO $mig$
DECLARE
  r        record;
  v_qual   text;
  v_check  text;
  v_sql    text;
  v_done   int := 0;
  v_left   text[];
  v_tbl    text;
  v_pol    text;
  i        int;
  -- table, policy. Every one of these reads club_members.role and already
  -- admits owner and admin.
  v_targets text[] := ARRAY[
    'anti_cheat_events',     'anti_cheat_events_select_staff',
    'bbj_daily_user',        'read_own_bbj_daily_user',
    'blacklists',            'blacklists_delete',
    'blacklists',            'blacklists_insert',
    'blacklists',            'blacklists_select',
    'club_announcements',    'Owners can manage announcements',
    'club_arena_audit_logs', 'allow_read_audit',
    'club_shop_purchases',   'club_shop_purchases_select',
    'hand_histories',        'Club admins can view club hands',
    'promo_distributions',   'promo_dist_read',
    'rake_rate_audit',       'rake_rate_audit_club_admin_read',
    'rake_records',          'rake_records_read',
    'settlement_periods',    'settlement_read',
    'table_chat_mutes',      'mutes_admin_manage',
    'table_sessions',        'table_sessions_select_own_or_staff',
    'table_templates',       'templates_admin_access',
    'table_waitlist',        'waitlist_admin_read',
    'union_rakeback_log',    'union_rakeback_log_union_select'
  ];
BEGIN
  i := 1;
  WHILE i < array_length(v_targets, 1) LOOP
    v_tbl := v_targets[i];
    v_pol := v_targets[i + 1];

    SELECT * INTO r
      FROM pg_policies
     WHERE schemaname = 'public' AND tablename = v_tbl AND policyname = v_pol;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'policy %.% not found', v_tbl, v_pol;
    END IF;

    IF COALESCE(r.qual, '') || COALESCE(r.with_check, '') !~ '''co_owner''' THEN
      v_qual  := r.qual;
      v_check := r.with_check;

      -- Both orders occur: ARRAY['owner','admin'] and ARRAY['admin','owner'].
      v_qual := regexp_replace(v_qual,
        '''owner''::text(\s*,\s*)''admin''::text',
        '''owner''::text\1''co_owner''::text\1''admin''::text', 'g');
      v_qual := regexp_replace(v_qual,
        '''admin''::text(\s*,\s*)''owner''::text',
        '''admin''::text\1''co_owner''::text\1''owner''::text', 'g');
      v_check := regexp_replace(v_check,
        '''owner''::text(\s*,\s*)''admin''::text',
        '''owner''::text\1''co_owner''::text\1''admin''::text', 'g');
      v_check := regexp_replace(v_check,
        '''admin''::text(\s*,\s*)''owner''::text',
        '''admin''::text\1''co_owner''::text\1''owner''::text', 'g');

      IF COALESCE(v_qual, '') || COALESCE(v_check, '') !~ '''co_owner''' THEN
        RAISE EXCEPTION 'policy %.% has no owner/admin role list to patch', v_tbl, v_pol;
      END IF;

      EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);

      v_sql := format('CREATE POLICY %I ON public.%I AS %s FOR %s TO %s',
                      r.policyname, r.tablename,
                      CASE WHEN r.permissive = 'PERMISSIVE' THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                      r.cmd,
                      (SELECT string_agg(quote_ident(x), ', ') FROM unnest(r.roles) AS x));
      IF v_qual IS NOT NULL THEN
        v_sql := v_sql || format(' USING (%s)', v_qual);
      END IF;
      IF v_check IS NOT NULL THEN
        v_sql := v_sql || format(' WITH CHECK (%s)', v_check);
      END IF;

      EXECUTE v_sql;
      v_done := v_done + 1;
    END IF;

    i := i + 2;
  END LOOP;

  -- Assert the outcome: no listed policy may still be blind to co_owner.
  v_left := ARRAY[]::text[];
  i := 1;
  WHILE i < array_length(v_targets, 1) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies p
       WHERE p.schemaname = 'public'
         AND p.tablename  = v_targets[i]
         AND p.policyname = v_targets[i + 1]
         AND COALESCE(p.qual, '') || COALESCE(p.with_check, '') ~ '''co_owner''')
    THEN
      v_left := v_left || (v_targets[i] || '.' || v_targets[i + 1]);
    END IF;
    i := i + 2;
  END LOOP;

  IF array_length(v_left, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'these policies still do not admit co_owner: %', v_left;
  END IF;

  RAISE NOTICE 'co_owner staff patch: % policy/policies rewritten', v_done;
END
$mig$;

-- -----------------------------------------------------------------------------
-- 4. The ladder, and the audit label
-- -----------------------------------------------------------------------------
-- fn_role_rank knew six roles and scored the seventh at 0, which put a co-owner
-- BELOW a player (1) in every fn_has_club_role comparison. The other five keep
-- the numbers they had; only owner moves up to make room.
CREATE OR REPLACE FUNCTION public.fn_role_rank(p_role text)
RETURNS integer
LANGUAGE sql IMMUTABLE
SET search_path TO 'public', 'extensions'
AS $$
  SELECT CASE p_role
           WHEN 'owner'       THEN 7
           WHEN 'co_owner'    THEN 6
           WHEN 'admin'       THEN 5
           WHEN 'super_agent' THEN 4
           WHEN 'agent'       THEN 3
           WHEN 'sub_agent'   THEN 2
           WHEN 'player'      THEN 1
           ELSE 0
         END;
$$;

-- fn_audit_actor_role wrote 'co_owner' into audit_trail whenever the actor was
-- an ADMIN - a stand-in from before co_owner existed. Now that it does, that
-- label names the wrong person in the one record kept to say who acted.
CREATE OR REPLACE FUNCTION public.fn_audit_actor_role(p_club_id uuid, p_actor uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM public.clubs c
                 WHERE c.id = p_club_id AND c.owner_id = p_actor) THEN 'owner'
    ELSE COALESCE(
      (SELECT CASE cm.role
                WHEN 'owner'       THEN 'owner'
                WHEN 'co_owner'    THEN 'co_owner'
                WHEN 'admin'       THEN 'admin'
                WHEN 'super_agent' THEN 'super_agent'
                WHEN 'agent'       THEN 'agent'
                WHEN 'sub_agent'   THEN 'sub_agent'
                WHEN 'player'      THEN 'player'
                ELSE 'system'
              END
         FROM public.club_members cm
        WHERE cm.club_id = p_club_id AND cm.user_id = p_actor
        LIMIT 1),
      'system')
  END;
$$;

-- -----------------------------------------------------------------------------
-- 5. Proof, in the migration rather than in a report
-- -----------------------------------------------------------------------------
DO $verify$
BEGIN
  IF public.fn_role_rank('co_owner') <= public.fn_role_rank('player')
     OR public.fn_role_rank('co_owner') <= public.fn_role_rank('admin')
     OR public.fn_role_rank('co_owner') >= public.fn_role_rank('owner') THEN
    RAISE EXCEPTION 'fn_role_rank does not place co_owner between admin and owner';
  END IF;

  IF to_regprocedure('public.fn_club_is_staff(uuid, uuid)') IS NULL THEN
    RAISE EXCEPTION 'fn_club_is_staff was not created';
  END IF;
END
$verify$;

COMMIT;

-- =============================================================================
-- PRE-PATCH BODIES, for the rollback described at the top.
--
-- fn_role_rank:        owner 6, admin 5, super_agent 4, agent 3, sub_agent 2,
--                      player 1, ELSE 0   (no co_owner arm at all)
--
-- fn_audit_actor_role: CASE cm.role WHEN 'owner' THEN 'owner'
--                                   WHEN 'admin' THEN 'co_owner'
--                                   WHEN 'agent' THEN 'agent'
--                                   ELSE 'system' END
-- =============================================================================
