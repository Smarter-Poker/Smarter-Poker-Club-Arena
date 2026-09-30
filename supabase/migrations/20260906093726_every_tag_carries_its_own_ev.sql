-- BACKFILLED 2026-09-12 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260906093726; the .sql file was never committed at the
-- time. Content below is byte-exact to what ran. Do NOT re-apply; it is already live.
--
-- ===========================================================================
--  THIS IS A MIRROR. IT DESCRIBES DDL PRODUCTION ALREADY HAS.
-- ===========================================================================
--
-- LEDGER ROW
--   version     20260906093726   (the stamp IS the apply time, UTC: 2026-09-06 09:37:26)
--   name        every_tag_carries_its_own_ev
--   created_by  daniel@bekavactrading.com
--   statements  1 statement(s), 9067 bytes
--
-- WHY THE FILENAME VERSION WAS NOT RESERVED
--
-- CLAUDE.md 4.5 says never hand-pick a migration version and always run
-- scripts/new-migration.mjs. A mirror is the one sanctioned exception, and the
-- exception is what makes it safe: 20260906093726 IS ALREADY IN
-- supabase_migrations.schema_migrations under the name above. Reserving a fresh
-- version would open a SECOND ledger row for DDL that has run once, and a
-- rebuild would then apply it twice. The file must carry the version the ledger
-- already holds, or it is not a mirror of anything.
--
-- WHAT IT CREATES OR CHANGES (read out of the recorded statements, not guessed)
--     FUNCTION       public.fn_hhr_rollup_add, public.fn_horse_tag_ev, public.fn_audit_river_aggression_ev
--
--   NOTE: it also changes GRANT/REVOKE on what it touches.
--   NOTE: it also contains DML (INSERT/UPDATE/DELETE) against live rows.
--
-- HOW FAITHFUL THIS IS
--
-- RECOVERED, NOT RECONSTRUCTED. The body is the ledger's own `statements`
-- array joined by newlines - the same text Supabase split the original file
-- INTO - so it is the SQL that ran, not a re-derivation from pg_proc. Nothing
-- below was typed by hand. The header is the only added text, and every fact
-- in it comes from the ledger row or from the body.
--
-- DO NOT APPLY THIS FILE BY HAND. It is already live. Where the body contains
-- DML, re-running it would repeat a live data change that nobody asked this
-- bookkeeping branch to make.
-- ===========================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- EVERY TAG CARRIES ITS OWN EV (2026-09-06)
--
-- Two problems, one fix.
--
-- 1. THE NIGHTLY AUDIT IS AT ITS CEILING. Measured 2026-09-06:
--
--      fn_audit_river_aggression_ev      5,868 ms
--      every other audit step combined     951 ms
--
--    It makes TWO full-day passes over horse_hand_reviews - 26,969 rows for
--    2026-09-05 in a 437MB table, so ~43MB of heap each - to answer "what did
--    river aggression net". The whole audit is 17.5s cold against a 15s
--    engine-client abort. This step is the audit.
--
-- 2. NO TAG HAS AN EV. horse_review_rollup already carries leak COUNTS per
--    horse/day/variant, and HorseHandReview's own source says the point of
--    mirroring the tags was so "the audit can rank by EV instead of by
--    damage". Nothing could: a count says how often a shape happened, never
--    whether it was wrong. Ranking tags by their loss total is ranking them
--    by how often they occur in big pots.
--
-- `leak_net_bb` puts the net beside the count. The audit then reads 2,935
-- narrow rows instead of 26,969 fat ones, and EVERY mirrored tag gets the
-- treatment river aggression got by hand - which is how `river_aggr_lost`
-- was proved to be the cost of a winning line (+16.20 bb/hand) rather than
-- the fleet's biggest leak.
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
-- THE RANKING THE TAGS WERE MIRRORED FOR
--
-- A tag whose name ends `_won` is the winning mirror of the tag without it.
-- Pairing them gives the EV of the SITUATION rather than the cost of its
-- losses. The fold family (big_bet_fold, big_fold_river, big_fold_early,
-- bet_fold_line) has no mirror and CANNOT have one - a folded hand never
-- wins - so it is reported apart and never ranked against the mirrored tags.
-- Ranking a one-sided tag against a two-sided one is the error this whole
-- function exists to stop.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fn_horse_tag_ev(p_since date)
returns table (
  situation text, mirrored boolean, hands bigint, won_hands bigint,
  net_bb numeric, bb_per_hand numeric, win_rate numeric
)
language sql stable security definer set search_path = public as $$
  with flat as (
    select k as tag,
           (r.leak_counts->>k)::bigint            as cnt,
           coalesce((r.leak_net_bb->>k)::numeric, 0) as net
      from horse_review_rollup r, lateral jsonb_object_keys(r.leak_counts) k
     where r.day >= p_since
  ),
  agg as (
    select tag, sum(cnt)::bigint as cnt, sum(net) as net
      from flat group by tag
  ),
  paired as (
    select
      case when a.tag like '%\_won' then left(a.tag, length(a.tag) - 4) else a.tag end as situation,
      a.tag like '%\_won' as is_won,
      a.cnt, a.net
    from agg a
  )
  select p.situation,
         bool_or(p.is_won)                                   as mirrored,
         sum(p.cnt)::bigint                                   as hands,
         coalesce(sum(p.cnt) filter (where p.is_won), 0)::bigint as won_hands,
         round(sum(p.net), 1)                                 as net_bb,
         round(sum(p.net) / nullif(sum(p.cnt), 0), 2)         as bb_per_hand,
         round(coalesce(sum(p.cnt) filter (where p.is_won), 0)::numeric
               / nullif(sum(p.cnt), 0), 3)                    as win_rate
    from paired p
   group by p.situation
  having sum(p.cnt) >= 100
   order by 5 asc;
