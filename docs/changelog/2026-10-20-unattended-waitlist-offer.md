# A waiting-list offer opens its assigned buy-in

A player could join a must-move game's queue and remain there even after
a vacancy. The vacancy transaction only considered table-specific queues;
the global listener received holds but no longer opened their destination.

The existing seat-offer transaction now considers the game's FIFO queue
after the table-specific queue. It commits one notified game entry, one
table hold and the existing notification together. Actual capacity, pending
moves, wallet eligibility, private membership, bars and hold limits remain
authoritative. The offer-user claim also serializes a concurrent direct
game join. No new worker or repair schedule is introduced.

The client opens the real offered table with its existing buy-in deep link.
It handles first delivery, a hold discovered on reload, and the subscription
handoff; duplicate delivery, deadline extension and expired holds do not
reclaim focus. Buying chips still requires confirmation.

Native PostgreSQL qualification reproduces the missed game queue before the
change and verifies committed holds, notifications, eligibility, reservations,
concurrent vacancies, idempotent arrival and replay refusal after it. The
required accounting CI shard runs that fixture. The real SDK transport test
also verifies navigation through the mounted listener and bus without a
second join or purchase request. Publication and unattended live evidence
are recorded separately in the owning task checkpoint.
