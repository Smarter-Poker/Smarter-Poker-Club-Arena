# 2026-08-31 — The stuck-COMPLETING recovery invented a podium and paid 141% of a pool

Found by the post-ship verification sweep of the MTT audit (PR #2004, #2019).

## Symptom

`Sunday $200 Deep Stack` (dfae9288) disbursed **62,841.60 against a 44,640.00
prize pool — 141%**. Two payout runs paid the same places to different people:

| when (UTC)       | path                               | places     | pool implied |
| ---------------- | ---------------------------------- | ---------- | ------------ |
| 2026-08-30 19:47 | `Tournament prize (recovery)`      | 1..9       | 20,880       |
| 2026-08-31 02:32 | `Tournament payout reconciliation` | 1..5, 7..9 | 44,640       |

The first run happened **73 minutes before the tournament started**
(`started_at` 21:00:16). `be61d864` was paid 6,264.00 as "position 1" and
actually finished **107th**; `484d22c4` was paid 4,176.00 as "position 2" and
finished **87th**.

## Root cause — two defects, and it takes both

1. **`recoverStuckCompleting` ranked a podium out of players who never sat.**
   Its `alive` set is `status IN ('playing','registered')` — deliberately, so a
   genuine late registrant still waiting on `ensureLateRegSeated` is paid. But
   when _every_ alive row is `registered`, nobody has been dealt a card: they
   all hold the same starting stack, so the `chips` sort that assigns places
   1..N is arbitrary order, and the full payout structure is paid against it.

2. **`GameServer`'s played-but-registering sweep treated zero as decided.**
   `stillPlaying > 1` returns a live contest to RUNNING; everything else fell
   through to COMPLETING — including **0**. In a tournament that has not
   started nobody is `playing`, so this labelled a never-dealt event as decided
   and handed it to (1).

The two payout paths also do not dedupe against each other: the recovery keys
`tourney:{id}:prize:place:{N}`, while `fn_tournament_payout_reconcile` keys
`tourney:{id}:prize:{user}:{place}:reconcile`. The reconciler measures what a
place-holder has been paid _by user_, so when the holder of a place changes
between runs it correctly sees "unpaid" and pays again. Blocking the invented
first payout is what closes this; the reconciler's own behaviour is right.

## Fix

- `tournamentRecovery.ts`: refuse to pay when no surviving entrant is
  `playing`; report `recoverStuckCompleting_no_dealt_in_survivor` and leave the
  event COMPLETING for the reconciler or a human — the same stance the function
  already takes for a position collision. Registered survivors stay payable
  whenever at least one player is `playing`, so the late-reg case is unchanged.
- `GameServer.ts`: `stillPlaying === 0` reports
  `played_registering_zero_playing` and does not settle.
- Pinned by `NoPodiumFromPlayersWhoNeverSat.guard.test.ts`, which also asserts
  the guard sits _before_ the crediting loop and that the alive filter was not
  narrowed.

## Blast radius, and the money

Four tournaments in 14 days carry both a recovery and a reconcile payment:
dfae9288 (62,841.60 paid / 44,640.00 pool), 84c8a517 (554.00), 27fcd7db
(100.00), 856620cc (56.00). Only dfae9288 is materially over pool; the other
three are within their pools.

**No clawback was performed.** `fn_tournament_payout_reconcile` states the house
position explicitly — "automatic clawback is deliberately not done" — and
recovering ~20,880 chips from players who have since played on is a financial
decision for Dan, not an agent. Raised for his call.
