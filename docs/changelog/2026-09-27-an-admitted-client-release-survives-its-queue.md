# An admitted client release survives its queue

The client publisher selected protected main cbee6e60 at16:57, waited over22minutes for its build runner, then refused the same immutable target because checkout observed one newer main commit. Vite and prerender had passed. The candidate was11commits ahead of the live origin, so this was a queue-induced refusal, not a rollback. Existing publisher concurrency already lets one active run finish while later pushes select the next target.

The existing web and native build steps now bind the admitted target to the protected publisher workflow, repository, push or exact recovery event, run identity and complete actual Git graph. The build retains truthful ahead/behind counts. Only a clean admitted ancestor of observed main qualifies when main advances. PR, unknown, shallow, divergent, rewound and mismatched identities remain refused. Both existing artifact predicates validate the admission record; trusted older zero-counter releases remain readable for rollback sealing.

The origin comparison, host lock, expected-current compare-and-swap, immutable asset pool, manifest verification, required client checks and single publisher are unchanged. This does not introduce a release timer, retry, fallback publisher or fake current-main ref.

Regression protection executes disposable Git graphs, the actual build stamper, both JavaScript/Python artifact predicates, the existing origin ordering case and host compare-and-swap. The original reader failed the new admitted-forward cases. Live publication remains a separate required outcome.
