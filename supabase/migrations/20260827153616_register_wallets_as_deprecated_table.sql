-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260827153616; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- The frozen global chip pool joins the deprecated registry (2026-08-27).
--
-- public.wallets has taken no write since 2026-08-21 00:59 UTC and holds
-- 732,591,994.33 stranded chips. CLAUDE.md 11.5 already said "nothing reads
-- it" — eleven client sites did, including the store behind useCanAfford and
-- the "Playable Now" figure on the player wallet page. Because the table still
-- HOLDS numbers, those reads never rendered the tell-tale zero that the
-- deprecated-table gate was built to catch; they rendered six-day-stale
-- plausible figures. Measured the day of the fix: the frozen PLAYER pool summed
-- to 732,581,244.32 against a live economy of 121,018,710.03, and one sampled
-- player read 3,313,727.73 against a true 34,818.60.
--
-- The registry row and the CI gate entry are the durable half of the fix; the
-- code repointing is the other. Reads now fail the build.
INSERT INTO public.deprecated_tables (table_name, reason)
VALUES (
  'wallets',
  'Global chip pool, frozen 2026-08-21 with 732,591,994.33 chips stranded. Live pools: club_members.chip_balance/.promo_balance/.locked_chips (club-scoped) and agents.agent_wallet_balance; fn_player_spendable_balance answers what a player can SPEND. Reads returned stale plausible numbers (one player 3,313,727.73 vs a true 34,818.60), not zeros, which is why this went unnoticed for six days.'
)
ON CONFLICT (table_name) DO UPDATE
  SET reason = EXCLUDED.reason;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.deprecated_tables WHERE table_name = 'wallets') THEN
    RAISE EXCEPTION 'wallets was not registered as deprecated';
  END IF;
END $$;
