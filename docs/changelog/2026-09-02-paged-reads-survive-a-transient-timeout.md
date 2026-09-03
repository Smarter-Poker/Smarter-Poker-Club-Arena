# One dropped packet cost a whole tournament-filling cycle

**2026-09-02** - `fix/paged-reads-survive-a-transient-timeout`

Every caller of `fetchAllRows` fails CLOSED on `complete: false`. That is right:
acting on half a read is the silent-truncation bug the module exists to
eliminate. But it made a single dropped packet expensive out of all proportion.

Measured on the live engine today:

```
[TournamentRecurring.registerHorses.page_failed] Error: supabase_timeout
[TournamentRecurring] registerHorses skipped: fleet read incomplete
```

An entire tournament-filling pass abandoned because one HTTP request to read a
1,000-row fleet timed out.

## The change

A page read is idempotent - same cursor, same filter, no side effects - so
re-asking carries none of the hazard that makes retrying a WRITE dangerous
(CLAUDE.md 11.5). `fetchAllRows` now retries a failed page `PAGE_ATTEMPTS` (3)
times with a 200ms/400ms backoff, and only then declares the read incomplete.

Bounded deliberately: this runs inside the 5-second discovery tick, so a doomed
read costs 600ms of added latency, not an open-ended schedule.

Only the FINAL failure alarms. Reporting each attempt would turn one flaky page
into three alarms and bury the signal.

## What did not change

Fail-closed. When the database genuinely will not answer, the result is still
partial AND flagged, and every caller still bails. The retry rescues a flap; it
does not soften the contract.

## The pin that broke, and why it was right to

`flags incomplete on a page error instead of passing off a partial result`
failed a page on call 2 only - which now RECOVERS. Updated in this commit (not
left asserting the old rule) to fail from call 2 ONWARD, so it still pins
fail-closed against a page that stays down. Renamed to say PERSISTENT so the
distinction is legible.

## Verification

- `npx tsc --noEmit` clean
- `npx vitest run` - 327 files, 3,638 tests, all pass
- Seven new pins: recovers from one timeout, recovers from two, still fails
  closed when the page never answers, alarms once not per-attempt, stops at
  PAGE_ATTEMPTS, honours `pageAttempts: 1`, and retries the SAME cursor so a
  rescued page cannot skip rows
