# 2026-08-28 — Four tables must not mean four of everything

MultiTablePage keeps up to four TablePages mounted and never unmounts itself,
so anything a table does per-instance is silently multiplied by four. Two
fixes already landed on this theme today (#1601's settings read, #1623's
button skin). These are the ones that were left.

## The theme rows were read once per table

`useUserThemeSettings` queries `user_theme_settings` keyed on `user_id`
ALONE — the bucket is resolved in memory by `pickThemeRow` — so four mounts
issued four byte-identical queries on every table open. Given the same
in-flight-promise de-duplication `useUserTableSettings` already carries,
copied deliberately down to the reasoning: the cache is the PROMISE, dropped
as soon as it settles, so it can only ever collapse a burst of simultaneous
mounts. A table opened later still reads the database; a theme write is never
served a stale row; there is no TTL to tune and no invalidation to forget.

## The screen wake lock ignored the rule its own file states

`useTableEnvironment`'s header says: "if the answer involves a document-level
singleton, it belongs behind the refcount." The viewport tag obeys that. The
wake lock did not — every table requested its own sentinel and attached its
own `visibilitychange` listener, so four tables meant four sentinels for one
screen and four simultaneous re-requests on every visibility change. Now
refcounted like the viewport tag: one sentinel, one listener, released when
the LAST table closes (closing one of four must not let the screen dim on the
three still dealing), with concurrent requests collapsed and a late-arriving
sentinel released rather than leaked.

## The turn clock ran for tables with nobody on the clock

`useTableTimer`'s rAF loop plus a 500ms watchdog was mounted with `deps: []`
— correct for "subscribe once", but it also meant the drivers ran for the
life of every mounted table. Four permanent rAF loops at ~20 evaluations/sec
each, three of them for tables where no clock was running. Now gated on the
PRESENCE of a deadline (the same shape as MultiTablePage's `anyTurnLive` gate
on its shared 1s clock), which does not weaken the deliberate "hold at zero"
rule: holding at zero happens while a deadline is set. When the deadline goes
away, one forced publish settles the ring rather than leaving it frozen.

## The hand-strength memo re-ran on every snapshot

Its comment said "memoised on the cards and the variant, so it runs when the
board changes rather than on every timer tick." It did not: the dep array
carried `tableState.players`, and mapEngineSnapshot builds a FRESH players
array per snapshot — and it also listed `cachedHandStrength`, which the effect
below sets FROM it, so it re-ran on its own output. `bestFive` is
combinatorial: 21 scorings for Hold'em, 60 for PLO4, 150 for PLO6, each with
a sort and a Map build. Four PLO6 tables put roughly 600 evaluations per
snapshot round on the main thread, straight through the 16ms budget
`useFrameBudgetMonitor` measures.

Now keyed on WHAT THE CARDS ARE (two cheap joins over at most six and five
cards) with the card objects read through a ref — sound precisely because the
keys change whenever those objects do. The hand-over branch moved out of the
memo; it was the only reason the self-feeding deps existed.

## Pinned by

`tests/unit/fourTablesAreNotFourOfEverything.test.ts` (7) — a live test that
four concurrent theme reads issue ONE query and that a rejection does not
wedge future mounts, plus the wake-lock refcount and the memo's dep contract.
`tests/unit/heroTimeoutFiresOnce.test.ts` updated in the same commit: its
locator keyed off the old empty dep array, and it gains an assertion for the
new gate. Every assertion it already made is unchanged — the closure-capture
rule it exists to pin is unaffected.
