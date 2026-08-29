# 2026-08-29 — the rest of the money path

Six findings were left open when the exact-to-the-cent work shipped. Five are
fixed here. The sixth is a rule, not a bug, and is written up for Dan.

Every one was verified against the source and, where it touches the database,
against production — not taken on trust from the audit that surfaced them.

---

## 1. A recovery top-up that moved zero chips and then recorded a payment

`tournamentRecovery.ts` step 3 tops up in-the-money players whose recorded
prize is short. It credited under **`tourney:{id}:prize:place:{N}`** — the same
key `eliminatePlayer` already paid that place under.

The comment above it says "recorded with a zero prize", but the condition is
`owed > recorded`, so it also fires on a **partial** shortfall: the late-reg
pool grew, the place is owed more, and the player already has the smaller
amount under that key. `fn_credit_and_log` deduped the credit to nothing, the
boolean saying so was discarded, and the very next statement stamped
`prize = owed`.

So `tournament_players` claimed a payment that never happened, and because
every later pass compares `owed` against that stamped figure, **no pass would
ever look again**. Exposure: the whole late-reg and guarantee growth for every
paid place on every rescued event.

`recalculateEliminatedPrizes` had this right all along — a `prizeadj`
namespace carrying the **amount**, so a different amount is a different key
while a genuine re-run still dedupes. Same shape now, deliberately, so the two
adjustment paths also dedupe against each other. `credit()` returns whether
chips actually moved, and step 2 keeps the shared key on purpose: there it is
paying the place itself and _must_ collide with the main path.

## 2. A satellite that paid its whole pool to one player

```ts
const { data } = await supabase.from('tournaments').select(...)   // error discarded
target = (data as SatelliteTarget | null) ?? null;
```

A failed read is indistinguishable from "no target configured". `target = null`
drives `ticketCost` to 0, which drives `seats` to 0, which sends the **entire
prize pool** down the cash path to `ranked[0]`.

A 200ms blip reading one row turns an N-seat satellite into winner-take-all
cash. On the Sunday Major Satellite that is five promised seats collapsing into
one payment — and the event then completes, so there is nothing left to retry.

The finishers read two lines down had the mirror-image bug: unreadable became
empty, which returns early and leaves the pool **undistributed entirely**.

A row that is genuinely absent still falls through to cash, on purpose.
Deciding on a read that _failed_ is what stops.

## 3. Recovery paying over satellites and chops

Both live payout sites refuse to pay per-place cash on a satellite. The
recovery watchdog never did, though it already selects `variant`.

A satellite stuck in COMPLETING was paid structure cash under the identical key
`processSatelliteAwards` uses for the ticket value — two different amounts
racing for one key, so a player received whichever won. If recovery won, the
seats were never awarded and the target's field never funded.

Same shape for a chopped event: `settleFinalTableDeal` pays under
`tourney:{id}:ftd:{user}`, a namespace recovery never writes, so nothing
dedupes and its top-ups would be new money on top of a deal the players
negotiated. Both are now skipped, and an _unreadable_ deal check is skipped too
— that is the one case where guessing costs money.

## 4. A reprice that only happened when the guarantee was funded

`prizePoolFinalized` is set three statements **before** funding is attempted,
and the reprice ran only when funding succeeded.

That is not a no-op. `finalFieldSize()` gates on exactly that flag, and once it
returns a number the structure is **trimmed to the field** so the residual
lands on a place somebody reached. Places paid before that line were priced
against the untrimmed structure and places after against the trimmed one, with
the residual holder moving between them and nothing reconciling the two — the
short-field residual defect the trimming was introduced to fix, reachable again
through the funding-failure branch.

The pool has stopped moving whether or not the guarantee landed, so the reprice
is owed either way. On failure it runs against the last known accrued pool —
the same number the close broadcast already sends, never an invented one.

## 5. A structure rewrite that truncated, misplaced its remainder, and hid its failures

At start, a structure not summing to 100 was normalised and the result
**permanently written back** to `tournaments.payout_structure`. Four things
wrong:

- it truncated in binary floats — the same arithmetic that had the engine and
  the database disagreeing by a cent, except this one wrote its lossy answer
  into the column every payout site then reads;
- it dumped the remainder on `payouts[0]` — the first **array element**, not
  place 1, and a headline prize either way, which is the exact opposite of the
  payout law;
- the write error was discarded, leaving the in-memory cache and the column
  holding different structures — a fifth independent structure, created by a
  failure nobody logged;
- **it was redundant.** `computePlacePrize` divides by the structure's own
  total in integer basis points, so a 95% structure is already spread exactly,
  by every payout site at once.

Deleted. The operator's configured structure is left as they wrote it, and a
structure that does not sum to 100 still warns.

---

## Open — this one is Dan's call, not a bug to fix

**A split pot shares the mystery chest but not the bounty.**

`claimants` carries everyone with a claim on a knockout and the weight of that
claim — the winners of the pot that held the busted player's last chips,
equally weighted when that pot was tied. The mystery path honours it. The
regular/PKO path calls `fn_collect_bounty` with a single collector, so on a
tied pot one winner takes the whole head — the cash **and**, in a PKO, the half
that accumulates onto their own head — and the other takes nothing.

This is not fixed, deliberately. **Splitting a PKO head is a rule, not
arithmetic**: whether each winner takes half the cash and half the head
increment, or the head passes whole to one of them, is a decision about how the
game plays. Improvising it inside a money RPC would be the same mistake as
inventing the horses-earn-nothing rule.

What is fixed is that it was silent. A tied pot on a bounty event now reports
the players and their weights, so the frequency is measurable and the ruling
can be made against real numbers.
