-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260826040305; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

CREATE TABLE IF NOT EXISTS public.hand_history_retention_policy (
  id                   boolean PRIMARY KEY DEFAULT true CHECK (id),
  horse_retention_days integer NOT NULL DEFAULT 7 CHECK (horse_retention_days >= 1),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  note                 text
);

COMMENT ON TABLE public.hand_history_retention_policy IS
  'How long a horses-only hand is kept. One row, enforced by the boolean PK. Hands with a human in them and hands flagged reported are NEVER pruned and are not governed by this. Default 7 days is the pre-existing value, kept deliberately; the right number is a product decision.';

INSERT INTO public.hand_history_retention_policy (id, horse_retention_days, note)
VALUES (true, 7, 'Carried over unchanged from sp_prune_hand_history. Not yet a deliberate choice.')
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.hand_history_retention_policy ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.sp_prune_hand_history(p_batch integer DEFAULT 2500)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_budget    constant interval := interval '20 seconds';
  v_deadline  timestamptz := clock_timestamp() + v_budget;
  v_days      integer;
  v_window    interval;
  v_doomed    uuid[];
  v_keepers   uuid[];
  v_deleted   integer := 0;
  v_round     integer;
begin
  select greatest(coalesce(horse_retention_days, 7), 1)
    into v_days
    from public.hand_history_retention_policy
   limit 1;

  if v_days is null then
    v_days := 7;
  end if;
  v_window := make_interval(days => v_days);

  loop
    v_doomed  := null;
    v_keepers := null;

    with candidates as (
      select id, players
        from public.hand_history
       where has_human is distinct from true
         and reported is not true
         and created_at < now() - v_window
       order by created_at
       limit p_batch
       for update skip locked
    ),
    classified as (
      select c.id,
             case
               when jsonb_typeof(c.players) is distinct from 'array' then true
               when jsonb_array_length(c.players) = 0 then true
               else exists (
                 select 1
                   from jsonb_array_elements(c.players) e
                   left join public.profiles p
                          on p.id = (
                               case when length(e.value->>'userId') = 36
                                     and (e.value->>'userId') ~
                                         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                                    then (e.value->>'userId')::uuid end
                             )
                  where p.id is null
                     or p.is_horse is not true
               )
             end as is_human
        from candidates c
    )
    select array_agg(id) filter (where is_human is false),
           array_agg(id) filter (where is_human is distinct from false)
      into v_doomed, v_keepers
      from classified;

    exit when v_doomed is null and v_keepers is null;

    if v_keepers is not null and cardinality(v_keepers) > 0 then
      update public.hand_history
         set has_human = true
       where id = any(v_keepers);
    end if;

    if v_doomed is not null and cardinality(v_doomed) > 0 then
      delete from public.hand_history where id = any(v_doomed);
      get diagnostics v_round = row_count;
      v_deleted := v_deleted + v_round;
    end if;

    exit when clock_timestamp() >= v_deadline;
  end loop;

  return v_deleted;
end
$function$;

CREATE OR REPLACE FUNCTION public.fn_hand_history_prune_backlog()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH pol AS (
    SELECT greatest(coalesce(horse_retention_days, 7), 1) AS days
      FROM public.hand_history_retention_policy LIMIT 1
  ), cap AS (
    SELECT count(*) AS n
      FROM (
        SELECT 1
          FROM public.hand_history
         WHERE created_at < now() - make_interval(days => (SELECT days FROM pol))
           AND has_human IS DISTINCT FROM true
           AND reported IS NOT true
         LIMIT 200000
      ) z
  )
  SELECT jsonb_build_object(
    'retention_days',     (SELECT days FROM pol),
    'prunable_backlog',   (SELECT n FROM cap),
    'backlog_capped_at',  200000,
    'backlog_is_capped',  ((SELECT n FROM cap) >= 200000),
    'oldest_prunable',    (SELECT min(created_at) FROM public.hand_history
                            WHERE created_at < now() - make_interval(days => (SELECT days FROM pol))
                              AND has_human IS DISTINCT FROM true
                              AND reported IS NOT true),
    'measured_at',        now()
  );
$function$;

COMMENT ON FUNCTION public.fn_hand_history_prune_backlog() IS
  'Is the hand_history pruner keeping up? prunable_backlog should sit near zero. A backlog that climbs run over run means the insert rate has passed the prune rate and the table will grow without bound.';

CREATE OR REPLACE FUNCTION public.fn_hand_history_bloat_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'heap_bytes',        pg_relation_size('public.hand_history'),
    'index_bytes',       pg_indexes_size('public.hand_history'),
    'total_bytes',       pg_total_relation_size('public.hand_history'),
    'heap_pages',        pg_relation_size('public.hand_history') / 8192,
    'live_tuples',       (SELECT n_live_tup FROM pg_stat_user_tables
                           WHERE relname = 'hand_history' AND schemaname = 'public'),
    'live_tuples_per_page',
        round( (SELECT n_live_tup FROM pg_stat_user_tables
                 WHERE relname = 'hand_history' AND schemaname = 'public')::numeric
               / greatest(pg_relation_size('public.hand_history') / 8192, 1), 2),
    'measured_at',       now()
  );
$function$;

COMMENT ON FUNCTION public.fn_hand_history_bloat_report() IS
  'live_tuples_per_page is the number to read. Measured 1.33 on 2026-08-26 against a packed capacity of about 5, i.e. 73% of the heap was free space. Reclaiming it needs VACUUM FULL or partitioning, both of which need a maintenance window - this function exists so that decision is made against a number rather than a guess.';
