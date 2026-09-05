-- ===========================================================================
-- THE SEVEN SUPPLY BREACHES OF 2026-08-31, EXPLAINED AND ABSORBED
-- ===========================================================================
-- Settled under CLAUDE.md 10.9 (YOU DECIDE THE MONEY). All five tests pass:
-- the outcome is READ from rows, nobody is paid twice (nothing is paid at
-- all), nothing is taken back from a player for our defect, no balance is
-- touched so there is nothing to probe, and the paragraph is below.
--
-- WHAT HAPPENED. Snapshots 2-8 (2026-08-31 15:05 to 20:05 UTC) carry
-- unexplained deltas totalling 3,290,063.53 chips. They are not seven events;
-- they are seven consecutive hourly snapshots of one event. Tournament stacks
-- are PLAY chips and are deliberately excluded from the supply total (the
-- `felt` term skips tournament tables), so a tournament stack cashing out
-- into a real wallet moves a chip into the counted world from outside it,
-- with no ledger row of a minting type. That is exactly what `unexplained`
-- measures, and the instrument was working correctly.
--
-- VERIFIED INDEPENDENTLY for this settlement, not taken on report: summing
-- chip_ledger where from_type='table_stack' and to_type='player_wallet',
-- joined to tables with a non-null tournament_id, over 2026-08-31 gives
-- 26,715.00 + 214,665.00 + 559,587.50 + 1,258,184.43 + 475,020.00 + 56,708.00
-- = 2,590,879.93 across 412 rows in six hours, and ZERO in every hour after
-- 19:00 that day. The remainder of the 3.29M is the 200,000 settlement
-- suspense to club treasury and 400,000 of club-opening credits that were
-- unledgered as mints at the time (fixed 20:09 by
-- ca_phase5_opening_bank_is_a_mint), plus ~110k residue.
--
-- ALREADY FIXED, AND THE FIX IS HOLDING. Migrations
-- 20260831192940 ca_phase4_tournament_table_cashout_mint_guard (19:29) and
-- 20260831194043 ca_phase5_credit_wallet_tournament_mint_guard (19:40) block
-- this in all three cash-out paths, and the flow stops dead inside that hour.
-- Re-verified 2026-09-05: exactly one such row exists since, on 2026-09-04 at
-- 13:07 for 230.00 chips, and it is NOT a recurrence - it is
-- actor_service='chip-std-migrate', category='correction', on a COMPLETED
-- tournament, mislabelled `table_stack` only because the ledger mirror
-- trigger defaults the counterparty when the caller declares none.
--
-- DISPOSITION: 2,590,879.93 chips created by this defect remain in player
-- wallets and are ABSORBED. CLAUDE.md 10.9 rule 3 is not discretionary -
-- overpay our defect caused is absorbed, reported and left alone, and it does
-- not become clawable because the players happen to be horses (10.5: horses
-- are players). Largest balances still holding it: co captain, george
-- moretti, pebbles. No balance is altered by this migration.
--
-- This acknowledgement closes a finding that could not otherwise ever clear,
-- because fn_ca_unacknowledged_supply_breaches reports an unacked breach
-- FOREVER. It does not close the separate, still-open question of the ~+/-1k
-- hourly residual drift, which is the read-window race inside
-- fn_ca_supply_snapshot and is recorded as its own item.
-- ===========================================================================

INSERT INTO ca_supply_breach_ack (snapshot_id, acknowledged_by, reason, acknowledged_at)
SELECT s.id,
       'claude-daily-horse-audit',
       'Tournament play-chip stacks cashed out 1:1 into real wallets between '
       || '2026-08-31 14:50 and 19:40 UTC: 2,590,879.93 chips over 412 ledger rows, '
       || 'plus 200,000 settlement-suspense to treasury and 400,000 unledgered '
       || 'club-opening credits. Tournament stacks are excluded from the supply '
       || 'total by design, so this entered the counted world from outside it and '
       || 'was correctly reported as unexplained. Closed by the mint guards in '
       || 'migrations 20260831192940 and 20260831194043; zero such rows since. '
       || 'The chips already created are ABSORBED per CLAUDE.md 10.9 rule 3 (no '
       || 'clawback for a platform defect) - no balance was altered. See '
       || 'docs/changelog/2026-09-04-audit-flaw-sweep.md.',
       now()
  FROM ca_supply_snapshots s
 WHERE s.id BETWEEN 2 AND 8
   AND abs(COALESCE(s.unexplained, 0)) > 5000
   AND NOT EXISTS (SELECT 1 FROM ca_supply_breach_ack a WHERE a.snapshot_id = s.id);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM ca_supply_breach_ack WHERE snapshot_id BETWEEN 2 AND 8;
  IF n <> 7 THEN
    RAISE EXCEPTION 'expected 7 acknowledged breaches, found %', n;
  END IF;
END $$;
