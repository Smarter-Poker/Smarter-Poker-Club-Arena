# tests/a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts

No new migration may validate an identifier with a uuid-VERSION regex
(`[1-5]` version nibble, `[89ab]` variant nibble). A horse's id is
`00000000-0000-0000-0000-0000000000NN` and 33 human accounts predate the v4
generator - 95 of 1,198 profiles are valid uuids that such a pattern rejects,
which froze bounty settlement as `invalid_claimants` and, in `ca_index_every_seat`,
inverted into a stats index that covered only those 95. The files that already
carry it are frozen in a HISTORICAL list that may only shrink.
