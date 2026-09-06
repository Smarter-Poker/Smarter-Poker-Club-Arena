-- ═══════════════════════════════════════════════════════════════════════════
-- EVERY TAG CARRIES ITS OWN EV (2026-09-06)
--
-- Two problems, one fix.
--
-- 1. THE NIGHTLY AUDIT WAS AT ITS CEILING. Measured 2026-09-06:
--
--      fn_audit_river_aggression_ev      5,868 ms
--      every other audit step combined     951 ms
--
--    It made TWO full-day passes over horse_hand_reviews - 26,969 rows for
--    2026-09-05 in a 437MB table, so ~43MB of heap each - to answer "what did
--    river aggression net". The whole audit was 17.5s cold against a 15s
--    engine-client abort. This step WAS the audit.
--
-- 2. NO TAG HAD AN EV. horse_review_rollup already carried leak COUNTS per
--    horse/day/variant, and HorseHandReview's own source says the point of
--    mirroring the tags was so "the audit can rank by EV instead of by
--    damage". Nothing could: a count says how often a shape happened, never
--    whether it was wrong. Ranking tags by their loss total ranks them by how
--    often they occur in big pots.
--
-- `leak_net_bb` puts the net beside the count. The audit then reads a few
-- thousand narrow rows instead of 26,969 fat ones, and EVERY mirrored
-- situation gets the treatment river aggression got by hand.
--
-- MEASURED AFTER: 5,868 ms -> 107 ms, and the step went from reporting one
-- situation to ranking twenty-one.
--
-- WHY THIS IS A REAL SIGNAL AND THE FLEET AGGREGATE IS NOT: the fleet plays
-- itself, so its total result is zero minus the drop and can never measure
-- skill. These tags are ASYMMETRIC - only the horse in the bad spot is
-- tagged, never its opponent - so a negative EV here is that horse's mistake
-- rather than a chip that moved from one pocket to another.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.horse_review_rollup
  add column if not exists leak_net_bb jsonb not null default '{}'::jsonb;

comment on column public.horse_review_rollup.leak_net_bb is
  'Per-tag SUM of net_bb, the denominator-mate of leak_counts. count says how often the shape happened; this says what it was worth. Written by fn_hhr_rollup_add, read by fn_horse_tag_ev.';

create or replace function public.fn_hhr_rollup_add(
  p_horse uuid, p_day date, p_variant text, p_is_win boolean,
  p_net_bb numeric, p_tags text[])
returns void
language plpgsql security definer set search_path = public as $function$
declare t text; counts jsonb; nets jsonb;
begin
  insert into horse_review_rollup as r (horse_user_id, day, game_variant, big_wins, big_losses, sum_net_bb, leak_counts, leak_net_bb)
  values (p_horse, p_day, p_variant,
          case when p_is_win then 1 else 0 end,
          case when p_is_win then 0 else 1 end,
          coalesce(p_net_bb, 0), '{}'::jsonb, '{}'::jsonb)
  on conflict (horse_user_id, day, game_variant) do update set
    big_wins   = r.big_wins   + excluded.big_wins,
    big_losses = r.big_losses + excluded.big_losses,
    sum_net_bb = r.sum_net_bb + excluded.sum_net_bb,
    updated_at = now();
  if p_tags is not null and array_length(p_tags, 1) > 0 then
    select leak_counts, leak_net_bb into counts, nets from horse_review_rollup
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
    foreach t in array p_tags loop
      counts = jsonb_set(counts, array[t], to_jsonb(coalesce((counts->>t)::int, 0) + 1));
      -- The SAME hand's net against every tag it carries. A hand with three
      -- tags contributes its net to all three: each tag is a separate claim
      -- about that hand, and each is judged on the hands that carry it.
      nets = jsonb_set(nets, array[t],
               to_jsonb(round(coalesce((nets->>t)::numeric, 0) + coalesce(p_net_bb, 0), 2)));
    end loop;
    update horse_review_rollup set leak_counts = counts, leak_net_bb = nets, updated_at = now()
      where horse_user_id = p_horse and day = p_day and game_variant = p_variant;
  end if;
end $function$;

revoke all on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) from public, authenticated, anon;
grant execute on function public.fn_hhr_rollup_add(uuid, date, text, boolean, numeric, text[]) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- BACKFILL, 2026-08-31 onward (the tag-mirroring deploy).
--
-- NOTE THE GROUP BY. The first attempt grouped by r.played_at - the full
-- TIMESTAMP - so every hand formed its own group and jsonb_object_agg, which
-- keeps the LAST value for a duplicate key, wrote one hand's net per tag
-- instead of the sum. It read as river aggression netting +4,298bb on a day
-- the raw table says +136,479bb. Caught by cross-checking the rollup against
-- horse_hand_reviews per day; both now agree to the decimal.
-- ─────────────────────────────────────────────────────────────────────────
do $$
declare d date;
begin
  for d in select generate_series('2026-08-31'::date, current_date, '1 day')::date loop
    with per_tag as (
      select r.horse_user_id, r.played_at::date as day, r.game_variant, t as tag,
             round(sum(r.net_bb), 2) as net
        from horse_hand_reviews r, lateral unnest(r.leak_tags) t
       where r.played_at >= d::timestamptz and r.played_at < (d + 1)::timestamptz
       group by 1, 2, 3, 4
    ),
    src as (
      select horse_user_id, day, game_variant, jsonb_object_agg(tag, net) as nets
        from per_tag group by 1, 2, 3
    )
    update horse_review_rollup r set leak_net_bb = src.nets, updated_at = now()
    from src
    where r.horse_user_id = src.horse_user_id and r.day = src.day
      and r.game_variant = src.game_variant;
  end loop;
end $$;
