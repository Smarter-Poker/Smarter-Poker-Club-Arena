# 2026-10-17 - Club Data stops retrying a read nobody wants

## What broke

`tests/components/club-data-page-renders.test.tsx > aborts a protected request
when its response deadline expires` failed two of six `publish-club-arena`
runs on 2026-10-17 (6df9f96a62, b001b51530), blocking the publish of #7285.
Locally it passed alone and failed about one run in ten when the whole file
ran under CPU load.

## Cause

Traced with a stack on every `ca_club_data_snapshot` call: the extra request
was a RETRY (retryFetch resumed after its backoff) from the PREVIOUS test's
ClubDataPage. That page had unmounted, but `coldRead` never asked whether its
answer was still wanted, so retryFetch ran its full budget and the late retry
called the shared rpc mock, which by then belonged to the next test.

In production the same defect means an owner who leaves Club Data mid-load,
or changes a filter, keeps paying for up to three more 12 s cold scans of the
full reporting window per abandoned read, answers that every caller already
throws away behind its own `stale()` check.

## Fix

`coldRead` takes the caller's abandonment check and hands it to retryFetch as
`isMountedRef`, so no attempt starts once the page has gone or a newer query
owns the result. The snapshot, ranked page, player totals, player page and
Load More reads use their existing `stale()`; the Recent prefetch, which Load
More of the same query may await, stops on unmount only.

## Pin

`stops retrying a cold read once the page that wanted it has gone` unmounts
mid-load and advances five minutes: exactly one snapshot request. It fails
before the fix. The whole file passed 30 of 30 runs under the same CPU load
that failed it before.
