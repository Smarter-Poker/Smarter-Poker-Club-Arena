# The players ledger keeps its own page

2026-09-07, immediately after the games ledger was fixed. The next Post-Deploy
E2E run got further and then stopped in the same place, one tab over:

```
club-data-deep.spec.ts:185
  Error: expect(received).not.toBe(expected)
  Expected: not "Load More Players - 100 Of 571"
  Timeout 60000ms exceeded while waiting on the predicate
```

The button was clicked this time. The games fix landed and the Games Load More
at line 163 now passes. What line 185 says is that the Players Load More was
pressed and nothing happened for a minute.

## Three faults, one shape

**1. The same stranded skeleton, on the players side.** `playersLoading` was
cleared by `if (!stale()) setPlayersLoading(false)`, where `stale()` is true
whenever any later read has bumped `playersVersion` - the 60 second poll and
every realtime row included. And `loadMorePlayers` opens with

```ts
if (
  !clubUuid ||
  !playerCursor ||
  !playersHasMore ||
  playersMoreRef.current ||
  playersLoading ||
  isHydrating ||
  !userId
)
  return;
```

so a stranded flag does not merely grey the button out, it makes the click a
no-op that leaves the label exactly where it was. That is the failure above.

**2. A refresh is not a new question.** Both Load More paths captured the read
version and threw their page away if anything bumped it mid-flight:

```ts
const myVersion = playersVersion.current;
const stale = () => cancelledRef.current || playersVersion.current !== myVersion;
...
if (stale()) return;              // the fetched rows are discarded here
```

That check is right for a sort or filter change - the page really does belong
to a ledger nobody is looking at any more. It is wrong for a refresh of the
same query, which is what the poll and the realtime drain are. On a club with
continuous traffic the operator can press Load More repeatedly and have every
page silently dropped.

**3. And a discarded page left its own spinner up.** `finally` cleared
`playersLoadingMore` only `if (!stale())`, so a superseded page left the
control reading "Loading" for ever. Same line, same reasoning, in
`loadMoreGames`.

## The fixes

- `playersSpinnerVersion` and `backgroundPlayersInFlight`, exactly as the games
  ledger got yesterday: only a foreground read raises the players skeleton, only
  that read or a newer foreground one puts it down, and a background read yields
  to one already in flight.
- `gamesQueryEpoch` and `playersQueryEpoch`, bumped on a club change and on a
  foreground load, never on a background refresh. Both Load More paths watch the
  epoch instead of the read version, so a refresh of the same question can no
  longer discard the page the operator asked for.
- Whoever raises a Load More spinner puts it down. `if (!cancelledRef.current)`,
  not `if (!stale())`.

## The lesson

I fixed the games ledger yesterday and wrote the note about one authority owning
a flag. The players ledger is the same file, the same three states, the same
three bugs, and I did not look at it. 10.86 rule 4 says a fix that leaves the
same trap one level up has not landed; this is that rule pointing sideways
rather than up. When a defect is a SHAPE rather than a line, the fix is not
finished until every place with that shape has been read.

## Files

- `src/pages/club/ClubDataPage.tsx`
- `tests/club-data-query-performance-contract.test.ts` - two new contracts (the
  players skeleton, and pagination keyed to the question), and one existing pin
  moved to the mechanism that replaced it rather than deleted.
