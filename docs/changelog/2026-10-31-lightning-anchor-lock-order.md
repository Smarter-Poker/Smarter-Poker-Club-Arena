# Lightning formation and settlement acquire anchors in the same order

Production PostgreSQL 40P01 records show Lightning settlement waiting on
`table_seats` while matchmaking waits on that settlement. Formation locks anchor
seats in seat UUID order; settlement locked the same anchors in player UUID
order. Those independent UUID orders can oppose each other.

The settlement function now acquires anchors in seat UUID order. Its request
hash, canonical result order, delta calculations, physical settlement, receipts,
lease checks, role permissions and recovery paths remain unchanged. The migration
requires the exact installed preimage and verifies the resulting source hash.

A native PostgreSQL regression builds the maintained Lightning estate, uses
adversarial anchor/player order, and synchronizes two actual backends after the
first real settlement lock. The original settlement and actual formation barrier
reproduce 40P01. The corrected settlement completes without a cycle, commits one
physical hand and replays the same request. The existing required settlement
harness runs the regression against its own socket-only disposable database.
No production hand or balance is changed for testing.
