-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260821175623 "restore_verify_home_games_health_and_fix_two_spelling_checks"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 280709f639ee5faea1b79a6fd94f6936 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- RESTORE verify_home_games_health, AND FIX THE TWO CHECKS THAT TESTED SPELLING.
--
-- MY MISTAKE, RECORDED PLAINLY. The previous migration
-- ('health_check_stops_testing_spelling') was written as if a CREATE OR
-- REPLACE could be staged and then amended in the same file. It cannot: the
-- first statement replaced the whole 305-line function with a stub returning
-- no rows, and the "surgical edit" that was supposed to follow was a comment.
-- The function was gutted for roughly two minutes. It is restored below from
-- supabase/migrations/ZZZZ_snapshot_home_games_schema.sql, which carries the
-- full shipped body, with only the two predicates below changed - every other
-- check is byte-identical to what was there before.
--
-- WHY THE TWO CHECKS WERE WRONG. Both reported a permanent failure, and that
-- matters more than the individual checks: a report that always shows red
-- marks is a report nobody reads, which is exactly how "zero XP columns" sat
-- at ✗ for months.
--
-- FALSE ALARM 1: "7 fn_home_* seat RPCs have defense-in-depth guard", 0 / 7.
--   The check demanded the literal   auth.role() <> 'service_role'
--   All seven functions say          auth.role() IS DISTINCT FROM 'service_role'
--
--   The guard is present in every one, and the form they use is the BETTER of
--   the two: `<>` yields NULL when auth.role() is NULL, so the enclosing AND
--   collapses to NULL and the guard silently does not fire. IS DISTINCT FROM
--   is null-safe. The check was failing the correct implementation and would
--   have passed the subtly broken one. It now accepts either spelling.
--
-- FALSE ALARM 2: "home_members_host_sees_group policy non-recursive", ✗.
--   The check looked for one helper BY NAME, fn_home_is_approved_member, and
--   the policy calls fn_home_is_group_staff. Both exist and both are SECURITY
--   DEFINER, which is the property that actually prevents the recursion: RLS
--   is not re-applied inside a function owned by the table's owner. Verified
--   empirically first - selecting from commander_home_members as a signed-in
--   user returns rows rather than raising "infinite recursion detected in
--   policy". The check now resolves whichever helper the policy calls and
--   asserts that it is SECURITY DEFINER, so renaming a helper no longer turns
--   the report red.
--
-- Applied to production via Supabase MCP as
-- 'restore_verify_home_games_health_and_fix_two_spelling_checks'.

