# tests/a-profile-shows-strangers-only-what-the-table-needs.law.test.ts

Ruling 22 (docs/DIAMOND-RULINGS.md, decided by Claude on Dan's delegation of
2026-09-30): a stranger sees only what playing with you needs - display name,
username, avatar, player number and public statistics - and a profile's money,
real identity and whereabouts are readable only by their owner and by platform
staff. Migration 20260930234000 opened the doors (the owner's
get_my_full_profile(), pinned; get_full_profiles_for_staff for platform staff;
fn_profile_presence, a boolean that never hands out the heartbeat) and moved
eleven database readers off the private fields by asserted substitution. The
law pins those doors and edits, and that no Club Arena read of public.profiles
names a private column in a select, a filter or an order: Postgres refuses the
whole statement once the column is revoked, and several readers here treat
42501 as "no profile" and would fail silently.
