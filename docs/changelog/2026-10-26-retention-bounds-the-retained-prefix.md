# Retention bounds the retained prefix before evaluating guards

The Phase 4 cursor migration is installed and advancing, but natural hourly
resets still hit 120-second statement timeouts (16:12 and 17:14-17:22 UTC).
The remaining cause is at the query's limit: choosing 250 **eligible** hands
still evaluates every retained row before it. The unchanged installed query,
run against an isolated PostgreSQL fixture, evaluated 1,250 accounting guards
to choose 250 eligible rows. The 20-second work budget cannot interrupt an
individual query.

Migration `20261026174211` materializes at most 250 raw history rows before
the existing guards and advances through the examined page even when all its
rows must be retained. It distinguishes an empty eligible page from the end
of the scan. A `(created_at,id)` cursor visits equal-timestamp rows across
page boundaries. The original timestamp index still bounds the range; no hot
table index or foreign key is added. The existing hourly pass revisits released
guards. The eight-day policy, all accounting/F06/restoration/human guards,
disposals, row-lock refusal, schedule, timeouts and 20-second budget remain.

Installation pins the exact installed preimage and preserves its owner, ACL,
security, volatility and search path. Cursor and disposals remain one
transaction. The new cursor column is private with the existing cursor table.

The source-bound native PostgreSQL fixture fails before the repair with
1,250 guard evaluations in a single 250-row batch and passes after. It also
checks retained-page progress under both join plans, reaching later eligible
rows, 600 hands sharing a timestamp, frozen entry, released guards, human
retention, atomic rollback, and a separate real transaction holding a row.
The first materialized-page prototype failed the hash-join countercase; the
locked lateral point read now keeps guard evaluation downstream of the page.
The existing accounting CI shard 4 runs the fixture through the maintained
native runner. This change does not by itself certify the separate engine
main-thread CPU cause or whole-system latency; production installation and
natural-run evidence are recorded in the owning task checkpoint.

The accounting workflow gains one shard-4 fixture step. Its six current input
bindings are refreshed to that reviewed workflow identity only; all financial
source pins, assertions, historical receipts and qualification states remain.
The normal push hook first refused an unqualified singleton cursor reset and
then stale workflow bindings. The reset now explicitly targets its singleton,
and the bindings name the actual candidate workflow. These failures remain in
the task evidence; successful hosted qualification is still required.
