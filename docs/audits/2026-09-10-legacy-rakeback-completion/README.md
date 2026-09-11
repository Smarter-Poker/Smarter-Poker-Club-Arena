# Legacy Rakeback Completion Candidate

This directory is a reviewed local candidate. It has not been activated in production and is not an authorization to migrate it independently.

The existing direct player claim remains funded from the club treasury. The existing weekly Round 3 remains funded from the assigned agent's club wallet. Direct claim and Union Round 3 pin their admitted club set before taking sorted locks and restrict their payment cursor to that same set. A newly inserted closed period in another club remains payable on the next call. The unique existing period payout receipt and sorted club admission prevent those two legitimate paths from paying the same period twice. A shortfall on one path does not erase the historical entitlement or silently select another payer.

Direct claims select only closed UTC earning periods and the lower-level payer independently refuses an open period before it mutates the period or money. The pure-legacy cold scan uses the same explicit UTC dates as the mixed-source basis. Mixed captured-source periods recompute only their legacy remainder. Captured-only legacy projections become zero without a legacy financial receipt; captured-source entitlements remain in their separate funding owners. Paid historical periods and receipt rows are not rewritten or backpaid. Direct claims write the wallet receipt pointer after the actual wallet row exists. Round 3 records the exact period receipt, wallet pointer and single balanced journal leg. Round 3 uses explicit UTC earning dates and pays only periods fully closed by the requested bank cutoff, so the following earning week is never swept early. A status-transition guard independently prevents an old zero-payout branch from marking an open period paid without a wallet row. It leaves existing paid rows unchanged. Final receipt fences reject an old Round 3 body without the unique unpaid receipt, and reject an old direct-close body that includes captured-source value. Raising an error rolls back the preceding money mutation.

Round 1 excludes transactions already bound to captured bank receipts. The basis reader also excludes captured accepted-hand attribution and bypasses the active cache when the window contains captured bank receipts. Existing final historical settlement witnesses retain precedence.

## Verification

`python3 run-local.py` builds three fresh, private socket-only PostgreSQL 17 clusters, clears inherited PG connection variables, verifies each data-directory identity and empty TCP listener configuration, and stops each cluster after the run. Existing production credentials and connections are not read. Clusters are retained for ownership-safe cleanup.

- `before-proof.json`: three negative-control groups against the captured original payer bodies.
- `guards-proof.json`: the same three groups with 17 captured money guards. Existing journal uniqueness stops one weekly duplicate but does not stop the independent direct-claim payment.
- `after-proof.json`: 24 corrected groups, including observed transaction/advisory waits, authenticated actor scope, the two historical funding paths, mixed and captured-only periods, pointer evidence, shortfall preservation, final-journal rollback, and both captured old-body refusals.
- `runner-evidence.json`: exact executed source hashes and private cluster identity.
- `basis-fixture-pins.json`: repository provenance for the actual allocator, ledger-backed share reader and ghost-twin predicate.

The focused fixture has synthetic club, player, period and rake inputs. It includes actual captured payer owners, actual allocation helpers, table constraints and the documented money-guard subset. Authentication uses an authenticated database role with an explicit synthetic user claim. This is not a real browser session, HTTP API proof, complete production-schema replay, or proof that a call was compiled before a live replacement. The old-body tests execute exact captured function bodies under local test names, with no new money authority invented.

## Integration And Remaining Boundaries

The outer integration lane owns actual Round 1, Round 2, Round 3, conservation and producer/bank finality composition. It must run these exact candidate hashes with the complete source/capacity/claim owners. This focused runner does not install `02-legacy-round1.sql`; the outer lane validates that owner.

The candidate requires source and bank schema, source capture, R2 exclusion, captured capacity/payment owners, legacy payer exclusion, producer/bank closure and finality contracts in one reviewed activation. Online indexes are a separate pre-activation step. No capability row is enabled here. No financial period, weekly closeout or invoice is certified by these local tests. A currently compiled historical multi-period claim can still have its prior lock order; transaction abort/retry behavior across deployment must be checked by the coordinated cutover proof.

The prior V2 API/payer archive remains commit `7adbfb02544b68ccc1754c51f11d2f61fa406180` and browser archive remains `7a9c887a8277a759dc05312f0525472212a99a47`. Their existing proof is retained, not counted as fresh live browser/API verification. Production capability and an actual authenticated browser/API acceptance remain required before those callers can ship.

## Maturity Contract And Frontend Dependency

`maturity-contract.json` pins the existing contracts used for the maturity correction. The batch payer already selects closed periods. The period writer updates only pending rows and intentionally preserves paid weeks. Therefore an early direct claim could mark the week paid and exclude its later accrual from recomputation; that is a wiring defect, not a documented partial-claim feature. The V2 payer independently requires closed UTC earning weeks. No new payout cadence was invented.

The legacy `src/pages/RakebackPage.tsx` at the recorded base still sums every pending period for `Ready To Claim` and chooses the first pending club. Its display can therefore overstate readiness for open periods. This SQL archive does not fix or certify that frontend. The held V2 browser archive must be reconciled with these closed-period contracts and tested with the activated backend and a real authenticated browser before coordinated publication. No frontend capability was enabled by this followup.

## Aggregate policy successor, 2026-09-11

The prior f393 24-group report, runner hashes, source and probe are preserved under `historical-f393/`. The current 33-group report retains those checks and adds nine focused aggregate, malformed-basis, context and rolling-call groups. Round3 pins exact period membership while holding row locks, checks installed aggregate owed per club/agent/player before positive payment, and defers the entire group on shortfall. Funded retry creates exact per-period receipts and counts one player group as one payee. Negative offsets or absent/non-finite positive receipt basis refuse atomically for explicit repair; no replacement rate or zero contribution is invented. No live malformed-data census was performed.

The observed old Round3 tests start the actual original public body, observe its agent-row wait, replace that public function, pay either one or both selected periods by direct claim, then resume it. The preinstalled wallet fence rejects the aggregate receipt and rolls old money/status changes back. These establish an executing original body spanning function replacement; table fences were already present before the call. First-install trigger DDL overlap is reserved for the standalone successor proof.

Actual original multi-period claim tests also span public function replacement. Its old period-first lock order conflicts with club-first admission. Two private detector-timeout configurations exercise each deadlock victim: PostgreSQL aborts one transaction with 40P01, the survivor pays two periods once, and both retries pay zero. Callers must retry aborted transactions; an error-free rolling handoff is not claimed.

All-category journal endpoint checks distinguish direct treasury payments (treasury to suspense plus suspense to player) from one named agent-to-player Round3 leg. The exact original two-period claim comparator preserves evidence that atomic credit leaked app.ledger_category into the next treasury debit. Corrected close saves/restores that context, preserving the caller's original treasury category without changing amounts, funding paths, journal writers or history. Both possible rolling winners have exact linked receipts, no extra balance leg and zero net suspense.

This remains a dormant captured-source composition candidate. It cannot install on the current legacy-only production schema without separately reviewed capture prerequisites. The independent legacy package is in sibling 2026-09-11-legacy-rakeback-maturity. No production activation, money call, live browser/API acceptance or producer finality is claimed.
