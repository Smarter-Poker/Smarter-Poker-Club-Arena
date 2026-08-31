# Cashier Phase 2: Authorization And Audit Contracts

## What Existed

The live database had narrower member and agent policies than an empty database
would receive from migration replay. The tracked legacy policies admitted every
club member to every roster and agent row, including financial fields. Ticket
upgrades also left two older policy names behind on some paths; one allowed any
cashier-role member to read every ticket in the club.

Agent send, agent claim back, and tournament ticket issue accepted a missing
retry key and generated a fresh value. First-party cashier surfaces already
supplied keys, but the RPC boundary did not require the safety contract.

Ticket cancellation and redemption both closed escrow with a generic
`peer_transfer` row. Neither row carried the ticket id, so the ledger could not
prove which ticket released the value or distinguish refund from redemption.

## What Changed

- Clean replay now rebuilds roster and agent visibility as self, owner/admin,
  owned-union overseer, or the caller's server-verified cashier downline.
- Ticket visibility is issuer, holder, or owner/admin full-cashier scope only.
- Anonymous agent and ticket reads are revoked, and browser DML on those tables
  remains closed.
- Public send, claim-back, and ticket-issue RPCs refuse missing retry keys. The
  proven money bodies are retained behind cores that authenticated callers
  cannot execute directly.
- Ticket cancellation writes `tournament_ticket_cancel`; redemption writes
  `tournament_ticket_redeem`. Both receipts contain ticket, issuer, holder,
  escrow action, and credited balance metadata.
- A partial unique index permits one cancellation receipt and one redemption
  receipt per ticket. A repeated close returns the original receipt rather than
  applying a second credit.

## Verification

- Migration DDL and assertions compiled inside a production transaction and
  rolled back.
- A combined transaction-isolated production probe produced thirteen PASS
  results and rolled back every fixture and cent movement.
- The probe covered missing retry-key refusals, player roster/agent/ticket
  privacy, cancel/redeem success, close replay, linked receipts, and exact
  one-cent credits.
- Focused Vitest and client TypeScript passed.

Real-time law: not applicable. This phase changes database authorization and
atomic ledger contracts; it adds no polling or snapshot-diff UX.
