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

---

## The audit Dan asked for, and what it found

> "CHECK FOR ANY AND ALL BUGS, GAPS, STUBS, ERRORS, REGRESSIONS OR WIRING
> ISSUES ANYWHERE AND EVERYWHERE."

Nine findings in the tournament money path. Three are fixed here; the rest are
written up below with file and line so the next session can take them in order.
Every one was verified against the source or the live database before being
believed — the audit also cleared five things that look wrong and are not, and
those are recorded too so nobody re-opens them.

### Fixed now

**A regression armed and waiting.** Two migrations written on 2026-08-29 both
redefine `fn_tournament_payout_reconcile` in full: mine made the pricing exact,
and another agent's — `20260829140000_reconciler_stamps_the_prize_it_pays` —
made it write `tournament_players.prize`, which it had never done (833 paid
placements displaying 0 to the player and feeding 0 to the POY race). Both are
right. But theirs sorts **after** mine, so on any replay it lands last and
silently reverts the exactness fix. Nothing would have noticed until a pool
divided unevenly again. `20260829145557` carries both and sorts after both, and
a guard now fails if a later redefinition drops either.

**A phantom ledger row, in my own migration.** I wrote:

```sql
PERFORM credit_player_wallet(...);   -- returns void, dedupes silently
PERFORM log_wallet_transaction(...); -- runs regardless
```

That is the exact pair `20260822190000_credit_player_wallet_once` was written
to abolish, after it produced 95 phantom prize rows worth 7,446.45 chips. The
idempotency key carries no amount, so a second reconcile of the same place at a
_higher_ expected prize dedupes the credit to nothing and logs the delta anyway
— and since `v_paid` is computed by summing `wallet_transactions`, that phantom
row makes the real shortfall permanently invisible to the only automated net
there is. Now credits through `fn_credit_and_log`, which returns boolean and
writes the row only when money moved; a refusal is reported as an issue instead
of recorded as a payment.

**A configured mystery bounty that was never configured.**
`mystery_bounty_top_percent` was read fourteen lines below a select list that
did not contain it. PostgREST returns only what you ask for, `undefined == null`
is true, so **every mystery bounty event built its chest at the 20% default**
regardless of what the host set. The spec file claims this defect was already
fixed — it was fixed in the arithmetic and never wired to the query. On a
25,000 pool configured at 30%, the lobby advertises a 7,500 headline prize and
the chest holds 5,000.

**A champion the stuck-tournament watchdog could not see.** Its collision map
tested `status === 'eliminated'`, and `finishTournament` stamps the winner
`status: 'winner', position: 1`. A process dying between that stamp and the
COMPLETED flip — the exact window the watchdog exists for — left place 1 reading
as free, and the lone survivor was handed it. Nobody is paid twice, and that is
what makes it nasty: the survivor is stamped `winner` with first prize and
receives **nothing**, while the place they actually finished in is never paid to
anybody.

### Open, in order of money at risk

1. **`tournamentRecovery.ts:463-482`** — the ITM top-up reuses
   `tourney:{id}:prize:place:{N}`, the same key `eliminatePlayer` already paid
   under, so whenever `recorded > 0` the top-up moves **zero chips** — and the
   next line stamps `prize = owed` as if it had. No caller anywhere checks
   `fn_credit_and_log`'s boolean. `recalculateEliminatedPrizes` gets this right
   with a distinct namespace (`prizeadj:{user}:{position}:{prize}`); recovery
   does not. Exposure: the whole late-reg pool growth for every ITM place on
   every rescued event.
2. **`TournamentManager.ts:549-561`** — a transient failure reading the
   satellite target is discarded, `ticketCost` falls to 0, and the event pays
   **the entire pool as cash to one player** instead of awarding N seats. The
   unchecked `finishers` read two lines down has the opposite failure: an empty
   list returns early and the pool is never distributed at all.
3. **`tournamentRecovery.ts:262-268`** — recovery has no satellite guard and no
   final-table-deal guard, though both `eliminatePlayer` and `finishTournament`
   do. A satellite stuck in COMPLETING gets paid structure cash under the same
   key `processSatelliteAwards` uses for the ticket value; whichever runs first
   wins and the other silently no-ops **with a different amount**.
4. **`TournamentManagerBase.ts:3572-3591`** — `prizePoolFinalized` is set
   _before_ the guarantee funding is attempted, and funding failure returns
   `null` so `recalculateEliminatedPrizes` is skipped. The flag is what trims
   the structure to the field, so places priced before and after that line use
   different structures and nothing reconciles them.
5. **`TournamentManagerBase.ts:1866-1888`** — the start-time structure
   "normalisation" truncates percentages in floats, permanently overwrites the
   stored column with the lossy version, dumps the remainder on `payouts[0]`
   (the first array element, not necessarily place 1, and a headline prize
   either way — the opposite of the payout law), and discards the write error.
   Now redundant: `computePlacePrize` already normalises exactly. Recommend
   deleting it.
6. **`TournamentManagerEliminations.ts:1578-1620`** — split-pot knockouts share
   the mystery chest but not the regular/PKO bounty: `claimants` is computed and
   then ignored, so on a tied pot one winner takes the whole head and the other
   takes nothing.

### Looked wrong, is not

- `tryTournamentRebuys` filtering on `is_horse` is the sanctioned input-device
  exception, not a denial — horses take the same RPC at the same price with the
  same eligibility enforced in SQL, because they have no browser to click with.
- `mysteryBountyPool.ts` is integer cents throughout with a largest-remainder
  carry and an inventory assertion. Clean.
- `eliminatePlayer`'s place-scoped idempotency key is deliberate and correct;
  findings 1 and 3 are about _other_ paths reusing it for a _different amount_.
