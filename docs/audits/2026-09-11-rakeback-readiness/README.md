# Rakeback Readiness UI Candidate

This candidate separates loaded pending earnings from positive pending periods whose inclusive earning end date has closed at the following UTC midnight. It preserves the existing query, loaded history rows, chart and legacy `fn_claim_rakeback(p_club_id)` response contract. The first positive closed period in the existing display order supplies the club; newer open periods, closed zero rows and rows with a missing club cannot hide an eligible club. The button now says Claim Rakeback because each call remains scoped to one club.

The page schedules its next displayed period boundary without polling and recomputes the eligible club against the current clock at click time. Invalid date-only values remain pending. A loading or failed refresh disables a claim from stale data. Readiness is a client display hint: the server remains the authority for payout and funding.

## Verification

The focused component suite passed 8 tests in one file. `component-proof.json` records the exact source and test hashes; `component-test-output.txt` preserves the raw output. The suite executes the actual page, readiness helper, rewards header and retry owner with mocked external Supabase, auth, events and chart boundaries. It covers an open period, mixed clubs and history with successful club-scoped claim/refresh, zero and missing-club rows, UTC midnight while the page stays open, a clock change before the click, three malformed dates, and failed-refresh disabling. It makes no live financial request.

The initial runner launch failed before test collection because the provisioned dependencies had a hollow Rollup native package. A normal `npm ci --include=optional` in this isolated worktree restored the locked dependencies before the successful run. The package manifest and lockfile are unchanged.

## Activation Hold

This is a separately archived candidate on `backup/resume-poker-sep11/rakeback-readiness`, based on `61bab809fce854b37f7634d84bfc4565d7e80839`. It has no V2 capability, RPC signature, migration or production activation change. The corresponding server maturity guard remains in the payer coordinator's candidate and must be adopted through coordinated review before release. This UI test does not prove source admission, bank finality, funding availability, database maturity enforcement, or a deployed browser experience. The existing 12-row query limit is unchanged; the totals describe the currently loaded periods.
