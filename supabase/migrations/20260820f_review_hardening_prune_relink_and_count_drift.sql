-- Mirror of the live catalog (applied 2026-08-20 via mcp apply_migration).
-- ═══════════════════════════════════════════════════════════════════════════════
-- HARDENING PASS — defects found reviewing 20260820a/b/c line by line
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1. The pruner could wedge itself PERMANENTLY on one malformed userId ─────
--
-- `nullif(e.value->>'userId','')::uuid` is a hard cast. Any players[] element
-- whose userId is a non-empty non-uuid string — 'guest', a legacy integer id, a
-- username, a truncated value — raises `invalid input syntax for type uuid` and
-- aborts the whole function. There is no exception block, and candidates are
-- `order by created_at limit p_batch`, so the poisoned row is the OLDEST: every
-- subsequent 5-minute run picks the identical batch and fails identically.
-- Retention stops dead, silently (pg_cron records failures in
-- cron.job_run_details, which nothing watches), while hand_history grows
-- ~238k rows and ~1 GB a day.
--
-- Not hypothetical: `invalid input syntax for type uuid: "guest"` appears 67
-- times in 23h of this database's own postgres logs. No such row is in
-- hand_history's oldest 40,000 today — this is a landmine, not a fire.
--
-- A non-castable id now falls through to "not a known horse" -> human -> KEPT,
-- which is the fail-safe direction the function already intends everywhere else.
--
-- Also fixed here:
--   * `for update skip locked` on the candidate CTE. pg_cron does not suppress
--     overlapping runs of the same job, and a pass during the backlog drain has
--     been measured at 24s against a 5-minute interval — close enough that two
--     passes contending on the identical oldest rows is worth making harmless
--     rather than merely non-corrupting.
--   * the rationale comment for `has_human IS DISTINCT FROM true` was WRONG. It
--     claimed a run dying between the UPDATE and the DELETE could strand
--     has_human=false rows. A plpgsql function body is one transaction, so both
--     roll back together and nothing can be stranded. The predicate is kept
--     because it is harmless and defensive, but the false reasoning is removed.
CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_horse_window constant interval := interval '7 days';
  v_uuid_re constant text :=
    '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
  v_doomed uuid[];
  v_deleted int;
begin
  with candidates as (
    select id, players
      from public.hand_history
     where has_human is distinct from true
       and reported is not true
       and created_at < now() - v_horse_window
     order by created_at
     limit p_batch
     for update skip locked
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
                        -- Only cast what IS a uuid. A malformed id yields NULL,
                        -- the join misses, and `p.id is null` counts it as a
                        -- person — the same fail-safe as an unknown account.
                        on p.id = (
                             case when e.value->>'userId' ~ v_uuid_re
                                  then (e.value->>'userId')::uuid end
                           )
                where p.id is null            -- unknown/unparseable -> a person
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

  delete from public.hand_history where id = any(v_doomed);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$function$;

-- Monitoring hook for the one way this design degrades: hands that are KEPT
-- (human, reported, or unreadable) accumulate at the head of
-- idx_hand_history_created and are skipped by a filter on every pass. Measured
-- today the scan finds its full batch immediately (54ms, 0 rows filtered).
--
-- NOTE: this zero-arg version is a full table scan and TIMED OUT the first time
-- it was called. 20260820g drops it and replaces it with a bounded probe. It is
-- kept here so the migration sequence reproduces what actually happened.
CREATE OR REPLACE FUNCTION public.fn_hand_history_prune_skip_depth()
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT count(*)::bigint
    FROM public.hand_history
   WHERE created_at < now() - interval '7 days'
     AND (has_human IS TRUE OR reported IS TRUE);
$function$;

-- ── 2. fn_relink_rake_record_to_hand reported success without linking ────────
--
-- The SELECT and the UPDATE were separate statements with no lock. If another
-- session linked that row in between — or two engine instances retried the same
-- hand concurrently, both passing the `exists` guard under READ COMMITTED — the
-- UPDATE matched zero rows and the function still returned 1. The caller only
-- inspected `error`, so a no-op read as a successful relink and the rake row
-- stayed unattributable with nothing flagged.
--
-- Now one statement, and it returns the TRUE row count. Also adds a tiebreak on
-- id: `order by created_at` alone is arbitrary when two rake rows were banked in
-- the same microsecond.
CREATE OR REPLACE FUNCTION public.fn_relink_rake_record_to_hand(
  p_table_id uuid,
  p_hand_number bigint,
  p_hand_id uuid
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
declare
  v_linked int;
begin
  if p_table_id is null or p_hand_number is null or p_hand_id is null then
    return 0;
  end if;

  -- uq_rake_records_hand_id is UNIQUE on hand_id WHERE hand_id IS NOT NULL, so
  -- refuse rather than error if this hand id is already attached somewhere.
  if exists (select 1 from public.rake_records where hand_id = p_hand_id) then
    return 0;
  end if;

  update public.rake_records r
     set hand_id = p_hand_id
   where r.id = (
           select id
             from public.rake_records
            where table_id = p_table_id
              and hand_id is null
              and metadata->>'hand_number' = p_hand_number::text
            order by created_at, id
            limit 1
            for update skip locked
         )
     and r.hand_id is null;

  get diagnostics v_linked = row_count;
  return v_linked;
end;
$$;

COMMENT ON FUNCTION public.fn_relink_rake_record_to_hand(uuid, bigint, uuid) IS
  'Attach a hand_history row written late (after a transient write outage) to the rake_records row banked for the same hand. Matches on (table_id, metadata->>hand_number). Returns the number of rows ACTUALLY linked (0 or 1) — a caller must not read 0 as failure: a tournament hand, a zero-rake hand, or a hand whose rake row has not been created yet all legitimately return 0. Added 2026-08-20, made single-statement 2026-08-20 after review.';

-- ── 3. clubs.table_count can now drift permanently ──────────────────────────
--
-- 20260820b was right to stop the trigger firing 91,678 times a day on writes
-- where nothing relevant changed. But that waste was ALSO a continuous full
-- re-sync from truth, which silently papered over every drift source. With the
-- IS DISTINCT FROM guard, drift once introduced is permanent. Three real
-- sources, none previously covered:
--
--   a) club_id or union_id CHANGING. fn_sync_club_table_counts read
--      COALESCE(NEW.club_id, OLD.club_id) — on an UPDATE that moves a table
--      from club A to club B, NEW.club_id is B, so only B was recomputed and A
--      kept the stale count forever. (Under the old always-fire trigger the
--      next hand at any of A's tables fixed it.)
--   b) tournament_id. fn_live_table_count filters `tournament_id IS NULL`, but
--      tournament_id was not in the UPDATE trigger's column list at all.
--   c) union_clubs membership. fn_live_table_count reads union_clubs to resolve
--      a club's union, and nothing anywhere triggers on that table.
--
-- Fixed: recompute BOTH sides of a move, watch tournament_id, trigger on
-- union_clubs, and add a nightly whole-table reconciler as the backstop that
-- the old accidental behaviour was providing.
CREATE OR REPLACE FUNCTION public.fn_sync_club_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_clubs uuid[];
  v_unions uuid[];
