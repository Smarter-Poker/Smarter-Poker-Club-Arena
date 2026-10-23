# Announce committed MTT standings after every accepted hand

The tournament HUD/lobby cannot receive chip changes through Postgres Changes:
tournament_players is deliberately excluded from that expensive publication.
The exact settlement already writes the chip mirror atomically with the hand.

The current table owner now announces standings_changed on the existing
authenticated tournament channel after exact acceptance is proved. It reaches
observers at every table and in the lobby, carries only table ID and hand number,
and cannot turn a presentation failure into a failed accepted hand.

This engine signal is backward compatible. The separate client delivery will
consume it only after serving engine adoption is proved. No database publication,
financial writer, release policy, maintenance boundary or scheduled job changes.

Focused verification includes real ChannelHub fanout, tournament isolation,
transport error handling and placement behind the authoritative commit gate.
Deployment must use the maintained engine route and sealed production proof.
