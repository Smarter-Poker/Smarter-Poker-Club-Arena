-- BACKFILLED 2026-09-01 from supabase_migrations.schema_migrations.statements.
-- Applied to production 20260828024112; the .sql file was never committed at the
-- time (see docs/changelog and issue: unrecorded-migration backfill). Content is
-- byte-exact to what ran. Do NOT re-apply; it is already live.

-- Money-path audit 2026-08-27. Unblocking remediation.
--
-- tournaments_spin_has_no_fee encodes a real rule: a Spin's price is its buy-in,
-- there is no separate fee line. It was added AFTER 7,120 Spin rows had already
-- been written carrying a non-zero buy_in_fee.
--
-- The constraint is already NOT VALID, and the assumption seems to have been that
-- this grandfathers those rows. It does not. NOT VALID only skips the initial
-- full-table validation; the CHECK is still enforced on every INSERT *and every
-- UPDATE*. So any UPDATE touching one of those 7,120 rows fails outright with
-- 23514 - including the ones remediation needs to make. This was found the hard
-- way: a guard smoke-test picked a legacy Spin at random and aborted on it.
--
-- Practical effect if left alone: the survivor-ranking trigger, the stale-board
-- reaper, the payout sweep and every back-pay silently cannot touch a seventh of
-- the Spin table. It would have looked like those rows were simply being skipped.
--
-- Measured: 7,120 violators, first 2026-04-13, last 2026-08-20 19:17 UTC, ZERO of
-- them still live (all COMPLETED or CANCELLED), 1,373.60 of buy_in_fee between
-- them. Nothing has violated the rule since 20 Aug.
--
-- So: grandfather by creation date rather than by rewriting history. Zeroing
-- buy_in_fee on 7,120 settled events would falsify what those players were
-- actually charged, and that data is the evidence base for the rest of this
-- audit. The rule stays fully enforced for everything created from 21 Aug onward,
-- which is every Spin the platform will ever create from here.

ALTER TABLE public.tournaments DROP CONSTRAINT IF EXISTS tournaments_spin_has_no_fee;

ALTER TABLE public.tournaments
  ADD CONSTRAINT tournaments_spin_has_no_fee CHECK (
    created_at < TIMESTAMPTZ '2026-08-21 00:00:00+00'
    OR (
      (lower(COALESCE(variant, ''::text)) <> 'spin'::text
       AND upper(COALESCE(tournament_type, ''::text)) <> 'SPIN'::text)
      OR COALESCE(buy_in_fee, (0)::numeric) = (0)::numeric
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT tournaments_spin_has_no_fee ON public.tournaments IS
  'Spins carry no separate fee. Rows created before 2026-08-21 are grandfathered: '
  '7,120 legacy rows predate the rule and must stay UPDATE-able for remediation.';
