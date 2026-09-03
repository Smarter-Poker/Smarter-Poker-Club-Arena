-- Mirror of the live catalog (applied 2026-08-20 as migrations 20260820c and
-- 20260820d; combined here so a fresh database reaches the same end state in
-- one step). The story of the first attempt is kept in the comments below
-- because the way it failed is the interesting part.
-- ═══════════════════════════════════════════════════════════════════════════════
-- HAND HISTORY RETENTION — a human's hand is kept forever, a horse's for 7 days
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- Dan, 2026-08-20: "HUMANS KEEP FOREVER, NEVER CALL THEM BOTS, HORSES 7 DAYS IS
-- FINE."
--
-- The old policy was a flat 90 days for everything. That was written when the
-- room was quiet. It now takes 238,583 hands a day (~1 GB), so a 90-day window
-- lands at roughly 21 million rows — and measured on a 20,000-hand sample of
-- the last 90 days, only 0.025% of hands had a human at the table (5 in 20,000,
-- all one player). The flat window was therefore spending essentially all of
-- its storage on horse-vs-horse hands nobody will ever open, while ALSO
-- deleting real players' hands at 90 days.
--
-- New policy:
--   * any hand with at least one human seated  -> kept forever, never pruned
--   * horse-only hands                         -> pruned after 7 days
--   * a hand flagged `reported`                -> never classified, never pruned
--
-- HOW A HAND IS CLASSIFIED. `players` is a jsonb array of
-- {seat, cards, stack, userId, username}. A hand counts as human if ANY seat's
-- userId is not a known horse — including a userId with no profiles row at all.
-- That is the deliberate fail-safe direction: anything we cannot positively
-- identify as a horse is treated as a person, so the rule can only ever keep
-- too much, never delete a player's history.
--
-- WHY A COLUMN AND NOT A LIVE CHECK. Re-deriving this on every pruner pass
-- would re-examine every kept human hand every five minutes, forever. The flag
-- is computed ONCE, lazily, at the moment a row becomes eligible — seven days
-- after it was written. That deliberately keeps it off the write path: this
-- database has just had 40% of its execution time returned by removing exactly
-- that kind of per-hand trigger work (see 20260820b), and adding new work there
-- would be a straight trade backwards.
--
-- WHAT THE FIRST VERSION GOT WRONG. It classified a batch, then ran a SEPARATE
-- delete:
--
--     select id from hand_history
--      where has_human is false and created_at < now() - '7 days'
--        and reported is not true
--      order by created_at limit p_batch
--
-- `created_at` is an index condition but `has_human is false` is only a FILTER.
-- Whenever fewer than p_batch such rows exist — which is the NORMAL state, since
-- the run that classifies them also deletes them — that scan walks the entire
-- remaining backlog looking for matches it will never find. Measured live: the
-- first cron run took 24.2s (against 0.0-0.1s for the old 90-day pruner) and the
-- delete's SELECT alone did not finish inside 60s.
--
-- A partial index on (created_at) WHERE has_human IS FALSE would fix it, but
-- building one needs a full scan of a 10 GB table: CONCURRENTLY is the only safe
-- way and a cancelled client leaves an INVALID index behind (it did, and had to
-- be dropped), while a plain CREATE INDEX blocks hand_history inserts on a live
-- room.
--
-- The index is not needed. The run that classifies a row is the run that should
-- delete it, so the ids are carried straight through and deleted BY PRIMARY KEY.
-- Measured after the fix: 500 rows in 0.79s, 2,500 in 3.3s, 4,000 in 8.0s under
-- live load.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.hand_history
  ADD COLUMN IF NOT EXISTS has_human boolean;

COMMENT ON COLUMN public.hand_history.has_human IS
  'True if at least one seat in this hand belonged to a person rather than a horse. NULL means not classified yet — sp_prune_hand_history fills it lazily once the row is older than the horse retention window, so this costs nothing on the write path. Anything not positively identifiable as a horse counts as human, so the flag can only over-keep. Added 2026-08-20.';

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_horse_window constant interval := interval '7 days';
  v_doomed uuid[];
  v_deleted int;
