# Parse the structure once, and let `React.memo` do its job

**Date:** 2026-08-29

Two CPU costs on the tournament page that nothing was measuring, both paid per
second for as long as a tab is open.

## `blind_structure` was re-parsed 60 times a minute

It is a TEXT column and arrives from PostgREST as a string. Nothing kept the
parsed form, so every reader parsed it again — from the same unchanged string.

`DetailOverviewTab`'s `level` memo lists `tick` in its dependencies, correctly:
the clock has to count. It calls `tournamentService.getCurrentLevelState()`,
which calls `parseBlindStructure()`, which runs `JSON.parse` over a 40-level
structure from scratch. The parse is not the reason the memo recomputes — it is
just carried along by it, **sixty times a minute, to produce a result identical
to the one before**. The lobby does the same thing four times per card
(`tournamentBlinds`, `blindLevelMinutes`, `levelRemainingMs`, `lateRegEndMs`),
on a board that re-renders on a timer.

`src/utils/parseJsonCached.ts` memoises the parse on the string. The key is
exactly right for this: the row changes and the string changes with it, so a
stale entry is not reachable — a new structure is a new key.

Measured in `tests/unit/blindStructureParsedOnce.test.ts` by spying on
`JSON.parse`: **60 reads of one 40-level structure now cost 1 parse instead of
60**, and that holds across both of the estate's two independent
`parseBlindStructure` implementations, which share the cache.

**It returns a COPY.** Handing every caller the same array would make one
caller's `.sort()` or `.push()` everybody else's bug, at a distance and
intermittently — the worst possible trade for a performance fix. The copy is a
shallow clone of 40 references; the parse it replaces is the actual cost. A test
pins that two callers never get the same array.

A parse FAILURE is cached too. Re-attempting a parse that has already thrown,
once a second, for a row that will not change, is the same waste in a worse
costume. Malformed input still degrades exactly as before — a usable default
from one parser, `null` from the other, never a throw.

## `TablesTab`'s `React.memo` was fully defeated

`TableRow` is wrapped in `React.memo`, and the parent passed it `line` — an
object rebuilt inside a `useMemo` keyed on `entries`. Chips arrive on `entries`,
so **every chip tick produced a brand-new object for every row** and the shallow
compare failed on all of them. A 200-table event re-rendered 200 rows and 200
meters, per chip update, to change nothing on 199 of them.

The props are spread flat now. `table` stays an object and that is fine — it
comes from the `tables` prop, whose element identities are stable across a chip
tick. Only a row whose own numbers moved re-renders.

## What this does not fix

The open item was "still 41–54 Supabase calls per page load, largest untouched
`tournament_players` ×13–14". This commit does not reduce that count; it removes
CPU, not round trips. What has come off the query count today is in the earlier
commits: the satellite surfaces went from **1 + N queries to 2** (one list, one
batched registration lookup replacing one per card), and both dropped
`select('*')` on `tournaments` for a named column list.

The remaining `tournament_players` fan-out is many components each asking once
on mount, not one component asking many times — only one tab is mounted at a
time, so it is not the tabs. The right fix is a short-lived in-flight coalescer
for identical reads, the same shape as the `useWalletStore` fix from 2026-08-28.
That is a real change to how every component gets its data and it deserves its
own pass with a before-and-after measurement against a live page, which I cannot
take here honestly. Deliberately left rather than half-done.

Also still open from the tab audit: `UnionsTab` reloads its whole 4-to-16-query
sweep on every new registration because `entrantKey` changes, and the Spin
level-duration disagreement between `level.remaining` and `level.duration`.

## Verification

The parse test was confirmed red without the fix — removing the cache lookup
turns 3 of its 8 cases red (60 parses instead of 1). A test that passes either
way pins nothing.

Full suite: 573 files / 8,785 passing. `npx tsc --noEmit` exit 0.