$$;

revoke all on function public.fn_horse_tag_ev(date) from public, authenticated, anon;
grant execute on function public.fn_horse_tag_ev(date) to service_role;

-- ─────────────────────────────────────────────────────────────────────────
-- The audit step that was 86% of the audit, rewritten onto the rollup, and
-- widened from ONE situation to every one that has a mirror.
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.fn_audit_river_aggression_ev(p_day date)
returns jsonb
language plpgsql security definer set search_path = public as $function$
declare
  v jsonb := '[]'::jsonb;
  r record;
  v_ranked int := 0;
begin
  for r in
    select * from fn_horse_tag_ev(p_day - 6)
     where mirrored and hands >= 200
     order by bb_per_hand asc
  loop
    v_ranked := v_ranked + 1;
    -- Only the losing situations are worth a line; a profitable one is the
    -- cost of a winning line and saying so once (below) is enough.
    if r.bb_per_hand < 0 then
      v := v || jsonb_build_object('severity', case when r.net_bb < -20000 then 'warn' else 'info' end,
        'category','gto','code','tag_ev_negative',
        'title', r.situation || ' is losing ' || r.bb_per_hand || 'bb per hand over ' || r.hands || ' hands',
        'evidence', jsonb_build_object('situation', r.situation, 'hands', r.hands,
                                       'won_hands', r.won_hands, 'net_bb', r.net_bb,
                                       'bb_per_hand', r.bb_per_hand, 'win_rate', r.win_rate),
        'recommendation','Both outcomes of this situation are counted, so this is EV and not a damage total. A negative number here is a real leak and a cap is worth testing: flag it, add a league matchup, and do not claim an improvement without significance.');
    end if;
  end loop;

  if v_ranked = 0 then
    v := v || jsonb_build_object('severity','info','category','schema','code','tag_ev_unavailable',
      'title','No mirrored situation has 200 hands in the七-day window',
      'evidence', jsonb_build_object('day', p_day),
      'recommendation','horse_review_rollup.leak_net_bb is written by fn_hhr_rollup_add on every review insert. If counts exist and nets do not, the rollup is running a build from before 2026-09-06.');
  else
    v := v || jsonb_build_object('severity','info','category','gto','code','tag_ev_ranked',
      'title', v_ranked || ' mirrored situations ranked by EV over seven days',
      'evidence', jsonb_build_object('situations', v_ranked, 'since', p_day - 6),
      'recommendation','Ranked by bb per hand across BOTH outcomes, which is the only honest ranking: a loss-only total ranks situations by how often they occur in big pots. The fold family has no winning mirror and is deliberately excluded - a folded hand never wins, so its total is the fold, not a leak.');
  end if;

  return v;
end $function$;

revoke all on function public.fn_audit_river_aggression_ev(date) from public, authenticated, anon;
grant execute on function public.fn_audit_river_aggression_ev(date) to service_role;
