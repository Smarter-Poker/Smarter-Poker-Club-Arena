# Sibling table-size reads are no longer turned away by the main read's lockout (2026-10-25)

Horses read a player's saved profile for the exact game and table size, and,
when that profile is thin, the same player's saved profile at the sibling
table size (full ring for a short table, short for full ring). Both reads
shared one process-wide gate: at most eight at once, and any failed or
canceled read closes the gate for 1.5 seconds.

Measured over six production hours on 2026-10-25 (horse telemetry and
`pg_stat_statements`, SELECT only): 36,244 sibling reads were turned away as
busy and 156 succeeded, while the sibling select itself averages 0.1 ms in
the database. The exact read is the expensive one (13 ms mean, up to 8 s), and
its lockouts were starving the cheap read. Sibling reads feed the thin-profile
blend and the cross-table-size corroboration that engages a known maniac's
short-table read, so on most hands the horse fell back to whatever this
process had cached.

The sibling read now has its own gate with the same bound (eight at once, 1.5
second lockout after its own failure). The exact read's admission, timeouts
and database protection are unchanged. Pinned in
`server/src/services/HorseOpponentMemory.test.ts` ("donor reads have their own
admission"), which fails against the shared gate.
