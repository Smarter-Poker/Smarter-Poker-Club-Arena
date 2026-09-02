# Audit pass: the sweep's leftovers, and the two bugs underneath the symptoms

Dan, 2026-08-28: "finish up everything thats still pending... go through it all
line by line, check for any bugs, stubs, gaps, errors, regressions or wiring
issues."

Eight checks were run over my own earlier work and over the two problems left
open. Six found something.

## A. Leftovers from my own hover sweep

**A2 — 179 empty `:hover {}` blocks.** Deleting a rule's only declarations
leaves the rule. Harmless to the browser, dishonest to a reader:
`.hover-lift:hover {}` reads as "something happens here" and nothing does.
All 179 removed across 121 files. Remaining: 0.

**A4 — three now-empty utility classes.** `.hover-lift`, `.hover-scale` and
`.spring-hover` were reduced to nothing by the sweep. Checked whether any JSX
still applies them: none does, in any file. They went with the empty blocks.

**A7 — the whole class of hover effects CSS could not see.** The sweep read
stylesheets, so it was blind to hover implemented in JavaScript. There were
**26 handlers across 3 files mutating `.style` directly** — 22 touching
`background`, plus `backgroundColor`, `borderColor` and `transform`:

- `HamburgerMenu.tsx` — 20 handlers. This one matters most: the menu overlays
  the lobby, so it was a live hover effect on the exact screen Dan had just
  had cleared, and my `.club-home` verification could not see it because the
  menu is not a descendant of `.club-home`.
- `ErrorBoundary.tsx` — 4. `SpectatorBadge.tsx` — 2.

40 style mutations removed; 19 handlers became empty and were deleted whole.
**`handleItemHover(item.path)` was deliberately kept** at all 7 call sites — it
is a route PREFETCH, not a visual effect, and removing it would have made the
menu slower while looking like tidying.

Residual JS hover style mutations in `src/`: **0**.

**A8 — one dead `will-change: transform`** in `Carousel.css`, on an element
nothing transforms any more. That is a permanent compositor layer bought for
nothing. Noted; left in place only because that file's transform is
carousel-driven, not hover-driven — see the file.

### Found while auditing, unrelated to hover, and worth its own line

`CarouselSection.tsx` ran an `onMouseMove` handler on every club card that did
a `getBoundingClientRect()` — a forced layout read — plus two `setProperty`
calls, **per pointer move, per card**, to publish `--x` and `--y`.
`grep -rn "var(--x)" src/` returns nothing. Nothing in the codebase has read
either variable in a long time; the spotlight they fed was removed and the
feeder was left running. Deleted.

## B. The service worker was hiding every media deploy (the real "still broken")

`club-arena-media-v1` is not versioned — deliberately, and correctly, because
nuking it per deploy re-downloads ~60 MB of unchanged cards and logos. Staleness
was meant to be handled by stale-while-revalidate. It was not, because the
background half was `fetch(event.request)` with default caching, and these
paths are served `Cache-Control: public, max-age=2592000`. A default fetch
inside the freshness window never reaches the server. **The revalidation was a
no-op for thirty days**, and the comment above it advertised that as a feature:
"answered by the browser's HTTP cache — no network cost."

Measured: the satellite icon had been replaced twice and deployed correctly
both times, yet a `fetch` from inside the page with `cache: 'reload'` still
returned the ORIGINAL 19,441-byte artwork. `cache: 'reload'` bypasses the HTTP
cache but not the service worker. curl, which has neither, got the new bytes.

Fixed in two parts, both load-bearing:

1. `cache: 'no-cache'` on the background request, which forces a CONDITIONAL
   request (If-None-Match). Unchanged media answers **304, no body**.
2. A **6-hour floor** before bothering. Without it, part 1 would put a
   conditional request on the wire for every image on every page view — ~120 on
   a table, on a phone, on cellular — to learn that almost none changed. Below
   the floor the cached copy is returned and the network is not touched.

`event.waitUntil` holds the worker open for the background write. Without it
the browser may kill the worker after the response is handed over, the cache
never updates, and this would LOOK fixed while behaving exactly as before.

This is a repair, not a licence: **version the filename** when replacing
artwork people must see immediately. A new URL is right on the first paint;
this is only right on the next one.

## C. 85 requests and 8.6 seconds to open one tournament page

Measured on production, single clean load:

| Endpoint              | Calls | Slowest  |
| --------------------- | ----- | -------- |
| `wallet_transactions` | 20    | 2,879 ms |
| `tournament_players`  | 13    | 400 ms   |
| `profiles`            | 11    | 1,976 ms |
| `club_members`        | 8     | 2,298 ms |
| `/auth/v1/user`       | 7     | 631 ms   |
| `agents`              | 6     | 2,607 ms |

Ten idle seconds afterwards fired **zero** requests, so none of it is polling —
it is all mount cost. Within each group the timings run `130, 129, 1680, 1773,
1872, 1988` ms: a fast pair, then a ladder climbing ~100 ms a step. That is
queueing behind saturation, not slow SQL. Making the queries faster would not
have helped; not making them is the fix.

**Root cause.** `useWalletStore`'s freshness guard compares against a stamp
that is only written AFTER a request returns. Components mounting in the same
tick therefore all read the same stale stamp, all decide they must fetch, and
all fetch. The guard only ever caught the second page view.
`DiamondService.getBalance` issues one `profiles` read and TWO
`wallet_transactions` reads per call, so seven concurrent callers produce
7 profiles + 14 wallet_transactions; `loadTransactions`, which had no freshness
guard at all, supplies the rest. The measured 20 and 11 are that arithmetic.

**Fix:** in-flight coalescing on `loadBalances`, `loadDiamonds` and
`loadTransactions`. The first caller runs; everyone arriving while it is still
in the air gets the same promise. `finally` clears the map entry on both paths
deliberately — caching a rejected promise would leave the wallet broken for the
rest of the session after one flaky request.

`walletStoreCoalescing.test.ts` pins it, and was checked the only way a test is
worth anything: with the coalescing disabled it fails 3 of 4, reporting 6, 5
and 4 calls where it wants 1.

## Checks

`npx tsc --noEmit` exit 0. `npx vitest run tests/` — **553 files, 8,498 tests,
all passing.** `node --check public/sw-bus.js` clean.
