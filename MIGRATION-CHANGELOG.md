## 2026-09-14: A rake settlement cannot bank a fee without attribution

**Files:** migration20260914223105, captured native fixture/runner, source law, package test command and changelog.
**What existed:** the captured live authority could exhaust four attribution attempts, retain the banked fee and return ok:true/attributed:false. An incomplete old claim also returned success. Main terminal settlement separately checks attribution; the rake authority itself did not enforce the same boundary for all callers.
**What changed:** preserve transient retries, propagate exhaustion/permanent SQLSTATEs, roll back incomplete logical attribution, refuse incomplete historical replay without altering it, and return stored attribution on complete replay. No formulas, amounts, Diamond custody, lock order, permissions, repairs or payments changed.
**Verified locally:**90 PostgreSQL17 assertions with real row contention and explicit financial transaction recorders;8 source-law tests and root TypeScript pass. Historical349 fee amounts and2128 player VIP/rake receipts match; commission completeness and original initiating errors remain open. UNINSTALLED. Full financial dependency, native release and production verification remain required.

# Historical migration record

Current work belongs in the existing dated changelog and owned source handoffs. This frozen history does not authorize reviving retired services.

The byte-identical original restored history is retained outside maintained source in the restricted restoration archive at `work/pipeline-archive-20260916/sentry-removal/arena-before-historical-cleanup.tar.gz` under restoration task `01a0ab39-71ca-7821-825d-4943a0a6a0a3`. Its SHA-256 is `d4fd498044efa369789594695a04251eaba64d9fc9caa5daa182291ff88082a9`. Git object history was not rewritten.
