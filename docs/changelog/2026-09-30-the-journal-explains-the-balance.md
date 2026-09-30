# The journal explains the balance

**2026-09-30.** 439 diamond wallets held 220,985 diamonds that
`diamond_transactions` could not account for. The missing journal rows are
written. No balance moved.

## What was wrong

A third of the wallets that had a ledger at all showed the player two numbers
on one screen that could not both be true. `fn_diamond_wallet_summary` reads
`on_hand` from `profiles.diamonds` and `lifetime_earned` / `lifetime_spent`
from `diamond_transactions`, so a wallet whose journal was short by 500 said
both "you have 1,030" and "you have earned 545".

The gap was always the balance being HIGH, never low. **No player was ever
short a diamond**, and no player has ever been shown less than they hold.

| cohort                       | wallets |    diamonds |
| ---------------------------- | ------: | ----------: |
| the 500 diamond signup grant |     437 |     218,500 |
| `clubco`, opening balance    |       1 |         485 |
| `kingfish`, residual         |       1 |       2,000 |
| **total**                    | **439** | **220,985** |

Four of those 437 had no journal row _at all_, so the obvious query - an
`INNER JOIN` from `profiles` to `diamond_transactions` - could not see them.
They are the same defect and they are settled with the rest.

## The cause, named to the line

Before 2026-09-01, `handle_new_user`'s `INSERT INTO public.profiles` carried
the welcome grant as a literal in its `diamonds` column:

```sql
INSERT INTO public.profiles (..., diamonds, diamond_balance, ...)
VALUES               (..., 500,      500,             ...)
```

The balance existed from the instant the row was born, and nothing wrote a
`diamond_transactions` row for it. The player had the diamonds; the ledger had
never heard of them.

The cutoff is sharp enough to read to the minute. The newest affected profile
was born **2026-09-01 01:46:08 UTC**. Migration `20260901032430`
(`ca_signup_diamonds_journal_their_own_grant`) landed at **03:24:30 UTC** the
same morning. Every profile created after it is clean; 416 of the 634
September profiles that have a ledger are in the cohort and every one of them
predates that migration.

## The cause was already closed, three times over

This is worth stating plainly, because it would have been easy to ship a
fourth "fix" for a door that is already bolted:

1. **`20260901032430`** made the signup grant journal itself.
2. **2026-09-08** `handle_new_user` was rewritten to insert `0` and ask
   `fn_ca_mint` for the 500 under op id `signup:<id>`, which fills the
   balance, journals it and registers it in one call, and replays as a no-op.
3. **2026-09-15** `ca_diamond_rule_modes` flipped
   `DR2:balance_born_outside_the_mint` and
   `DR6:balance_changed_without_journal` from `log` to `refuse`. A player
   profile may no longer be _born_ holding diamonds
   (`zz_ca_diamond_born_with_balance` raises `P0402`), and an unsanctioned
   write to `profiles.diamonds` is refused outright
   (`fn_ca_audit_diamond_change` raises `P0406`).

So the live path is fixed and hard-guarded. What was left was the damage.

## The settlement

`20260930055147_the_journal_explains_the_balance.sql` writes the 439 missing
journal rows and **changes no balance**. There is no `UPDATE public.profiles`
in the file.

That direction was not a close call. The ledger was wrong and the wallets were
right. Reducing 439 balances to match a ledger we failed to write would be
taking diamonds back from players for our own defect, which CLAUDE.md 10.9
rule 3 forbids outright.

- **437 players** get a `signup_bonus` row dated to the moment their profile
  was created. Their wallet already showed the 500; now the "Welcome Bonus"
  line that explains it is there too.
- **`clubco` (5a7e34f8)** gets a 485 `adjustment` row. Its first ledger row is
  a `+10` profile picture reward whose `balance_after` is 495, so the wallet
  demonstrably opened at 485 before any ledger row existed. Recorded as an
  opening balance, not as the 500 grant it resembles, because 485 is what can
  be read.
