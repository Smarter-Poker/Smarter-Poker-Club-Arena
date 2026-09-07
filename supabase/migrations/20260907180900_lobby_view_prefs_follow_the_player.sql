-- Dan 2026-09-07, item 5: "FILTER TAB SELECTIONS NEED TO BE SAVED AND CACHED
-- AS WELL AS SAVED AND UPDATED ON CROSS USER DEVICES. THEY SHOULD BE SAVED
-- REGARDLESS OF WHICH DEVICE YOU LOG INTO."
--
-- The lobby already had half of this. The Advanced Filters sheet went
-- cross-device on 2026-08-31 into user_lobby_filters; the GAME TYPE TAB, the
-- SORT BY control and the Favorites chip stayed in localStorage
-- (ca_lobby_view_<club>) and so followed the browser, not the player. Those
-- three are the ones a player notices first, because they change what the
-- board looks like at a glance.
--
-- Same row, not a second table: these are the same lobby's preferences for the
-- same (user, club) pair, and one row means one write, one read and one RLS
-- surface instead of two that can disagree about which device won.
alter table public.user_lobby_filters
  add column if not exists view_prefs jsonb not null default '{}'::jsonb;

-- COLUMN GRANTS ARE SEPARATE FROM RLS, and Postgres rejects the WHOLE
-- statement when a star-select touches an ungranted column - the trap that
-- made every profiles read 403 for every signed-in user (see the 2026-08-20
-- asset-and-grant sweep). The four owner-only policies on this table already
-- cover the new column; this is the other half.
grant select (view_prefs), insert (view_prefs), update (view_prefs)
  on public.user_lobby_filters to authenticated;

comment on column public.user_lobby_filters.view_prefs is
  'Lobby view state: game-type tab, per-tab sort, Favorites chip. Written by src/components/lobby/lobbyViewPrefs.ts; localStorage is the first-paint cache, this is the truth.';
