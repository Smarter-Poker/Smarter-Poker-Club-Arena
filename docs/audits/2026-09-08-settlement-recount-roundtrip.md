# Settlement recount request reduction

The live engine cec6eb4d still measured a 7,920 ms median and 12,152 ms p90 between the hand-free broadcast and the next deal on September 8. Its bounded 2,000-sample window included eight rebuy pauses. This is not a two-second result. Settlement was the largest median phase at 4,184 ms.

The table-unlock settlement step made an authoritative seat count request, then always sent a table summary update request. The existing database comparison filter suppressed unchanged writes but did not eliminate the network request.

The engine now reads the active seat relation and the stored count/status together in one database snapshot. Matching summaries need no update request. Changed summaries retain the conditional database update. Failed or absent reads remain unknown, preserve the database summary, and leave the existing in-memory fallback for the paired table-unlocked event. A failed update is reported explicitly. The financial settlement barrier and next-deal ordering remain in place.

A read-only production SDK query verified the explicit table_seats_table_id_fkey relation and active-seat filter: six active seats, stored count six, running status, 346 ms from the development host. That measurement is not an engine-host latency promise. No schema change or paid gameplay test was used.

Validation: 12 behavioral recount tests plus 101 existing recount/cluster assertions passed; server TypeScript passed. Cases cover unchanged tables, joins/departures, status-only corrections, genuine zero seats, failed/missing relation reads, and failed updates.

Production adoption and post-deployment timing remain required. This removes one redundant request on a stable table; it does not establish that all next-hand latency is resolved.
