# The epoch reset contract

**Roadmap 9.8. Written 2026-09-08. The reset itself is Dan's to call; this is
what has to be true when he does.**

A reset zeroes every balance on the platform and starts a new epoch. Dan ruled
on 2026-09-02 that it covers **all unions and all clubs**. `ca_financial_epochs`
already exists and already carries the hook — `id, name, description,
started_at, ended_at, is_current`, two rows today, `epoch-2-hardened-ledger`
current.

**A reset is a phase, not an event.** It has a before, a during and an after,
and the failure mode is not "the reset goes wrong" — it is "the reset goes fine
and nobody can prove what the balances were the moment before."

---

## Before: the gate

The entry conditions are already written in the roadmap's own gate section and
are not restated here. This adds the ones that are about the reset itself:

1. **9.1 is landed and validated.** One definition of a chip, enforced. A reset
   writes an opening balance to every account; doing that while a column can
   still hold a third decimal place opens the leak at the exact moment the
   platform has the least history to detect it with. _(Shipped in this same PR.)_
2. **The journal's retention policy is in force** for the epoch about to close
   (9.4). An epoch cannot be closed into an archive that has no rule.
3. **A restatement policy exists** (9.3), because the first week of a new epoch
   is when somebody notices that a closing balance was wrong.
4. **PITR is measured healthy and the restore rehearsed** (8.3 — measured, the
   rehearsal is still open). PITR is the net under the net, not the plan.

## During: the four steps, in this order

### 1. The closing position is recorded and journalled BEFORE anything is zeroed

Every account — player wallet, club treasury, club wallet, union wallet, agent
wallet, promo balance, escrow bank, BBJ bank, seat stack — gets a row naming its
closing balance, and that row is written **as a leg in `chip_ledger`**, not only
as a snapshot table.

The reason is the whole contract: a snapshot proves what a table said, a leg
proves it against the journal. `fn_ca_ledger_replay` must be able to replay the
last day of the closing epoch and arrive at exactly these numbers. **If the
closing position is only a snapshot, the epoch cannot be audited after it
closes**, and every question asked later becomes unanswerable.

### 2. The reset runs inside a :55 freeze with nobody seated

`fn_platform_frozen()` true, every table parked at a hand boundary, and
`table_seats` empty of live players — not merely parked. Measured on 2026-09-08
at 04:55: zero hands in flight during the freeze, and a migration applied inside
it cost nothing, where the same class of migration applied during play cost
eighteen hands three hours earlier.

Seated is not the same as parked. A parked seat still holds a stack, and a stack
zeroed under a seated player is a chip balance that no longer matches what the
player can see.

### 3. One migration can put every balance back

Not "PITR could restore it" — **a migration, written before the reset runs,
that reads the closing rows from step 1 and writes them back.** It is tested by
being applied and rolled back on the live database before the reset, exactly as
every money migration in this programme has been (11.5).

A reset whose only undo is a database restore is a reset nobody can undo at
09:00 on a Monday with players online.

### 4. The opening grants are issued through the Mint

Every chip in the new epoch enters through `ca_mint_ledger`, so
`fn_ca_mint_register_vs_supply()` reads difference 0.00 on the first day. Not by
`UPDATE`-ing balances into place: a balance that appears without a leg is
exactly the drift phase 3 built the Mint to make impossible, and starting a
fresh epoch by doing it once "just for the opening" teaches the next agent that
there is an exception.

The new epoch starts from a **known** number, not an assumed one.

## After: the first week

- `fn_ca_trial_balance` at 0.00 on every account, every day, or the epoch is
  not sound and the answer is the rollback migration from step 3.
- The closing epoch gets `ended_at` set, and its legs become WARM under 9.4.
  Nothing is deleted.
- The closing position from step 1 stays online and readable for the full
  seven years. **It is the only evidence of what anybody held**, and it is
  what a dispute six months later will be settled from.

## The one-word calls that are Dan's, at reset time

These are named in the roadmap's gate section and are listed here so the reset
does not stop to look for them:

- the certification-fleet wipe,
- the dead-pool retirement,
- the BBJ lifetime gap (73,367.70),
- each historic write-off named in the gate,
- and, per 9.3, any restatement over 25,000 chips the closing position exposes.

## Status

**Nothing here is built.** It is the contract the reset must satisfy, written
before the reset rather than after it, so that the work has a shape to be built
to. Step 1 is the piece with the longest lead time and the least glamour, and
it is the one that cannot be added afterwards.
