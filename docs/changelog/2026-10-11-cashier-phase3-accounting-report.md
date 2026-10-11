# Cashier Phase 3: On-Demand Accounting Report

Reconcile Now now reads a single club-scoped accounting snapshot from the authoritative database in Trade and Advanced Cashier. Refreshing balances no longer claims reconciliation succeeded. Active owner, co-owner and admin access is required, including when the club owner identifier remains after suspension.

Bank and player expectations use their own opening-baseline timestamps and all booked ledger legs, including correction and reversal entries. Missing or future baselines remain incomplete; opposite individual discrepancies cannot cancel the verdict. Exact decimal comparisons preserve sub-chip discrepancies. Agent, promo, held and cash-table balances are explicitly unverified inventory; tournament units, pots, escrow and reservations are not presented as a full supply certificate. No repair or money write runs.

The first readonly production query exceeded eight seconds because its posted-only filter required heap reads over a 12.37-million-row ledger and omitted booked corrections/reversals. The final query materializes the club journal once, uses the existing covering partial index, and completed in about 3.7 seconds including tool transport. No new index or background worker is required.

The report rejects stale account, club and authority replies, including completed reports after authority changes, malformed or contradictory replies, duplicate clicks and offline requests. Failed reads show an error without claiming balances changed.

Qualification: 135 isolated PostgreSQL cases, including the original 98 transfer-authority/recovery cases; 114 connected mounted cases, including actual Trade-to-RPC wiring; 67 style/console contracts; app compiler and all four copy gates. Exact migration installed once as provider version 20261011164459, name 20261011162855_cashier_club_baseline_conservation_report. SQL MD5 314449638edc6e24e5f20b7fffbfb89f; native and production function definition MD5 070c95f0e89b41685aaf584068e76fce, PostgreSQL owner, STABLE SECURITY DEFINER, pinned search path and anonymous refusal agree.

Protected checks, merge, static publication and affected published desktop/mobile proof are separate delivery requirements recorded in the existing task checkpoint. No production financial fault writes or replay of earlier migrations or settlements.
