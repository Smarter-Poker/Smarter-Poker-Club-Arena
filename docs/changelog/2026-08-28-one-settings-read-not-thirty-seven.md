# Opening four tables fired ~37 identical settings queries. Now it fires one.

Dan: "find any and all ways to improve, enhance and upgrade this page and
functionality to the max."

## The measurement

`useUserTableSettings` is called from far more places than it looks, because
`useButtonImage` calls it too:

| caller                                                                                                                                                   | count |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `TablePage` (direct)                                                                                                                                     | 1     |
| `useButtonImage` — from `TableMenu`, `PreviousHandCard`, `MiniStatsCard`, `RabbitHunt`, `TableChat`, `TimebankCounter`, plus two more inside `TablePage` | 8     |
| `MultiTablePage`, `HamburgerMenu`, `SettingsPanel`                                                                                                       | 3     |

**Nine of those live inside a `TablePage`**, and `MultiTablePage` keeps up to
four `TablePage`s mounted. So opening four tables fired roughly **37 identical
`select('*')` calls on `user_table_settings`** — same user, same row, all within
a second, every one a round trip to Supabase before the felt could paint.

Nothing was wrong with any single call site. The hook is used the way a cheap
selector is used, while doing the work of a fetch.

## The fix, and the part I deliberately did not do

Concurrent callers for the same user now share **one in-flight promise**. N
mounts cost one query.

**It de-duplicates the READ and nothing else.** Every hook instance keeps its own
state, its own MasterBus subscriptions and its whole write path —
`writeTailsRef`, `durableValueRef`, `pendingEchoRef`, `mutationRevisionRef` — all
untouched.

That restraint is the point. Sharing the _state_ would be the bigger win and a
much bigger risk: this hook's write path is a documented minefield of echo
suppression and revision counters (its own notes describe a latch that
"swallows the next genuine cross-component change"), and collapsing N writers
onto one store deserves its own commit and its own tests, not a line in a
performance pass.

**The cache is the in-flight promise, not the result.** The entry is dropped the
moment it settles, so this can only ever collapse a burst of simultaneous
mounts. A component mounting later still reads the database, and a settings
write is never served a stale row. There is no TTL to tune and no invalidation
to forget, because nothing is retained.

The entry is dropped on **rejection** too — otherwise one network blip would
wedge every future mount onto a permanently failed promise.

## Two things that bit me, written down

**The PostgREST builder is a thenable, not a Promise.** It has `.then` but no
`.catch`/`.finally`, so it cannot be stored or awaited as one — `TS2739`.
`Promise.resolve(...)` around it once gives a real Promise many callers can
await. My first attempt also tried to derive the result type through four
nested `ReturnType`s of `supabase.from`, which does not typecheck because
`from` is an overload set. A one-line `const settingsRowQuery = ...` and
`Awaited<ReturnType<typeof settingsRowQuery>>` is both correct and readable.

**My first draft of the test could not fail.** It guarded every assertion behind
"if the internal fetcher is not exported, assert something trivial instead" —
which passes when the feature is absent. Same vacuous-pass shape as the
`/\bdvh\b/` bug in `feltReserveIsStatic`. The seam is exported instead, and the
test asserts the real thing.

A second, subtler version of the same trap: the mock originally kept a single
shared `settle` handle, so each new query overwrote the previous one and earlier
promises stayed pending forever. Because the de-duplication map is
module-level, those strays leaked into the next test's count and three tests
failed for the wrong reason. Every query now gets its own deferred.

## Guard

`tests/unit/settingsReadIsDeduped.test.ts` (4 tests): concurrent readers collapse
to one query and all receive the _same_ settled object; two different users are
never served each other's request; a later mount reaches the database again; a
rejected read is evicted and the next attempt genuinely retries.

Both mutations caught:

```
MUTATION: remove the de-duplication      -> 3 failed | 1 passed
          "concurrent readers issued more than one query: expected 3 to be 1"
MUTATION: keep settled entries in the map -> 3 failed | 1 passed
restored                                  -> 4 passed
```

## Results

```
npx tsc --noEmit        TSC=0
npx vitest run tests/   8132 tests, 0 failed
npm run build           BUILD=0
```