BEGIN
  -- Both sides, so a table MOVING between clubs or unions fixes the club it
  -- left as well as the one it joined.
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);

  IF cardinality(v_clubs) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id) WHERE id = ANY(v_clubs);
  END IF;

  -- Every club that can see a touched union's tables (members + the union row).
  IF cardinality(v_unions) > 0 THEN
    UPDATE clubs SET table_count = fn_live_table_count(id)
     WHERE id = ANY(v_unions)
        OR id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions));
  END IF;

  RETURN NULL;
END $function$;

COMMENT ON FUNCTION public.fn_sync_club_table_counts() IS
  'Recomputes clubs.table_count. Reached by three triggers on public.tables (ins/del/upd) and one on public.union_clubs. The UPDATE one carries an IS DISTINCT FROM guard: `AFTER UPDATE OF status` fires whenever status is in the SET list, and the engine writes status alongside current_players once per hand, which made this trigger 40% of all database time on 2026-08-20. Do not merge these back into one trigger. fn_reconcile_club_table_counts() is the nightly backstop for anything these miss.';

-- tournament_id added to the watched columns.
DROP TRIGGER IF EXISTS trg_tables_sync_club_counts_upd ON public.tables;
CREATE TRIGGER trg_tables_sync_club_counts_upd
  AFTER UPDATE OF status, is_deleted, club_id, union_id, tournament_id ON public.tables
  FOR EACH ROW
  WHEN (
    NEW.status        IS DISTINCT FROM OLD.status
    OR NEW.is_deleted    IS DISTINCT FROM OLD.is_deleted
    OR NEW.club_id       IS DISTINCT FROM OLD.club_id
    OR NEW.union_id      IS DISTINCT FROM OLD.union_id
    OR NEW.tournament_id IS DISTINCT FROM OLD.tournament_id
  )
  EXECUTE FUNCTION public.fn_sync_club_table_counts();

-- Union membership changes the count for every club in that union.
CREATE OR REPLACE FUNCTION public.fn_sync_union_membership_table_counts()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_unions uuid[]; v_clubs uuid[];
BEGIN
  v_unions := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.union_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.union_id END
  ], NULL);
  v_clubs := array_remove(ARRAY[
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.club_id END,
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.club_id END
  ], NULL);

  UPDATE clubs SET table_count = fn_live_table_count(id)
   WHERE id = ANY(v_clubs)
      OR id = ANY(v_unions)
      OR id IN (SELECT club_id FROM union_clubs WHERE union_id = ANY(v_unions));
  RETURN NULL;
END $function$;

DROP TRIGGER IF EXISTS trg_union_clubs_sync_table_counts ON public.union_clubs;
CREATE TRIGGER trg_union_clubs_sync_table_counts
  AFTER INSERT OR UPDATE OR DELETE ON public.union_clubs
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_union_membership_table_counts();

-- The backstop. Cheap now that fn_live_table_count is index-served.
CREATE OR REPLACE FUNCTION public.fn_reconcile_club_table_counts()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_fixed int;
begin
  with drifted as (
    select c.id, fn_live_table_count(c.id) AS truth
      from clubs c
     where c.table_count is distinct from fn_live_table_count(c.id)
  )
  update clubs c set table_count = d.truth
    from drifted d
   where c.id = d.id;
  get diagnostics v_fixed = row_count;
  return v_fixed;
end $function$;

COMMENT ON FUNCTION public.fn_reconcile_club_table_counts() IS
  'Nightly backstop for clubs.table_count. Before 2026-08-20 an always-firing trigger re-synced every count on every hand; removing that waste also removed an accidental reconciler, so drift became permanent. Returns the number of clubs corrected — a non-zero result means a drift source is still uncovered and is worth investigating, not just repairing.';

SELECT cron.schedule(
  'reconcile-club-table-counts-nightly',
  '40 3 * * *',
  'SELECT public.fn_reconcile_club_table_counts();'
);
