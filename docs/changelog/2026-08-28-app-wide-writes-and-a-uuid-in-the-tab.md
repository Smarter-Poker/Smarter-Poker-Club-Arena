# Four tables, one browser tab, one toast — closing out the app-wide writes

Dan: "finish up everything thats still pending... check for any bugs, stubs,
gaps, errors, regressions or wiring issues."

The remaining unfixed items from the multi-table sweep, all the same shape as
the ones already shipped: **a per-instance component writing something the whole
app owns**, in a page where MultiTablePage keeps up to four TablePages mounted.

## 1. Every rakeback and table-balance toast fired once per open table

`useMasterBusSubscription('RAKEBACK_DISTRIBUTED', …)` and
`useMasterBusSubscription('TABLE_BALANCE_EXECUTED', …)` were the **only two**
subscriptions in that block with no `payload.tableId !== tableId` guard. Their
neighbours all have one (`TIME_BANK_EXTENDED`, `TIME_BANK_EXTENSION_DENIED`,
`STRADDLE_TOGGLED`, …).

The emitters go out of their way to make the guard possible — both
`case 'RAKEBACK_DISTRIBUTED'` and `case 'TABLE_BALANCE_EXECUTED'` stamp
`tableId` onto the payload immediately before `masterBus.emit`, for exactly this
purpose. MasterBus is app-wide, so four mounted tables meant **four identical
toasts for one rakeback**.

It survived because the Toast layer dedups identical messages. That is not a
fix, it is a coincidence: a swallowed duplicate is still a duplicate, and the
moment somebody legitimately turns dedup off for a message it becomes four
popups.

## 2. The browser tab was named after the wrong table, using a raw UUID

`useTableEnvironment`'s title effect was:

```ts
document.title = tableId ? `${tableId} | Smarter Poker` : 'Table | Smarter Poker';
```

Two defects in one line:

- **Whichever table mounted LAST won.** `document.title` is a single string and
  four instances wrote it. The tab was named after a table the player might not
  be looking at, and it never followed them as they switched — a mounted
  instance's effect does not re-run when a sibling becomes active.
- **It printed a raw UUID.** The tab read
  `f2c86e7a-e7c9-4d3c-b496-cd09ab33215d | Smarter Poker`, and so did every
  bookmark anyone made of a table.

Now gated on `isActive` (so exactly one instance writes, and it is the table in
front) and it prefers `tableState.tableName` — the tab says **"NLH 0.25/0.50"**.
Falls back to the id only while the name is still `Loading...`, so the tab is
never blank.

The hook call moved down TablePage to sit below `tableState`, which is what it
now needs. Still unconditional, still once per render — all hook order requires.

**Not restored on unmount, deliberately.** MultiTablePage's "YOUR TURN" badge
effect owns the restore and captures `document.title` at the moment it badges,
precisely so it hands back the _current_ title rather than a mount-time one (see
its AUDIT 2026-08-25 note). A restore here would fight it.

## 3. `.bankroll-widget` — a selector matching nothing

Deleted from the `.table-page.ca-raising` list. Nothing in `src/` renders that
class, verified by grep across every `.tsx`. A selector that matches no element
is not free: it is a claim that a widget exists, and the next reader has to go
and find out that it does not.

## Guards

`tests/unit/keyboardBelongsToOneTable.test.tsx` gains two, both proven to fail
on reintroduction:

```
MUTATION: remove the RAKEBACK tableId guard   -> 1 failed | 13 passed
MUTATION: remove the isActive gate on title   -> 1 failed | 13 passed
restored                                      -> 14 passed
```

The title guard asserts three things together, because any one alone is
satisfiable without the fix: the hook bails on `!isActive`, it no longer
interpolates `${tableId}` first, **and** TablePage actually passes
`displayName: tableState.tableName` — otherwise the hook's default wins and the
test would pass against a caller that never opted in.

## A correction to my previous report

I told Dan there was a live defect where "a dead table renders phantom players":
table `f2c86e7a…` showed two players with hole cards while `table_seats` was
empty and the engine's HTTP `/state` returned `players: []`.

**Every observation was accurate; my conclusion was not.** That table had
genuinely drained (all nine seats left between 06:04 and 06:18) and has since
refilled. Re-checked at 08:10: nine seated, hand #3170219, eight hands in the
last ten minutes, and the engine's WebSocket snapshot agrees with the database
exactly. Money was never at risk — `fn_unaccounted_seat_exits()` is 0
platform-wide.

What I actually saw was a narrower thing: while the table sat empty, the
engine's WS hub replayed the **last completed hand's** snapshot (#3145102, the
two remaining players, stacks 38/41 matching their exit rows) to a fresh
subscriber, while `/state` correctly reported empty. That is a real
disagreement between two engine surfaces, it is transient, it self-heals when
the table refills, and **I cannot reproduce it now.** It is logged here as an
open question rather than fixed, because I will not guess at a fix on a money
surface I cannot currently observe failing.

## Results

```
npx tsc --noEmit        TSC=0
npx vitest run tests/   518 files, 8099 tests, 0 failed
npm run build           BUILD=0
```