begin
  -- Classify the oldest unresolved rows and capture the horse-only ones.
  --
  -- Two details keep this correct across restarts:
  --
  --   * the predicate is `has_human IS DISTINCT FROM true`, not `IS NULL`. If a
  --     run ever dies between the update and the delete, the orphaned
  --     has_human=false rows are the OLDEST rows in the table, so the very next
  --     run picks them straight back up. No state can be stranded.
  --   * `reported IS NOT TRUE` is in the candidate predicate, not just the
  --     delete. A reported hand is evidence and is never deleted, so it must
  --     also never be classified — otherwise it would be re-updated every five
  --     minutes forever.
  --
  -- Human hands accumulate at the head of idx_hand_history_created and are
  -- skipped by the filter. At the measured rate (0.025% of hands, ~60 a day)
  -- that is ~22k rows a year to skip per run.
  with candidates as (
    select id, players
      from public.hand_history
     where has_human is distinct from true
       and reported is not true
       and created_at < now() - v_horse_window
     order by created_at
     limit p_batch
  ),
  upd as (
    update public.hand_history h
       set has_human = case
             -- Unreadable or empty player list: cannot prove it was horses
             -- only, so keep it.
             when jsonb_typeof(c.players) is distinct from 'array' then true
             when jsonb_array_length(c.players) = 0 then true
             else exists (
               select 1
                 from jsonb_array_elements(c.players) e
                 left join public.profiles p
                        on p.id = nullif(e.value->>'userId','')::uuid
                where p.id is null            -- unknown account -> a person
                   or p.is_horse is not true  -- known, and not a horse
             )
           end
      from candidates c
     where h.id = c.id
     returning h.id, h.has_human
  )
  select array_agg(id) filter (where has_human is false) into v_doomed from upd;

  if v_doomed is null or cardinality(v_doomed) = 0 then
    return 0;
  end if;

  -- Primary-key deletes. No scan, no filter, no index to maintain.
  delete from public.hand_history where id = any(v_doomed);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

COMMENT ON FUNCTION public.sp_prune_hand_history(integer) IS
  'Retention for hand_history. A hand with any human seat is kept FOREVER; horse-only hands are deleted after 7 days; reported hands are never classified and never auto-deleted. One pass classifies the oldest unresolved batch and deletes the horse-only ones by primary key. Policy set by Dan 2026-08-20, replacing a flat 90 days that spent ~99.97% of its storage on horse-vs-horse hands while deleting real players history at 90 days.';

-- Batch raised 2500 -> 4000 to drain the ~2.4M-row backlog left by the old
-- 90-day window. 4,000 per 5 minutes is 1.15M/day against 238k/day arriving, so
-- the backlog clears in about two and a half days. It needs no manual reset
-- afterwards: once caught up, each run simply finds fewer eligible rows.
-- REVIEW FIX 2026-08-20: this was wrapped in `EXCEPTION WHEN others ... RAISE
-- NOTICE`, which swallowed a permissions failure or a NULL jobid identically to
-- "the job is absent". The migration would report success while the pruner
-- silently stayed at 2,500/run — half the rate the comment above claims is
-- needed to drain the backlog. Distinguish the cases and be loud about the
-- unexpected one.
DO $cron$
DECLARE v_jobid bigint;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'sp_prune_hand_history_10m';
  IF v_jobid IS NULL THEN
    RAISE NOTICE 'cron job sp_prune_hand_history_10m not present — nothing to bump';
  ELSE
    PERFORM cron.alter_job(v_jobid, command := 'select public.sp_prune_hand_history(4000)');
    RAISE NOTICE 'sp_prune_hand_history batch raised to 4000 (job %)', v_jobid;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'could not alter cron job sp_prune_hand_history_10m: %. The pruner will '
                'run at its previous batch size and may not drain the backlog.', SQLERRM;
END $cron$;
