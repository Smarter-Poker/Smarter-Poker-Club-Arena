# An Unroutable Move Does Not Become An Ambiguous Commit

The move transport treated PostgREST PGRST202 and PGRST203 function-routing errors as uncertain writes. On a new operation this retained a source-table move pause despite the database function never being selected. The incident recorded by PR #4108 exposed the reachable missing-function path.

The existing refusal classifier now recognizes those two pre-execution errors. It keeps the same bounded identical-identity request attempts. The manager releases a definitely refused new operation through its existing refusal branch, without changing seats, paying anything or inventing a committed receipt. A previously ambiguous attempt, including one retained across calls, still requires its exact receipt. No existing ambiguous operation is discarded.

PostgREST documents PGRST202 as missing/stale function resolution and PGRST203 as ambiguous overloaded function selection: https://docs.postgrest.org/en/stable/references/errors.html (retrieved September 10, 2026). This classification follows that documented request boundary, not the text of an arbitrary server error.

Two new routing tests failed before correction; the expanded transport and actual-manager composition suites pass 20 tests after correction. The manager test calls the actual transport with a controlled Supabase response and verifies zero pending outcomes plus release of the source owner. The two lost-response/prior-identity cases preserve uncertainty. This is not a production move or settlement rehearsal.

Read-only observations at 05:24-05:36 UTC supersede the old absent-mover blocker: PR #4108 installed the forward move function and resolver, and 82 immutable move receipts across 18 events were present at 05:36:51 UTC. The historical full-cutover marker and the two older migration versions were absent in the earlier read. These observations establish the forward door exists, not the full historical cutover or move/rank acceptance.

At 05:32 UTC the live c4163531 engine still reported 20 stalled tournament tables, zero blocked settlements, and idle maintenance. This correction is not represented as recovery of those existing stalls. Full Phase 3, deployed adoption, and K08/K09/BX14 acceptance remain open.
