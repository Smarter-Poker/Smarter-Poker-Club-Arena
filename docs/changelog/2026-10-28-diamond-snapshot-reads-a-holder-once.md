# Diamond snapshot reads a holder once

Job201 timed out repeatedly on October27 and again at11:10UTC October28.
Its player Mint register aggregation must read action/amount from the ledger
heap because the existing indexes do not cover the holder grouping and sum.
The live read-only register query exceeded a five-second budget. In addition,
the fixture classifier runs for every historical custody row:110849rows but
only1009distinct holders at inspection.

The change adds a concurrent partial covering index for the original diamond
register query. It materializes the distinct holder set in the same original
statement and asks the existing authoritative fixture/cert classifiers once
per holder. The scalar classifiers are unchanged and remain authoritative.
The profile, register, house and arena readings retain one SQL snapshot;
all drift arithmetic, saved fields and incident consumers remain unchanged.

Native PostgreSQL17 runs the captured original and candidate full snapshot
functions with the actual captured classifiers. It verifies all stored fields,
steady/explained/unexplained movement, identical drift consumer output,
function identity/ACL/settings and replay refusal. The index plan changes from
a heap scan to an index-only scan over50012rows with7heap fetches from the
small mutable fixture tail. The external arena meter and incident consumers
are explicit fixture boundaries; this is not payout qualification.

The first candidate without the covering index still exceeded15seconds in a
live read-only benchmark and was not published. Natural production timing,
loaded index validity and affected report readback remain separate requirements
after protected merge and exact installation. No balance, receipt, policy,
schedule, timeout or financial guard changes.
