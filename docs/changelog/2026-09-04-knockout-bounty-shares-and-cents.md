# The knockout pays every winner of the pot, and says the exact amount

2026-09-04. Follows the audit in `2026-09-04-seat-knockout-audit.md`, which
read the seat knockout (PR #1687 + #1766) against current `origin/main` and
against production, and found the four things below. Dan: "FIX ANYTHING AND
EVERYTHING THATS CURRENTLY WRONG WITH THE KNOCKOUT BOUNTY."

The animation itself (gloves, star, stamp, beats, sound) is untouched. Every
change here is in what the animation is TOLD.

## A. Split-pot knockouts were animated for the wrong amount, at one seat

The 2026-08-31 ruling made `fn_collect_bounty` split a tied pot's bounty by
claim weight and return `shares` (one row per winner) plus `paid_cash` as the
TOTAL. The engine never read `shares`: it broadcast `amount: paid_cash` under
one `knockerUserId`. So the client flew the whole bounty to one of the two
winners, drew nothing at the other, and in a PKO added the whole
`addedToHead` to one head badge. The money in the database was right
(7.50 + 7.50); the table lied about it.

Measured, not guessed: 55 split knockouts in `tournament_bounties` between
08-30 and 09-04, all two-way, 0.7% of all knockouts.

- **Engine** (`TournamentManagerEliminations.processBountyCollection`): types
  `split` and `shares` off the RPC result, looks up every winner's name, and
  puts `shares: [{ userId, name, amount, addedToHead }]` on the
  `bounty_collected` broadcast. Only when there are two or more; the
  single-winner payload is byte-for-byte what it was, so an older bundle that
  never reads `shares` behaves exactly as before.
- **Client**: `src/utils/bountyBroadcast.ts` `bountyWinnersOf(payload)` is the
  ONE reader of both shapes. TablePage asks it three times per broadcast: for
  the glove (`isHero` is now "any winner is me"), for the money (the
  accumulator, the timer, the chip streams and the `+N` are keyed per WINNER,
  so a split knockout is two streams to two chairs each carrying that
  winner's own share) and for the head badges (each winner's own
  `addedToHead`, never the flat total).

## B. The "+N" float rounded cents away

`spawnPotWinFloat` built its label as `Math.round(amount)` for anything >= 1.
A 7.50 bounty floated up as `+8` while the seat's own stack delta beside it
said `+7.50`. 401 of the 7,508 bounties paid since 08-28 (5.3%) carried cents
and every one was shown rounded; cash pots at penny stakes went through the
same line.

`formatChipAward` in `src/utils/format.ts`: snap to cents first (with a 1e-7
nudge so 17.955 does not land a half-cent DOWN, the same binary-double trap
the 2026-08-29 payout fix removed from the arithmetic), then whole chips read
as whole chips and anything else keeps exactly two places. Same contract as
SeatSlot's stack delta, so the two labels for one payment agree.

## E. A player who came back could never be knocked out again

`koSeenRef` (one stamp per busted player) was released only when the table
changed. A player who busted, re-entered and sat back down at the same table
would match the old key on the second bust and get no glove. No occurrence in
production since 08-28 (nobody has re-entered after a bounty), so this is
latent, fixed while the file was open. The release is a TRANSITION: absent
from the previous roster, present in this one. It is guarded against an
ordinary roster update while the busted player is still seated (the bounty
broadcast precedes `player_eliminated`, so they are seated when the key is
written) and against a reconnect that rebuilds the roster from empty.

## G. One `profiles` query per knockout for a field nothing reads

`eliminatedAvatar` was looked up and broadcast for the full-screen
`KnockoutAnimation`'s falling head. That overlay was deleted on 2026-08-28.
Removed.

## Not changed, and why

- **Two numbers on the winner.** The audit noted the winner sees the bounty
  `+N` and, separately, the pot-win `+N` / stack delta. Those are two
  different payments (the pot and the bounty) and both are correct; with B
  fixed they are also both exact. Left as is.
- **A bust followed by a rebuy pays no bounty and plays no KO.** The
  elimination sweep removes a rebuying player before `eliminatePlayer` runs,
  so `fn_collect_bounty` is never called for that bust. PokerBros pays the
  knocker the head on a rebuy bust and gives the rebuyer a fresh one. That
  sets what players are owed in future events, which CLAUDE.md 10.9 keeps
  for Dan. Recommendation: pay it (it is what the bounty pool was funded
  for, and `process_tournament_rebuy` already adds a fresh head on rebuy);
  it needs `fn_collect_bounty`'s idempotency key to become per-bust rather
  than per-player, and the sweep to collect before it hands the rebuy.

## Tests

- `tests/unit/knockoutBountyIsSharedAndExact.test.ts` (new): `bountyWinnersOf`
  on the single, split, raw-RPC-shape, one-row, no-id and NaN cases;
  `formatChipAward` on whole, cents, float-noise and the half-cent trap; and
  source pins that the engine sends `shares`, the avatar lookup is gone,
  TablePage reads winners through the helper for glove, money and badge, the
  float label is `formatChipAward`, and the `koSeenRef` release is a guarded
  transition.
- `tests/animations-always-play.law.test.ts` and
  `tests/components/BountyAnimations.test.tsx` unchanged and green: the
  stamp-beat coalescing (`SKO_STAMP_AT_MS * getAnimationSpeed()`,
  `bountyAwardAccRef`) is still the mechanism, now keyed per winner.

## Files

```
changed  server/src/tournament/TournamentManagerEliminations.ts
changed  src/pages/TablePage.tsx
changed  src/utils/format.ts
added    src/utils/bountyBroadcast.ts
added    tests/unit/knockoutBountyIsSharedAndExact.test.ts
added    docs/changelog/2026-09-04-seat-knockout-audit.md
added    docs/changelog/2026-09-04-knockout-bounty-shares-and-cents.md
```
