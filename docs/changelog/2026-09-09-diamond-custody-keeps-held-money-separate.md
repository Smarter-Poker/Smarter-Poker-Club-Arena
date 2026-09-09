# Diamond Custody Keeps Held Money Separate

Phase 3 prepares dedicated Diamond custody so a game reservation cannot be mistaken for a club chip balance or spendable wallet money. Atomic reservation and release contracts bind retries to their original payload, preserve purchase provenance, and settle reversed-purchase debt without paying it twice.

A failed release remains a durable obligation. The bounded recovery worker commits repayment before checking diagnostics; a broken report cannot roll back money already returned. The OpenClaw schedule uses the existing management alert path.

Available and held balances are exposed through an authenticated read and rendered on the Diamond access screen. Public funded gameplay remains closed for the later gameplay phases. Supply and trial-balance reports include custody and keep fixture holdings in the correct population.

Verification and the exact production cutover blocker are recorded in [the Phase 3 audit](../audits/2026-09-08-diamond-phase-3-custody.md). This change is not yet deployed: automatic approval review requires explicit approval for the production financial-schema migration. Dependent frontend, worker and schedule publication must follow successful database application.
