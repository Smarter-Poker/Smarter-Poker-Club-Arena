-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260905162259 "name_the_dead_mirrors_so_nobody_revives_them"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 cd7c6c1fafcba6c91f899ae27ab19cad of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Name the dead mirrors, so the next agent does not wire one up.
--
-- Three things on this schema read as live and are not. None is dropped: a
-- DROP is irreversible and the World Hub shares this database, so the honest
-- move is to write down what each one actually is, where the truth lives, and
-- what happens to anyone who gates on it. Measured 2026-09-05 across 1,313
-- profiles.
--
-- 1. `training_achievement_definitions` - 23 rows, `threshold` = 0 on every
--    one, `icon_url` NULL on every one. Nothing in the Club Arena client or
--    the engine reads it. The live catalogue is the `ACHIEVEMENTS` array in
--    src/services/AchievementService.ts, and the profile credential reads its
--    unlocks through achievementService. A definitions table whose thresholds
--    are all zero cannot decide anything.
--
-- 2. `profiles.tier` - the literal 'Newcomer' on 1,313 of 1,313 rows.
--    AuthPage writes it at signup and nothing ever updates it. It is a RANK
--    label, not a VIP column, and it has already cost two live defects:
--    FriendListPanel cast it to a VIP tier so every avatar rendered
--    `tier-Newcomer`, a class with no colour, and no player ever saw the VIP
--    ring; and CompleteProfileModal gated the VIP avatar collection on
--    `vip_level !== 'bronze'` where vip_level mirrors this column, so
--    'Newcomer' !== 'bronze' held the gate open for every account.
--
-- 3. `profiles.access_tier` - one distinct value across all 1,313 rows. Read
--    by nothing in this client.
--
-- `profiles.skill_tier` is NOT in this list: it carries 7 distinct values and
-- is real. `vip_tier` is real too ('lifetime' | 'monthly' | NULL).
--
-- VIP is is_vip + vip_tier + vip_expires_at, resolved by public.fn_arena_name's
-- sibling utils/vipStatus on the client. Dan, 2026-09-04: "THERE IS NO SUCH
-- THING AS 'PLATINUM VIP' BTW. JUST VIP, AND LIFETIME VIP."
--
-- COMMENT-only. No data moves, nothing is dropped, no behaviour changes.

BEGIN;

COMMENT ON TABLE public.training_achievement_definitions IS
  'DEAD MIRROR (2026-09-05). 23 rows, threshold = 0 on every row, icon_url NULL on every row, and no reader in the Club Arena client or the engine. The live achievement catalogue is the ACHIEVEMENTS array in src/services/AchievementService.ts. Do not wire this table to a surface without first deciding which of the two is the source; two catalogues is how the streak and VIP ladders drifted.';

COMMENT ON COLUMN public.profiles.tier IS
  'RANK LABEL, NOT A VIP COLUMN. The literal ''Newcomer'' on 1,313 of 1,313 rows as of 2026-09-05: AuthPage writes it at signup and nothing updates it. NEVER gate an entitlement on it - it is a constant, so every comparison against it is decided at signup. It has already caused two live defects (the VIP ring that never rendered, and the VIP avatar gate that stood open for every account). VIP is is_vip + vip_tier + vip_expires_at.';

COMMENT ON COLUMN public.profiles.access_tier IS
  'One distinct value across all 1,313 rows as of 2026-09-05, and no reader in the Club Arena client. Treat as unused until something sets it; do not gate on it.';

COMMENT ON COLUMN public.profiles.skill_tier IS
  'REAL, unlike tier and access_tier: 7 distinct values as of 2026-09-05.';

COMMENT ON COLUMN public.profiles.vip_tier IS
  'REAL. ''lifetime'' | ''monthly'' | NULL - a membership KIND, not a ladder rung. Resolved with is_vip and vip_expires_at by src/utils/vipStatus.ts.';

COMMIT;
