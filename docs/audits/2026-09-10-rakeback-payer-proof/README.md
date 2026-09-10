# Rakeback Payer Proof Checkpoint

The current cumulative funding and V2 API candidate is documented in [round1-owner/README.md](round1-owner/README.md) and [closeout-inventory.md](closeout-inventory.md). The original per-week model below remains historical proof and is not the current proposed cash contract. No proposal here is activated.

The three unbound payment RPC retirements have fourteen standalone ACL assertions. The source payer and direct wrapper proposal now has thirty-one native PostgreSQL groups. Neither proposal is a deployed replacement.

## Reproduce

Run `bash docs/audits/2026-09-10-rakeback-payer-proof/run-local.sh source` for the source payer, claim, close, batch and Round 3 evidence. The runner creates and removes a PostgreSQL 17 cluster with a private Unix socket and no network listener. Node refuses another host or database.

Run the same script with `guards` for installed-function baseline reproductions. Seventeen captured financial triggers supplement three captured append-only triggers. The precise subset is listed in money-guards-coverage.json. This is not the complete production trigger graph. Auth JWT reads and platform freeze remain fixture dependencies. The union overseer function now uses its captured production body, MD5 5a42c5e7097a527856f56fc7224f9457, with minimal fixture relations.

The guarded baseline shows Round 3 versus Round 3 aborting the second duplicate with 23505. Actual installed authenticated claim versus Round 3 instead pays the same entitlement twice, from different club and agent sources. PostgreSQL waits are observed before release. The unguarded older experiment is superseded.

## Prospective Contract

Each accepted hand/player has one immutable exact entitlement accrual from captured source-time payer and negotiated terms. Only captured receipt generation 1 and matching accepted payload hashes establish admission. Historical unmarked receipts, legacy period estimates, invalid assignments and unbound unassigned policy cannot initiate payments. Genuine self-agent zero remains explicit.

Provisional cash is the floor to whole cents of cumulative exact entitlement per captured payer and UTC earning week, minus immutable cash already paid. Fractions remain liabilities. One hundred one-cent rake shares at fifteen percent pay fifteen cents, including a payment attempt after every source. At 104 sources, exact entitlement is .156 and cash remains .15; at 107 sources, cash reaches .16. A .01 rake source with valid 70/60 agent/player terms retains .006 rather than paying an unearned cent. Final cent apportionment requires a separate explicit source-finality witness.

Every positive payment debits the captured payer wallet and credits the player wallet at the earning club in the same transaction as actual linked wallet and journal records. A short payer never falls back to the club. Source, payment, request, attempt and linked money evidence reject mutation.

Canonical source periods are separate from legacy period estimates. Read-model pending is unpaid cash entitlement, not full earned value. Exact unpaid fractional liability is returned separately, including fraction_pending status. Paid-so-far never claims finality.

The named claim RPC binds request UUID, expected authenticated player and club filter. An immutable original result survives late sources and repeat calls. A new request can claim later entitlement; replay of the old request returns the original result byte-equivalently. Account or club scope changes refuse.

All claim clubs are admitted in sorted order before discovery, period or wallet locks. Direct claim/batch and authenticated Round 3/close races share one payer identity. The multi-club/multi-week case observes a wait on the final club while the first period and payer wallet remain available to a separate transaction.

The existing batch worker excludes paid/zero weeks and uses immutable attempt order to avoid starving funded recipients behind a short payer. Its budget starts after scope admission, and it always permits the first selected due attempt before a soft budget exit. No new cron was added.

## Verification Limits And Remaining Work

- source-payer-proof.json records thirty-one passing groups and observed lock waits. Full public fixture table content is compared on final journal failure and on final claim-receipt failure after payments across two weeks.
- source-payer-wrappers.sql is executable local proposal SQL. It replaces legacy claim, close, batch and Round 3 only inside the disposable fixture. The browser and deployed functions have not switched.
- union-cascade-installed.sql pins the captured outer function. union-cascade-source-boundary.sql proposes cache warmup first, payer-club admission before Round 1, conservation before partial-shortfall returns, and withholding the settled marker while source_final is false. This outer patch still needs complete native cascade rehearsal.
- Source-compatible Round 2 and direct agent claims need the same prospective source admission, recipient, earning week and payment receipts. Created-at ranges and current active-agent joins are insufficient.
- Full accepted-hand owner and production money-trigger composition, live source activation overlap, management deferral routing and immutable finality authority remain required.
- Complete browser wiring must retain request identity after an ambiguous response, offer recovery after pending reaches zero, preserve prior history and reject stale-account completions.
- Production query plans and indexes for club/player/week source discovery and the fair due queue remain to be verified at representative scale.
- Genuine unassigned and noncash policies remain separate release gates. No new policy or historical backpay is inferred.
- No production source-payer migration, manual wallet repair, forced engine restart or table lockout has occurred.

### Newly Verified Release Blockers

Production Union weeks use America/Los_Angeles while player earning weeks use UTC. The current Round3 prototype full-containment selector excludes normal source weeks from Pacific cascade windows, including the 167-hour spring and 169-hour fall weeks. The thirty-one direct tests do not certify real Union calendar dispatch. union-funding-catalog.json records the exact definitions and three read-only boundary results. A simple prior-week selection is not accepted: original source IDs must retain their earning identity and bind to actual funding receipts in their recorded Pacific funding window.

The accepted-owner source extension is adding original Union route/rates, but the authoritative bank receipt bridge and Round1/2 funding coverage are not yet composed. Current source_active is only a prototype capture marker and must become an explicit coordinated payer release witness before any browser activation.

The generation/timestamp edge in this payer fixture is synthetic boundary testing, not an observed production clock defect. The actual accepted receipt uses clock_timestamp(); accepted-owner overlap proof belongs to the separately composed owner fixture. The marker and payload hash establish ownership independently of calendar inference.

## Exact Outer Control-Flow Rehearsal

Run `bash docs/audits/2026-09-10-rakeback-payer-proof/run-local.sh cascade`. Ten native groups execute the exact captured outer definition and its guarded patch with explicitly synthetic round effects and a synthetic conservation dependency. They verify assertion ordering, provisional/shortfall return behavior, all-public-row rollback for malformed or failed Round2/3 contracts, numeric-cast failures, assertion failure and repeated-patch refusal. This is not evidence of actual Union money conservation, complete production triggers, funding coverage or finality.

Malformed/failed Round2 and Round3 contract branches now raise 23514 so earlier rounds and audit rows roll back. Existing numeric casts can raise 22P02 before those branches; the tests preserve that distinction. Valid typed shortfalls still retain progress only after conservation succeeds. Existing Round1 failure/incident behavior is unchanged. Broader finite/nonnegative shape validation and full warm-cache/standalone Round1 lock rehearsal remain separate gates.

The eventual source_final field must bind the common producer, bank, Round1 and Round2 finality witness. The current permanently provisional player result cannot certify that chain by itself.
