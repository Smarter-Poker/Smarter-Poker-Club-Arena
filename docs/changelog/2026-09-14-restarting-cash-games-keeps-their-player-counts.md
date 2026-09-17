# Restarting cash games keeps their player counts

Startup preserved occupied cash seats but overwrote every open table's player
count with zero. During the September 14 maintenance restart, the club lobby
showed NLH 2/5 Madness and Classic as empty while their seat records still held
two and four players. Counts recovered after dealing resumed, leaving the lobby
wrong throughout the break.

Normal startup now resets only the table status. Seat transactions retain
ownership of the count, including arrivals that commit while the restart write
is pending. Closed tables and tournaments retain their existing treatment.
A rejected status write is reported and cannot produce a success message.

The real startup method is exercised without constructing a server or opening
network connections. Five old-source failures reproduce occupied-count loss,
a concurrent arrival being erased, repeated-restart loss, and false success on
a rejected write; the empty-table and protected-test-table controls pass before
the repair. The existing table-closure guard now forbids a normal-start count
write while continuing to require the cash-only status filter.
