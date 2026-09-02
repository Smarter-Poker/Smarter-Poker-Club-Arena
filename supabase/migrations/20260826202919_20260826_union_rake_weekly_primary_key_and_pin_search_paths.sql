-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826202919; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- TIER 2. One primary key on a 17-row table, plus search_path pinned on ten
-- functions. No function body is changed.
--
-- PART A -- union_rake_weekly had no primary key.
-- Verified safe before adding: 17 rows, 17 distinct (union_id, club_id,
-- week_start), 0 NULLs in any key column. The other three no_primary_key
-- findings are all backup tables and are deliberately left alone.
--
-- PART B -- ten functions ran with a mutable search_path.
-- Worth stating plainly: NONE of these ten is SECURITY DEFINER (checked
-- prosecdef for every one). A mutable search_path on a SECURITY INVOKER
-- function is a correctness and lint issue, not the privilege-escalation
-- vector it would be on a definer function -- so this is lower severity than
-- the advisor's WARN suggests.
--
-- Pinning to 'public' alone is safe here because none of the ten references an
-- extension-schema object (checked each body for gen_random_uuid, pgcrypto,
-- unaccent, similarity, citext and friends -- all clean). Functions elsewhere in
-- this database that DO need them are pinned to 'public, extensions'; do not
-- copy the bare 'public' below onto one of those.
--
-- ROLLBACK:
--   ALTER TABLE public.union_rake_weekly DROP CONSTRAINT union_rake_weekly_pkey;
--   ALTER FUNCTION <each signature below> RESET search_path;

-- ---------- PART A ----------
ALTER TABLE public.union_rake_weekly
  ADD CONSTRAINT union_rake_weekly_pkey PRIMARY KEY (union_id, club_id, week_start);

-- ---------- PART B ----------
ALTER FUNCTION public.fn_club_home_in_scope(uuid,boolean,uuid,uuid,uuid,uuid[])            SET search_path = 'public';
ALTER FUNCTION public.fn_finalize_settlement_period(uuid,text,integer,integer,numeric,numeric,jsonb,text) SET search_path = 'public';
ALTER FUNCTION public.fn_notification_action_url(text,jsonb,jsonb)                          SET search_path = 'public';
ALTER FUNCTION public.fn_notification_fill_action_url()                                     SET search_path = 'public';
ALTER FUNCTION public.fn_run_pending_rakeback_settlement()                                  SET search_path = 'public';
ALTER FUNCTION public.fn_spin_required_seed(numeric)                                        SET search_path = 'public';
ALTER FUNCTION public.fn_spin_seed_instalment(numeric,numeric,numeric)                      SET search_path = 'public';
ALTER FUNCTION public.fn_url_encode_segment(text)                                           SET search_path = 'public';
ALTER FUNCTION public.sp_normalize_cosmetic_token(text)                                     SET search_path = 'public';
ALTER FUNCTION public.trg_hand_history_club_member_stats()                                  SET search_path = 'public';

DO $$
DECLARE v_pk int; v_unpinned int;
BEGIN
  SELECT count(*) INTO v_pk FROM pg_constraint
   WHERE conrelid = 'public.union_rake_weekly'::regclass AND contype = 'p';
  IF v_pk <> 1 THEN
    RAISE EXCEPTION 'assertion failed: union_rake_weekly has % primary key(s)', v_pk;
  END IF;

  SELECT count(*) INTO v_unpinned
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname IN ('fn_run_pending_rakeback_settlement','fn_spin_seed_instalment',
                       'trg_hand_history_club_member_stats','fn_club_home_in_scope',
                       'fn_finalize_settlement_period','fn_spin_required_seed',
                       'fn_url_encode_segment','sp_normalize_cosmetic_token',
                       'fn_notification_fill_action_url','fn_notification_action_url')
     AND (p.proconfig IS NULL
          OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%'));
  IF v_unpinned <> 0 THEN
    RAISE EXCEPTION 'assertion failed: % of the ten functions still has a mutable search_path', v_unpinned;
  END IF;

  RAISE NOTICE 'union_rake_weekly has a primary key; all ten search_paths pinned';
END $$;
