# Keep every ledger entry when statement pages share a timestamp

The statement sorted by timestamp and entry ID, but its continuation carried
only the timestamp. Entries committed together could disappear between pages.
A PostgreSQL reproduction returned 51 of 140 existing legs and skipped 89.

The reader now returns an opaque cursor containing timestamp, entry ID and
direction, bound to the requested account and club filter. The component sends
it unchanged, preserving PostgreSQL microseconds, and keys each rendered leg by
both ID and direction. Pagination remains bounded to 200 legs per page.
Balances, ledger entries, snapshots and account ownership are unchanged.

Cached clients retain the original RPC. It refuses a page when its timestamp
continuation would omit tied entries, with an explicit refresh error.
Unambiguous legacy pages continue to work. The current component uses the new
reader and refuses a missing cursor without falling back to the old one.

Native PostgreSQL 17 qualification exercises the actual functions with real
roles and fixture balance/policy readers: exact ordered traversal at page sizes
1, 2, 7, 50 and 200; self-transfers; microseconds; malformed and cross-account
cursors; club filters; browser denial; unchanged financial output and ledger;
legacy refusal and migration replay. Nine component tests cover the actual
RPC handoff, appended rows, self-transfers and failed continuation responses.

This is a read-path correction. Historical tournament settlement, payout,
custody and full horse audit acceptance remain separate.

Rollout order: install the new paged RPC, verify the component is served, then
apply the separate legacy-refusal migration. This keeps the existing reader
available while the component release is pending. Both migrations refuse
unqualified definition drift and are replay-tested.
