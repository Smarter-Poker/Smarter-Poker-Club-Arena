# A Horse Rebuys From Its Own Wallet Before The Club Treasury

**Date:** 2026-10-02
**Migration:** `20261002134205_a_horse_rebuys_from_its_own_wallet_before_the_club_treasury.sql`
**Owner decision:** Dan, 2026-10-02: "you decide if you want to pay them or not, it doesn't matter as long as the bug / glitch is fixed."

## The Bug

Deep Stack Society's treasury reached zero within a day and was kept alive by two
direct `UPDATE clubs.chip_treasury` top-ups (auto-ledgered as `system_mint`:
14,630.53 at 09:44 UTC and 34,625.00 at 11:30 UTC).

A horse's first buy-in already came out of its own club wallet
(`player_wallet -> table_stack`, category `buyin`) and every cash-out went back to
that wallet (`table_cashout`). Its rebuy after a bust did not: the engine's
`autoRebuyHorse` calls `fn_horse_fund_from_treasury`, whose money core paid the
whole rebuy from `clubs.chip_treasury`. So the treasury paid for every bust and
the chips it funded cashed out to the horse's wallet: an open loop.

Measured 2026-10-02 13:30 UTC:

| Club               | Rebuys paid by treasury  | Horse wallets                           | Treasury                           |
| ------------------ | ------------------------ | --------------------------------------- | ---------------------------------- |
| Deep Stack Society | 879 / 104,403.00 in 24 h | 416 horses, 5,491,527.72 (min 5,349.15) | 36,765.00 after the manual top-ups |
| Club JAQK          | 206 / 47,195.00 in 48 h  | 580 horses, 84,024,233.71               | 4,369.76                           |
| SHARK CLUB         | 235 / 47,275.00 in 48 h  | 584 horses, 58,599,434.92               | 20,870.68                          |

DSS treasury outflow per day since 2026-09-18 was 45,000 to 97,000, of which
horse rebuys were 33,000 to 93,000, against zero inflow.

## The Fix

`fn_horse_fund_from_treasury_before_maintenance_gate` (the money core behind the
public door) now pays the rebuy from the horse's own wallet in the seat's club
first, through the same add-on door a human uses
(`atomic_table_addon_before_maintenance_announcement_gate`: wallet debit,
`player_wallet -> table_stack` `addon` leg, wallet journal, chip continuity
baseline, funding receipt keyed `horse_fund_wallet:<op>`). Only a shortfall the
wallet cannot cover is drawn from the treasury, with the same
`horse_funding` leg, key `horse_fund:<op>` and funding receipt as before.

A horse's money is now a closed loop on its own roll, which is the roll
`horseRebuyAmount` already sizes the rebuy from, and it is what CLAUDE.md 10.5
requires: the same buy-in, out of the same club wallet, through the same RPC.
The treasury is no longer touched by a horse that can pay for itself, so nobody
needs to top it up by hand for horses.

No engine change: the public door, its receipt and the response fields the
engine verifies are unchanged (`amount` is still the full rebuy;
`wallet_amount` and `treasury_amount` are added).

## Chips Already In Horse Wallets

They stay. CLAUDE.md 10.9 rule 3 (nothing is taken back from a player for our
defect) and 10.5 ("they are horses" is never the reason to take money back)
forbid a clawback, and none is needed: from now on those wallets pay the horses'
own rebuys, which is exactly the spend the treasury was carrying. The two manual
mints stay recorded as they are.

## Rake Into A Standalone Treasury (Finding, Not Changed Here)

Union clubs' rake goes to `union_wallets.rake_wallet` and comes back to each
club treasury in the weekly union close (`union_wallet -> club_treasury`
rakeback: JAQK 370,167.88, SHARK 356,237.81 on 2026-10-01/02), which covers
their weekly commission (324,124.23 and 290,943.43). With rebuys closed, union
treasuries balance.

A standalone or private game's rake has been retired since
`20260917181100` (`table_stack -> chip_retirement`, "Standalone cash rake
retired"; DSS 31,000 to 58,000 a day), and standalone tournament fees likewise,
while the standalone weekly close still pays commission and rakeback out of
`chip_treasury` (DSS 317,122.74 on 2026-09-29, 207,388.87 on 2026-10-02). That
contradicts `.agent/architecture/CLUB-MONEY-LEDGERS-CANONICAL.md` (standalone
rake to `chip_treasury`). It is not changed here: crediting the treasury per
hand is the club-row lock that `20260929040413` removed after measured
HandProjection timeouts, and the weekly bank belongs to the weekly close
coordinator, which this task was told not to touch.

## Verification

- Production probe, one self-aborting DO block with a `pg_temp` copy of the body:
  wallet path 2.00 gives one `addon` leg, wallet -2.00, treasury unchanged, one
  receipt; split path (wallet 0.75) gives `addon` 0.75 plus `horse_funding`
  1.25 keyed `horse_fund:<op>`, treasury -1.25, two receipts.
- `scripts/ci/probes/chip-journal-atomicity/test_atomicity.py fixed --bootstrap`
  on local PostgreSQL 17: all suites pass, including `reload_funding` (5 fault
  cases, wallet path) and horse funding receipts (14 cases, treasury path).
