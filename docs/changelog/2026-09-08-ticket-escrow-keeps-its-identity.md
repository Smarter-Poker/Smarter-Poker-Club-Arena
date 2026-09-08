# Ticket escrow keeps its identity

2026-09-08

The current cashier issues, redeems and cancels tickets through database transactions. Those transactions posted to an unnamed escrow account, preventing a ticket's funding and release from being identified directly in the ledger. They also left transaction-local ledger settings behind for later operations in the same transaction.

Issue now allocates the ticket ID before debiting the issuer, uses it as the escrow entity, and records it in the issuance receipt. Cancellation and redemption validate that receipt and release from the same escrow entity. Historical tickets without the new marker retain their recorded unnamed escrow identity. All three functions preserve and restore ledger category, counterparty, entity and tournament context. Authorization, wallet amounts, row locking and replay behavior remain in their existing transaction.

Validation: 67 isolated PostgreSQL cases passed, including 50 injected failures across journal, ticket, chip receipt and wallet receipt writes; issuance/release replays; context restoration; historical compatibility; mismatched receipts; inactive membership; and concurrent cancellation/redemption. The preceding 246 database cases also passed. No production monetary test writes or historical balance edits were performed.

Deployment: guarded function replacement through the production Supabase migration path, with existing service-only issuance-core and authenticated release permissions explicitly preserved. Repository publication follows the private Club Arena GitHub/Hetzner path. This closes ticket escrow identity and context gaps; it does not certify the remaining economy paths or resolve historical incidents.

Production verification: migration 20260908123720 applied successfully. The uncommitted filename was aligned with the authoritative applied version. Function hashes: issue 267995c5bd9d6231c8506625c1bf3d73; cancel b868529de4bff4db7c922486901d8bc6; redeem d878007c685fc08f6be985f1abc642dd. Anonymous execution remains denied for all three; issuance core remains service-only, releases retain authenticated execution.
