# Diamond Custody Keeps Held Money Separate

Phase 3 prepares dedicated Diamond custody so a game reservation cannot be mistaken for a club chip balance or spendable wallet money. Atomic reservation and release contracts bind retries to their original payload, preserve purchase provenance, and settle reversed-purchase debt without paying it twice.

A refused release raises and rolls back every money write in its transaction. Retrying the original request returns the same immutable receipt after success. The superseded recovery worker and proposed OpenClaw schedule have been retired to match production.

Available and held balances are exposed through an authenticated read and rendered on the Diamond access screen. Public funded gameplay remains closed for the later gameplay phases. Supply and trial-balance reports include custody and keep fixture holdings in the correct population.

Verification is recorded in [the Phase 3 audit](../audits/2026-09-08-diamond-phase-3-custody.md). The user explicitly approved the cutover and Supabase applied version `20260909065458`. Live reconciliation returned no discrepancies. Dependent publication and authenticated acceptance remain open.
