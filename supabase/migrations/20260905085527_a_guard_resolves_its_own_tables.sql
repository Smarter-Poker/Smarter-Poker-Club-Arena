-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260905085527 "a_guard_resolves_its_own_tables"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 15953c6b4cab8977edaab9d8453a8217 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A GUARD RESOLVES ITS OWN TABLES (2026-09-05)
--
-- 23 routines in `public` carried no fixed `search_path`, so the schema every
-- unqualified name in them resolves to comes from the CALLER's session. The
-- Supabase advisor reports this as function_search_path_mutable.
--
-- It matters more here than the generic advice suggests, because of WHICH
-- routines they are. Nine are live triggers, and they are the guards on the
-- money and rake paths:
--
--   fn_ca_block_browser_money_table        4 triggers
--   fn_guard_rake_belongs_to_club          1
--   fn_ca_settlement_transition_guard      1
--   fn_tournaments_creation_guard          1
--   fn_tournaments_refuse_unbuilt_multi_day 1
--   fn_ca_incident_events_append_only      1
--   fn_clubs_lobby_message_keeps_its_own_books 1
--   fn_a_benched_horse_stays_benched       1
--
-- A guard whose table references resolve through the caller's search_path is a
-- guard that can, in principle, be pointed at a different table than the one
-- it was written to protect.
--
-- SAFE TO PIN, checked rather than assumed: none of the 23 references another
-- schema (auth, storage, vault, cron) and none calls an extension function
-- (gen_random_uuid, digest, crypt, uuid_generate) that would live outside
-- `public`. So `public, pg_temp` is sufficient and nothing needs `extensions`.
--
-- This is a SETTING change. No body is rewritten, so no behaviour moves.
-- pg_temp is last, which is the documented ordering: it must never shadow a
-- real table with a temporary one of the same name.

DO $pin$
DECLARE
  r record;
  v_count integer := 0;
BEGIN
  FOR r IN
    SELECT p.oid,
           p.prokind,
           quote_ident(n.nspname) || '.' || quote_ident(p.proname)
             || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
     WHERE pg_get_userbyid(p.proowner) = current_user
       AND p.proname IN (
         'fn_clubs_lobby_message_keeps_its_own_books','fn_club_home_in_scope',
         'fn_ca_incident_events_append_only','fn_ca_incident_recipient_ids',
         'fn_ca_current_epoch','fn_rake_schedule_drift','fn_tournaments_creation_guard',
         'fn_ca_settlement_transition_guard','fn_a_benched_horse_stays_benched',
         'fn_ca_block_browser_money_table','fn_ca_diamond_engine_of','fn_effective_rake_cap',
         'fn_arena_name','fn_ca_union_wallet_ledger_shape','fn_ca_reconcile_owned_entity_types',
         'fn_like_escape','fn_skip_noop_update','fn_guard_rake_belongs_to_club',
         'fn_rake_club_isolation_violations','fn_seat_first_boards_ready',
         'fn_tournaments_refuse_unbuilt_multi_day','sp_ca_reconcile_backpaid_events',
         'fn_is_free_buy_event')
       -- Only the ones that are actually unpinned.
       AND NOT EXISTS (
         SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c
          WHERE c LIKE 'search\_path=%'
       )
  LOOP
    IF r.prokind = 'p' THEN
      EXECUTE format('ALTER PROCEDURE %s SET search_path = public, pg_temp', r.sig);
    ELSE
      EXECUTE format('ALTER FUNCTION %s SET search_path = public, pg_temp', r.sig);
    END IF;
    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE 'pinned search_path on % routines', v_count;
END
$pin$;

DO $verify$
DECLARE
  v_left     integer;
  v_triggers integer;
BEGIN
  SELECT count(*) INTO v_left
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE pg_get_userbyid(p.proowner) = current_user
     AND p.proname IN (
       'fn_clubs_lobby_message_keeps_its_own_books','fn_club_home_in_scope',
       'fn_ca_incident_events_append_only','fn_ca_incident_recipient_ids',
       'fn_ca_current_epoch','fn_rake_schedule_drift','fn_tournaments_creation_guard',
       'fn_ca_settlement_transition_guard','fn_a_benched_horse_stays_benched',
       'fn_ca_block_browser_money_table','fn_ca_diamond_engine_of','fn_effective_rake_cap',
       'fn_arena_name','fn_ca_union_wallet_ledger_shape','fn_ca_reconcile_owned_entity_types',
       'fn_like_escape','fn_skip_noop_update','fn_guard_rake_belongs_to_club',
       'fn_rake_club_isolation_violations','fn_seat_first_boards_ready',
       'fn_tournaments_refuse_unbuilt_multi_day','sp_ca_reconcile_backpaid_events',
       'fn_is_free_buy_event')
     AND NOT EXISTS (
       SELECT 1 FROM unnest(COALESCE(p.proconfig, '{}')) c WHERE c LIKE 'search\_path=%'
     );

  IF v_left <> 0 THEN
    RAISE EXCEPTION '% of the listed routines are still unpinned', v_left;
  END IF;

  -- The guards must still be attached to their tables.
  SELECT count(*) INTO v_triggers FROM pg_trigger WHERE NOT tgisinternal;
  IF v_triggers = 0 THEN
    RAISE EXCEPTION 'no user triggers remain - something went very wrong';
  END IF;

  RAISE NOTICE 'clean: all listed routines pinned, % user triggers intact', v_triggers;
END
$verify$;
