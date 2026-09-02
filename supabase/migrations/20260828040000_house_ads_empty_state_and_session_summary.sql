-- THE LAST TWO CLUB ARENA SLOTS GET INVENTORY
--
-- Phase 1 declared five slots and wired one. `hub_promotions` was lit on
-- 2026-08-28. `empty_state` and `session_summary` have been declared, empty and
-- pointing at nothing since the beginning: the CHECK constraint permits them,
-- the resolver serves them, and not one row in `ad_placement` has ever named
-- either. A wired surface with no placements renders nothing, which is
-- indistinguishable from a surface that was never built.
--
-- This is the data half. The components are HouseAdCard, mounted in
-- ClubHomePage's empty view and in SessionSummaryHost.
--
-- ── WHERE EACH SLOT ACTUALLY APPEARS ──────────────────────────────────────
--
-- `empty_state` renders in ONE of the lobby's four empty views: the one where
-- the club has nothing running at all. The other three each carry a remedy
-- ("Show All Games"), and an advert placed beside a fix competes with the fix.
-- The justification for this slot is that it fills space that is genuinely
-- dead. A filtered-out list is not dead space; it is a list one tap away.
--
-- `session_summary` sits inside the Session Complete card, under the numbers
-- and above the actions, so it never comes between a player and Done.
--
-- ── WHY THESE CAMPAIGNS AND NOT THE OTHERS ─────────────────────────────────
--
-- EMPTY STATE. The player is looking at a club with no games. Every promo here
-- has to answer "so where do I go instead", which rules out anything pointing
-- back into this club's empty lobby:
--
--   tournaments_daily  /tournaments               a board that is running now
--   bbj_running        /clubs/{clubId}/jackpot    the jackpot is live whether or not tables are
--   referral_invite    /invite                    nobody here to play with, so bring somebody
--
--   spins_jackpot is deliberately absent: Spins live in this club's own lobby,
--   which is the empty thing the player is already looking at.
--
-- SESSION SUMMARY. This host lives at the app root and survives the navigate()
-- off the table, so it has NO club in hand and calls the resolver with NULL.
-- Any destination carrying {clubId} would be unresolvable, and since
-- 20260828034000 the resolver drops those rather than serving a broken link.
-- Every placement here therefore names its own destination explicitly:
--
--   tournaments_daily  /tournaments   the natural next thing after a session
--   referral_invite    /invite
--   vip_upsell         /vip           audience non_vip, as everywhere else
--
--   diamonds_store IS DELIBERATELY NOT PLACED HERE, and this is the one entry
--   on the page that is a judgement rather than a mechanic. The Session
--   Complete card is shown to a player who has just finished, and roughly half
--   of them have just lost. "Diamonds Buy Chips Instantly" is the single piece
--   of house inventory that asks somebody to spend money, and the moment
--   immediately after a loss is the moment not to ask. If Dan wants it there,
--   it is one INSERT - but it should be his call and not a side effect of
--   placing everything everywhere.
--
-- ── CAPS ───────────────────────────────────────────────────────────────────
-- Tighter than the lobby's. The lobby is a room a player sits in; these two are
-- moments they pass through, and a moment repeated is a moment resented. Caps
-- are per surface since 20260828032000, so these numbers mean what they say and
-- do not spend the lobby's budget or have it spent for them.
--
-- ── VIP ────────────────────────────────────────────────────────────────────
-- No VIP suppression, in either direction (Dan 2026-08-27: "even vips will see
-- ads remove that for now"). vip_upsell keeps its non_vip audience because
-- selling a VIP membership to a VIP is a broken advert, not a policy.
--
-- ROLLBACK
--   delete from public.ad_placement where slot in ('empty_state','session_summary');

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

-- Assertions. Abort rather than half-apply.
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

  -- session_summary resolves with NO club, so nothing there may need one. A
  -- templated destination on this surface would be silently dropped by the
  -- resolver and the slot would look empty for a reason nobody could see.
  --
  -- Asserted against the placements rather than through fn_resolve_ads,
  -- because the resolver applied as postgres has auth.uid() = NULL and a NULL
  -- user can never match the `non_vip` audience. The first draft of this
  -- assertion called the resolver, got 2 of 3, and aborted the migration on a
  -- fact about the probe rather than a fact about the data. That is the right
  -- failure mode, and the reason the assertion is here at all - but the
  -- question worth asking is "does any destination on this surface need a club
  -- it will never be given", so ask exactly that.
  select count(*) into v_broken
    from public.ad_catalog c
    join public.ad_placement pl on pl.ad_id = c.id
   where pl.slot = 'session_summary' and pl.is_active
     and coalesce(pl.target_url, c.target_url) like '%{%';
  if v_broken > 0 then
    raise exception
      '% session_summary destination(s) need a club this surface never has', v_broken;
  end if;

  -- empty_state DOES have a club, so its templated destination must expand.
  select id into v_club from public.clubs order by created_at limit 1;
  if v_club is not null then
    select count(*) into v_broken
      from public.fn_resolve_ads('empty_state', v_club, 10) f
     where f.target_url is null or f.target_url not like '/%' or f.target_url like '%{%';
    if v_broken > 0 then
      raise exception '% empty_state destination(s) are not a usable path', v_broken;
    end if;
  end if;

  -- Phase 1 and the Hub must be untouched.
  select count(*) into v_lobby
    from public.ad_placement where slot = 'lobby_strip' and is_active;
  if v_lobby <> 6 then
    raise exception 'lobby_strip placements changed: expected 6, found %', v_lobby;
  end if;
end $$;
