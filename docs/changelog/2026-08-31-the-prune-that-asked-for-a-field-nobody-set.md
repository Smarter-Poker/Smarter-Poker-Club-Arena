# The prune that asked for a field nobody set

**2026-08-31** — follow-up audit of #2010 (changing tables from the lobby).

Dan asked for the observe/lobby path to be verified end to end. Reading it
found a second, older bug sitting underneath the one just fixed, plus the
reason neither was caught by a test.

## 1. The rebuild's prune was inert on every tab a reload created

`MultiTablePage`'s server-truth rebuild closes tabs that claim a seat the
server no longer has — the fix from 2026-08-28 bug 1, written for the frozen
"Connection Lost, Trying To Get You Back" felt.

Its predicate asked:

```ts
prev.filter((t) => !(t.kind === 'table' && t.seated === true && !liveSeatIds.has(t.id)));
```

and the `additions` the SAME rebuild builds, forty lines above, carried no
`kind` field at all. So every tab the rebuild created was exempt from the
rebuild's own prune. After a page reload, rebuild-created tabs are the only
tabs a player has — which means the fix did nothing in precisely the case it
was written for: reload, reconnect, get moved by the balancer, keep staring at
a dead table.

Proven before it was touched, by running the real predicate against the real
tab shapes:

```
CURRENT  survivors (should be none): [ 'T1' ]   <- rebuild tab, seat closed, kept
PROPOSED survivors (should be none): []
```

Fixed twice over, because either alone would rot again:

- `additions` now set `kind: 'table'`, like every other tab factory in the file;
- the predicate asks `!isLobbyLike(t)` instead of `kind === 'table'`, so it
  needs no field to be remembered by whoever writes the next tab factory.

## 2. Why no test caught it

The test that "covered" this asserted the SHAPE OF THE SOURCE TEXT:

```ts
expect(CODE).toMatch(/t\.kind === 'table' && t\.seated === true/);
```

That passes on a line that is present and wrong. It matched happily while the
prune did nothing. A regex over source cannot see which objects reach the
predicate.

Both decisions moved into `src/utils/tabSlots.ts` — pure, and pinned BY
BEHAVIOUR in `tests/unit/tabSlots.test.ts`, which runs them against all four
tab shapes the container constructs (lobby, TABLE_SEATED, observer, rebuilt).
Same reasoning that lifted `swipeTargetIndex` out of the touch handler. The
old source-grep pins were updated in the same commit, per rule 8, and now pin
the wiring rather than the logic.

## 3. Slot selection consolidated

`pickObserveSlot` now owns the order that #2010 changed — focus an already-open
table, else take the ACTIVE tab's slot when it is free, else a parked lobby
tab, else append, else refuse out loud. `isFreeSlot` (`lobby || seated !== true`)
is the single definition of "this screen holds nothing the player would lose",
and both the slot choice and the prune read it. They had drifted apart once;
that is what produced both bugs.

## Verification

- `npx tsc --noEmit` clean.
- Full client suite in a worktree containing ONLY these four files, on top of
  `origin/main`: **9777 passed / 9777, 0 failed, 2910 files.**
- The three unrelated failures seen earlier (`rit-full-boards.law`,
  `hamburgerMenuLaw`, `tableConfigSeatLawClamp`) reproduce on a pristine
  `origin/main` checkout without these changes, and pass there once the shared
  host tree's uncommitted work is excluded — not caused by, and not fixed by,
  this change.

## Not changed, deliberately

- `activeIndexRef` still lags one commit (passive effect). Every other reader
  in the file has the same lag and bus events do not arrive inside the
  interaction frame; leaving it matches the file's existing contract.
- Replacing the active tab clears a lobby tab's tournament drill-in. The
  storage mirror keys off `tables.find(isLobbyTab)`, so it clears with it — no
  stale drill-in can be restored later. Verified by reading, not assumed.
