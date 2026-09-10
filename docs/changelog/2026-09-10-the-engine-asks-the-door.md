# The engine asks the door even when the head is unattributable

2026-09-10

The engine half of [a place is not a
bounty](./2026-09-10-a-place-is-not-a-bounty.md). The database half landed at
14:58; this is why it only got two thirds of the way.

## What happened after the database fix

The corrected knockout door began accepting busts it had been refusing.
Stranded busts across the ten frozen events fell **62 to 27 in seven minutes**,
and then stopped dead.

The split explains itself exactly:

| stranded busts | blocker                           | after the DB fix |
| -------------- | --------------------------------- | ---------------- |
| 33             | behind a PKO settlement watermark | cleared          |
| 33             | no exact pot claimant             | still stuck      |

The ones that cleared **had** claimants, so the engine called the door and the
corrected door accepted them. For the ones without claimants, the engine never
called the door at all.

Verified rather than inferred: a rolled-back `DO`-block probe (11.5) called
`fn_claim_tournament_bounty_elimination` for six of the stuck candidates. All
six returned `ok:true`, `claimed:true`, `obligation_id:null`,
`bounty_blocked:'exact_pot_claimants_not_found'`. The database was ready. The
engine was not asking.

## The same conflation, one level up

`eliminatePlayer` loads bounty evidence before anything else and returns false
when it comes back null:

```ts
const bountyEvidence = hasBounty ? await this.loadPersistedBountyEvidence(userId) : null;
if (hasBounty && !bountyEvidence) {
  return false;
}
```

and `loadPersistedBountyEvidence` deferred on **every** unready gate verdict,
including `knocker_not_attributable`. So the engine refused to ask whether a
player had busted because it could not work out who to pay.

## The rule

`knocker_not_attributable` is the one verdict that says nothing about whether
the player busted. Everything the gate checks before it - the accepted
zero-stack settlement, the matching atomic receipt, the player at zero in the
history roster, the live-seat veto, the candidate's immutable identity - has
already passed. The bust is proven; only the pot ledger naming the knocker is
missing.

So on that one verdict the loader admits the elimination on the candidate's own
evidence and marks `attributionUnavailable`. **Every other verdict still
defers**, because every other one means the bust itself is not proven, and
placing a player on no proof is worse than placing them late.

Four coordinated changes, all in `TournamentManagerEliminations.ts`:

1. `CandidateBackedKnockoutEvidence` gains `attributionUnavailable`, and the
   admitted branch carries the empty `'none'` attribution so nothing downstream
   can mistake it for a payable claim.
2. The claim passes **NULL** claimants, never an empty array - the door refuses
   `[]` as `invalid_claimants`, which is the freeze this change exists to end.
3. `bounty_blocked` on an **accepted** response is treated as a durable commit
   with no obligation row. Demanding a row there would reject a commit that
   already happened; the previous reconciliation required `row.id`,
   `knocker_user_id` and a non-empty claimant list, all of which are correctly
   absent.
4. `processBountyCollection` is skipped: it needs a knocker, there is none, and
   the head stays in the pool for `fn_finalize_bounty_pool` to resolve as
   residual.

## Verified

- `tsc -p server/tsconfig.json --noEmit` clean.
- Server suite: **661 files, 9,014 tests passed**, including the guard tests
  that pin `eliminatePlayer`'s shape.
- Client suite: **1,366 files, 18,582 tests passed**.

`tests/the-engine-asks-the-door-even-when-the-head-is-unattributable.law.test.ts`
pins the rule and, more importantly, pins **every other deferral verdict by
name** so the admitted branch can never widen by accident.

Lands on the next `:55` engine restart.
