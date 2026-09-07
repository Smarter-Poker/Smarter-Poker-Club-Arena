# 2026-09-07 - Phase 5 measured: the partition blocker is not the one written down

Roadmap 8.4 says `chip_ledger` partitioning is "blocked on the
`ca_mint_ledger.chip_ledger_id` foreign key (a partitioned parent's unique key
must carry the partition column)". Measured before building anything, because
this programme's premises have now been stale twice.

## The named blocker is gone. Two worse ones are not.

**There is no foreign key into `chip_ledger`.** Zero, from any table. The
`ca_mint_ledger.chip_ledger_id` column still exists and 361 of its 7,321 rows
still hold a ledger id, but nothing constrains them any more. That is not
"unblocked" - it is a reference that outlived the constraint that protected it,
so a partition dropped in the future would orphan those 361 rows silently
where the FK would once have refused.

The real blockers are two UNIQUE indexes, and they are the journal's integrity:

| index                                                      | what it guarantees                   | scans in 4d 8h |
| ---------------------------------------------------------- | ------------------------------------ | -------------- |
| `ux_chip_ledger_idempotency_key` (partial, WHERE NOT NULL) | a payment is recorded once           | 113,642        |
| `chip_ledger_chain_seq_key`                                | the hash chain has no duplicate link | 1,925,003      |

Postgres requires every unique index on a partitioned table to include the
partition key. Partition by `created_at` and both become
`(key, created_at)` - which is not a weaker version of the same guarantee, it
is a different guarantee. **The same idempotency key in two different
partitions would both be accepted**, which is precisely the defect I fixed on
`tournament_payouts` three days ago, re-introduced into the journal itself. The
chain's uniqueness goes the same way.

So 8.4 as written cannot be built. It can be built like this, and the design is
worth writing down before anyone tries the naive version:

> Partition the journal by month on `created_at` with the primary key
> `(created_at, id)`, and move the two global guarantees into small companion
> tables that are NOT partitioned - `chip_ledger_key(idempotency_key PRIMARY
KEY, leg_id, created_at)` and the same shape for `chain_seq`. Every insert
> writes the companion first; the unique violation there is what refuses a
> double. The companions stay small because they hold one row per leg and no
> payload, and they are never dropped when a partition is.

## Growth, measured

`chip_ledger` is **1,666 MB** - 839 MB of rows and **826 MB of index**, which
is the first thing worth noticing. 2,002,532 legs, oldest 2026-03-19, and
**nothing prunes it**: there is no retention policy, no archive, no prune
function, and no partitioned table anywhere in `public`.

Its rate is not what the roadmap recorded, because the chip standard changed
it. Legs per day:

```
08-27  33,922      09-02  169,076
08-28  25,467      09-03  527,563   <- the declaration work lands
08-29  28,644      09-04  392,608
08-30  24,107      09-05  225,648
08-31  56,327      09-06  263,705
09-01  90,734
```

An eight-fold rise in a week. That is the cost of phases 1-8 making every money
path declare itself, and it is the right cost - but it means the journal now
grows about 3.5 GB a month and accelerating, with no policy for what happens
next.

`hand_history`, for comparison: **9,464 MB**, 3,547,741 rows, 509,027 hands a
day, **1.32 GB a day**. Its 7-day horse prune works exactly as designed -
99.92% of the table is younger than seven days, 2,822 rows are 7-30 days old
and three are older.

## The index set costs as much as the journal

826 MB of index against 839 MB of rows, and every one of them is maintained on
every insert - 285,000 a day. Over a 4 day 8 hour window (since the 09-02
restart; 1,924,695 inserts, 7,190,648 index scans, so a representative sample
and not a fresh reset):

| index                                   | size   | scans     |
| --------------------------------------- | ------ | --------- |
| `idx_chip_ledger_club_to_created`       | 157 MB | **4**     |
| `idx_chip_ledger_club_from_created`     | 146 MB | 464       |
| `ix_chip_ledger_settlement`             | 45 MB  | **3**     |
| `idx_chip_ledger_club_created_desc`     | 77 MB  | 6,720     |
| `idx_chip_ledger_overlay_by_tournament` | 32 kB  | 4,678,680 |

**The 3-scan index is not dead and must not be dropped.** `settlement_id` is
read by `fn_ca_settlement_correctness_check`, `fn_ca_quick_reconcile`,
`fn_ca_adjustments_report` and `fn_ca_journal_append_only` - three scans in
four days is a nightly check doing its job, and 45 MB is what it costs to let
that check finish instead of timing out. This is the same trap as the "0 of 982
events" reading: a low number is not evidence of absence.

The two club-prefixed composites are a different case - 303 MB for 468 scans,
against `(club_id, created_at DESC)`, `(to_entity_id, created_at DESC)` and
`(from_entity_id, created_at DESC)` which already serve 152,000 scans between
them. They look genuinely redundant. **They are not dropped here**: index
surgery on the busiest money journal is exactly the class of change Dan's risk
rule says to leave alone without a reason to do it now, and the reason to do it
is a retention decision that has not been made.

## Nothing was built, and why

Roadmap 9.4 says the journal's retention policy "has to be settled in the same
work as 8.4, not after it", and it is right: partitioning without retention
just renames the problem, and a partition you never drop costs more than the
table it replaced. Retention is Dan's - 10.5 records him deciding the 7-day
horse window himself, on the record, as a storage decision - so the build waits
on a decision, not on engineering.

The horse-recording gate is the same shape and is put to him with the numbers
below.

## The two decisions, with what each costs

**1. How long is a leg of the journal kept?** Today: for ever, no policy,
1,666 MB and about 3.5 GB a month. The options and their costs are in the
message to Dan; the cheapest correct answer is probably a partitioned journal
with a long retention (a year or more) and an archive, because the legs are
what proves every balance and the replay in 8.1 reads them.

**2. Does a horse-only hand still write a full `hand_history` row?** Measured
over 24 hours: **494,000 hands, 17 of which had a human in them** - 0.0034%.
At 1.32 GB a day, essentially all of that 9.5 GB is horses playing horses. But
10.5 is binding and explicitly rejects "equal outcome by a different
mechanism", and bounty attribution reads those rows to decide who busted whom
in tournaments that pay real chips. It is Dan's call and always was.