- **`kingfish` (47965354)** gets a 2,000 `adjustment` row. This account
  predates the ledger and was already reconciled once, on 2026-05-03, by a
  `+453,929` row; 2,000 remains. **The writer cannot be named from rows**, and
  the row says so rather than guessing: `ca_diamond_balance_audit`, which
  records the writer of every balance change, only begins in September 2026.
  The `balance_after` column on this account is unreliable besides - dozens of
  rows where the `balance_after` delta disagrees with `amount`, from
  concurrent diamond-game writes - so the single row where the arithmetic
  happens to show `+2000` is an artifact of that, not evidence of when the
  diamonds arrived.

### Why the Mint's register is deliberately left alone

`fn_ca_mint_supply('diamonds')` and what players hold agree **exactly** today:
6,834,511 each, `difference 0.00` on the trial balance. The born-with-balance
door moved the register even though it skipped the journal, so the register
already counts these 220,985 diamonds. Letting it follow these journal rows
would count them twice and break an identity that is currently true.

`fn_ca_diamond_journal_origin` already refuses to register a `signup_bonus`
row for exactly this reason. This migration adds one named clause beside it -
`IF v_src = 'journal_backfill' THEN RETURN NULL` - so the same holds for the
two rows that are not signup grants. Every settlement row carries
`source = 'journal_backfill'`, and the migration asserts afterwards that not
one of them reached the register, rolling the whole thing back if any did.

> **Separately, and out of scope here:** the register does _not_ agree with
> holdings wallet-by-wallet. 1,068 wallets differ, netting to zero globally.
> That is a different defect from this one and is untouched.

### Idempotent by construction

`idx_diamond_transactions_reference_id` is a UNIQUE index on `reference_id`.
Every settlement row is keyed per user (`signup_bonus_journal:<uuid>`,
`journal_gap_settlement:<uuid>`), so a second run inserts nothing: the
`WHERE NOT EXISTS` skips it and the unique index would refuse it even if the
guard were removed. Nobody can be paid twice.

### It aborts rather than guess

The cohort is computed inside the transaction, not pasted from a probe, and
the migration raises if the board has moved since it was measured (439 wallets
/ 220,985 diamonds), if any gap is negative (a player being _short_ is a
different defect with a different settlement), if the wallets it cannot
explain is not zero afterwards, or if any settlement row reached the register.

## Horses

The cohort is selected on the drift and on nothing else. `is_horse` appears
nowhere in the migration. A horse in this cohort gets its journal row exactly
as a human does (CLAUDE.md 10.5).

## Not a repair job

This is a one-time settlement in a migration, with the live path already fixed
and armed to refuse. It creates no cron, no sweep, no backfill job and no
reconciler, and nothing in it runs again (CLAUDE.md 10.12).

## The law

`tests/the-journal-explains-the-balance.law.test.ts` refuses, from
`20260930` on, any migration that softens DR2 or DR6 below `refuse`, drops or
disables `zz_ca_diamond_born_with_balance` or `zz_ca_audit_diamond_change`, or
opens a new born-with-balance door by giving `profiles.diamonds` a non-zero
literal on INSERT. It also pins this settlement to changing no balance, keying
every row per user, and marking every row `journal_backfill`.

Those two rule rows and their triggers are the hard-coded fix. Softening one
would un-fix the defect while the guards still read as present, which is the
failure mode CLAUDE.md 10.86 exists to prevent.

---

**Correction, 2026-09-30 (same day).** The out-of-scope note above is wrong in
two ways and the next agent should not go looking for missing money on its
account. The 1,068 wallets do **not** net to zero: they differ by 1,021,092 and
every one of them leans the same way, because the difference is the 2026-09-03
opening baseline that was deliberately booked as a single `circulation` row and
never attributed per holder. It is not a defect. Read
[`2026-09-30-the-register-is-a-supply-ledger-not-a-wallet.md`](./2026-09-30-the-register-is-a-supply-ledger-not-a-wallet.md).
