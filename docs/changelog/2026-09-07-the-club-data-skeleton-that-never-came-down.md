# The Club Data skeleton that never came down

2026-09-07. `Post-Deploy E2E (production)` had been red on `main` for five
consecutive runs. Every one of them died in the same place:

```
1) club-data-deep.spec.ts:147 - operates sorting, pagination, players, and a verified manual refresh
   Error: locator.click: Test timeout of 180000ms exceeded.
     - locator resolved to <button disabled type="button">Load More Games - 100 Of 90,372</button>
     - 339 x waiting for element to be visible, enabled and stable
         - element is not enabled
```

The button was rendered, it was visible, it said there were 90,272 more rows to
fetch, and it was disabled for three minutes. Nothing on the page said why.

## What was actually wrong

`Load More Games` is disabled by `gamesLoadingMore || loading`. The label was
the idle one, so `gamesLoadingMore` was false. The page-level `loading` flag was
true, and it stayed true for the life of the page.

`loading` was cleared in one place:

```ts
} finally {
  // Only the newest request may clear the skeleton. A background poll that
  // finished first used to pull it out from under a load the user had just
  // started, leaving stale rows looking settled.
  if (!stale()) {
    setLastRequestMs(...);
    setLoading(false);
  }
}
```

`stale()` is `cancelledRef.current || loadVersion.current !== myVersion`, and
`loadVersion` is bumped by EVERY read - the 60 second recovery poll, every
`visibilitychange`, and `queueEventRefresh`, which fires on any realtime row
touching `tables`, `tournaments`, `settlement_invoices` or `club_members`.

The intent of that guard is right and it stays: a background poll must not pull
the skeleton out from under a load the operator just started. The defect is that
it made the background poll the OWNER of a flag it is not allowed to raise. On a
club quiet enough that a read finishes before the next one starts, the two are
the same thing. On Shark Club they are not:

- a ranked read of that club's 14 day window measured 1,151 ms warm and 15,493
  ms cold, and
- the club runs about 90,000 tournaments a fortnight, so one of the four
  watched tables is almost always changing.

So every read was superseded before it could settle, every `finally` saw itself
as stale, and `setLoading(false)` was never reached by anybody. Not once.

Two smaller faults were sitting in the same path:

- **The event debounce could never fire.** `queueEventRefresh` cleared and
  re-armed a 750 ms timer on every event. Shark Club never went quiet for 750
  ms, so the ledger only ever refreshed when the 60 second recovery poll landed.
  A debounce with no ceiling is a promise, not a schedule.
- **Background reads stacked.** Nothing stopped a second full-window scan
  starting beside the first, which is the worst thing to do to a query that is
  slow because of its width.

## The fixes

**The skeleton belongs to a foreground request.** A new `spinnerVersion` ref is
written only by reads that asked for the spinner. Raising it and clearing it are
now the same authority, so a newer FOREGROUND load still wins the ordering the
original comment describes, and a heartbeat can neither raise the skeleton nor
keep it up. A club change retires the outgoing club's claim with its request
order.

**A background read yields to a background read already in flight.** It cannot
make the ledger any fresher than the one already out; it can only add a second
scan and take the ordering away from the first.

**The event debounce has a ceiling.** `EVENT_REFRESH_MAX_WAIT_MS` (5s) bounds
how far a burst of rows may push a queued refresh out. The 750 ms quiet window
is unchanged for the normal case.

**And the query got out of its own way.** `ca_club_game_page` returns 100 rows.
To find them it was carrying every presentation column - name, variant, blinds,
rake percent, status, creator name and avatar, fee, winnings, hands, players -
through three MATERIALIZED copies of the whole window and then a full sort. The
ranking now runs over a narrow key set (the four sort keys plus only what the
filter itself reads) and the wide projection is joined back for the rows that
survive the LIMIT. `tournament_players`, a 90k row `count(DISTINCT)`, is joined
for those rows too instead of being merged into every row of the window.

Paired measurement on production, alternating calls in ONE session so both saw
the same load:

| run      | before   | after  |
| -------- | -------- | ------ |
| 1 (cold) | 4,064 ms | 842 ms |
| 2        | 1,208 ms | 694 ms |
| 3        | 1,151 ms | 688 ms |

|                            | before  | after   |
| -------------------------- | ------- | ------- |
| shared buffers touched     | 317,658 | 125,851 |
| temp blocks read + written | 5,862   | 861     |

Live after the migration, all four sorts: 709-874 ms. The client wraps this RPC
in `coldRead`, a 12,000 ms per-attempt budget with three retries, so the cold
path had been crossing its own timeout and each retry started another
full-window scan. It now sits at about a fourteenth of that budget.

`supabase/migrations/20260907042418_the_ranked_club_data_page_ranks_a_narrow_key_set.sql`
was proven identical before it was written: built as a `pg_temp` function
(11.5 rule 4) and diffed against the live function on production over 48
combinations of sort x game class x stakes tier x search, and three consecutive
cursor pages for each of the four sorts with each page fed from its own
function's `next_cursor`. Every comparison was
`(old - 'generated_at') = (new - 'generated_at')`.

## What this is an instance of

10.86, again, in a shape it had not been written down in yet. Nothing here
answered incorrectly. `stale()` answered a question it was asked and answered it
truthfully; it simply was not the question anyone needed answered, because
"which read is newest" and "is a spinner owed" stopped being the same question
the moment reads got slower than the interval between them.

The tell was on the screen the whole time: a control that is disabled for a
reason the operator cannot see. If a flag can be raised by one actor and is
cleared by whoever happens to be last, it has no owner - and a flag with no
owner eventually stays where it was left.

## Files

- `src/pages/club/ClubDataPage.tsx`
- `supabase/migrations/20260907042418_the_ranked_club_data_page_ranks_a_narrow_key_set.sql`
  (applied and recorded on production, version `20260907042418`)
- `tests/club-data-query-performance-contract.test.ts` - three new contracts:
  the narrow ranking set, the foreground-only skeleton, and the bounded event
  debounce.
