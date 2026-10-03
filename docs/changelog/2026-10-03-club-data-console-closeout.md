# Club Data Console Closeout — 2026-10-03

## Scope

The Club Arena Data route and its connected financial, statement, report, casework, agent, tournament-payment, and wallet readers now use the approved `#ClubArenaConsole` painted families. The work preserves the existing server authorities and write doors; it changes client presentation, read validation, response ownership, and export completeness.

## Operator Experience

- Replaced flat cards, generic frames, improvised glyph controls, and CSS-built chrome with the painted spade, shark, and riveted console families.
- Kept action words in Title Case, retained engraved metadata labels, added explicit loading, empty, denied, stale, and unavailable states, and kept touch targets usable at 375px and 393px.
- Reset account-, club-, union-, period-, and route-owned data before a new scope paints, and reject late responses from an earlier scope.
- Kept forward-facing chip figures on the shared compact whole-chip presentation while exports retain their exact values.

## Data Integrity

- Club Financials validates its range, complete daily series, identities, counts, timestamps, exact-cent amounts, derived net rake and net revenue, and daily-to-total reconciliation before rendering or exporting.
- Union statement and insurance readers bind the response to the selected union and period, require complete accounting snapshots, reconcile row and aggregate counts and amounts, and reject malformed or partial payloads.
- Union statement amounts are signed from their persisted direction before totals render, payment capture now calls the maintained presettlement function, and both payment mutation receipts are verified before a success state can publish.
- Settlement History validates exact-cent invoice splits and requires gross rake to equal union hold plus club retained.
- Disputes, drift incidents, transaction ledgers, agent wallets, invoices, accounting summaries, tournament payments, chip statements, bomb-pot reports, and insurance reports fail closed instead of converting unreadable values into plausible zeroes.
- Sensitive casework and financial readers retain exact viewer/club scope and response-generation ownership across navigation, refresh, realtime, and account changes.

## Complete Export

- Rake export now prepares an immutable server snapshot and downloads every authorized row rather than only the visible browse page.
- Every page repeats and verifies the receipt identity, range, search, sort, scope, totals, expiration, and metadata fingerprint.
- Duplicate, missing, malformed, expired, unauthorized, changed-entitlement, non-advancing, and incomplete exports are refused without downloading a partial file.
- CSV output uses one browser/native handoff, UTF-8, RFC 4180 escaping, spreadsheet-formula neutralization, delayed URL cleanup, and no horse identity fields.

## Verification Contract

The release candidate requires focused Data-family tests, TypeScript, affected-file lint, copy and painted-console gates, production build, protected merge, the normal Club Arena publisher, matching public build provenance at both origins, the independent client post-deploy job, and signed-in desktop plus 375px and 393px production verification before completion is reported.

## Settlement History Live Contract Correction

Signed-in production verification found that `union_to_club` describes a transfer direction, not a settlement-cycle category. Four newer rakeback transfer documents shared that direction with the genuine rake-split history row, and the immutable legacy split mirror contained harmless binary serialization dust even though its authoritative gross and net columns remained exact cents. The reader now filters for both rake-split mirror fields on the server before its limit, refuses direction-only transfer documents, and accepts only sub-millionth-of-a-cent legacy mirror dust that reconciles exactly to the authoritative columns.

## Deployed Browser Certificate Corrections

- Club Pulse now gives its reporting range a full console row at every width, with the previous and next controls centered beneath it. This removes the range row's intrinsic tablet/desktop overflow without clipping content, weakening the page overflow check, or changing the approved painted console.
- Rate Audit now promotes the painted console title to the page's single `h1` in both access-check and ready states. The redundant visually hidden title was removed, so the page has one accessible `Rate Audit Trail` heading while retaining the same artwork and content.
- Rate Audit restores the visible `N Changes` label in the painted count pill, including the exact `0 Changes` state after two successful empty scoped reads; an empty history stays distinct from a failed read and never offers a false retry.
- Focused regressions bind the range layout to its wrap/order contract and preserve the console title element in the read-view harness so duplicate or missing headings fail locally.

## Policy Receipt

- Policy version: `2.9`
- Read at: `2026-10-03T14:33:04.256Z`
- Manifest SHA-256: `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`
- Owner policy: `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
- Operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
- Hardening standard: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
- Reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
- Reader: `d5e6189878846064ac60269a41dfc4e6d9a7bda54610110ddc5813230198f36e`

### Resumption Receipt

- Read at: `2026-10-03T16:28:35.288Z`
- Policy version: `2.9`
- Manifest SHA-256: `a659f31c5c1c2b0864889508079a635dd5fe2fc98decfbfc9d3f9c80dd45ec3b`
- Owner policy: `b9478d0331314413d8e12c41210b63479cdcabc1f86ed3fdcb3251efa36e6349`
- Operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`
- Hardening standard: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`
- Reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`
- Reader: `d5e6189878846064ac60269a41dfc4e6d9a7bda54610110ddc5813230198f36e`
