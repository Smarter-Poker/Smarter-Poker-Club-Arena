# Keep the selected balancing player until a destination is available

The balancing planner removed the next-big-blind player from its candidate list before finding a free destination chair. A destination whose otherwise empty chairs were reserved consumed that candidate without moving them. Each blocked destination could discard another eligible player from the ordering.

Keep the selected candidate until an actual destination chair is found. Regression cases reproduce the wrong blind-order selection after one blocked destination after three blocked destinations, while checking unique moves and unchanged input tables. No production seat or chip edits are part of this change.

Existing table-break destinations also checked physical seats without checking roster reservations. They could retain a chair that the atomic move door would refuse on every dispatch. Validate both occupancy sources and use the existing immutable amendment path to select a free chair, preserving the source occupancy and predecessor request. The actual manager regression fails before the correction and exercises the amendment RPC after it.
