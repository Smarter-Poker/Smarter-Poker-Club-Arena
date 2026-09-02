# The overlay is funded by the main bank, atomically

**Dan, 2026-09-02:** _"ANY OVERLAYS ARE SUPPOSED TO BE FUNDED BY THE MAIN BANK.
SO CHANGE IT TO THE BET POOL, AND MAKE IT ATOMIC SO IT CAN NEVER BE WRONG."_

## It was never a funding problem

Two guards already existed. `trg_tournaments_guarantee_affordable` refuses a
guarantee the bank cannot cover — it even tracks how much is already promised
on live events. `fn_guard_tournament_start_readiness` refuses to _start_ an
event whose guarantee is short.

Both check that the bank **could** pay. Neither ever made it **pay**. The money
was always there; nothing moved it. That is the entire defect, and it is why
the backfill below is a transfer rather than a mint.

## The bet pool already existed in the ledger

`chip_ledger` models this properly and I nearly missed it: `to_type`
`'prize_liability'` **is** the bet pool, and `category` `'overlay'` was already
in the vocabulary. The overlay posts `union_bank → prize_liability`.

My first attempt invented `tournament_pool` / `tournament_overlay`, the CHECK
constraints rejected it, and **my own `EXCEPTION WHEN OTHERS THEN NULL`
swallowed the reason** — the money moved and no journal row was written, the
exact class closed in Phase 1, re-created by me while fixing something else.
The probe caught it because it asserted on `ledger_rows`, not just balances.
The handler now records failures to `ca_ledger_write_failures`.

## Atomic means one write

The funding is a `BEFORE UPDATE` trigger that assigns `NEW.prize_pool`
directly rather than issuing its own `UPDATE`. The top-up and the status change
are therefore **one statement**: the event cannot leave registration and the
bank cannot fail to fund it, because they are the same write. No job, no sweep,
no nightly repair.

It fires on the transition **out of registration** — the moment the field locks
and the guarantee becomes a debt. Funding at COMPLETED would be too late: all
six underpaid events show `credited == prize_pool` exactly, so payouts are
priced off the pool.

**Idempotent by construction** — the top-up removes the shortfall, so a second
pass computes zero. No flag to drift out of sync.

**All or nothing** — if the bank cannot cover it the pool is untouched and a
critical is raised. A partially funded guarantee is worse than an unfunded one
because it looks paid.

Money comes from `union_wallets.chip_balance`, the Union Bank. Never
`rake_wallet`: rake is owed to the clubs on Friday and is not the operator's to
spend.

## The six that were already short

1,703.00 chips across 46 finishers, paid pro-rata — an overlay inflates every
paid position in proportion. The pro-rata landed exactly on each event's
shortfall with no rounding residual.

**One trap worth recording.** Crediting `tournaments.club_id` paid only **35 of
46**. A union event is played by members of its _constituent_ clubs, and 11
finishers hold no member row in Midway Union at all — they entered from Club
JAQK or SHARK CLUB. All 11 are horses, who under the 2026-08-27 law are paid
exactly as humans are. `tournament_players.club_id`, stamped on entry, is the
correct target. 46 of 46.

## And one more of my own mistakes

The backfill also wrote explicit `chip_ledger` rows — but the balance writes
are auto-journalled, and since the category had been declared first, the
automatic rows were already perfectly categorised. Two journal entries for one
movement. Verified 1:1 (46 and 46, both totalling 1,703.00) and removed the
duplicates through the sanctioned maintenance path so the deletion is logged.

The rule, written into the migration so nobody repeats it: **declare the
category and let the auto-journal record it, or suppress the auto-journal and
write the row yourself — never both.**

## Verified

| check                    | result                                                    |
| ------------------------ | --------------------------------------------------------- |
| pool topped to guarantee | 100 → 600                                                 |
| bank debited             | −500.00 exactly                                           |
| shortfall after          | 0                                                         |
| journal row              | `union_bank → prize_liability` 500.00, category `overlay` |
| ledger write failures    | 0                                                         |
| back-payment             | 46 finishers, 1,703.00, bank −1,703.00                    |
| underpaid events now     | **0**, ratchet pinned at 0                                |
