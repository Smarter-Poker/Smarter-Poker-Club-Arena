# A break its dead generation began is finished by its successor

2026-09-26. Migration `20260926092954`. Law
`tests/a-break-its-dead-generation-began-is-finished-by-its-successor.law.test.ts`.
Incident 34f66b95.

## What was frozen

Event 7c6277e7, Morning Free Buy (NLH). Table 244a2997 has not dealt since
2026-09-19 14:04 UTC. It is the source of F06 table break dce8ddb0, which is
in state `begun`, revision 1. The break has eight members in its manifest.
One of them, MiaPoker (3b7caeb9), moved at 14:29:14 with 13,510 to 26c00afc
seat 3. The other seven attempts are `active` and were never dispatched.

The break's origin and custody generation is 29afae24, which is dead. The
event's other two tables hold one player each (UncleConnor 124,007 and
TinyMuckReg 114,503), so neither can deal. The whole event has been stopped
since 2026-09-25 16:27.

Chips conserve: 338,000 on the felt, equal to the 338,000 held by the nine
playing registrations. The 283.80 prize is held in escrow.

## Why the live generation never took custody

The current lease holder does try. The source table's admission reads
`source_excluded` and calls `fn_f06_admit_parked_movement`, the protocol's
door for a successor to take a break's custody and move its players. The
engine logged `Tournament table 244a2997 ... was never ready` on every
attempt. A rolled-back probe named the refusal:
`F06_MOVEMENT_ORIGINAL_PROOF_MISSING`.

The door binds custody to a movement proof, and it had only two ways to get
one:

1. carry forward a proof that an earlier generation recorded in
   `f06_movement_admissions`; or
2. capture a fresh one from a break still `park_requested` with no manifest.

Neither applied here:

- Generation 29afae24 began this break and moved its first member while it
  held a live dealer for the table. That path records no movement admission,
  so there was nothing to carry forward.
- A `begun` break may not be recaptured, because the table no longer holds
  the whole original roster.

So every break that a live generation begins and then dies part-way through
is refused for good. PR #5035's `continueAbandonedNoStartPark` handles only a
`park_requested` last-table park with no members, so it does not cover this
shape.

## The fix

The door has a third way to get the proof. It applies only when all four of
these hold:

- the break is `begun`;
- the break has a manifest;
- neither its origin generation nor its custody generation is the caller's
  (the caller holds the lease, so both are dead);
- no admission was ever recorded for the break.

`smarter_private.f06_movement_abandoned_begun_proof` then rebuilds the proof
the dead generation would have taken. It uses the same boundary (the table's
sealed last hand) and runs every check of `f06_movement_prior`, with three
exceptions. Each exception rests on a durable row:

| what changed at the chair since the boundary  | accepted only on                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the member left through this break's own move | this break's winning receipt: same source seat, occupancy, lifecycle and break; `moved_at` equals the chair's `left_at`; the carried stack equals what the chair held |
| chips bought during the break (rebuy, add-on) | the purchase door's own wallet debits for this event after the boundary, at the event's chip rates; any non-debit purchase row refuses                                |
| a busted chair re-seated by a rebuy           | a rebuy debit after the boundary and before the new `joined_at`                                                                                                       |

Every manifest member must be accounted for, either moved or still in its
manifest chair with its manifest occupancy. The live roster must equal the
remaining members exactly.

After admission, the unchanged `f06_assert_movement` checks the proof at
every move. The successor then finishes through the protocol's own
transitions: `fn_f06_claim_custody`, `fn_move_tournament_player` for each
active attempt, then close and cleanup acknowledgement. No state column and
no seat row is hand-written. Withdrawal was not an option: the protocol
withdraws only before a manifest, and one member has already moved.

## What the rows say

The last hand (13176489, 14:04:04) left these stacks: MiaPoker 3,510,
Zoe86 2,451, OldCole 7,561, MadDonkBoss 5,853, tali 0, RIVER 7,453,
sea_kayla 6,964 and ladiesboat2 16,208. After that hand:

