# 2026-10-01 - A profile's private fields have an owner door and a staff door

Diamond Arena Phase 10, line 2. Ruling 25 ([DIAMOND-RULINGS](../DIAMOND-RULINGS.md)), decided by Claude on Dan's
delegation of 2026-09-30 ("these are all for you to decide not me ... FIX AND FINISH ALL OF THESE"): a stranger sees
only what playing with you needs - display name, username, avatar, player number and public statistics - and a
profile's money, real identity and whereabouts are readable only by their owner and by platform staff.

Until now any signed-in account could read every account's Diamond balance and multiplier, legal name, birth year,
city, state, country, last seen, last login and referred-by straight from `public.profiles`. This is the first of two
steps: it opens the doors and moves every reader; the column revoke that closes the table
(`20260930234500_a_profile_shows_strangers_only_what_the_table_needs`) is applied only after the World Hub has moved
too, because Postgres refuses a whole statement that names one revoked column - a missed reader is a broken screen.

## The database (migration `20260930234000_a_profiles_private_fields_have_an_owner_and_a_staff_door`)

- **Staff door**, new: `get_full_profiles_for_staff(uuid[])`, whole rows to platform staff (`fn_is_platform_admin()`)
  only; anyone else is refused by name (42501), and a visitor cannot call it.
- **Presence door**, new: `fn_profile_presence(uuid[])` answers who is online now - the persisted flag counted only
  while its heartbeat is under five minutes old - and never returns the heartbeat. The raw `is_online` flag alone was
  stale-true on 288 human rows (measured), so it cannot stand in for `last_seen`.
- **Owner door**, unchanged: `get_my_full_profile()` (the caller's own row and nothing else), pinned.
- **Eleven database readers** stop reading private fields, each by asserted substitution (live md5 pinned, the clause
  found once, the reverse proved, grants unchanged): the story bar's author name (`fn_get_stories`, an invoker that
  would have swallowed the refusal and shown an empty bar), a club's mission leaders, the seven notification triggers
  that printed the acting person's legal name, the signed-out profile page (`get_public_profile_by_username`: no legal
  name and no Diamond balance for anyone), and `get_unified_user_profile` (city and state for the owner only).

Rehearsed in one rolled-back transaction with the revoke simulated inside it (REHEARSAL OK: a stranger is refused,
public columns read, the owner door and an owner's own edit work, an upsert naming a private column is refused,
presence and the moved readers work, staff read), then applied and recorded at 00:05 UTC.

## The Club Arena

- `PLAYER_NAME_COLUMNS` names no real-name column. The arena already calls a player by their handle; the resolver
  still keeps a display name that is the legal name off the felt when it has the owner's own row.
- The player's own private fields (Diamond balance, login day, last login, their own legal name for the resolver) are
  read through the owner door: `ownProfile(id)` in `src/lib/ownProfile.ts` (wallet, profile page, VIP page, chip mint,
  advertising, time-bank store, data export, login streak, the profile account sync, the user store).
- Who is online comes from the presence door (`readPresence`): friends list, online-friends pill, presence dot, agent
  dashboard. **A friend who is offline now reads "Offline"**, not "Active 3h ago": how long ago someone left is theirs.
- The agent dashboard's activity panel and the agent score card's retention read **the last hand played in that
  club** (`player_stats.updated_at`, the club's public statistics) instead of the player's platform-wide last-seen
  time; the column is now headed "Last Played".
- The waitlist and union admin names resolve as arena handles instead of legal names; the agent player search and the
  invite search no longer ask for email (never granted, so both searches were refused whole until now).
- `tests/a-profile-shows-strangers-only-what-the-table-needs.law.test.ts` holds every `.from('profiles')` read in
  `src` to public columns, named literally.

Evidence: [profile privacy, 2026-10-01](../evidence/profile-privacy-2026-10-01.md).
