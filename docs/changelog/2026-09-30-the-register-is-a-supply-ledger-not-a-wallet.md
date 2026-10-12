# The register is a supply ledger, not a wallet

**2026-09-30.** The 1,068 diamond wallets where "the Mint register disagrees
with holdings" are not a money defect. Nobody is short a diamond, nothing is
owed, and **no money moved**. What shipped is the definition and the check.

## What was claimed, and what is true

`20260930055147` (the journal explains the balance) closed a real defect and
left this behind:

> Separately, and out of scope here: the register does _not_ agree with
> holdings wallet-by-wallet. 1,068 wallets differ, netting to zero globally.
> That is a different defect from this one and is untouched.

Read from rows on production today, one clause of that is right and two are
wrong.

**Right:** 1,068 of 1,427 live wallets differ. Confirmed to the wallet.

**Wrong: they do not net to zero.** They differ by **1,021,092 in total** and
**every single one leans the same way**: the wallet holds MORE than its own
register rows add up to. The gross difference equals the net difference
exactly, 1,021,092 = 1,021,092, so **not one wallet is short**. That is the
discriminating fact. A per-wallet money defect scatters in both directions; a
missing opening balance goes one way only.

**Wrong: it is not a defect.** It is the 2026-09-03 opening baseline, and the
register says so in its own row.

## The cause, named to the row

On 2026-09-03 the entire pre-standard diamond supply was acknowledged as ONE
register row:

| op_id                             | holder      | amount    | holder_label                                                           |
| --------------------------------- | ----------- | --------- | ---------------------------------------------------------------------- |
| `baseline:diamonds:2026-09-03:v2` | circulation | 1,030,092 | all player wallets (pre-standard circulation acknowledged as baseline) |

plus two `register-opening-baseline-correction:diamonds:%` rows on 09-05.
Circulation nets **1,623,417**.

`docs/DIAMOND-ACCOUNTING-STANDARD.md` lane B specified that, in those words,
and specified "backfill NOTHING". So every wallet that already held diamonds
on 2026-09-03 carries an opening balance the register counted once, in the
circulation bucket, and never attributed to the holder. The arithmetic closes
without a remainder:

```
  1,623,417   circulation baseline (never attributed to a holder)
 -   602,325   residual on 667 holders whose profiles have since been deleted
 ___________
  1,021,092   the live per-wallet gap, to the diamond
```

And the shape of it is a signup ledger, not noise:

| gap per wallet | wallets | profiles created         | what it is           |
| -------------: | ------: | ------------------------ | -------------------- |
|            300 |     581 | 2026-01-13 to 2026-03-11 | the 300 signup grant |
|            500 |     436 | 2026-03-06 to 2026-09-01 | the 500 signup grant |
|         10,000 |      10 | one second on 2026-02-28 | one seeded fleet     |
|          other |      41 | assorted                 | opening balances     |

## The register's per-wallet truth was there all along

`ca_mint_ledger` carries `balance_before` and `balance_after` on every row.
Checked against production: for **all 1,252** live wallets the register has
ever tracked, a register row at that wallet's latest register instant carries
`balance_after` equal to what the wallet holds today. **Zero drift.**

Independently, `diamond_transactions` sums to holdings for 1,413 of the 1,415
wallets that have a journal. The two exceptions are a `balance_after` left
NULL and a March 2026 legacy row, and both wallets' journals still sum to
their holdings to the diamond.

And the global identity is exact: `fn_ca_mint_supply('diamonds')` = 6,853,624,
`SUM(profiles.diamonds)` = 6,853,624, `fn_ca_diamond_register_vs_supply()`
difference **0.00**, house 0, arena float 0.

## The mistake I made first, recorded so nobody repeats it

The first pass at "does the register's chain end at holdings" ordered each
wallet's rows `ORDER BY created_at DESC LIMIT 1` and reported **38 drifting
wallets, 9,033 diamonds**, every one of them a horse. It was wrong. One
transaction claiming thirty-six daily challenges writes thirty-six journal
rows and thirty-six register rows with the **identical** `created_at`, so
"the last row" picked arbitrarily among them. Read by value, the chain ends
exactly at holdings for all 38.

That is CLAUDE.md 10.86 rule 1 in miniature, made by the detector rather than
by the platform: a check that answered confidently when its ordering could not
tell. It is pinned in the law and written into the column comment, because the
next person to ask this question will reach for the same query.

