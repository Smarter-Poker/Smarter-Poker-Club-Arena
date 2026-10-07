# 2026-10-07 - The Diamond cash rake leaves custody without a wallet journal row

Three defects, one money-integrity defect among them, read from production
rows at 11:22 UTC on 2026-10-07.

## 1. The hourly cash rake sweep journalled rake the cash-out had already paid

**Cause, to the line.** `fn_ca_diamond_sweep_cash_rake` (20261005183028,
scheduled hourly at :14 by #6366 / 20261007034146) wrote, per payer per sweep,

```sql
INSERT INTO public.diamond_transactions(user_id,type,transaction_type,amount,balance_after, ...)
VALUES (v_p.user_id,'cash_rake','cash_rake',-v_p.amount::integer,v_wallet, ...)
```

and, by its own comment, did not touch `profiles.diamonds`. That half was
right: `fn_poker_diamond_settle_cash_hand` takes each rake from the payer's
arena custody into `ca_diamond_rake_accrual`, so the payer's `arena_withdraw`
is already smaller by exactly that rake. The journal row recorded it a second
time. The row existed only to drive the Mint register
(`trg_ca_diamond_register_follows_journal` turns a negative journal row into a
player burn, and the sweep asserts the register retired the swept total before
minting it to the house).

**Measured.** 46 `cash_rake` rows from six sweeps (05:14 to 10:14 UTC; 11:14
found nothing), 4,460 Diamonds, 13 wallets. For exactly those 13 wallets
`profiles.diamonds - SUM(diamond_transactions.amount)` equalled their
cash_rake total; every other wallet's journal explained its balance exactly
(drift was 0 after the 2026-09-30 settlement). The same rows also allocated
2,386 Diamonds of phantom spend against Lifetime VIP diamond lots (30
allocations), because `trg_allocate_lifetime_vip_diamond_spend` fires on every
negative journal row.

**Design chosen.** The register burn is right (the register counts custody
Diamonds as still the player's, because the arena doors are not followed by
design), so it stays; the wallet journal was the wrong carrier for it. The
sweep (`20261007112751`) now writes the player-holder burn into
`ca_mint_ledger` itself, `op_id poker-cash-rake-sweep:<sweep>:<user>`,
`balance_before = balance_after =` the untouched wallet, and writes no
`diamond_transactions` row. Rake revenue keeps its own records where it
belongs: per hand and per payer in `ca_diamond_rake_accrual` (stamped with
the sweep id), one house mint per sweep in `ca_mint_ledger`, and
`ca_diamond_house`. The retired-from-players and identity assertions are
unchanged in meaning.

Rejected: splitting the cash-out into gross plus rake. Rake is taken per hand
and swept per hour; a cash-out happens once per session, before or after any
given sweep, so the split would need a cash-out row that may not exist yet.

**Settlement (`20261007112808`).** No balance moves: the wallets are right and
the journal was wrong. The 46 rows stay as written (append-only); each gets one
correcting `cash_rake_correction` row of the opposite sign, keyed
`cash_rake_correction:<original id>`, marked `journal_backfill` so the
register (whose burns were correct) does not follow it, `issuance_class
'admin'` so it never reaches the promotional earn ledger. Proved first in one
self-aborting `DO` block on production: 46 inserted, 0 wallets left
unexplained, 0 register rows followed, 0 earn rows, identity 0.00, 0 Diamonds
of balance moved; then rolled back and re-read (0 rows remained).

Who and why: thirteen players, every one a horse, settled exactly as humans
would be (CLAUDE.md 10.5). Each keeps every Diamond in their wallet and gets a
correcting ledger line for each Diamond Arena rake line their cash-out had
already paid: kanelockhart 1,199 (6 rows), wilderquintero 1,063 (6), oakesvane
459 (5), cyrusthackeray 395 (3), groveellsworth 356 (2), quinnsinclair 247 (3),
maceabernathy 156 (5), sagemontrose 153 (2), sagehartley 106 (4),
prairieunderwood 102 (3), thornefairbanks 91 (3), indigoravenscroft 82 (1),
kaneashcroft 51 (3).

**Lifetime VIP lots, left as they are.** The 2,386 Diamonds of phantom lot
consumption are not reversed. Those lots expire 2026-12-31 to 2027-01-02;
restoring their remaining amount would make more Diamonds expire from these
players later than will now, which is taking back from a player for our defect
(10.9 rule 3). The live fix stops it recurring: the sweep writes no negative
journal row, so it allocates no lot.

**No `financial_alerts` row exists for this defect** (searched the last day for
cash_rake, journal, register and diamond); nothing to resolve.

## 2. register_drifts 0 -> 29 was the verdict misreading the design

All 29 drifting wallets (all horses) satisfied
`held = register chain end + SUM(journal rows after the last register row)`,
and every one of those rows was an `arena_deposit` or `arena_withdraw`.
`fn_ca_diamond_journal_origin` refuses to register the arena doors by design
(2026-09-08: a buy-in moves the player's own Diamonds, it issues or retires
none). The rake rows were not a cause: their register rows carried
`balance_after =` the wallet at the sweep. So the register is not following
arena legs because it must not, and `fn_ca_mint_wallet_attribution` now carries
the chain forward over journal rows the register does not follow by design
(origin NULL), while still reporting a drift for any row it should have
followed. Read against production before applying: 0 drifts, 0.35 s.

## 3. A Mint grant was labelled "Diamonds You Bought"

`fn_diamond_kind_bucket` mapped `mint` to `purchases`. Every `mint` row (1,857,
2,758,000 Diamonds) is a signup grant, a Lifetime VIP monthly benefit or a
horse bankroll; purchases write `purchase`. `mint` now buckets as `bonuses`
("Bonuses And Promotions"), and `cash_rake_correction` is named in
`adjustments`. The emitted bucket set is unchanged, so the World Hub contract
(`scripts/ci/lib/diamond-wallet-contract.mjs`) still matches. The two tests
that pinned the live map by file path (`the-diamond-arena-is-diamonds-only`,
`whereTheDiamondsGo`) are repointed; the SQL harnesses load the pre-rake map as
their baseline on purpose and are unchanged there.

## 4. VIPPage printed a balance-after of 0 for rows that recorded none

`Number(entry.balance_after ?? 0)` became `readBalanceAfter(...)`
(`src/utils/readBalanceAfter.ts`), and the activity timeline prints
"Not Recorded" for a null (CLAUDE.md 10.86).

## Found, same class, not changed here

`fn_poker_diamond_tournament_drain` journals a house-bound tournament fee or
Spin surplus from custody with no wallet movement, exactly as the sweep did.
It has written no row yet (0 `tournament_fee`, 0 `arena_spin_surplus`). Its
movement table requires a `wallet_journal_id` on every non-zero release and it
has two callers with their own register assertions, so it needs its own
change. The extended law binds it the moment it is next redefined.

## Pins

- `tests/the-journal-explains-the-balance.law.test.ts`: no function written
  from 20261007112751 on may insert a wallet journal row without moving the
  wallet; the sweep retires in the register with no journal row; the
  settlement moves no balance, corrects row for row and stays out of the
  register.
- `tests/sql/run-diamond-cash-rake.py`: runs the live sweep on isolated
  PostgreSQL 17 and asserts no journal row, one register burn per payer
  (horse included), no wallet movement, identity 0 (49 checks).
- `tests/unit/aMissingBalanceAfterIsUnknown.test.tsx`.
