# Accepted observation lineage prerequisite

An action's hand number, worker fence and current seat are not durable observation identity. The accepted-hand producer now binds each eligible public action to the immutable hand UUID and its original ordinal in the full action list. Forced actions, private discards and runout pseudo-actions do not shift later ordinals.

The session key hashes the original actor, table, seat UUID and verbatim database join timestamp from the generation captured when the hand was dealt. Settlement passes its existing hand-bound generation snapshot before the atomic write. It never looks up a replacement seat, rounds away timestamp precision or exposes the raw seating generation in the action metadata.

The existing atomic hand transaction stores the identity with its accepted actions. The worker receives the same bound actions only after the receipt is validated. A lost response retries the same payload; a rejected or mismatched receipt never feeds observations. Missing lineage and non-voluntary origins remain explicitly unavailable. Caller-supplied identities are recomputed, and older actions without public nodes remain unannotated. The legacy HorseMind key and gameplay are preserved.

Verification on 1e848f90e8335b5e086cd9d0ce1760d393c60a8d: server build passed; 49 focused tests passed, including actual controller capture, the settlement snapshot across a yield, original ordinals, excluded origins, identity spoofing, pending/failed receipts and immutable retries. The full server suite passed 11,066 tests with 145 existing skips (759 passing files, one skipped file).

A separate native proof played 162 complete offline hands across nine variants, three seat populations, ordinary/bomb configurations and three action policies. It bound 2,205 unique public observations and excluded 70 private actions. Serialized retry and a separate Node process produced identical identity digests. Changing the raw seating timestamp by one microsecond kept observation IDs fixed and changed session keys. This verifies source identity stability; it does not prove database model deduplication or natural fleet behavior.

This is a Phase14 prerequisite, with no policy activation. Exact tournament stage/deduction context, durable scoped models, session/sample/uncertainty floors, proposal evidence, isolated holdouts, shadow evaluation and activation/rollback controls remain required. Protected publication and natural release proof are pending.
