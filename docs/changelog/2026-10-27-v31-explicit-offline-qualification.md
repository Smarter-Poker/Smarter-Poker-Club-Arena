# Explicit offline V31 qualification

A manual protected-main workflow runs the existing V31 evaluator with the configured provider identity and the exact healthy serving engine source. Evaluation and promotion remain separate explicit operations; existing receipt, provenance and database gates remain authoritative.

Pull request admission checks cancel only a superseded run of that same pull request. Dispatched dataset operations serialize without cancellation. The existing concurrency law covers both boundaries.

Validation: five focused admission contracts and all 91 existing superseded-CI law checks passed. The inherited public-history fixture failure is resolved by integrating protected main's distinct sparse-fact UUID namespace; its assertions are preserved. Hosted exact-head qualification and protected merge remain required. No dataset evaluation, promotion or engine restart was performed by this change.
