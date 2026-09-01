-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828034134; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

insert into public.ad_placement (ad_id, slot, audience, daily_cap, club_id, is_active, target_url)
select c.id, v.slot, v.audience, v.daily_cap, null, true, v.target_url
  from public.ad_catalog c
  join (values
      ('tournaments_daily', 'empty_state',     'all',     2, null),
      ('bbj_running',       'empty_state',     'all',     2, null),
      ('referral_invite',   'empty_state',     'all',     1, null),
      ('tournaments_daily', 'session_summary', 'all',     2, '/tournaments'),
      ('referral_invite',   'session_summary', 'all',     1, '/invite'),
      ('vip_upsell',        'session_summary', 'non_vip', 1, '/vip')
  ) as v(ad_key, slot, audience, daily_cap, target_url) on v.ad_key = c.ad_key
on conflict (ad_id, slot, club_id) do update
  set target_url = excluded.target_url,
      audience   = excluded.audience,
      daily_cap  = excluded.daily_cap,
      is_active  = excluded.is_active;

do $$
declare
  v_empty   int;
  v_session int;
  v_broken  int;
  v_club    uuid;
  v_lobby   int;
begin
  select count(*) into v_empty
    from public.ad_placement where slot = 'empty_state' and is_active;
  if v_empty <> 3 then
    raise exception 'Expected 3 active empty_state placements, found %', v_empty;
  end if;

  select count(*) into v_session
    from public.ad_placement where slot = 'session_summary' and is_active;
  if v_session <> 3 then
    raise exception 'Expected 3 active session_summary placements, found %', v_session;
  end if;

  select count(*) into v_broken
    from public.ad_catalog c
    join public.ad_placement pl on pl.ad_id = c.id
   where pl.slot = 'session_summary' and pl.is_active
     and coalesce(pl.target_url, c.target_url) like '%{%';
  if v_broken > 0 then
    raise exception
      '% session_summary destination(s) need a club this surface never has', v_broken;
  end if;

  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_broken
      from public.fn_resolve_ads('empty_state', v_club, 10) f
     where f.target_url is null or f.target_url not like '/%' or f.target_url like '%{%';
    if v_broken > 0 then
      raise exception '% empty_state destination(s) are not a usable path', v_broken;
    end if;
  end if;

  select count(*) into v_lobby
    from public.ad_placement where slot = 'lobby_strip' and is_active;
  if v_lobby <> 6 then
    raise exception 'lobby_strip placements changed: expected 6, found %', v_lobby;
  end if;
end $$;
