# server/src/observability/theLoopThatRenewsEveryLeaseCannotStopSilently.law.test.ts

`runOwnershipLeaseRenewalLoop` renews every cash lease and every tournament
lease in the engine process, it is launched once, and nothing relaunches it. Its
two exits were both permanent and both silent: a serialized pass that never
settles leaves `ownershipLeaseRenewalOperation` set forever so every later tick
awaits the same hung promise, and a clean return when the admission generation
moves on simply ends the job. On 2026-09-12 one of them stopped every renewal in
the platform for at least two hours. Measured at the database 73 seconds apart,
`heartbeat_table_leases_v4` and `heartbeat_tournament_leases_v4` did not move at
all (27,886 and 27,765) while `claim_table_lease_v2` took 283 calls, 233 a
minute: every one of the 78 cash tables was being killed by its own twenty
second proof watchdog and re-claimed, 26,129 times, three quarters of those
engine lives dealing no hands, at tables holding 9 of 9 seats, with 1,483 hands
abandoned mid-play.

Nothing logged, nothing errored and nothing alerted, because nothing failed - it
was not running, and an engine not doing a thing reads exactly like an engine
with nothing to do. The law pins the two closures and the instrument that tells
those apart: a pass is abandoned once it outlives the proof window it defends so
it cannot poison its successors, the loop leaving while its generation is still
current is reported as a fault, and `poker_lease_renewal_passes_total` is
zero-seeded across every outcome so a rule reading a rate of zero is never an
empty vector.
