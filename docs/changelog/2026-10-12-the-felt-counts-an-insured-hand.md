# The Felt Counts An Insured Hand

**Date:** 2026-10-12
**Migration:** `20261012031852_the_felt_counts_an_insured_hand.sql`
**Law:** `tests/the-felt-counts-an-insured-hand.law.test.ts`, `docs/laws.d/tests-the-felt-counts-an-insured-hand.md`
**Incident:** 9294e359-98a3-4047-9726-69b36f88150f (closed with this change)

## What The Ledger Replay Reported

The daily ledger replay (`fn_ca_ledger_replay`, 06:40 UTC) found the cash chip felt
(`table_stack:...0fe17e:table_seats.stack`) holding slightly more than its journal said:

| Reading          | Moved      | Journal    | Unexplained | Cumulative |
| ---------------- | ---------- | ---------- | ----------- | ---------- |
| 2026-10-10 06:40 | -40,874.54 | -40,884.30 | +9.76       | 9.76       |
| 2026-10-11 06:40 | -5,601.34  | -5,605.44  | +4.10       | 13.86      |

## Root Cause, Measured Against The Replay's Own Snapshots

A cash hand settles in two transactions. The commit moves the seats by
inflow - rake - bbj; `fn_ca_process_hand_post_commit_obligations` then posts the
rake leg, the jackpot drop legs and the insurance bank's leg, usually 0.2 s later.
The felt reader counted only open seats, so a reading taken between the two halves
read the felt short of its journal by that hand's fees, and the next reading read
the difference back as drift. It was the reader, not the chips:

- The baseline reading of 2026-10-09 16:43 (taken by `20261009164317`) fell inside six
  hands' gaps: 8.10 + 2.00 + 0.55 + 0.80 + 2.03 + 0.38 = 13.86 of rake and drop.
- The 2026-10-10 06:40 replay read under snapshot `1093584683:1093584880`. Hand
  `758d1f4f` on table `bd52ccec` had committed its seats at 06:40:00.17, but its
  rake (3.60) and drop (0.25 + 0.12 + 0.13) legs carry transaction ids 1093587143 to
  1093588555, past that snapshot's horizon, and committed at 06:40:02.68: 4.10.
- The 2026-10-11 06:40 replay caught no hand between its halves.

So +9.76 is 13.86 - 4.10 and +4.10 is 4.10 - 0, and the cumulative 13.86 is exactly
the first reading's gap. No seat, wallet, rake wallet or jackpot was ever short or
long: every one of those legs committed within three seconds of its hand. Nobody
is owed anything and nothing was moved by hand.

## The Correction

`20261011200421` (PR #6678, another lane, merged 2026-10-11 21:13 UTC) taught
`fn_ca_account_balance('table_seats.stack')` to count the unresolved add-ons and
the rake and drop of every settled hand whose post-commit obligations have not
committed, and took a fresh reading. It read the fees from the payload and left
out the third leg the second half posts: an insured hand's inflow, which the seats
receive at commit and the insurance bank's leg journals later. A reading between
the halves of an insured hand would have read the felt long by that inflow and
reported it the next morning.

This change makes the reader count the hand as rake + bbj - inflow, read from the
stack result the seats were actually moved by. That is the exact quantity the
per-transaction ledger invariant (`fn_ca_tally_balance_move`, `20261001231409`)
already carries for the same hand, so the two definitions of the felt cannot
disagree. On every chip hand of the last two hours the payload and the stack result
agree to the cent, and inflow is zero (insurance last paid on 2026-08-29), so the
reading taken by `20261011200421` stays comparable and no rebaseline is needed. The
migration refuses to apply while an insured hand is between its halves.

## Proof

- Trial in a rolled-back transaction: reader 124,090.36 equals seats 124,090.36 plus
  add-ons 0 plus owed 0 in one statement.
- Live: `fn_ca_account_balance` md5 `3b5ade0f0b3e026e9fe037bbeb7d3dbe` to
  `10fb48193630ebaacff488dced27b230`; recorded statement md5
  `91789dc316006f02e182b2fde2306e40`.
- The 2026-10-12 06:40 replay judges the felt on this definition (see the incident's
  closure for its reading).
