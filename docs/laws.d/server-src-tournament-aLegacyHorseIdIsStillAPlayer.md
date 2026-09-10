# server/src/tournament/aLegacyHorseIdIsStillAPlayer.law.test.ts

62 of the 1,000 horses carry ids minted before gen_random_uuid()
(`00000000-0000-0000-0000-0000000000NN`, `face0000-...`). Postgres stores them
in uuid columns and has seated, paid and settled them since February. On
2026-09-09 the atomic seat-assignment verifier required RFC-4122 version and
variant nibbles, so the database committed each such seat and returned ok:true
while the engine read the committed receipt as invalid, called the outcome
unknown and aborted the launch; nineteen MTTs sat REGISTERING for a day holding
881 live seats that every club card counted as ACTIVE. Nothing in the tournament
path may validate an id more tightly than the column that stores it: one shape,
`UUID_SHAPE` in `server/src/lib/uuidShape.ts`, and the seat receipt for a legacy
horse is an exact receipt.
