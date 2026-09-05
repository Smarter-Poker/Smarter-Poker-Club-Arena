-- ═══════════════════════════════════════════════════════════════════════════
-- THE FLEET STATE SAYS WHEN A HORSE LAST ACTED, AND THE MIND REMEMBERS TEMPO
-- (2026-09-05, from the deep audit)
--
-- 1. ca_horse_fleet_state: 564 rows said `seated` while last_action_at was
--    NULL on all 1,000, hands_this_session was 0 on all and
--    session_started_at NULL on all. The fleet manager's minute upsert sends
--    those three as null/0 and fn_ca_fleet_state_upsert overwrote them, so
--    nothing that wrote them could ever survive a minute. The panel cannot
--    tell a seated horse that is playing from one that is stuck.
--
--    fn_ca_fleet_seat_touch(p_rows) is the engine's per-hand touch (batched
--    on the HorseHandReview timer): last_action_at = the hand's settlement,
--    hands_this_session += hands, session_started_at = its first touch at
--    this table. The upsert now PRESERVES those three when the incoming row
--    carries nothing, and resets the session when the table changes.
--
-- 2. horse_mind_stats: four tempo counters. A river bet of 20bb+ that
--    reached showdown is now also classed by how fast it was made (snap
--    under 1.5 s, tank over 8 s since the previous action) and whether the
--    shown hand was value. HorseMind.snapBetValueTendency / tankBet... read
--    them; persisted under the same GREATEST merge as every other counter,
--    because every deploy forgetting the answer is the failure the V34
--    migration documented.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_ca_fleet_seat_touch(p_rows jsonb)
returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare n int := 0; r jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then return 0; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    update public.ca_horse_fleet_state s
       set last_action_at = greatest(coalesce(s.last_action_at, 'epoch'::timestamptz),
                                     coalesce(nullif(r->>'at','')::timestamptz, now())),
           hands_this_session = case
             when s.table_id is not null and nullif(r->>'table_id','')::uuid is not null
                  and s.table_id <> nullif(r->>'table_id','')::uuid
             then coalesce((r->>'hands')::int, 0)
             else coalesce(s.hands_this_session, 0) + coalesce((r->>'hands')::int, 0) end,
           session_started_at = case
             when s.table_id is not null and nullif(r->>'table_id','')::uuid is not null
                  and s.table_id <> nullif(r->>'table_id','')::uuid
             then coalesce(nullif(r->>'at','')::timestamptz, now())
             else coalesce(s.session_started_at, nullif(r->>'at','')::timestamptz, now()) end,
           updated_at = now()
     where s.horse_id = nullif(r->>'horse_id','')::uuid;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.fn_ca_fleet_seat_touch(jsonb) from public, authenticated, anon;
grant execute on function public.fn_ca_fleet_seat_touch(jsonb) to service_role;

-- The minute upsert keeps what the touch wrote. Patched in place from the
-- live definition: only the three assignments change.
do $patch$
declare d text;
begin
  select pg_get_functiondef('public.fn_ca_fleet_state_upsert(jsonb, jsonb)'::regprocedure) into d;
  if position('coalesce(excluded.last_action_at, s.last_action_at)' in d) > 0 then
    return;
  end if;
  d := replace(d, 'last_action_at     = excluded.last_action_at,',
    'last_action_at     = coalesce(excluded.last_action_at, s.last_action_at),');
  d := replace(d, 'session_started_at = excluded.session_started_at,',
    'session_started_at = case when excluded.table_id is distinct from s.table_id then excluded.session_started_at else coalesce(excluded.session_started_at, s.session_started_at) end,');
  d := replace(d, 'hands_this_session = excluded.hands_this_session,',
    'hands_this_session = case when excluded.table_id is distinct from s.table_id then excluded.hands_this_session when excluded.hands_this_session > 0 then excluded.hands_this_session else s.hands_this_session end,');
  execute d;
end $patch$;

alter table public.horse_mind_stats
  add column if not exists snap_bet_sd        integer not null default 0,
  add column if not exists snap_bet_sd_strong integer not null default 0,
  add column if not exists tank_bet_sd        integer not null default 0,
  add column if not exists tank_bet_sd_strong integer not null default 0;

comment on column public.horse_mind_stats.snap_bet_sd is
  'V43 tempo read: river bets of 20bb+ made within 1.5 s of the previous action that reached showdown.';
comment on column public.horse_mind_stats.snap_bet_sd_strong is
  'V43 tempo read: ... where the shown hand was two pair or better.';
comment on column public.horse_mind_stats.tank_bet_sd is
  'V43 tempo read: river bets of 20bb+ made 8 s or more after the previous action that reached showdown.';
comment on column public.horse_mind_stats.tank_bet_sd_strong is
  'V43 tempo read: ... where the shown hand was two pair or better.';

do $patch$
declare d text;
begin
  select pg_get_functiondef('public.upsert_horse_mind_stats(jsonb)'::regprocedure) into d;
  if position('snap_bet_sd' in d) > 0 then
    return;
  end if;
  d := replace(d,
    'post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,' || chr(10) || '       r_hands,',
    'post_aggr, post_passive, river_bet_opps, river_bet_folds, checks,' || chr(10) ||
    '       snap_bet_sd, snap_bet_sd_strong, tank_bet_sd, tank_bet_sd_strong,' || chr(10) || '       r_hands,');
  d := replace(d,
    'COALESCE((r->>''checks'')::integer, 0),',
    'COALESCE((r->>''checks'')::integer, 0),' || chr(10) ||
    '       COALESCE((r->>''snap_bet_sd'')::integer, 0),' || chr(10) ||
    '       COALESCE((r->>''snap_bet_sd_strong'')::integer, 0),' || chr(10) ||
    '       COALESCE((r->>''tank_bet_sd'')::integer, 0),' || chr(10) ||
    '       COALESCE((r->>''tank_bet_sd_strong'')::integer, 0),');
  d := replace(d,
    'checks           = GREATEST(t.checks, EXCLUDED.checks),',
    'checks           = GREATEST(t.checks, EXCLUDED.checks),' || chr(10) ||
    '      snap_bet_sd        = GREATEST(t.snap_bet_sd, EXCLUDED.snap_bet_sd),' || chr(10) ||
    '      snap_bet_sd_strong = GREATEST(t.snap_bet_sd_strong, EXCLUDED.snap_bet_sd_strong),' || chr(10) ||
    '      tank_bet_sd        = GREATEST(t.tank_bet_sd, EXCLUDED.tank_bet_sd),' || chr(10) ||
    '      tank_bet_sd_strong = GREATEST(t.tank_bet_sd_strong, EXCLUDED.tank_bet_sd_strong),');
  execute d;
end $patch$;
