# A route segment is not an id (and a bug table nobody can read)

2026-09-12. `horse_bug_reports` held **243 unresolved rows that were all one
defect**, filed steadily since 2026-09-02 and still arriving while this was
being written. They were not data. They were a client bug, a mis-routed
category, a dedupe that could not fire, and a production E2E suite writing its
own test fixtures into the production bug table.

## What was actually wrong

`src/components/tournament/TournamentStartingTicker.tsx` matched the URL and
put the result straight into a uuid column:

```ts
const tableMatch = location.pathname.match(/^\/table\/([^/]+)/);
...
.eq('id', tableMatch[1])          // no guard. 22P02 lands here.
```

`/table/demo` and `/table/nonexistent-table-id` are two routes
`tests/e2e/routes/admin.spec.ts` visits **against production**
(`post-deploy-e2e.yml`, `BASE_URL: https://smarter.poker/hub/club-arena/`) on
every deploy. Each visit raised Postgres 22P02, the ticker's catch called
`reportError`, `TablePage` had started `horseBugReporter.startCapturing()`
which monkey-patches `console.error`, and `persistToSupabase` inserted a row.
Every thirty seconds, for as long as the page stayed open.

**The club branch was not safer for being routed through a resolver.**
`resolveClubUUID` documents its own fallback - "return as-is (will fail
downstream, but that's the existing behavior)" - so an unknown slug comes back
out of it as a slug and reaches the same `.eq('id', ...)`. The asymmetry the
audit named was real but smaller than it looked: neither branch checked the
value it was about to use. Both do now.

## Why nobody saw it for ten days

`HorseBugReporter` categorised on the **whole console message**, and
`reportError` writes `console.error('[' + context + ']', error)`, so the
component's NAME was the first thing every rule tested. A client-side uuid
defect in a file called `TournamentStartingTicker` matched
`msg.includes('Tournament')` and arrived in the operator's dashboard as a
`tournament_bug`. It looked like a tournament money incident, which is a
category people leave to somebody else. Any label works this way: anything
named `*Wallet*` filed as `wallet_sync`/high, and `msg.includes('function')`
matched the word anywhere, which is most stack traces.

## Why it was 243 rows and not one

The dedupe compared raw titles inside a **5-second window held in one page
session**. Every E2E run is a fresh browser context about half an hour apart,
so the guard was structurally incapable of firing, and the two literals
differed anyway. A guard scoped more narrowly than the thing it guards is not
a guard.

## What changed

1. **The boundary.** Both ticker branches check the value they are about to
   use with `isUUID` and fall back to defaults without a round trip. A segment
   that cannot be a uuid is not a table, so nothing is queried and nothing is
   filed.
2. **The silent half, closed.** A **well-formed** uuid with no readable row
   returns `{data: null, error: null}` from `.maybeSingle()`, so `clubUuid`
   stayed null, `TickerManagementService.get(null, null)` returned platform
   defaults, and nothing said so - a different defect, found beside this one.
   It now reports through `reportWarning`, once per scope per mount
   (`warnOnce`): console.warn is not intercepted by the bug reporter, so
   observability here cannot become the next flood.
3. **The categoriser routes on the body, never the label.** 22P02 and the
   other malformed-literal codes are `runtime_error`, where a client boundary
   defect belongs. A genuine wallet or tournament failure still files as it
   did.
4. **Identity is a fingerprint**: context label plus the message with its
   variable literals stripped, hashed into the `text` PRIMARY KEY as
   `cbug:<hash>`, so the second occurrence UPSERTS the first row instead of
   adding one. `created_at` is deliberately left out of the payload so it
   keeps meaning "first seen"; `context.last_seen_at` says when it last
   happened. Repeats refresh on a five-minute throttle rather than per poll.
5. **A robot does not write to the production bug table.** Persistence is
   withheld under `navigator.webdriver`. Capture is unchanged, so a spec can
   still assert on the reports. **This is not an `is_horse` gate and must
   never become one (CLAUDE.md 10.5)**: a horse is a player and its bugs are
   real bugs. `horse_id: 'console'`, `horse_name: 'Console'` was never a
   horse - it was a Playwright process. A horse has no browser at all, so it
   cannot reach this code path.
6. **The spec that caused the flood now prevents it.**
   `tests/e2e/routes/admin.spec.ts` keeps both routes - testing an invalid id
   is the right test - and asserts the app absorbs it in silence: nothing on
   the console, and no SQLSTATE text on the felt.

## Measured

Run against production, 2026-09-12:

|                                    |                                                  |
| ---------------------------------- | ------------------------------------------------ |
| Rows from this one defect          | **243** (2 distinct descriptions, 1 fingerprint) |
| Resolved, in the whole table       | **0 of 16,241**                                  |
| Whole table, distinct descriptions | 8,871                                            |
| Whole table, after fingerprinting  | **2,262**                                        |

The fingerprint collapses this defect to one row and the table to 2,262 open
bugs, without folding unrelated ones together. What that number makes visible
is the thing this table could not show anybody before: **8,457 of the 16,241
rows are a single `HydraService.seatHorse.logTransaction` constraint
violation**, and 405 are one missing RPC (`bulk_update_position_stats`). Both
are outside this change and neither is mine to fix, but both were invisible
underneath a flood that looked like tournaments.

## The law

`tests/a-route-segment-is-not-an-id.law.test.ts`. No path-match subscript
reaches an id filter without an `isUUID` guard dominating it; the ticker's two
branches are pinned by name; and the eleven inherited `useParams()` call sites
that do the same thing one step less obviously are frozen by a one-way
ratchet, because a law that went red on all eleven today is a law somebody
deletes tomorrow (CLAUDE.md 10.83).

Every pin above was verified by breaking the code and watching it go red. The
first draft of the generic rule used `/\bMatch\[\d\]/`, which matches nothing -
there is no word boundary between the `e` and the `M` of `tableMatch` - so it
stayed green while the guard it guards was removed. It was found by that
deliberate-failure run and fixed. A law is not written until you have seen it
fail.

## Not done here, and why

The stronger dedupe is an `occurrences` counter incremented server-side, with
`fingerprint` and `last_seen_at` as real columns and a partial unique index on
unresolved rows - the `autofix_attempts_one_open_per_issue` shape. It is not in
this change for two reasons, both checkable:

- PostgREST cannot target a **partial** unique index from `.upsert()`. It
  sends `ON CONFLICT (cols) DO UPDATE` with no predicate, and Postgres needs
  the index predicate to infer a partial index, so the write fails 42P10. A
  server-side fold (trigger or RPC) is needed, which is DDL.
- A migration that is written and not applied is a blocking red check here
  ("Supabase Invariants - New Migrations Were Applied", inside the required
  `TypeScript Check` job), and this session was scoped to read-only SELECTs
  against production. Shipping the file alone would have blocked the fix.

So the collapse is delivered now through the primary key, which is a real
unique index that already exists, and the counter is honest about its scope:
`context.occurrences_this_session`. The one thing lost against the column
version is a count that spans sessions; `created_at` (first seen) and
`context.last_seen_at` still answer "is this still happening", which is the
question an operator actually asks.
