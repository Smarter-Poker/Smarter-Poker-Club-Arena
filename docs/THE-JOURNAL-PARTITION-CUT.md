# The journal partition cut - Dan's rulings and the staged plan

**Status: rulings made 2026-09-07, build not started. Read this before writing
any partitioning migration.** Roadmap 8.4 and 9.4 are superseded by what is
below, because 8.4's stated blocker does not exist and the real ones are worse.

## Dan's rulings, 2026-09-07

**1. `chip_ledger` keeps every leg, for ever, partitioned by month.** Nothing is
dropped. Partitioning is for making old months cheap to read and archivable
later, not for deleting them. This settles roadmap 9.4, which said the retention
policy had to be decided in the same work as the partitioning.

**2. `hand_history` keeps exactly what it keeps today.** The 7-day horse-only
window and the forever-keep for any hand a human was dealt into are both
unchanged, so CLAUDE.md 10.5 is untouched. What changes is only the mechanics:
the prune becomes `DROP PARTITION` instead of a mass `DELETE`.

Both were put to him with the measurements in
`docs/changelog/2026-09-07-phase-5-the-partition-blocker-measured.md`.

## What the retention flag is worth, since everything rests on it

`hand_history.has_human` decides what the prune keeps. Checked against the
participant index over the two-hour window that contained the only human hands
of the day: **23,722 hands, 17 flagged human, 17 actually human, zero
disagreements in either direction.** It is trustworthy, and a partition cut must
keep it that way - the pruning predicate moves from a `WHERE` clause to the
choice of which partition to drop, and a horse-only partition can only be
dropped if no hand in it has a human.

**That is the one thing a naive day-partition gets wrong.** A day's partition
holds both horse-only and human hands, and human hands are kept for ever, so no
day can simply be dropped. The partition key has to be `(has_human, day)` - list
on the flag, range on the day - or the human hands have to live in their own
table. This is the single most important design note here and it is why "just
partition by day" would quietly start deleting human hand histories.

## The real blocker, on both tables

Postgres requires every UNIQUE index on a partitioned table to include the
partition key. That is fatal to four guarantees:

| table          | index                                | what it guarantees                   | scans measured   |
| -------------- | ------------------------------------ | ------------------------------------ | ---------------- |
| `chip_ledger`  | `ux_chip_ledger_idempotency_key`     | a payment is recorded once           | 113,642 in 4d 8h |
| `chip_ledger`  | `chip_ledger_chain_seq_key`          | the hash chain has no duplicate link | 1,925,003        |
| `hand_history` | `hand_history_pkey`                  | one row per hand id                  | -                |
| `hand_history` | `uq_hand_history_global_hand_number` | one hand per global hand number      | -                |

Add `created_at` to any of them and it stops meaning what it says: the same
idempotency key in two months would both be accepted, which is exactly the
double-record defect fixed on `tournament_payouts` on 2026-09-06, re-introduced
into the journal itself.

`hand_history` carries three foreign keys pointing INTO it as well -
`ca_hand_facts`, `ca_hand_notes`, `ca_hand_flags` - and eight triggers. PG17
does allow a foreign key to reference a partitioned table, but only against a
unique constraint that includes the partition key, so all three children need
their reference widened in the same cut.

`chip_ledger` has **no** foreign key pointing at it, which is not the good news
it sounds like: `ca_mint_ledger.chip_ledger_id` still holds 361 live references
with nothing constraining them, so a dropped partition would orphan them
silently. Under ruling 1 no partition is ever dropped, so this is latent rather
than urgent - but the cut should re-establish the constraint while it is in
there.

## The design that works

Move the global guarantees OUT of the partitioned table and into small companion
tables that are not partitioned:

```
chip_ledger_idem (idempotency_key text PRIMARY KEY, leg_id uuid, created_at timestamptz)
chip_ledger_chain(chain_seq bigint PRIMARY KEY, leg_id uuid, created_at timestamptz)
```

Every insert writes the companion first and the unique violation THERE is what
refuses a double. The companions hold one narrow row per leg and no payload, are
never dropped when a partition is, and keep working across every month. The same
shape serves `hand_history`'s global hand number.

## The stages, in order, each shippable and verifiable on its own

1. **Companions built and backfilled, still unused.** Additive, reversible,
   proves the backfill is exact (`count` and `EXCEPT` both directions) before
   anything depends on it.
2. **Writes start filling the companions**, unique indexes still in place. Both
   mechanisms live at once; any disagreement is a bug found before the cut.
3. **The new partitioned parent is created and backfilled** in batches off the
   hot path, with `(has_human, day)` for `hand_history` and monthly range for
   `chip_ledger`.
4. **The cut, inside the :55 freeze** (CLAUDE.md 13): rename, re-point the three
   `hand_history` foreign keys, move the eight triggers, re-establish
   `ca_mint_ledger.chip_ledger_id`.
5. **The prune becomes `DROP PARTITION`**, and only for a partition proved to
   hold no human hand.

Stage 1 is safe to start immediately. Stage 4 is the only one that needs a
freeze window, and it is the only one that is not reversible in a minute.

## What was deliberately not done, and why

**The index set was left alone.** `chip_ledger` carries 826 MB of index against
839 MB of rows. `idx_chip_ledger_club_to_created` is 157 MB and was scanned
**four times** in four days; `idx_chip_ledger_club_from_created` is 146 MB for 464. They look redundant against the three narrower indexes that serve 152,000
scans between them, and under ruling 1 - keep every leg for ever - that cost
compounds.

But `ix_chip_ledger_settlement` is 45 MB and was scanned **three** times, and it
is NOT dead: `fn_ca_settlement_correctness_check`, `fn_ca_quick_reconcile`,
`fn_ca_adjustments_report` and `fn_ca_journal_append_only` all read
`settlement_id`. Three scans in four days is a nightly check doing its job. A
low number is not evidence of absence - the same trap as reading "0 of 982
events" as a fix - so the two that look redundant get dropped as part of stage
3, with the plan measured first, and not as an unprompted change to the busiest
money journal on the platform.
