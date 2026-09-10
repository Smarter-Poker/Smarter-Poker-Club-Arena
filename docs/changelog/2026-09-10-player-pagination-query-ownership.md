# Club Data Pagination Keeps Its Query Owner

The production canary reproduced a player ledger stuck at 100 rows after
switching from Biggest Winners to Biggest Losers. Its bounded request
diagnostics showed a continuation for the new sort before that sort's fresh
first-page read. Successful responses ruled out a slow or refused page request
as the cause of that occurrence.

A cached query change could retain the old background-read guard, skip the
new query's reconciliation, and still accept the old response. A retired
pagination request could also clear the loading state of its successor.

The player ledger now retires outgoing reads and pagination when its user,
club, date range or sort changes, including cache hits. Restoration happens
before paint. Reads and continuations verify their query owner, and pagination
uses the cursor restored for that owner. A stale completion cannot release a
new request's loading state. The redundant passive cursor copy is removed;
every cursor writer updates its ref together with its state.

The existing server authorization, page size, request deadlines, background
refresh behavior, exports and production assertions remain unchanged.

Two mounted cases failed on the original source: the cached sort did not
start its own first-page read, and an old page completion removed the newer
page's loading state. Both now pass. All 27 mounted Club Data cases, 22 query
contracts and five export contracts pass (54 total). Existing source contracts
now recognize the query-owned cursor and completion guard.

The matching Games ledger had the same defect. Two more mounted regressions
reproduced a cached game sort skipping its read and an old Recent prefetch
clearing a newer ranked page's loading state. The Games repair retires its
read, cursor, prefetched page and pagination when the query changes, restores
cache before paint, and gates both prefetch and network-page completion on
the current owner. It preserves the 100-row first render and the existing
200-row ranked fetch.

All four new regressions now pass. The complete focused result is 29 mounted
Club Data cases, 22 query contracts and five export contracts (56 total).
The production canary must still verify this repair after publication.
