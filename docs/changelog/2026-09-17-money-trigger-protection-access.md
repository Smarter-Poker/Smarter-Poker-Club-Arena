# Money-trigger protection is checked by an identity that can read it

GitHub omits `bypass_actors` from a ruleset response unless the caller can write that ruleset. The PR's readonly token therefore failed the strict protection guard even when the actual main ruleset had no bypass actors. This was reproduced against the maintained CLI with GitHub's documented response shape; no previously successful readonly full-protection baseline was found.

The PR now checks visible applicability and the exact independent App-bound required context, then reports deferral. The complete strict guard and its missing/nonempty-bypass refusals remain unchanged. Full qualification stays with the original default-branch money-trigger reporter.

Immediately before completion, that trusted workflow mints the existing infrastructure App 4680372 token for Club Arena only, with Administration permission only. Trusted finish code reads ruleset 21163380, applies the strict guard, and revokes that token before re-reading the PR head or writing the financial check. Automatic action cleanup remains enabled for interruption. Its second revocation can warn that the token was already revoked; it does not make the action fail.

The original check-only reporter App 4962039 remains the sole check writer. A single-use in-memory protection receipt binds the current run, captured head and reporter identity; no JSON artifact or input boolean can supply it. Missing, refused, stale or failed protection/revocation cannot report success. Existing five-minute live-catalog freshness, same-head checks and SQL qualification remain in force, with captured-state and SQL-proof run identity checked explicitly.

Regression tests execute the real PR CLI and trusted finish CLI with a closed fake transport, including credential separation, revocation ordering and failure paths. Existing protection and revision-boundary tests run through the already-required money-trigger CI caller entrypoint. These are local regression results; real provider execution and the original reporter-key restoration remain separate delivery prerequisites. This source-only correction changes no SQL, ruleset configuration, App permissions or production data.

References: [GitHub ruleset response visibility](https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset), [token action cleanup behavior](https://github.com/actions/create-github-app-token/blob/v3/lib/post.js).
