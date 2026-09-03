# 2026-08-31 - The satellite fix that paid four people back had nothing pinning it

## What was unguarded

`fn_award_satellite_seat` is idempotent: a winner already entered in the target
returns `ok:true, awarded:false` and moves no money. The branch handling that
used to log "Seat awarded" and pay NOTHING, while the write below still stamped
`prize = ticketCost`. Four winners across satellites `1a6f53a4`, `acb14548` and
`e3d3bd1e` got neither a seat they did not already have nor its value. They were
back-paid by the migration that taught the function to report
`held_from_this_satellite`.

That fix is on `main` and is correct. **It had no test.**

## Why it needed one urgently

Found while rescuing #1971 (see `2026-08-31-rescue-1971-boot-rescue-guard.md`).
That branch proposed a SIMPLER version of the same fix - pay cash whenever
`awarded === false`, with no `held_from_this_satellite` test at all. Taking the
branch's side of that conflict, which is the natural move when resolving one,
would have reintroduced a double payment on every recovery re-drive.

The simpler version is the tempting one. Nothing on `main` said so.

## The three load-bearing parts, now pinned

1. **The cash branch fires only when a DIFFERENT satellite seated them.** When
   THIS satellite did, it is a re-drive and paying again is a double payment.
2. **The test is `=== false`, not `!held_from_this_satellite`.** An old function
   without the flag returns `undefined`; under `!` that reads as "a different
   satellite seated them" and every re-drive pays again - the original bug,
   reached by a refactor that looks like a tidy-up. `=== false` sends
   `undefined` to neither branch, the conservative pre-migration behaviour.
3. **The cash payment carries the same stable place key** as the
   registration-failure branch, so a re-drive of this pass dedupes to nothing.

Plus: the already-held branch must not log "Seat awarded". The original defect
was visible only in that log, which is why nobody noticed the money had not
moved.

## Verified red before green

Reintroduced the exact defect (`=== false` changed to `!`):

```
x  is paid NOTHING when THIS satellite seated them - that is a re-drive
x  tests === false, so an old function returning undefined pays nobody twice
   Tests  2 failed | 4 passed (6)
```

Restored, and all six pass. Source-level on purpose: all three failures are a
CONDITION or an ARGUMENT, which renders identically to correct code.

## Suite

```
npx tsc --noEmit   server   exit 0
npx vitest run     server   280 files, 3131 tests, 0 failures
```