- tali rebought at 14:04:07 (1.00, 3,000 chips) and was re-seated at 14:04:27.
- Between 14:08:44 and 14:08:47, MiaPoker, Zoe86, OldCole, MadDonkBoss, tali
  and sea_kayla each took the 10,000 add-on (1.00 each).

Every chair now holds its boundary stack plus exactly those purchases.
MiaPoker's move carried 3,510 + 10,000 = 13,510.

## Five tests

| test                   | result                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. read, not assumed   | PASS: break, manifest, attempts, winning receipt, the last sealed hand, every purchase debit and every chair, all read above.                                                                                                                                                                         |
| 2. nobody paid twice   | PASS: no money moves. Each move is `fn_move_tournament_player` under the member's own request id, with a unique receipt per request, and a replay returns the stored receipt.                                                                                                                         |
| 3. nothing clawed back | PASS: every player moves with exactly the chips in their chair.                                                                                                                                                                                                                                       |
| 4. proved rolled back  | PASS: a one-block probe at 09:28 UTC, with this body in `pg_temp`. The admission succeeded (rebuilt proof: moved 1, remaining 7), custody went to generation 4f11ca96 at revision 2, and Zoe86's own request moved 12,451 to 26c00afc seat 6. Felt and registrations stayed 338,000 before and after. |
| 5. the paragraph       | PASS: below.                                                                                                                                                                                                                                                                                          |

**Paragraph.** The seven players still at 244a2997 are moved by the break's
own requests, each with exactly their chips:

- Zoe86 (559c9e97): 12,451 to 26c00afc seat 6;
- OldCole (8ebbb163): 17,561 to 26c00afc seat 7;
- RIVER (aecab0a3): 7,453 to 26c00afc seat 8;
- sea_kayla (b82cb704): 16,964 to 26c00afc seat 1;
- MadDonkBoss (93e59b77): 15,853 to 9e432569 seat 9;
- tali (ae0bc48d): 13,000 to 9e432569 seat 5;
- ladiesboat2 (bbca3b33): 16,208 to 9e432569 seat 6.

If a destination chair is no longer free, the engine's existing amendment
chooses another one. The break then closes, and the event plays on with nine
players on two tables and 338,000 chips. Nobody is credited or debited, and
the 283.80 prize escrow is untouched. All nine players are horses, and a
human would get the same ruling (10.5).

## Deadline

The rebuilt proof, and `f06_assert_movement` at every move, both read the
table's last `hand_history` row, 646fc835 (2026-09-19 14:04). That hand is
horse-only, so under the eight-day horse retention policy it becomes eligible
for pruning at 2026-09-27 14:04 UTC. (The oldest horse-only row still present
is from 2026-09-08, so pruning lags, but that lag is not a guarantee.) Apply
this migration and let the seven moves finish before then.

The same dependency exists for every movement proof on a table idle for more
than eight days. `f06_movement_permits` was freed from retention on
2026-09-25, but `f06_movement_prior` and `f06_assert_movement` were not. That
is recorded here for the owner of the movement lane.

## Measured after apply

Recorded on the pull request.

## Superseded (2026-09-26, later the same day)

Migration `20260926092954` never reached production and never can: its
pre-image pins `fn_f06_admit_parked_movement` md5 9bcb1b3b and
`f06_movement_prior` md5 97c4a1af, and both were replaced at 09:35:51Z by
`20260926091645_a_receipted_chip_is_movement_evidence`, which proves a begun
break that never recorded an admission member by member from its winning
receipts, live manifest chairs and durable purchase receipts. Break dce8ddb0
finished through that door (state `acknowledged`, 8 members, 8 winners) and
event 7c6277e7 completed. The file and its schema fragment are removed; the
law test now pins the same law against the definitions production holds.