## What shipped

`20260930164146_the_register_is_a_supply_ledger_and_says_so_per_wallet.sql`,
which moves no money, writes no register row and writes no journal row:

- **`fn_ca_mint_wallet_attribution(uuid)`** answers the per-wallet question in
  one read, with **three** verdicts and never two: `register_agrees`,
  `register_drifts`, and `opening_stock_only` for a wallet the register has
  never tracked. That third one is COULD NOT TELL and is not "balanced".
- **`fn_ca_mint_register_attribution()`** is the summary, and
  **`register_drifts` is the number that matters** (expected 0). It counts the
  only shape a genuine per-wallet fault can take: a wallet the register tracks
  whose balance chain does not end at what it holds. `wallets_net_differs`
  (1,068 today) is reported beside it and is explicitly not a fault count.
- A `COMMENT ON COLUMN ca_mint_ledger.balance_after` saying which of the two
  quantities is a balance, and how to read the chain.
- Section 8 of `docs/DIAMOND-ACCOUNTING-STANDARD.md`, which says the same
  thing where the standard is read, and says plainly: do not attribute the
  baseline per holder to make the net agree.

At install the migration asserts the SHAPE (every wallet gets one of the three
verdicts, the summary keeps every count) and deliberately does not assert the
COUNTS, because it moves no money and must not fail because a wallet moved
while it was applying.

## Installed, and what it reads

Applied to production 2026-09-30 16:41 UTC, recorded as
`20260930164146 the_register_is_a_supply_ledger_and_says_so_per_wallet`. The
file carries that version rather than the one `new-migration.mjs` reserved,
because a file whose name disagrees with the recorded version is a gap
`check-applied-migrations-are-recorded.mjs` would report for ever.

`fn_ca_mint_register_attribution()` immediately after install:

```json
{
  "live_wallets": 1426,
  "register_agrees": 1251,
  "register_drifts": 0,
  "opening_stock_only": 175,
  "wallets_net_differs": 1068,
  "unattributed_opening_stock": 1021092,
  "baseline_circulation_net": 1623417,
  "deleted_holder_residual": -602325,
  "global_identity_difference": 0
}
```

1,623,417 minus 602,325 is 1,021,092. The arithmetic closes with no remainder,
`register_drifts` is 0, and the supply identity is 0.

The whole-platform read was timed before it shipped (CLAUDE.md production DDL
policy rule 7: time the query, do not probe with DDL). The first shape took
**5,581 ms**, and 5.1 s of that was counting journal rows since the last
register row for all 1,427 wallets, which is diagnostic only for a wallet that
drifts. Computed only where the verdict is `register_drifts`, the same read
takes **327 ms** and that subplan was never executed, because nothing drifts.

## Why not just attribute the baseline per wallet

Because it would contradict a written standard (lane B, "backfill NOTHING"),
because it would append 1,231 rows to a money ledger to change no balance, and
because it buys nothing: `balance_after` already answers the per-wallet
question exactly. The live gap and the circulation lump also do not reconcile
to the diamond once deleted holders are included without a residual row, so an
"exact" attribution would be a guess dressed as arithmetic. CLAUDE.md 10.9
rule 1: the outcome is read, not assumed.

## No settlement, and nothing to resolve

There is no `financial_alerts` row naming this, because no alert ever fired:
the global identity has never been out. No player is owed a diamond, so there
is no per-user idempotent credit to write and no paragraph naming who gets
what, because the honest paragraph is that nobody gets anything. Horses and
humans alike: the cohort above is defined by the register and the balance and
by nothing else, and `is_horse` appears nowhere in the migration (CLAUDE.md
10.5).

## Not a repair job

No cron, no sweep, no backfill, no reconciler, nothing scheduled. Two STABLE
functions that read (CLAUDE.md 10.11, 10.12). `register_drifts` is expected to
stay 0; if it ever is not, the fix is the writer that moved a balance the
register did not follow, not a job that tidies the report.

## The law

`tests/the-register-is-a-supply-ledger.law.test.ts` keeps both functions read
only, keeps the third verdict from collapsing into "balanced", refuses a later
migration that re-attributes the baseline per holder or renames either read
into a repair, refuses `is_horse` in the migration, and pins the Diamond Arena
statement's `sessions === 0` branch so a player who has never played is never
told that every session reconciles.
