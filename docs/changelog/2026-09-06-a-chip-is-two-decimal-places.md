# 2026-09-06 - A chip is two decimal places, everywhere it is stored

Phase 3 of the chip-accounting programme (`docs/CHIP-ACCOUNTING-ROADMAP.md`
Part Two): "one definition of a chip".

## Measured first

Every money column in the conservation set, ~4.7 million rows, read on
production at 16:15 UTC:

| precision         | columns | examples                                                                                                                                                 |
| ----------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scale 2, correct  | 11      | `chip_ledger.amount`, `club_members.chip_balance`, `table_seats.stack`, `clubs.chip_treasury`, `wallet_transactions.amount`, `hand_history` pot/rake/bbj |
| scale 4           | 7       | `agents.agent_wallet_balance`, `club_wallets` x3, `rake_records` x2, `tournaments.total_rake`                                                            |
| **unconstrained** | **10**  | `tournament_payouts.amount`, `tournament_escrow` x3, `tournaments.prize_pool`/`bounty_pool`, `union_wallets` x3, `bomb_pot_award_units.amount`           |

**And the residue is one row.** Of 4.7M, exactly one value is not a whole
cent: `tournament_payouts` `aac184db`, amount `55.629999999999995` — 55.63
with IEEE754 noise, written by `backfill_2026_08_31`. The player was
correctly credited 225.62; nothing was mispaid. The roadmap's "no sub-cent
residue in live data" is right to one row.

## The distinction that decided the fix

A `numeric(18,4)` column **rounds on write**, so a float artifact handed to it
lands as `55.6300` — imprecise about the definition of a chip, but it cannot
leak one. An **unconstrained** `numeric` rounds nothing and stores the full
binary expansion, which is exactly how the one bad row got in. So the ten
unconstrained columns are the whole job; the scale-4 columns are a follow-up
that changes no value.

`ALTER TYPE`, not a `CHECK`: a CHECK **refuses** the write, so a prize credit
whose float ends in `...9995` would leave a player unpaid — trading a rounding
error for an outage. A declared scale rounds instead. Every legitimate value
is unchanged, float noise is neutralised, and no money path can ever be
refused for it. The bad value becomes unrepresentable rather than detected
(CLAUDE.md 10.11).

## Two migrations, because the hot table deadlocked

**`20260906162156`** (applied 16:27 UTC) — eight columns:
`union_wallets` x3, `tournament_escrow` x3, `bomb_pot_award_units.amount`,
`tournament_payouts.amount`. The type change rounded the artifact row to
55.63 as a side effect, which is the value it always meant.

`union_wallets` needed care: `trg_ca_autoledger` is declared `UPDATE OF
chip_balance, rake_wallet, ...`, and Postgres will not retype a column named
in a trigger's column list (the first run aborted on exactly that, with
nothing applied). That trigger journals every union wallet movement into
`chip_ledger`, so it is not re-typed by hand — its definition is read with
`pg_get_triggerdef`, dropped, and re-issued **verbatim from the captured
string**, inside the same transaction that already holds ACCESS EXCLUSIVE.
The recreation cannot drift from the original because it _is_ the original,
and the migration asserts it came back identical.

**`20260906162705`** — `tournaments.prize_pool` and `.bounty_pool`, run inside
the **:55 maintenance freeze**. They were in the first migration and it
deadlocked:

```
16:25:18  deadlock detected
Process A waits for AccessExclusiveLock on relation tournaments; blocked by B.
Process B waits for RowShareLock on auth.users; blocked by A.
```

Nothing was applied — the transaction rolled back whole, which is the design.
`tournaments` is 147 MB and every seat, registration and finish writes it; at
~460 hands a minute an ALTER TYPE rewrite is competing for the one lock
nothing else can share. CLAUDE.md 13 already provides the window: between :55
and :00 the platform is frozen and no money moves. Its `lock_timeout` is
deliberately short — inside the freeze the lock is free, so a long wait means
the freeze is _not_ in effect and the migration should abort rather than
fight live play again.

Splitting them is what let the other eight land immediately instead of
waiting.

## Pinned

`tests/a-chip-is-two-decimal-places.law.test.ts`: every conservation column is
given scale 2 by the TYPE and never by a CHECK; the hot table is altered only
in the freeze migration and says why; both pool columns move in one statement
so the table rewrites once; the union auto-ledger is captured and restored
rather than hand-written; and each migration proves the scale it claims.
