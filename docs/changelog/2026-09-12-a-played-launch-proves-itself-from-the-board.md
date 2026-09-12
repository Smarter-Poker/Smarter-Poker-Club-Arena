# A Played Launch Proves Itself From The Board

**2026-09-12** · `TournamentManagerBase`, `fn_prove_played_launch_from_board`

## Forty Games, Four Days, 2,574.12

Forty tournaments dealt hands on 2026-09-08, eliminated 82 players between
them, and stopped. They have been sitting in `REGISTERING` ever since.

| Stopped              | Events | Formats                   |
| -------------------- | ------ | ------------------------- |
| 2026-09-08 13:00 UTC | 7      | SPIN                      |
| 2026-09-08 14:00 UTC | 33     | MTT, SATELLITE, SNG, SPIN |

| Format    | Events | Buy-ins taken | Prizes paid | Refunded | Still held   |
| --------- | ------ | ------------- | ----------- | -------- | ------------ |
| SPIN      | 22     | 1,296.00      | 0.00        | 0.00     | 1,296.00     |
| SNG       | 13     | 818.00        | 0.00        | 0.00     | 818.00       |
| SATELLITE | 4      | 390.00        | 0.00        | 0.00     | 390.00       |
| MTT       | 1      | 170.00        | 99.88       | 0.00     | 70.12        |
|           | **40** | **2,674.00**  | **99.88**   | **0.00** | **2,574.12** |

`Breakfast Turbo` paid places 2, 3, 4 and 5 between 14:38 and 14:43 and never
paid place 1. Its champion has been owed 53.12 for three days and twenty-one
hours, still marked `playing`, still sitting opposite an opponent with zero
chips who was never eliminated.

## The Fix For This Already Existed And Could Not Reach Them

This incident was diagnosed on 2026-09-11 and two of its three layers were
fixed:

| Layer                                             | State                                            |
| ------------------------------------------------- | ------------------------------------------------ |
| GameServer start gate, `finishingADealtGame`      | Correct, deployed, **firing every five minutes** |
| Completion RPC, `fn_prove_played_launch_recovery` | Correct, installed, **never reached**            |
| `TournamentManagerBase.startTournament`           | **Missed**                                       |

The live engine log shows the first layer working exactly as intended:

```
[GameServer] Starting tournament: NLH Heads-Up 1 (finalized pool, already dealt
             - finishing with the field it has (1 on the board))
[Tournament:90c4d93f] Starting...
[Tournament:90c4d93f] Only 1 of 2 player(s) - standing down so the field can be
                      filled (NOT cancelling)
```

The manager counts the field and stands down **before it writes the launch
receipt**. It does have a played-game escape hatch, and it is Spin-only:

```ts
if (spinPaidGateWillRun && requiredField === SPEC_SPIN_SEATS && regCount === 2)
```

A paid Spin holding exactly two of its three passes. A heads-up game holding one
of two does not. An MTT holding two of four does not.

So no receipt was written, and the completion RPC whose first statement is

```sql
SELECT * INTO v_receipt FROM public.tournament_launch_receipts r
 WHERE r.tournament_id = p_tournament_id FOR UPDATE;
IF NOT FOUND OR v_receipt.launch_id <> p_launch_id THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'launch_receipt_mismatch');
```

was never called for any of them. `have_a_receipt = 0` on all forty, against
1,839 receipts written the same day by launches that cleared the middle gate.

**The chain was generalised at its end and left narrow in its middle.**

## The Change

`fn_prove_played_launch_from_board` asks the existing generalised proof,
deriving the one argument the manager cannot supply. The first hand in
`hand_history` is when the game began, and that is a fact rather than a claim.

The manager now asks it before standing down, in the same shape as the Spin
block above it. On success the field requirement becomes the field it actually
holds, and the derived first-hand time is stamped into the launch receipt, which
is what makes the completion RPC's own `started_at` check pass honestly a moment
later: the receipt says the game began when the first hand was dealt, because it
did.

## Why This Cannot Start An Under-Filled Fresh Game

A tournament that has dealt nothing is refused at the proof's first line, before
any other question is asked. Everything else is delegated to
`fn_prove_played_launch_recovery` unchanged, including the check that matters
most, that every surviving player holds a live seat.

The started_at comparison inside that proof is satisfied by construction on this
path. That is correct rather than a loophole: the check exists to catch a
_receipt_ whose claim disagrees with what happened, and on this path there is no
claim to disagree with.

Verified against production, read-only, inside a rolled-back transaction:

```
NOTICE:  fn_prove_played_launch_from_board OK: 40 of 40 stalled played
         tournament(s) provable from the board; 0 undealt tournaments approved.
```

## What Shipping This Does

It finishes all forty. It pays `Breakfast Turbo`'s champion the 53.12 he has
been owed since 2026-09-08, ranks and pays the rest through the ordinary finish
path, and closes the player rows. That is the engine completing its own work
rather than a repair job: no new payment path is added and nothing is written by
hand.

## Still Open

What happened between 13:00 and 14:00 on 2026-09-08 that cost forty launches
their receipts while 1,839 others got one. This change makes that class
self-recovering, so a repeat resolves itself within one pass instead of sitting
for four days, but it does not explain the original event.

## Pins

`tests/a-game-that-already-dealt-is-not-under-filled.law.test.ts`, eleven cases
across all three layers.

Proven to bite: reverting the manager change fails five of the six manager
cases. `SeatFirstActualDeal`'s one-player Heads-Up case was re-aimed from
"no RPC at all" to the invariant it is named for, no receipt, and strengthened
to prove the new door is asked and refuses for a field that never dealt.

All 1,791 tournament tests pass.
