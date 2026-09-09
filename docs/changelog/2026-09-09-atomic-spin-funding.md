# Spin Draws Book One Funded Rule Receipt

A Spin could select a prize using already-counted entries or reserve chips another launch was about to spend. Settlement could then create an operator-shortfall escrow credit without a matching bank debit.

The new launch RPC selects, books and stores the complete draw contract in one transaction. It validates still-paid entrants, holds the reserve lock through booking, rejects unbacked shortfalls and makes retries replay immutable rules. The engine reveals that receipt and uses its payout, stack and blind rules after restart. The database payout guard also preserves the receipt when the global ladder changes.

The approved Spin prices, three seats, 8% rake, probability table, payouts, levels and board stacks are unchanged. Historical draws keep their existing projected rules; missing historical odds are identified explicitly. No historical balances are repaired.

Verified with 42 isolated PostgreSQL checks, including a proved one-bust replay, refusal without that proof, refusal after a refund, and one-time adoption of an older funded draw. The merged client and server regression suites, TypeScript checks, and production builds are green after correcting two stale source assertions. The previously released base authority is live; publication of the played-game composition remains the release boundary for this change. The complete Phase 3 audit remains open; see docs/audits/2026-09-09-phase3-tournament-lifecycle.md.
