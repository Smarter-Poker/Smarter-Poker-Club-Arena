-- ═══════════════════════════════════════════════════════════════════════════
--  THE HEADS-UP RAKE IS A RULE, NOT A CONVENTION (2026-08-31, Phase 3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `tournaments_rake_within_10_pct` caps every tournament shape at a flat 10%.
-- A two-seat game pays 5% (src/config/headsUpSpec.ts, HEADS_UP_RAKE_RATE), and
-- until 2026-08-26 nothing but code said so. The history shows what the gap
-- permitted, measured over the last seven days of rows:
--
--     1,378 duel rows charged 10%   (18+2, 9+1, 90+10, 45+5)
--       456 charged 8%              (23+2)
--         7 charged 6.67%           (14+1)
--     all of them created on or before 2026-08-25; ZERO since.
--
-- So this is a latent regression with no guard, not an active overcharge, and
-- one edit to one helper is all that stands between the platform and doing it
-- again on a recurring schedule.
--
-- NOT VALID on purpose: the 2,300 historical rows above stay exactly as they
-- are. Rewriting settled money to satisfy a new constraint would be a far
-- worse idea than leaving an honest record of what was charged. The constraint
-- applies to every INSERT and UPDATE from now on, which is the whole point.
--
-- A cent of tolerance because fees are cut in cents (feeToCents), so a 1-chip
-- game's 0.05 must pass rather than fail on binary rounding.
--
-- Probed on production inside a rolled-back block before this file was
-- committed: a 95+5 duel row INSERTed, the same row UPDATEd to 90+10 was
-- refused with check_violation, and zero probe rows remain.
alter table public.tournaments
  drop constraint if exists tournaments_heads_up_rake_within_5_pct;

alter table public.tournaments
  add constraint tournaments_heads_up_rake_within_5_pct
  check (
    max_players is null
    or max_players > 2
    or coalesce(buy_in_fee, 0)
       <= round((coalesce(buy_in_amount, 0) + coalesce(buy_in_fee, 0)) * 0.05, 2) + 0.005
  )
  not valid;

comment on constraint tournaments_heads_up_rake_within_5_pct on public.tournaments is
  'A two-seat tournament charges at most 5% of what the player pays (headsUpSpec.HEADS_UP_RAKE_RATE). NOT VALID: rows written before 2026-08-26 carry 6.67-10% and are left as the honest record of what was charged.';
