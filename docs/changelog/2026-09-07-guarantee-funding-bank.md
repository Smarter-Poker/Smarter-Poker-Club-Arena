# Guarantee funding requires an actual bank debit

The original final guarantee function could claim an overlay and finalize an increased pool when both the selected bank and its club fallback were absent. The original-function temporary-fixture probe reproduced this behavior.

Migration 20260907230617 raises before claim completion or pool finalization when the bank UPDATE RETURNING yields no balance. The exception rolls back the overlay claim in the same transaction. Existing union-to-club fallback, guarantee amounts, event ownership and authorized negative-bank policy remain unchanged. The earlier event-ownership migration is included because it was absent from the inspected main tree and is a prerequisite to this audited definition.

Candidate and installed actual-function probes passed missing direct/fallback bank rollback, fully player-funded pools, replay, event ownership, private/standalone funding and successful union fallback. Tests use temporary copies without production wallet/ledger triggers; no historical payment or balance adjustment was performed. Existing-overlay proof and full escrow integration remain open.
