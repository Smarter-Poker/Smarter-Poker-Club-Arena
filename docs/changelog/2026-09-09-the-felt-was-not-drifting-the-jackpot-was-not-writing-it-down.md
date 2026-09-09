# The felt was not drifting. The jackpot was not writing it down.

2026-09-09

The kill switch tripped on the felt: `table_seats.stack` held 4,379.10 chips
more than the journal could account for, 6,504.34 over two days. It refused to
freeze payouts on a single unconfirmed reading and asked for the next one,
which is exactly right, and left the question open.

Two things were true at once, and only one of them was the felt.

## The chips that arrived with nothing to say where from

`bbj_credit_one_recipient` states the rule in its own comment: _"The felt is a
derived account: the pool debit (bbj_pool -> table_stack) is the leg, and the
seat row simply holds the chips."_ `bbj_atomic_payout_v2` obeys it. The mini
bad-beat jackpot did not: `fn_bbj_mini_payout` declared `bbj_pool` as its own
counterparty before debiting `bbj_pool`, so the autoledger wrote

    bbj_pool -> bbj_pool   700.00   category bbj_payout

a leg that cancels itself. The seats got the chips. The journal recorded
nothing.

Twelve payouts, 6,750.00 chips, every mini jackpot ever paid. The first was
2026-09-08 03:32, and the felt's residue had been under twenty chips a day for
the whole week before it:

| interval                   | felt unexplained | mini jackpots paid |
| -------------------------- | ---------------- | ------------------ |
| 09-07 06:40 to 09-08 06:40 | +2,150.16        | 1,825.00           |
| 09-08 06:40 to 09-09 06:40 | +4,379.10        | 4,225.00           |

The same missing leg is the `bbj_pools` line on the trial balance: -306.30 in
the balance column against 1,093.45 in the ledger for the 18:05-19:05 hour,
which is 1,400.00 of mini payout to the cent.

Fixed at the declaration. The twelve missing legs were posted as corrections
through `fn_ca_post_correction`, linked to the incidents they close, 5,625.00
and 1,125.00, one per pool. Nobody was overpaid or underpaid at any point:
every recipient got their share and the pool paid what it owed. What was
missing was the sentence saying so.

## The reader that lost chips of its own

`fn_ca_ledger_replay` captured `v_now`, scanned 26 hours of journal, built
three temp tables, re-scanned once per distinct previous reading, and only
then read the balance. The window ended at `v_now`; the balance was read
whenever the loop's portal opened. Everything that moved in between was in one
number and not the other.

Measured by hand, reading the balance and the journal in ONE statement so they
share a snapshot: -1.54 chips over 93 seconds, +0.91 over 288. The felt
conserves. Independently: 7,306 cash hands in an hour, `awarded + rake +
jackpot - pot = 0.00` on every single one, zero creating and zero destroying.

The window no longer ends at a timestamp. It ends at the snapshot the balance
is read in - `p_until` is `'infinity'` and the statement's own visibility
decides what counts. A leg that has not committed is in neither number; a leg
that has committed is in both. The mark each run leaves is captured
immediately before the statement rather than inside it, because a per-row
`clock_timestamp()` left the next run's window starting seconds late and
losing everything that committed in the gap - which cost -100.60 chips on the
first run after the rewrite, and is how the same class of bug was found in
three more meters.

993 accounts now read clean, worst 0.00.

## The same boundary, three more times

`chip_ledger.created_at` is the transaction's START. A leg whose transaction
began before a reading and committed after it belongs to no window at all: not
that one, because it is invisible, and not the next, because its timestamp is
already behind the new mark. It is lost from the journal side permanently, and
always in the same direction.

- **The jackpot meter** windowed each reading from the previous one, so those
  losses accumulated: whole drops, 0.25 / 0.13 / 0.12, never reversing. The
  window now runs from the pool's opening balance and never moves, the residue
  is cumulative, and a finding is that number growing the same way twice -
  which is what a leak does and a boundary cannot.
- **The jackpot conservation check** summed every hourly residue since the
  epoch opened, so it could only climb: 3.95 against a 1.00 tolerance without
  a chip going missing. It is one end-to-end comparison now.
- **The trial balance** shows the same effect on `table_stack` and
  `player_wallets`; it oscillates and does not accumulate.

## What the money did

- **20,377.49** to 28 club-agent pairs. Two settlement periods had sat at
  "processing" since 2026-08-20: round 1 paid the clubs 162,644.52, round 3
  paid the players 48,349.04, and round 2 - the clubs paying their agents -
  never ran. The agents had funded the downstream leg out of their own
  balances. Not a week the settlement floor quarantines, and `agent_commissions`
  is stamped with the club the hand was played at, so the union attribution bug
  the floor exists for does not touch it.
- **262.00** back to the spin reserve. A cancelled spin had paid 100.00 to
  second place before it was cancelled, and both return paths ask whether ANY
  prize was paid and give up entirely if one was. What an escrow still holds is
  the question, not who was paid; the sweep asks it every fifteen minutes now.
- **6,750.00** of correction legs, moving nothing, saying what already moved.

## What was not wrong

- **1,001.00 "paid twice"** - not one chip. Four events each paid exactly their
  guaranteed pool: 2,500.00, 800.00, 400.00, 250.00. A migration had written 32
  `tournament_payouts` rows directly, spending no idempotency key and leaving no
  journal leg, and the reconciler could not see the top-up in its source
  allow-list and paid the real 1,001.00 once, through the audited path. The
  detector counted rows; it counts registered credits now, and the question it
  stopped asking got its own check.
- **Four silent detectors.** They were never called: each of those drill arms
  writes to `club_members` or `chip_ledger`, and each threw `PLATFORM_FROZEN`
  because the drill's only scheduled run in history fires at 11:00 on Mondays
  and the maintenance freeze owns :55 to :00 of every hour. Two of the four had
  fired correctly in production that same week. The drill arms itself, runs at
  11:07, reports "could not arm" separately from "stayed silent", and passes
  9 of 9.
- **A critical that could not be off.** `fn_union_law_integrity_breaches`
  returns a jsonb array and the sweep measured it as `count(*) FROM select *
FROM fn()` - one row even when the array is empty. It had read `[]` since the
  day it was created.
- **29 orphaned checks.** Thirteen were case-management RPCs matching on the
  word "integrity" in their names. The rest were called by other functions. Two
  were genuinely unrun and are now in the sweep.
- **43,990.40 of rakeback** across 653 periods - paid on 2026-08-20, to 457
  players, through a path that credited the wallet without writing the audit
  row. 285,190.29 + 43,990.40 + one 0.20 that can never be paid = 329,180.89,
  the periods total, exactly. It has an opening position now.

## Left open on purpose

The board is not meant to be empty, it is meant to be true.

- `fn_ca_ratchet_watch`: undeclared money paths went 87 to 88. The path was not
  identified; the ratchet is doing its job by refusing to move.
- `fn_ca_conservation_sweep:fn_tournament_chip_conservation_check`: seven
  running events whose chips on open seats do not equal the chips dealt in. One
  attempt to narrow this check made it worse and was reverted the same hour -
  seats are recycled as players bust, so "ever appeared in table_seats" is who
  last sat in each chair, not who was dealt in.
- `fn_bbj_reconcile`: a residue that is growing again on the new cumulative
  basis, sub-chip per hour. Real, small, and now measured the right way.
- `audit:resolution_law_backfill_review`: 118 incidents resolved before the
  resolution law existed. Still nobody's review.
