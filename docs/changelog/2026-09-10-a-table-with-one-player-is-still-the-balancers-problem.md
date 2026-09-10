# A table with one player is still the balancer's problem

2026-09-10

Thirty-five running tournaments could not deal a hand, and had not been able to
for up to fourteen hours.

## What was measured

A tournament with two or more funded players, where **no single table holds two
of them**, cannot deal. Asked of every RUNNING event on 2026-09-10 at 15:47
UTC, that returned **35 events**. The worst:

| event                     | funded players | biggest table | last hand |
| ------------------------- | -------------- | ------------- | --------- |
| $100 Freeroll • 12:00 AM  | 36             | 1             | 10:04     |
| Prime Time Free Buy (NLH) | 26             | 1             | 09:40     |
| Midnight Free Buy (NLH)   | 23             | 1             | 07:07     |
| $100 Freeroll • 6:00 AM   | 20             | 1             | 14:09     |

Verified directly rather than trusted to the aggregate: the 12:00 AM freeroll
has **36 tables in `waiting`, each holding exactly one funded seat**, plus five
closed ones. Thirty-six players, thirty-six tables, one each.

## Why

```ts
if (this.tableEngines.size <= 1) return;                       // the break step
const balancerTables = await this.loadBalancerTables(
  [...this.tableEngines.keys()], 'balanceInitial');
...
if (this.tableEngines.size > 1) { ... }                        // the rebalance step
```

`tableEngines` holds only the tables that are **dealing**. A table cannot deal
to one player, so a table down to its last player has no engine. With no engine
the balancer never saw it. With the balancer never seeing it, nobody moved that
player to join anybody — and the table stayed at one player for ever.

It is a closed loop, and it tightens itself: every table that drops to one
player leaves the balancer's view permanently, so an event bleeds tables out of
the balancer one at a time until none of them can deal.

## The fix

The balancer works on the tables that **hold players**, read from the database,
not on the tables that happen to be dealing.
`liveTournamentTableIdsWithPlayers()` returns exactly that — live tables
(`running` or `waiting`) with at least one seat that has not been left — and
both gates now use it.

Nothing else had to change. `loadBalancerTables` already sources every field it
needs from the database and consults `tableEngines` only for a button seat,
which defaults to 0. **An engineless table was always representable; it was
simply never in the list.**

`countLiveTablesWithPlayers()` — the final-table gate — now shares the same
reader, so the two questions can no longer drift apart.

An unreadable answer is **UNKNOWN, never balanced**: both gates re-arm the
balance redrive and return rather than concluding anything from a failed read.
That is the same house rule as the elimination headcount, for the same reason.

## Verified

- `tsc -p server/tsconfig.json --noEmit` clean.
- Server suite: **661 files, 9,014 tests passed**, including every existing
  balancer and final-table guard.

`tests/a-table-with-one-player-is-still-the-balancers-problem.law.test.ts` pins
that neither gate may decide anything from `tableEngines.size` again, that both
steps read the database list, and that an unreadable list is handled twice.

Lands on the next `:55` engine restart.
