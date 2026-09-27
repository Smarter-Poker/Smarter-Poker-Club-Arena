-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260809021725 "fn_training_leaderboard_record_atomic"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 de4bed8a0ae7b86395473429d09c9812 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Atomic leaderboard accumulator, replacing the API's SELECT -> compute ->
-- UPDATE/INSERT read-modify-write in save-progress.js. That path has two
-- real failure modes under concurrency:
--   1. Lost update: two sessions finishing together both read the same
--      "existing" row and the second write overwrites the first's increments.
--   2. Swallowed first-insert: the (user_id, period_type, period_key) unique
--      constraint makes one of two concurrent first-inserts fail, and the
--      caller only console.warns -- that session's stats vanish silently.
-- One INSERT ... ON CONFLICT DO UPDATE does the arithmetic in the database,
-- where it is atomic per row. accuracy is recomputed from the accumulated
-- totals, never trusted from the client.

create or replace function public.fn_training_leaderboard_record(
  p_user_id uuid,
  p_period_type text,
  p_period_key text,
  p_answered integer,
  p_correct integer,
  p_is_perfect boolean,
  p_best_streak integer default null,
  p_gtow_score numeric default null,
  p_ev_loss numeric default null
) returns void
language sql
security definer
set search_path = public
as $$
  insert into training_leaderboard as tl (
    user_id, period_type, period_key,
    sessions_completed, questions_answered, questions_correct,
    accuracy, perfect_rounds, best_streak,
    gtow_score_avg, ev_loss_total, score_scale, updated_at
  ) values (
    p_user_id, p_period_type, p_period_key,
    1, greatest(p_answered, 0), greatest(p_correct, 0),
    case when p_answered > 0
         then round((greatest(p_correct,0)::numeric / p_answered) * 100, 2)
         else 0 end,
    case when p_is_perfect then 1 else 0 end,
    coalesce(p_best_streak, 0),
    p_gtow_score, coalesce(p_ev_loss, 0), 2, now()
  )
  on conflict (user_id, period_type, period_key) do update set
    sessions_completed = tl.sessions_completed + 1,
    questions_answered = tl.questions_answered + greatest(p_answered, 0),
    questions_correct  = tl.questions_correct  + greatest(p_correct, 0),
    accuracy = case
      when tl.questions_answered + greatest(p_answered,0) > 0
      then round(((tl.questions_correct + greatest(p_correct,0))::numeric
                 / (tl.questions_answered + greatest(p_answered,0))) * 100, 2)
      else 0 end,
    perfect_rounds = tl.perfect_rounds + (case when p_is_perfect then 1 else 0 end),
    best_streak = greatest(tl.best_streak, coalesce(p_best_streak, 0)),
    -- running mean over sessions; only counts sessions that supplied a score
    gtow_score_avg = case
      when p_gtow_score is null then tl.gtow_score_avg
      when tl.gtow_score_avg is null then p_gtow_score
      else round((tl.gtow_score_avg * tl.sessions_completed + p_gtow_score)
                 / (tl.sessions_completed + 1), 2) end,
    ev_loss_total = coalesce(tl.ev_loss_total, 0) + coalesce(p_ev_loss, 0),
    updated_at = now();
$$;

revoke all on function public.fn_training_leaderboard_record(uuid,text,text,integer,integer,boolean,integer,numeric,numeric) from public;
grant execute on function public.fn_training_leaderboard_record(uuid,text,text,integer,integer,boolean,integer,numeric,numeric) to service_role, authenticated;

-- Assertion: function exists and is executable.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'fn_training_leaderboard_record'
  ) THEN
    RAISE EXCEPTION 'fn_training_leaderboard_record was not created';
  END IF;
END $$;
