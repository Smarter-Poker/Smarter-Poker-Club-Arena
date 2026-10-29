# Native intake keeps each acknowledgement beside its read evidence

After #8595 installed, the first32 deliveries were genuinely read and ACKed.
The next32 were read, but automatic review could not establish complete visible
evidence for the combined32-ID ACK. That write was rejected and remained
unacknowledged. A healthy subscription and one successful batch did not prove
sustained intake.

The generated request now carries an exact manifest count and requires each
complete original/snapshot read to be followed immediately by its single-ID
ACK before the next read. Review rejection is preserved; no alternate identity,
tool or unchanged replay is allowed. An explicitly reviewed failed-attempt
record remains unread. Unknown outcomes retain their identity for inspection.

The existing source contract pins bounded read/write evidence and the existing
native consumer regression proves partial per-record outcome events do not
queue another batch, including restart. There is no database, game-engine,
financial, incident-state, scheduling or release-loop change. Sustained native
read/ACK and automatic advancement remain required live acceptance.
