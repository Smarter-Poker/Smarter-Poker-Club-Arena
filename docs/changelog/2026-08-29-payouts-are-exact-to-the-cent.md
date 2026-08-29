# 2026-08-29 — payouts are exact to the cent

Dan, binding:

> "THIS NEEDS TO BE EXACT AND 100% ACCURATE AT ALL TIMES, THERE CAN NEVER BE
> 'ROUNDING' IT MUST ALWAYS BE DOWN TO THE CENT. THERE CAN NEVER EVER EVER BE
> MISTAKES WHEN PAYING OUT, AND THIS SHOULD NOT BE DIFFICULT, ITS PRETTY CUT
> AND DRY ON THE PAYOUTS."

He is right that it is cut and dry. The reason it kept going wrong is that
**the arithmetic was done in dollars**, and a dollar amount with two decimals
is not a number a binary float can hold.

## The live defect

Union Morning Classic, pool 513.00, place 8 at 3.5%:

```
JS    513 * 3.5 / 100        ->  17.955        (looks exact)
      17.955 * 100           ->  1795.4999999999998
      Math.round(...) / 100  ->  17.95         rounded DOWN
SQL   round(513 * 3.5 / 100, 2)                17.96   exact decimal
```

So `fn_tournament_payout_reconcile` decided place 8 was a cent short and
**topped it up** — while the engine's last place had already absorbed the
residual and the event had paid out exactly 513.00. The top-up made it 513.01.

**The checker created the overpayment it was reporting**, on every run of that
event, twice a day.

Measured across all 39,609 completed events: 79 do not pay their pool exactly.
Every one since 2026-08-24 is this cent; everything before is the double-pay
defect fixed on the 27th and 28th.

| day    | events wrong |      net |
| ------ | -----------: | -------: |
| 21 Aug |           50 | 5,699.45 |
| 22 Aug |           47 | 1,754.00 |
| 23 Aug |           14 |   167.01 |
| 27 Aug |            1 |     3.50 |
| 28 Aug |            2 |     0.02 |
| 29 Aug |            2 |     0.02 |

## Four implementations, three rules

The bigger finding. "What is one place paid" was written four times:

| where                               | rule                                                           |
| ----------------------------------- | -------------------------------------------------------------- |
| `server/.../payoutMath.ts`          | round each, last place takes the residual — **pays the money** |
| `src/components/.../types.ts`       | `trunc(pool × pct) / 100`                                      |
| `src/services/TournamentService.ts` | `trunc(pool × pct) / 100`                                      |
| `src/services/PayoutEngine.ts`      | trunc, then shave any excess off **first place**               |

And a fifth in SQL, which moves money.

Measured on the pool-and-structure combinations actually used in production:
**13 of 78 showed the player a different number in the lobby from the one that
reached their wallet**, and the client's places did not sum to the pool at all.
The old client comment claimed it matched "the money" — it matched
`TournamentService.calculatePayout`, which has no callers and is itself a dead
client duplicate.

`PayoutEngine`'s fallback was the worst of them: when truncation overshot it
trimmed the difference off **first place**, the headline number. The engine's
rule does the opposite on purpose — an adjustment lands on the smallest prize.

## One rule, in integer cents

```
each place  = round_half_up(pool_cents × basis_points / total_basis_points)
              and never more than is left
last place  = whatever remains
```

No fraction exists to be rounded away, so the implementations cannot drift.
`Math.round` breaks a .5 tie upward and Postgres `round(numeric)` breaks it
away from zero; prizes are never negative, so the two agree by construction
rather than by luck.

**The pool is spent down as the ladder is built.** The old code priced the last
place as `pool − others` and clamped a negative result at zero — so on any pool
smaller than the number of places it was paying, the places summed to _more_
than the pool and nothing noticed. Taking `min(remaining, share)` makes
overspending impossible instead of unlikely. The exactness test found this;
it was not on anyone's list.

Now shared by:

- `server/src/tournament/payoutMath.ts` — the engine
- `src/lib/payoutMath.ts` — byte-identical copy for the client, with a test
  that fails if the two drift by a character
- `fn_tournament_payout_reconcile` — same integer-cent, basis-point rule
- the three client call sites, which now defer instead of computing

## Verification

- `tests/payout-one-rule-everywhere.law.test.ts` — the copies are identical, no
  display code prices a place on its own, nothing shaves first place, and the
  places sum to the pool across ~4,600 pools × 7 structures.
- `server/src/tournament/payoutExactness.law.test.ts` — every place matches a
  BigInt reference written independently, across the same matrix. Sharing the
  rule but not the arithmetic is the point: agreement cannot be a shared
  floating-point bug.
- Production, after the migration: **4,094 of 4,094** events in the last two
  days have places summing to the pool exactly, 0.00 owed.
- client 562 files / 8,623 tests, server 212 files / 2,328 tests, both `tsc`
  clean.

Three older tests pinned the replaced behaviour and were updated in this same
commit, each with a note saying what changed and why — the truncation spec in
`PayoutEngine.test.ts`, the `placePrize` contract in
`tournamentLobbyTabContract.test.ts`, and the `safePool - others` source guard.

## Left behind, deliberately

Four historical events sit at 513.01 — the cents this checker paid before it
was fixed. Four cents, to horses. They now report correctly as a one-cent
overpayment rather than being re-created every sweep. Reversing them is a
clawback and clawbacks are Dan's call, so they are reported, not touched.
