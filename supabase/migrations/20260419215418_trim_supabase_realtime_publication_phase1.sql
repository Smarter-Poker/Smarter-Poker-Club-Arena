-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260419215418 "trim_supabase_realtime_publication_phase1"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 dc790705f0e9d4821eff9341cc936a84 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 1 realtime publication trim.
-- Removes 30 tables from supabase_realtime publication:
--   * 29 tables that are empty in DB AND have no postgres_changes subscription in client code
--   * 1 high-volume append-only log (bbj_contributions, 168k rows, not subscribed in client code)
-- Expected savings: ~$30-60/mo from removed WAL broadcast overhead on empty tables,
--   plus eliminating bbj_contributions message volume.
-- Further cuts require client refactoring of subscriptions on hand_history,
--   wallet_transactions, rake_history — those remain in the publication for now
--   because removing them would silently break features.

ALTER PUBLICATION supabase_realtime DROP TABLE
  public.action_audit_logs,
  public.arcade_duel_queue,
  public.bbj_contributions,
  public.club_arena_messages,
  public.commander_seats,
  public.commission_history,
  public.geeves_missed_questions,
  public.hand_histories,
  public.live_sessions,
  public.messenger_call_signals,
  public.messenger_messages,
  public.messenger_reactions,
  public.poker_tables,
  public.rakeback_periods,
  public.sandbox_coach_results,
  public.sandbox_equity_history,
  public.sandbox_quiz_results,
  public.sandbox_weekly_spots,
  public.session_chat_messages,
  public.social_conversations,
  public.social_interactions,
  public.solution_bookmarks,
  public.study_rooms,
  public.time_bank,
  public.tournament_reminders_sent,
  public.trivia_pvp_matches,
  public.trivia_pvp_queue,
  public.union_leave_requests,
  public.union_wallet_transactions,
  public.user_progress;
