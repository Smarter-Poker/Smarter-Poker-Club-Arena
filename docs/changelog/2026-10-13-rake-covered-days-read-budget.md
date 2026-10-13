# Advanced Club Data covered settlement query

The first installed paid-index improvement preserved the accounting JSON but cold live Month requests still timed out. Actual production query plans identified 1.22 million still-open rows inside already-covered settlement days as the remaining cost.

The reader now uses the existing qualified daily amount for a complete UTC day inside merged settlement coverage. Unqualified days and partial edge pieces retain exact indexed raw reads; a one-time filter rejects complete days before opening those scans. Explicitly settled commissions outside the merged coverage remain disjoint. NULL, nonfinite, all-null aggregate, launch boundary and historical attribution behavior remain unchanged. No new metadata qualification, financial writer, schedule or request-timeout change is introduced.

Validation includes the existing 1,424 native JSON/clamp cases and unchanged original writer invariants. Under the same live read-only Month plan, the candidate used about 75,000 raw edge rows instead of 1.22 million and completed in 908ms versus 5,014ms. These observations are scoped measurements, not an unconditional latency guarantee. Actual guarded installation, all periods, automatic refresh and publication still require verification.
