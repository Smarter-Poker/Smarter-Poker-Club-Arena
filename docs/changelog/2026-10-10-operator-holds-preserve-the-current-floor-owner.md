# Operator holds preserve the current floor owner

The durable per-table operator hold is integrated with protected main `71aa27a37d97e713df59df9a929b48c042505ec0`, preserving the independent floor hold, cash-close fencing and their original accounting qualification. The pause predicates retain every owner: maintenance, hand-for-hand, Lightning, floor, durable admin hold, pending pause and unknown-acknowledgment commands. A polled unheld snapshot cannot release another owner.

Two connected regressions exercise the real engine request/RPC boundary: a confirmed durable per-table resume leaves an independent floor hold parked, and releasing the floor cannot lift a pending pause or its unconfirmed `57014` acknowledgment. The original five floor tests remain intact. Mock return types follow the existing PostgREST mock seam.

Local validation: proper server compiler passed; six affected server files passed 65 tests before the added regressions, the final floor file passed seven tests, the two updated source-law files passed 17 tests, cash-source admission passed six checks, and the source-binding reader verified all 821 pins. The combined workflow preserves both accounting qualification steps and all historical source fingerprints.

These are source/integration results. Current-image import, isolated first-upgrade and rollback, representative funded lifecycle, protected delivery, runtime activation and physical-device acceptance remain distinct required launch evidence. No financial settlement or installed migration is replayed.
