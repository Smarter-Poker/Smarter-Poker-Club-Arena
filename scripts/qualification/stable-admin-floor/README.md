The maintained executable is `node scripts/qualify-stable-admin-floor.mjs`.
Set `PG_BIN` to PostgreSQL 17's binary directory and `TMPDIR` to an owned external
SSD scratch folder locally. CI may use its allocation's runner temporary directory.
The runner creates a unique database in its own Unix-socket-only cluster, refuses
non-PG17 or existing public schemas, and removes only that cluster in `finally`.

The schema contains synthetic fixture rows and selected dependency columns. All
financial owners are exact, unmodified repository function bodies extracted at
runtime: occupancy cashout, administrative departure, chip credit/session close,
diamond custody release/credit/debt registration, and their predicate helpers.
No test-only money or permission writer replaces those functions.

`operator-permissions-original.sql` is an exact function-body snapshot from World
Hub `supabase/migrations/20260903140000_ca_operator_approval_gate_is_exact.sql`.
Its complete fixture-file SHA256 is
`1a3989628731f59efba152cbec8a7e9162b1850df94d22712bc0e59f23539275`.
The snapshot makes Club Arena qualification independent of another repository
checkout. Named-role rows remain synthetic inputs to this original resolver.

Behavior covers scope refusal, parked seat admission, live hand/occupied close
refusal, original departure authority, refused chip/diamond credits rolling back
seat exit and receipts, exact-once chip and diamond returns (including diamond
debt retirement), cancellation before application, unsafe cancellation and end,
and durable status read from another connection. Native concurrent connections
also prove admitted seating serializes with park and duplicate original cashout
credits once. PGlite execution is provisional sequential SQL proof only; it is
not native concurrency evidence or production installation/live proof.

This fixture does not simulate an entire game or certify every existing ledger
trigger. Real dealer behavior and maintenance/v3 thaw run in the existing engine
test suites; qualification remains one source-level release prerequisite.
