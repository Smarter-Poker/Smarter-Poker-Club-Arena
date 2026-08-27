-- Recorded in production as migration `jackpot_hands_are_never_pruned`.
-- Full reasoning: .agent/audits/2026-08-27-bbj-live-capture-and-realtime.md
--
-- 24 of 29 jackpot payouts had no hand_history row. Every one was a real hit;
-- the hand was written at the time and pruned a week later, because
-- sp_prune_hand_history deletes all-horse hands past the retention window and
-- the platform's tables are mostly horses. The winners list keeps the last five
-- hits forever, so the effect is that every jackpot's rundown goes dark after a
-- week — and bbj_payouts.hand_id is hardcoded NULL, so nothing can rebuild it.
--
-- A hand a bbj_payouts row points at is no longer a prune CANDIDATE.

CREATE INDEX IF NOT EXISTS idx_bbj_payouts_table_hand
  ON public.bbj_payouts (table_id, hand_number);

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
      select hh.id, hh.players
        from public.hand_history hh
       where hh.has_human is distinct from true
         and hh.reported is not true
         and hh.created_at < now() - v_window
         -- A HAND THAT HIT THE JACKPOT IS NEVER A CANDIDATE.
         -- bbj_payouts links to it only by (table_id, hand_number) and
         -- bbj_payouts.hand_id is always NULL, so a deleted hand is
         -- unrecoverable and fn_bbj_hand_detail goes dark for that winner
         -- permanently. See the header.
         and not exists (
               select 1
                 from public.bbj_payouts bp
                where bp.table_id = hh.table_id
                  and bp.hand_number = hh.hand_number
             )
       order by hh.created_at
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
