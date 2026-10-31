# Complete decided-event discovery

GameServer discovery read only the first database page of RUNNING candidates even though it paged their playing rows. A decided event after candidate 1000 never reached its finish owner. The same path could wake a registered manager after discovery retired while its database read was outstanding.

The existing discovery now keyset-pages the candidate board, acts only on a complete result, retains quarantine reporting state on incomplete reads, and fences both candidate and player-count continuations against its generation. Recovery still uses the existing manager admission and elimination authority; no settlement, payout rule, or new repair loop is added. Other discovery branches retain their normal execution when this board cannot be read.

The real GameServer regression reproduces four failures before the change: the 1001st candidate omission, a late page error treated as a complete board, and manager wakes after retirement during either read. The current-owner positive control passes before the repair. This is a scaling and shutdown defect, not a proved cause of today's smaller frozen events. Hosted and production verification remain pending.
