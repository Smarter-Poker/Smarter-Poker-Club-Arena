# The felt uses the blinds of the displayed hand

The tournament clock and table metadata can advance independently of an active
hand or arrive out of order after reconnect. The client previously divided
stacks, wagers and pots by that mutable metadata. A missed 1000-to-1200 update
can therefore label a 1200-chip big blind as 1.2 BB; an early update can change
the denomination of an unfinished old hand. This is a reproduced source gap,
not proof of the cause of Mongo's October 30 report.

The engine now adds optional `hand_blinds` to its player resync, observer and
live snapshots. Amounts and hand number come from the frozen HandController
configuration and must match the published hand identity. The client validates
table and hand identity, keeps schedule metadata separate, and uses one display
denominator for seats, pot and action previews. Actual wagers and chip amounts
are unchanged.

A legacy tournament snapshot without this contract displays chips consistently,
with the existing central pot label reading CHIPS. The user's BB preference is
retained and resumes when a verified denomination arrives. Legacy cash behavior
is unchanged. This optional contract is backward compatible; complete BB recovery
requires the engine addition to be installed and the connected client verified.
It does not block the independent action-response repair.

Focused checks cover reconnect, old/new hand boundaries, identity mismatch,
legacy fallback, canonical chip action submission and the real engine's
publication methods. Production publication and natural live proof remain separate.
