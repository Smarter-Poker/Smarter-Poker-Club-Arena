-- the_diamond_rake_guard_is_a_declared_money_trigger
--
-- Migration 20261005183028 diamond_cash_rake_reads_the_owner_settings created
-- the BEFORE INSERT OR UPDATE trigger poker_arena_no_chip_rake (function
-- fn_ca_reject_diamond_chip_rake_row) on rake_records, club_wallets,
-- rake_attributions and rake_distribution_legs without its row in
-- ca_declared_money_triggers. club_wallets is a table
-- fn_undeclared_money_triggers() watches, so UndeclaredTriggerOnAMoneyTable
-- (critical) has fired since 2026-10-05 22:18 UTC, 26 deliveries, reading a
-- reviewed guard as an unreviewed trigger on a money table. Reviewed
-- 2026-10-09: it moves no money; it refuses any club_wallets row for a Diamond
-- (asset = 'diamonds') club with 'Diamond Rake Is Never A Chip Rake Record'
-- (23514), which keeps Diamond rake off the chip rails. This is its
-- declaration (approved for production by Dan 2026-10-09, "Yes, apply it"),
-- and the proof that the register then lists nothing undeclared.
-- No money moves; no trigger changes.
BEGIN;
SET LOCAL lock_timeout = '5s';

INSERT INTO public.ca_declared_money_triggers (table_name, trigger_name, note)
VALUES ('club_wallets', 'poker_arena_no_chip_rake',
  'Refusal guard from migration 20261005183028 diamond_cash_rake_reads_the_owner_settings: BEFORE INSERT OR UPDATE, refuses any club_wallets row for a Diamond (asset=diamonds) club by name (Diamond Rake Is Never A Chip Rake Record). It moves no money; it keeps Diamond rake off the chip rails.')
ON CONFLICT DO NOTHING;

DO $prove$
BEGIN
  IF EXISTS (SELECT 1 FROM public.fn_undeclared_money_triggers()) THEN
    RAISE EXCEPTION 'MONEY_TRIGGERS_STILL_UNDECLARED';
  END IF;
END
$prove$;

COMMIT;