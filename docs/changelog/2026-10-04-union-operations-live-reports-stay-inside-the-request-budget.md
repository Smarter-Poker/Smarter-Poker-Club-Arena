# Union Operations Live Reports Stay Inside The Request Budget — 2026-10-04

## Scope

Signed-in production verification of the Financial Admin console found two real report failures after the first Union Operations release: Risk and the read-only scheduled-settlement review both exceeded the database statement budget. Initial chart paint also emitted two invalid-size warnings before layout measurement. This follow-up is limited to those launch blockers and the CI contract that prevents their PostgreSQL proof from being skipped.

## Report Read Paths

- Risk keeps its existing authorization, selected-union ownership, canonical roster and signed-rake contract while expanding each agent deal once and reading inbound and outbound wallet flow through their maintained indexes.
- Scheduled-settlement preview keeps the Pacific-week boundary, arena name, three-round shape and shortage semantics while deriving commission and rakeback facts once per active pair.
- A settlement interval that fully covers the requested period still excludes that pair. Partial overlap remains visible, and persisted settlement rows remain authoritative for what has already been paid.
- Both functions remain read-only. No scheduled job, cache, repair loop or financial mutation was added.

## Painted Console

- The seven-complete-days chart now begins with a valid 280 by 132 pixel measurement while its responsive container takes ownership of the live layout. This removes the transient negative-dimension render without changing the painted shark, riveted or engraved console surfaces.
- The initial width fits the 375-first Club Arena contract and remains responsive at desktop and 393-pixel verification widths.

## Enforced PostgreSQL Proof

- The Data Console PostgreSQL wrapper now runs the Union Operations Financial Admin fixture exactly once and maps it to runner-owned scratch storage.
- The CI classifier now selects that native PostgreSQL job whenever the runner, binding or Union Operations fixture changes.
- Source binding pins the predecessor migration, this follow-up migration, fixture bootstrap and exact assertions so a mismatched proof fails closed.
- The first hosted run exposed one remaining Risk-plan gap: all six million expanded contribution rows reached the outer roster join before four million non-roster rows were discarded. The roster join now stays inside a bounded lateral subplan, emitting only matching players while the denominator still sees every contribution.
- The second hosted run proved the corrected body remained environment-sensitive and still crossed its fixed eight-second budget on the LLVM-capable PGDG image. Production PostgreSQL reports JIT unavailable and disabled, so the Risk reader now removes that ambient variable by pinning JIT off only for its own execution and restoring the caller setting on return. The fixture deliberately enables ambient JIT and keeps the same eight-second budget, preventing a session-level test escape hatch.
- PostgreSQL 17 qualification exercised one million six-way risk-deal rows plus 300,000 wallet legs under an eight-second statement budget, completing in 788 ms with exact signed totals.
- A separate one-million-distinct-map plan probe completed in 4,147 ms without a temporary-file spill, compared with 4,301 ms for the failed candidate. The enforced source guard rejects grouping or materializing contribution JSON, which independently regressed that high-cardinality case and wrote nearly 1 GB of temporary data.
- The same qualification exercised 2.2 million commission rows, including 1.7 million rows covered by a prior full-period settlement, completing preview in 92 ms with exact Round 2 and shortage totals.
- Small semantic cases separately prove signed reversals, canonical membership, partial and full-cover settlements, the distinct positive-payee and signed-club shortage aggregates, all three preview rounds, same-union authorization, cross-union refusal, owner and function grants, usable index state and installed source identities.

## Delivery Contract

This change is not complete until the candidate is integrated with current protected main, the focused client and native PostgreSQL gates pass, protected CI merges it, the exact migration is installed once through the supported workflow, the normal Club Arena publisher serves the merge from both public build endpoints, post-deploy checks pass, and a fresh signed-in 375-pixel and 393-pixel production review proves both reports without timeouts or chart-size warnings.
