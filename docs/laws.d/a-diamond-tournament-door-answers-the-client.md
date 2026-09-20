# tests/a-diamond-tournament-door-answers-the-client.law.test.ts

A Diamond tournament door answers the client the way the client already
reads. `fn_poker_arena_context` reports the tournament switch beside the cash
switch it already reports, so the lobby can label a Diamond event "Not Open
Yet" instead of offering a Register the server refuses. The registration
core answers an ordinary Diamond refusal - not enough settled Diamonds, the
door closed, an unsettled debt, an entry already held - with `{ok:false,
reason}` exactly as it answers a chip refusal, and re-raises everything else
(a raise is what the client treats as an unknown transport outcome, retries
once and reports); its success receipt names the asset and the Diamond
wallet after the charge, and the Diamond unregistration receipt carries the
wallet after the refund, so the client can move the balance it shows without
a second round trip. This pins migration
`a_diamond_tournament_door_answers_the_client`: three in-place edits, each
with its live md5 pinned and the reverse substitution proved, the chip debit
asserted still present, the unregistration authority still owner-only, and
`tournaments_enabled` never written on.
