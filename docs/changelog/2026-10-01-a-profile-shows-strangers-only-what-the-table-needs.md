# 2026-10-01 - A profile shows strangers only what the table needs

Diamond Arena Phase 10, line 2, step 2 of 2. Ruling 25 ([DIAMOND-RULINGS](../DIAMOND-RULINGS.md)), decided by Claude
on Dan's delegation of 2026-09-30: a stranger sees only what playing with you needs, and a profile's money, real
identity and whereabouts are readable only by their owner and platform staff.

Step 1 ([the doors](2026-10-01-a-profiles-private-fields-have-an-owner-and-a-staff-door.md), #5679) opened the owner,
staff and presence doors and moved every reader; the World Hub moved its own in Smarter-Poker-World-Hub#2056. This
closes the table.

## The change (migration `20260930234500_a_profile_shows_strangers_only_what_the_table_needs`)

- **Refuses to run while any reader a browser can reach still names a private column**: an invoker function a
  signed-in or signed-out caller can execute or that a trigger fires on a table they can write, an RLS policy, or a
  browser-readable view. Only the six names step 1 reviewed pass (they read nothing private, or run only under a
  definer).
- **Revokes SELECT** on `diamonds`, `diamond_balance`, `diamond_multiplier`, `first_name`, `last_name`, `full_name`,
  `birth_year`, `city`, `state`, `country`, `last_seen`, `last_login`, `last_login_date`, `last_active`, `updated_at`,
  `referred_by` and `poker_near_me_preferences` from `authenticated` and `anon`. `authenticated` keeps 81 public
  columns. UPDATE and INSERT are untouched (an owner still edits their own row), RLS is untouched, `service_role` is
  untouched. Column grants take no lock on the table.
- **The live-stream list** (`get_visible_live_streams`, a definer the revoke cannot reach) stops answering every
  signed-in caller with each broadcaster's legal name: `broadcaster_full_name` is NULL, same signature, by asserted
  substitution. The World Hub stopped reading it in #2056.
- The two new doors' database comments name ruling 25.

## Applied and verified

- **Only after the old reads stopped.** The World Hub went live at 00:18 UTC and the Club Arena at 01:21 UTC; from
  01:26 to 11:23 UTC, nearly ten hours, `pg_stat_statements` counted no call of any of the 24 statements that had read a
  private column from either app. All 366 chunks of the live Club Arena build name no private column in a read.
- **Rehearsed, then applied.** The final rehearsal (11:25 UTC, the exact file) proved a stranger refused all 17 columns
  one by one and the owner refused them from the table, the public columns readable, the owner door and edits, staff
  through their door and a player refused it, a visitor with no row and a public profile page without a name or
  balance, and the five invoker functions the World Hub's agent listed as reading a private column (`fn_get_stories`,
  `get_top_mission_completers`, `fn_update_presence`, `fn_ca_diamond_transfer_names_its_counterparty`,
  `fn_hg_caller_display_name`) still working without telling a stranger anything private. apply.sh: APPLIED AND
  RECORDED 20260930234500 at 11:26 UTC.
- **Verified live.** The four `@live-proof` lines hold; `authenticated` reads 81 columns of `profiles`, `anon` the same
  two as before. No read either app sends was refused afterwards (`postgres_logs`), and both apps' signed-out pages
  load as before.

A stranger now reads a profile's display name, username, avatar, player number, level and public statistics, and
nothing about its money, real identity or whereabouts. What the revoke cannot reach (functions that run as their owner
behind home-game and agent screens, World Hub server routes) is listed in the evidence as follow-ups.

Evidence: [profile privacy, 2026-10-01](../evidence/profile-privacy-2026-10-01.md).
