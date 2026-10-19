# A correction into prize_liability is house funding too

**Root cause.** `fn_tournament_conservation_delta`'s `funded_overlay` term only
recognised a `chip_ledger` leg as house funding when `category='overlay'`. On
2026-09-09, migration `20260909060341_bubble_protection_is_funded_by_the_house_not_the_winner`
correctly paid two Sunday $200 Deep Stack winners (`a449e853-4ee1-4e36-bd38-8fe904664d7c`,
`f7412940-5644-4194-8d57-4a97c182bf04`) the 180.00 that the published payout
structure and bubble protection had double-promised, funding it from the host
club treasury and the union rake wallet respectively into `prize_liability` -
the same shape an overlay funds a guarantee shortfall. That leg was correctly
tagged `category='correction'` (a CLAUDE.md 10.9 backpay, not a guarantee),
but the conservation delta never looked for `'correction'`, so it re-flagged
both already fully-settled tournaments as "Tournament paid out money it never
collected" (delta exactly -180.00, both events, every run of
`fn_tournament_money_conservation` since) - 14+ `financial_alerts` rows for
money that had already been paid correctly, once, in full, 18 days earlier.

**Read, not assumed.** Traced both tournaments' full wallet ledger, payout
rows and `chip_ledger`: each carries exactly one `tournament_payouts`
`source='bubble_protection'` row (180.00, unfunded by anything the delta
already counts) and exactly one `category='correction'`, `to_type='prize_liability'`
`chip_ledger` row (180.00, `from_type` `club_treasury`/`union_bank`) - the
2026-09-09 backpay. Every other `category='correction'` row into
`prize_liability` in the whole table (`0ec5d7b2`, `from_type='settlement_suspense'`,
an already-resolved 2026-09-07 spin escrow shortfall) is not from a house
treasury bank, so the fix scopes to `from_type IN ('club_treasury','union_bank')`
rather than the bare category - matching every existing `'overlay'` row's
`from_type` exactly.

**The fix.** `supabase/migrations/20260927101545_a_correction_into_prize_liability_is_house_funding_too.sql`
widens the `funded_overlay` term to also sum `category='correction'` legs
from a house treasury bank. Read-only, `STABLE`, no side effects - no chips
move. The migration verifies both deltas resolve to 0.00 and resolves the two
now-explained `financial_alerts` rows in the same transaction (CLAUDE.md
10.11: the record is part of the fix).

**Hardening.** `tests/a-correction-into-prize-liability-is-house-funding-too.law.test.ts`
pins the widened term and its treasury-bank scoping; law registered in
`docs/laws.d/`.

**Fleet board:** Smarter-Poker/Smarter-Poker-Club-Arena#5070.
