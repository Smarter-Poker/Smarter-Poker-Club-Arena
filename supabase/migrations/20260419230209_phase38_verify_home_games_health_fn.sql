-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419230209 "phase38_verify_home_games_health_fn"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 e9c7f3936141253330d67939654ec0f5 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- ============================================================================
-- PHASE 38: Reusable health check — SELECT * FROM verify_home_games_health()
-- ============================================================================
-- Returns every invariant we enforced in Phases 32–38 as a passing/failing
-- row so regressions show up immediately. Safe to run any time: read-only,
-- no side effects, returns fast.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.verify_home_games_health()
  RETURNS TABLE(category text, check_name text, status text, detail text)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
BEGIN
    RETURN QUERY

    -- ── REGULATORY POSTURE (Phase 36 + 37) ────────────────────────────
    SELECT 'regulatory'::text, 'diamond_transactions CHECK no_home_games_source'::text,
           CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c
                  JOIN pg_class cl ON cl.oid=c.conrelid
                  WHERE cl.relname='diamond_transactions'
                    AND c.conname='no_home_games_source')
                THEN '✓' ELSE '✗ MISSING' END,
           'CHECK (source <> ''home_games'')'
    UNION ALL
    SELECT 'regulatory', 'zero diamond_transactions with source=home_games',
           CASE WHEN (SELECT COUNT(*) FROM diamond_transactions 
                       WHERE source='home_games')=0 THEN '✓' ELSE '✗' END,
           (SELECT COUNT(*)::text FROM diamond_transactions 
             WHERE source='home_games') || ' rows'
    UNION ALL
    SELECT 'regulatory', 'zero triggers on home tables minting value',
           CASE WHEN (SELECT COUNT(*) FROM pg_trigger t 
                       JOIN pg_class c ON c.oid=t.tgrelid
                       JOIN pg_proc p ON p.oid=t.tgfoid
                      WHERE NOT t.tgisinternal 
                        AND c.relname LIKE 'commander_home_%'
                        AND pg_get_functiondef(p.oid) ~* 
                            '(award_diamonds|add_diamonds|credit_diamonds|diamond_ledger|diamond_transactions)'
                      )=0 THEN '✓' ELSE '✗' END,
           'trigger handlers scanned for value-minting refs'
    UNION ALL
    SELECT 'regulatory', 'zero dropped reward fns still exist',
           CASE WHEN (SELECT COUNT(*) FROM pg_proc p
                       JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.prokind='f'
                        AND p.proname IN ('fn_grant_host_diamonds_on_complete',
                                          'fn_award_badges_on_game_complete',
                                          'award_home_games_badges',
                                          '_award_home_badge_if_new',
                                          'get_home_games_diamond_history',
                                          'get_home_games_leaderboards',
                                          'get_user_home_games_badges'))=0 
                THEN '✓' ELSE '✗' END,
           'Phase 36 dropped fns must stay gone'

    -- ── PRIVACY (Phase 37) ────────────────────────────────────────────
    UNION ALL
    SELECT 'privacy', 'host_private_note not readable by authenticated',
           CASE WHEN NOT has_column_privilege('authenticated',
                  'public.commander_home_members', 'host_private_note', 'SELECT')
                THEN '✓' ELSE '✗' END,
           'column-level grant gates access via SECURITY DEFINER fns only'
    UNION ALL
    SELECT 'privacy', 'host_private_note not readable by anon',
           CASE WHEN NOT has_column_privilege('anon',
                  'public.commander_home_members', 'host_private_note', 'SELECT')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'privacy', 'fn_home_list_seats has auth guard',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_home_list_seats'
                    AND pg_get_functiondef(p.oid) ILIKE '%NOT_A_GROUP_MEMBER%')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'privacy', 'fn_home_list_seats not anon-callable',
           CASE WHEN NOT has_function_privilege('anon',
                  'public.fn_home_list_seats(uuid)', 'EXECUTE')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'privacy', 'home_members_host_sees_group policy non-recursive',
           CASE WHEN EXISTS (SELECT 1 FROM pg_policy pol
                  JOIN pg_class cl ON cl.oid=pol.polrelid
                  WHERE cl.relname='commander_home_members'
                    AND pol.polname='home_members_host_sees_group'
                    AND pg_get_expr(pol.polqual, pol.polrelid) 
                        ILIKE '%fn_home_is_approved_member%')
                THEN '✓' ELSE '✗' END,
           'policy uses SECURITY DEFINER helper to avoid self-recursion'

    -- ── AUTH SURFACE (Phase 32–34) ────────────────────────────────────
    UNION ALL
    SELECT 'auth', '7 fn_home_* seat RPCs have defense-in-depth guard',
           (SELECT COUNT(*)::text || ' / 7' FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname IN ('fn_home_assign_seat','fn_home_init_seats',
                                 'fn_home_move_seat','fn_home_randomize_seats',
                                 'fn_home_set_seat_status','fn_home_vacate_seat',
                                 'revive_home_group')
               AND pg_get_functiondef(p.oid) ILIKE '%auth.role() <> ''service_role''%'
               AND pg_get_functiondef(p.oid) ILIKE '%auth.uid() IS DISTINCT FROM%'),
           CASE WHEN (SELECT COUNT(*) FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname IN ('fn_home_assign_seat','fn_home_init_seats',
                                 'fn_home_move_seat','fn_home_randomize_seats',
                                 'fn_home_set_seat_status','fn_home_vacate_seat',
                                 'revive_home_group')
               AND pg_get_functiondef(p.oid) ILIKE '%auth.role() <> ''service_role''%'
               AND pg_get_functiondef(p.oid) ILIKE '%auth.uid() IS DISTINCT FROM%')=7
               THEN '' ELSE 'expected 7' END
    UNION ALL
    SELECT 'auth', 'atomic_chip_transfer has all 5 guards',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='atomic_chip_transfer'
                    AND pg_get_functiondef(p.oid) ILIKE '%SELF_TRANSFER_FORBIDDEN%'
                    AND pg_get_functiondef(p.oid) ILIKE '%UNAUTHORIZED%'
                    AND pg_get_functiondef(p.oid) ILIKE '%INVALID_AMOUNT%'
                    AND pg_get_functiondef(p.oid) ILIKE '%AMOUNT_EXCEEDS_LIMIT%')
                THEN '✓' ELSE '✗' END, ''

    -- ── INFRASTRUCTURE ────────────────────────────────────────────────
    UNION ALL
    SELECT 'infra', 'all home game tables have RLS enabled',
           (SELECT COUNT(*) FILTER (WHERE c.relrowsecurity)::text 
                   || ' / ' || COUNT(*)::text
              FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relkind='r' 
               AND c.relname LIKE 'commander_home_%'),
           ''
    UNION ALL
    SELECT 'infra', 'all home game tables have at least one RLS policy',
           CASE WHEN (SELECT COUNT(*) FROM pg_class c 
                       JOIN pg_namespace n ON n.oid=c.relnamespace
                      WHERE n.nspname='public' AND c.relkind='r' 
                        AND c.relname LIKE 'commander_home_%'
                        AND c.relrowsecurity
                        AND NOT EXISTS (SELECT 1 FROM pg_policy 
                                         WHERE polrelid = c.oid)
                        -- Exclude rate-limit log tables (intentionally service_role-only)
                        AND c.relname NOT IN ('commander_home_group_view_log',
                                              'commander_home_group_share_log'))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'infra', 'composite index idx_commander_home_games_group_scheduled exists',
           CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                  WHERE tablename='commander_home_games'
                    AND indexname='idx_commander_home_games_group_scheduled')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'infra', 'all home game triggers enabled',
           (SELECT COUNT(*) FILTER (WHERE t.tgenabled='O')::text 
                   || ' / ' || COUNT(*)::text || ' enabled'
              FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
             WHERE NOT t.tgisinternal AND c.relname LIKE 'commander_home_%'),
           ''
    UNION ALL
    SELECT 'infra', 'home cron jobs scheduled',
           (SELECT COUNT(*)::text FROM cron.job WHERE jobname LIKE 'home-%'),
           'includes reminders, auto-complete, trending, stale sweep, recurring gen, quality, vitality, nudge, recap, snapshots, view-log prune'

    -- ── DATA INTEGRITY ─────────────────────────────────────────────────
    UNION ALL
    SELECT 'integrity', 'zero orphan RSVPs',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_rsvps r
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_games g 
                                          WHERE g.id = r.game_id))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero orphan seats',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_seats s
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_games g 
                                          WHERE g.id = s.game_id))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero orphan posts',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_posts p
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_groups g 
                                          WHERE g.id = p.group_id))=0
                THEN '✓' ELSE '✗' END, ''

    -- ── RATE LIMITERS (Phase 37) ───────────────────────────────────────
    UNION ALL
    SELECT 'rate_limit', 'track_home_group_view has dedupe logic',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='track_home_group_view'
                    AND pg_get_functiondef(p.oid) ILIKE 
                        '%commander_home_group_view_log%'
                    AND pg_get_functiondef(p.oid) ILIKE '%INTERVAL ''1 hour''%')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'rate_limit', 'track_home_group_share_click has dedupe logic',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='track_home_group_share_click'
                    AND pg_get_functiondef(p.oid) ILIKE 
                        '%commander_home_group_share_log%')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'rate_limit', 'home-view-log-prune cron scheduled',
           CASE WHEN EXISTS (SELECT 1 FROM cron.job 
                              WHERE jobname='home-view-log-prune')
                THEN '✓' ELSE '✗' END, ''
    ;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.verify_home_games_health() TO service_role;

COMMENT ON FUNCTION public.verify_home_games_health() IS
    'Home games health check. Returns one row per invariant enforced in '
    'Phases 32–38. Safe to run any time (read-only). Call from CI, nightly '
    'monitoring, or before/after deploys. Any non-✓ status indicates a '
    'regression that needs investigation.';
