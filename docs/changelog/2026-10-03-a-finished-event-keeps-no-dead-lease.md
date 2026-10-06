# A finished event keeps no dead lease (2026-10-03)

The 19:07 restart left lease rows on COMPLETED events `aa27c94f` and `e52435d6`. Both finished at
19:06:34/37, and their holder stopped heartbeating at 19:06:40/45 without releasing them. After the
21:00 database restart, nine rows on COMPLETED/CANCELLED events were more than 60 s stale. A row
like this grants no authority, but it names a holder for an event nobody will deal again. Before
this change only the reaper's one-hour cutoff removed it, at boot or hourly, so it could stand for
up to two hours.

Migration `20261003210500_a_finished_event_keeps_no_dead_lease` edits `reap_dead_engine_leases`
by two measured anchors:

- The tournament loop also takes a lease whose event is COMPLETED or CANCELLED and whose heartbeat
  is more than 60 s old, whatever cutoff the caller passed.
- Such a row is deleted only exactly as it was locked, and only when
  `f06_lease_has_pending_custody` reports no pending custody. The retention is unchanged and still
  counted.

The 600 s floor, the table loop and every live event's lease are unchanged. Every engine runs the
reaper at boot, so a restart clears its predecessor's leftovers at once.

Local PostgreSQL 16 run, with the same function text and md5:

- a COMPLETED lease 90 s stale was deleted;
- a CANCELLED lease 2 h stale was deleted;
- a COMPLETED lease 20 s old was kept;
- a RUNNING lease 90 s stale was kept;
- a COMPLETED lease with pending F06 custody was retained and counted.
