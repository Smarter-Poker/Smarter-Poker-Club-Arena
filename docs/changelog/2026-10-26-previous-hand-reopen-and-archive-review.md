# Previous Hand Reopens And Recorded Reviews Stay Reachable

Closing Previous Hand while its history query was still pending cancelled the response without releasing its loading state. Reopening then refused to start a query. The load lifecycle now releases a cancelled read immediately, ignores its eventual response, and preserves settled ready or failed results. Canonical query failures reach the existing failure view rather than masquerading as an empty history.

Archive Replay controls were rendered inside the route's isolated stacking context, below the table strip. Replay now uses a body portal. The archive also opens the existing Hand Detail modal for the exact selected record, allowing Summary, Detail and Replay review of older hands beyond the live table's recent page.

Payouts, per-board allocations, public/private cards and engine contracts are unchanged. Focused regressions cover cancellation and reopening, stale responses, failure and retry, and the selected archive review and overlay ownership. Production verification is recorded separately in the task checkpoint.
