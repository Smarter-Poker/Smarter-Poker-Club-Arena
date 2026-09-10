# Rakeback Payer Proof Checkpoint

This directory contains two separate results.

The ACL retirement in migration 20260910070710 has its own standalone runner and fourteen passing ACL assertions. That migration only retires three unbound service payment RPCs.

The broader source payer is a tested proposal, not a production migration or a wired replacement. Existing claim, batch and Round 3 implementations remain unchanged by the source proposal.

## Reproduce The Evidence

Run `bash docs/audits/2026-09-10-rakeback-payer-proof/run-local.sh guards` for three installed-function reproductions. Run the same script with `source` for thirteen prospective source-payer groups. Each invocation creates and removes a disposable PostgreSQL 17 cluster with a private Unix socket and no network listener. The Node runners reject any other host or database.

The historical fixture includes captured table columns, constraints and installed function definitions. The money-guards file adds seventeen captured financial triggers on top of three append-only triggers. The exact additions and body hashes are listed in money-guards-coverage.json. This is a financial guard subset, not a claim that every production trigger is loaded. Auth identity reads simulate JWT settings, and platform-freeze/overseer predicates are synthetic fixture dependencies.

With the actual key-claim trigger present, overlapping Round 3 calls do not double-pay: the second transaction fails with 23505 and rolls back. However, an actual authenticated fn_claim_rakeback call while Round 3 waits on the agent wallet still pays the same fifteen-chip entitlement twice, once from the club and once from the agent. Both calls use their captured installed bodies, and PostgreSQL lock waits are observed before release. The independent close also leaves its payout wallet_transaction_id unlinked.

The earlier unguarded experiment is superseded by guards-proof.json and must never be described as production-equivalent duplicate-payment proof.

## Prospective Source Payer

The prototype consumes ca_cash_commission_facts and its pinned activation boundary. It never recalculates a captured payer or negotiated terms from current membership. Pre-contract facts and legacy period estimates do not initiate payments. Invalid or unbound source terms remain unresolved.

Each accepted hand/player has one immutable exact entitlement accrual. The cash amount for an original payer and earning week is the rounded cumulative exact entitlement minus immutable cash receipts already paid. This preserves fractional claims: one hundred one-cent rake shares at fifteen percent pay fifteen cents; a per-hand rounded amount would have silently paid zero. Late sources carry their fractions into later cash receipts. A zero cash result never seals the source universe.

Every positive payment debits the captured agent wallet, credits the earning-club player wallet, and records an actual linked wallet transaction and journal leg. A funded club never replaces a short original payer. Source receipts, cash receipts and their referenced wallet/journal evidence reject later mutation. Repeated calls return the existing paid receipts while reporting zero new payout.

Thirteen groups cover mixed captured payers after reassignment, fractional carry, shortage and retry, invalid and unbound terms, the prospective cutover gate, overlapping period refusal, preserving legacy paid fields, journal failure rollback, observed concurrent payment, append-only/ACL protections and immutable linked money evidence.

## Required Before Integration

The source prototype is intentionally not callable from current claim, batch or Round 3 paths. Completing that integration requires all of the following:

- Acquire every involved club's shared payer lock in sorted order before any wrapper takes a period or wallet lock. The single-period primitive alone does not prove whole-transaction wrapper ordering.
- Verify the genuine union overseer through the complete authenticated wrapper and nested close. No caller-writable authorization flag is acceptable.
- Add immutable request receipts and retained client claim identity for lost-response recovery. Returning a period's paid receipts is financial evidence, not a complete request replay contract.
- Update period discovery and the UI together. RakebackPage currently sums full rakeback_earned for pending periods, so leaving already-paid accruals pending without changing the presentation would advertise money twice. The legacy recompute-period writer also ignores paid weeks. New source completion needs an explicit state, not a misleading calendar-final flag.
- Verify UTC canonical earning weeks against the current period writer and preserve every supported noncash or unassigned rate contract. The source prototype covers assigned cash facts and explicit self-agent zero only. Unassigned volume-ladder sources remain unresolved rather than zeroed.
- Exercise the full accepted-hand owner, activation overlap, reporting and source-period writers, and every production money trigger affected by the eventual path. The source capture checkpoint is owned by the commission-source lane.
- Rehearse all real wrapper overlaps, grants and rollback with that complete fixture before reserving a production migration, then verify the actual deployed release.

No source proposal SQL has been applied to production. No historical wallet repair, backpay, table lockout, forced engine restart or separate repair cron was introduced.

Independent review found session-timezone casts at source week boundaries. Explicit UTC half-open bounds and UTC today now match the source week, with UTC/Chicago boundary cases including the March DST week passing. The old worker uses UTC weeks but buckets rake_records.created_at, while new source periods must use accepted-hand settled_at to avoid retagging delayed Sunday banking into Monday.