CREATE OR REPLACE FUNCTION public.verify_home_games_health()
 RETURNS TABLE(category text, check_name text, status text, detail text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
    RETURN QUERY

    SELECT 'regulatory'::text, 'diamond_transactions CHECK no_home_games_source'::text,
           CASE WHEN EXISTS (SELECT 1 FROM pg_constraint c
                  JOIN pg_class cl ON cl.oid=c.conrelid
                  WHERE cl.relname='diamond_transactions' AND c.conname='no_home_games_source')
                THEN '✓' ELSE '✗ MISSING' END,
           'CHECK (source <> ''home_games'')'
    UNION ALL
    SELECT 'regulatory', 'zero diamond_transactions with source=home_games',
           CASE WHEN (SELECT COUNT(*) FROM diamond_transactions dt
                       WHERE dt.source='home_games')=0 THEN '✓' ELSE '✗' END,
           (SELECT COUNT(*)::text FROM diamond_transactions dt
             WHERE dt.source='home_games') || ' rows'
    UNION ALL
    SELECT 'regulatory', 'zero triggers on home tables minting value',
           CASE WHEN (SELECT COUNT(*) FROM pg_trigger t
                       JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_proc p ON p.oid=t.tgfoid
                      WHERE NOT t.tgisinternal AND c.relname LIKE 'commander_home_%'
                        AND pg_get_functiondef(p.oid) ~*
                            '(award_diamonds|add_diamonds|credit_diamonds|diamond_ledger|diamond_transactions)')=0
                THEN '✓' ELSE '✗' END,
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
                THEN '✓' ELSE '✗' END, 'Phase 36 dropped fns must stay gone'
    UNION ALL
    SELECT 'regulatory', 'XP absolute purge + DDL guard active',
           CASE WHEN EXISTS (SELECT 1 FROM pg_event_trigger
                              WHERE evtname='xp_ban_guard' AND evtenabled='O')
                AND (SELECT COUNT(*) FROM information_schema.columns
                      WHERE table_schema='public'
                        AND column_name ~* '(^xp$|_xp$|^xp_|^reputation_xp$|^total_xp$|^xp_total$|^xp_earned$|^xp_reward$|^bonus_xp_)')=0
                THEN '✓' ELSE '✗' END,
           'zero XP columns + event trigger enforcing permanent ban'

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
                    -- Any SECURITY DEFINER helper breaks the recursion: RLS is
                    -- not re-applied inside a function owned by the table's
                    -- owner. Resolve whichever one the policy actually calls
                    -- rather than pinning a single name.
                    AND EXISTS (
                      SELECT 1 FROM pg_proc hp
                        JOIN pg_namespace hn ON hn.oid = hp.pronamespace
                       WHERE hn.nspname = 'public'
                         AND hp.prosecdef
                         AND pg_get_expr(pol.polqual, pol.polrelid)
                             ILIKE '%' || hp.proname || '%'))
                THEN '✓' ELSE '✗' END,
           'policy uses SECURITY DEFINER helper to avoid self-recursion'
    UNION ALL
    SELECT 'privacy', 'GDPR content scrubber available for HG',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='fn_anonymize_hg_user_content')
                THEN '✓' ELSE '✗' END,
           'fn_anonymize_hg_user_content(user_id, requested_by) scrubs HG content bodies'

    UNION ALL
    SELECT 'compliance', 'onboarding gate trigger registered on HG write tables',
           (SELECT COUNT(*)::text FROM pg_trigger tg
              JOIN pg_proc p ON p.oid=tg.tgfoid
             WHERE p.proname='fn_hg_require_onboarded_on_write'
               AND NOT tg.tgisinternal)
              || ' tables gated',
           'BEFORE INSERT gates writes to HG tables when caller not onboarded'
    UNION ALL
    SELECT 'compliance', 'resource quota trigger registered on HG write tables',
           (SELECT COUNT(*)::text FROM pg_trigger tg
              JOIN pg_proc p ON p.oid=tg.tgfoid
             WHERE p.proname='fn_hg_enforce_quotas_on_write'
               AND NOT tg.tgisinternal)
              || ' tables gated',
           'groups (20/user), invite tokens (50/group), scheduled games (100/group)'
    UNION ALL
    SELECT 'compliance', 'platform policies seeded',
           CASE WHEN (SELECT COUNT(*) FROM platform_policies pp
                       WHERE pp.key IN ('home_games.tos.version',
                                     'home_games.privacy.version',
                                     'home_games.house_rules.version',
                                     'home_games.content_policy.version',
                                     'home_games.data_retention.version'))=5
                THEN '✓' ELSE '✗' END, '5 required platform_policies keys'
    UNION ALL
    SELECT 'compliance', 'length caps present on 10 user-facing text RPCs',
           (SELECT COUNT(*)::text FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname IN ('fn_home_create_post','fn_home_add_comment',
                 'fn_home_create_group','fn_home_update_group','create_home_group',
                 'fn_home_create_poll','fn_home_rsvp','fn_home_set_seat_status',
                 'fn_home_invite_member','fn_home_report_content')
               AND pg_get_functiondef(p.oid) ~*
                   '(CONTENT_TOO_LONG|MESSAGE_TOO_LONG|TOO_MANY_OPTIONS|NAME_TOO_LONG|NOTE_TOO_LONG|REASON_TOO_LONG)')
              || ' / 10',
           'CONTENT_TOO_LONG / MESSAGE_TOO_LONG / TOO_MANY_OPTIONS / etc.'
    UNION ALL
    SELECT 'compliance', 'notification preference columns complete',
           CASE WHEN (SELECT COUNT(*) FROM information_schema.columns
                       WHERE table_schema='public' AND table_name='user_notification_preferences'
                         AND column_name IN ('home_game_post_likes','home_game_post_comments',
                           'home_game_rsvp_confirmations','home_game_reminders',
                           'home_game_announcements','home_game_new_game_posted',
                           'home_game_cancellations','home_game_host_requests',
                           'home_game_review_prompts')) = 9
                THEN '✓' ELSE '✗' END,
           '9 HG-specific notification mute toggles'

    UNION ALL
    SELECT 'auth', '7 fn_home_* seat RPCs have defense-in-depth guard',
           (SELECT COUNT(*)::text || ' / 7' FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname IN ('fn_home_assign_seat','fn_home_init_seats',
                                 'fn_home_move_seat','fn_home_randomize_seats',
                                 'fn_home_set_seat_status','fn_home_vacate_seat',
                                 'revive_home_group')
               -- IS DISTINCT FROM is the null-safe form and is what all seven
               -- use; `<>` yields NULL for a NULL auth.role() and silently
               -- disables the guard. Accept either, prefer neither.
               AND (pg_get_functiondef(p.oid) ILIKE '%auth.role() <> ''service_role''%'
                 OR pg_get_functiondef(p.oid) ILIKE '%auth.role() IS DISTINCT FROM ''service_role''%')
               AND pg_get_functiondef(p.oid) ILIKE '%auth.uid() IS DISTINCT FROM%'),
           CASE WHEN (SELECT COUNT(*) FROM pg_proc p
                        JOIN pg_namespace n ON n.oid=p.pronamespace
                       WHERE n.nspname='public'
                         AND p.proname IN ('fn_home_assign_seat','fn_home_init_seats',
                                           'fn_home_move_seat','fn_home_randomize_seats',
                                           'fn_home_set_seat_status','fn_home_vacate_seat',
                                           'revive_home_group')
                         AND (pg_get_functiondef(p.oid) ILIKE '%auth.role() <> ''service_role''%'
                           OR pg_get_functiondef(p.oid) ILIKE '%auth.role() IS DISTINCT FROM ''service_role''%')
                         AND pg_get_functiondef(p.oid) ILIKE '%auth.uid() IS DISTINCT FROM%') = 7
                THEN '✓' ELSE 'expected 7' END
    UNION ALL
    SELECT 'auth', 'atomic_chip_transfer has all 5 guards',
           CASE WHEN (SELECT COUNT(*) FROM pg_proc p
                       JOIN pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='public' AND p.proname='atomic_chip_transfer'
                        AND pg_get_functiondef(p.oid) ILIKE '%auth.uid()%')>0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'auth', 'admin-action audit log coverage',
           (SELECT COUNT(*)::text FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname ~ '^(fn_home_|revive_home|create_home)'
               AND pg_get_functiondef(p.oid) ILIKE '%commander_audit_logs%')
              || ' / 18',
           'every privileged state change leaves an audit trail'

    UNION ALL
    SELECT 'rate_limit', 'track_home_group_view has dedupe logic',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='track_home_group_view'
                    AND pg_get_functiondef(p.oid) ILIKE '%INTERVAL%')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'rate_limit', 'track_home_group_share_click has dedupe logic',
           CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                  JOIN pg_namespace n ON n.oid=p.pronamespace
                  WHERE n.nspname='public' AND p.proname='track_home_group_share_click'
                    AND pg_get_functiondef(p.oid) ILIKE '%INTERVAL%')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'rate_limit', 'home-view-log-prune cron scheduled',
           CASE WHEN EXISTS (SELECT 1 FROM cron.job WHERE jobname='home-view-log-prune')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'rate_limit', '5 spam-vector RPCs use fn_try_consume_home_rate_limit',
           (SELECT COUNT(*)::text FROM pg_proc p
              JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname='public'
               AND p.proname IN ('fn_home_create_post','fn_home_add_comment',
                 'fn_home_invite_member','fn_home_add_photo','fn_home_like_post')
               AND pg_get_functiondef(p.oid) ILIKE '%fn_try_consume_home_rate_limit%')
              || ' / 5', 'post / comment / invite / photo / like'

    UNION ALL
    SELECT 'infra', 'all home game tables have RLS enabled',
           (SELECT COUNT(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname LIKE 'commander_home_%'
               AND c.relkind='r' AND c.relrowsecurity)
           || ' / ' ||
           (SELECT COUNT(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname LIKE 'commander_home_%' AND c.relkind='r'), ''
    UNION ALL
    SELECT 'infra', 'all home game tables FORCE RLS',
           (SELECT COUNT(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname LIKE 'commander_home_%'
               AND c.relkind='r' AND c.relforcerowsecurity)
           || ' / ' ||
           (SELECT COUNT(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
             WHERE n.nspname='public' AND c.relname LIKE 'commander_home_%' AND c.relkind='r'), ''
    UNION ALL
    SELECT 'infra', 'all home game tables have at least one RLS policy',
           CASE WHEN (SELECT COUNT(*) FROM pg_class c
                        JOIN pg_namespace n ON n.oid=c.relnamespace
                       WHERE n.nspname='public' AND c.relname LIKE 'commander_home_%'
                         AND c.relkind='r'
                         AND c.relname NOT IN ('commander_home_group_view_log',
                                               'commander_home_share_clicks',
                                               'commander_home_rate_limits')
                         AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid))=0
                THEN '✓' ELSE '✗' END, 'exempts 3 deny-all server-log tables'
    UNION ALL
    SELECT 'infra', 'composite index idx_commander_home_games_group_scheduled exists',
           CASE WHEN EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname='public'
                    AND indexname='idx_commander_home_games_group_scheduled')
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'infra', 'all home game triggers enabled',
           (SELECT COUNT(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
             WHERE c.relname LIKE 'commander_home_%' AND NOT t.tgisinternal
               AND t.tgenabled='O')
           || ' / ' ||
           (SELECT COUNT(*)::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
             WHERE c.relname LIKE 'commander_home_%' AND NOT t.tgisinternal)
           || ' enabled', ''
    UNION ALL
    SELECT 'infra', 'home cron jobs scheduled',
           (SELECT COUNT(*)::text FROM cron.job WHERE jobname LIKE 'home-%'), 
           'reminders, auto-complete, trending, stale sweep, recurring gen, quality, vitality, nudge, recap, snapshots, view-log prune, strike-decay'
    UNION ALL
    SELECT 'infra', 'realtime publication for HG tables',
           (SELECT COUNT(*)::text FROM pg_publication_tables
             WHERE pubname='supabase_realtime' AND tablename LIKE 'commander_home_%')
              || ' tables',
           'games, groups, members, rsvps, seats, seat reservations'

    UNION ALL
    SELECT 'integrity', 'zero orphan RSVPs',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_rsvps r
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_games g
                                          WHERE g.id=r.game_id))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero orphan seats',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_seats s
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_games g
                                          WHERE g.id=s.game_id))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero orphan posts',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_posts p
                       WHERE NOT EXISTS (SELECT 1 FROM commander_home_groups g
                                          WHERE g.id=p.group_id))=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero expired active invite tokens',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_invite_tokens t
                       WHERE t.is_active AND t.expires_at < NOW())=0
                THEN '✓' ELSE '✗' END, ''
    UNION ALL
    SELECT 'integrity', 'zero banned members w/o banned_at',
           CASE WHEN (SELECT COUNT(*) FROM commander_home_members m
                       WHERE m.status='banned' AND m.banned_at IS NULL)=0
                THEN '✓' ELSE '✗' END, ''
    ;
END;
$function$;
