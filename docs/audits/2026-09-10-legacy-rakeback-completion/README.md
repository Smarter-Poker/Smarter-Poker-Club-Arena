# Legacy Rakeback Completion Candidate

This directory is a reviewed local candidate. It has not been activated in production and is not an authorization to migrate it independently.

The existing direct player claim remains funded from the club treasury. The existing weekly Round 3 remains funded from the assigned agent's club wallet. The unique existing period payout receipt and sorted club admission prevent those two legitimate paths from paying the same period twice. A shortfall on one path does not erase the historical entitlement or silently select another payer.

Direct claims select only closed UTC earning periods and the lower-level payer independently refuses an open period before it mutates the period or money. The pure-legacy cold scan uses the same explicit UTC dates as the mixed-source basis. Mixed captured-source periods recompute only their legacy remainder. Captured-only legacy projections become zero without a legacy financial receipt; captured-source entitlements remain in their separate funding owners. Paid historical periods and receipt rows are not rewritten or backpaid. Direct claims write the wallet receipt pointer after the actual wallet row exists. Round 3 records the exact period receipt, wallet pointer and single balanced journal leg. Round 3 uses explicit UTC earning dates and pays only periods fully closed by the requested bank cutoff, so the following earning week is never swept early. Final receipt fences reject an old Round 3 body without the unique unpaid receipt, and reject an old direct-close body that includes captured-source value. Raising an error rolls back the preceding money mutation.

Round 1 excludes transactions already bound to captured bank receipts. The basis reader also excludes captured accepted-hand attribution and bypasses the active cache when the window contains captured bank receipts. Existing final historical settlement witnesses retain precedence.

## Verification

`python3 run-local.py` builds three fresh, private socket-only PostgreSQL 17 clusters, clears inherited PG connection variables, verifies each data-directory identity and empty TCP listener configuration, and stops each cluster after the run. Existing production credentials and connections are not read. Clusters are retained for ownership-safe cleanup.

- `before-proof.json`: three negative-control groups against the captured original payer bodies.
- `guards-proof.json`: the same three groups with 17 captured money guards. Existing journal uniqueness stops one weekly duplicate but does not stop the independent direct-claim payment.
- `after-proof.json`: 20 corrected groups, including observed transaction/advisory waits, authenticated actor scope, the two historical funding paths, mixed and captured-only periods, pointer evidence, shortfall preservation, final-journal rollback, and both captured old-body refusals.
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
