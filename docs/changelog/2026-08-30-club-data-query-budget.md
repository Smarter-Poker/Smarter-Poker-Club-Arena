# Club Data production query budget

## What existed

The authenticated Club Data Games and Players RPCs both exceeded PostgreSQL's
8 second `statement_timeout` for Shark Club's real 14-day window. The game
helper scanned the tournament rake ledger and ran two correlated entrant-count
subqueries for every untagged rake row. `ca_club_data_snapshot` then executed
that helper three times: current summary, previous summary, and current rows.

The production trace measured 83,000 tournament rake rows and 200,000 relevant
tournament wallet transactions in the current window. The browser received
SQLSTATE `57014` and rendered “Could not load club data” / “Could not load
player data.”

## What changed

- Added covering partial indexes for the tournament rake window and tournament
  wallet transactions used by both Club Data RPCs, plus the Players ledger's
  cash buy-in/cash-out branch.
- Replaced per-rake-row entrant counts with one set-based tournament entrant
  aggregation while preserving tagged-rake and proportional shared-rake math.
- Materialized the current game result inside `ca_club_data_snapshot`, so its
  summary and visible rows reuse one execution instead of asking the ledger the
  same question twice.
- Combined the Players ledger's cash and tournament net calculations into one
  indexed wallet pass instead of scanning the same reporting window twice.
- Added a covering index for that combined predicate so PostgreSQL can satisfy
  the pass from the index instead of revisiting the wallet heap.
- Bounded the initial Players render to the top 100 rows, clears stale retry
  errors when a new request starts, and gives that ledger a 25-second browser
  budget so active-table connection queuing cannot abort an otherwise healthy
  sub-8-second database request. CSV exports retain a separate 30-second budget.
- Preserved the existing security boundary: the internal helper remains
  service-role only; the authorized snapshot remains callable by authenticated
  users and still enforces `ca_can_view_club_finances`.
- Added a source-level regression test that pins the bounded query structure
  in CI. Live execution timing is verified separately because CI has no copy of
  production volume.

## Verification

The full migration's function and privilege statements were parsed by
PostgreSQL inside a rolled-back transaction before production application.
After the migration is applied, both RPCs are timed against Shark Club's live
14-day window and the Daniel account is cold-loaded in production to verify the
real Games and Players states.

Real-time law: not applicable. This changes an on-demand historical report and
adds no table-state UI or polling path.
