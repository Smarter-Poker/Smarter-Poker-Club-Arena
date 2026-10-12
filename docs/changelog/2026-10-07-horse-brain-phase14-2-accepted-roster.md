# Horse Brain Phase 14.2 (plan package P14-A): the seated roster is recorded when a hand settles (2026-10-07)

**What was missing.** Nothing recorded who was seated in a hand, horse or human,
at the moment the hand was accepted. The daily horse audit classified players
from today's `profiles.is_horse`, and action-origin inference misses horses that
never act. Worse, the settlement door accepted extra keys in
`p_post_commit_obligations`, so a caller could place an `accepted_actor_roster`
object into a hand's stored payload: the exact field the prepared roster reader
consumed.

**The producer.** Migration `20261007024757_horse_accepted_roster_at_settlement.sql`
adds `smarter_private.accepted_hand_rosters`, a private, insert-once, immutable
record keyed by `(table_id, hand_number)` and bound to the hand id and its
`post_commit_payload_hash`. It patches the settlement door
`fn_ca_commit_hand_settlement` with md5-pinned anchors (live preimage
`ad4eadeb4df8113db0ba2b598d219aaf`, read back from production before merge;
postimage `a40343a901e12f134f0e876c08f604bd`; owner, security and grants
unchanged):

- A caller-supplied `accepted_actor_roster` obligations key is refused by the
  door's existing `invalid_post_commit_obligations` check.
- On first acceptance only, under the locks the door already holds, the
  roster is built from the hand's exact seat generations (lawfully departed
  seats included, silent and post-only horses included) and `profiles.is_horse`
  read in that transaction, then written to the private record.
- A replay returns the stored record and never re-reads profiles. A hand
  accepted before this change returns `legacy_missing`.
- The door's result gains `accepted_roster`. Nothing else in the result,
  the stored payload, its hashes, the money, the request identity or the lock
  order changes.

**It can never stop a hand settling.** The builder runs inside its own
exception block. Any failure records `unavailable` with a named reason, and
the hand commits exactly as before. A forced builder error is part of the
qualification and leaves stacks, wallets, receipts, hashes and the result
byte-identical.

**Why the roster is not inside the payload.** Seven installed seal checks
rebuild the original request hash from `post_commit_payload` (F06 movement,
mixed-prior, retained-abort, retired-origin, historical-loss, and
`fn_cash_atomic_original_matches`). A new top-level key would fail every one
of them. So the payload stays byte-identical and the roster lives only in the
protected record.

**Engine.** `handHistory.ts` validates the returned `accepted_roster`
(`horseAcceptedRoster/acceptance.ts`). Only a captured roster bound to this
hand reaches the private completed-hand observation, as `acceptedActorRoster`.
The worker boundary checks it again and the journal keeps it. Anything else is
observed without a roster, and nothing on this path can throw into settlement
or reach a public or client path. The prepared reader and exporter now take
the roster only from the protected record, and refuse a payload roster key as
`payload_roster_unprovenanced`.

**Verification.** `scripts/ci/test-accepted-hand-roster.py` (new, PostgreSQL
17, accounting shard 3) passes 56 roster assertions. Cases include the
spoofed key, silent and post-only horses, null and missing profiles, a
departed seat, a profile flip followed by replay, an identical replay, the
forced builder error, lock-set comparison, legacy stacks and receipts, and
privileges and immutability. The existing hand-submission probe passes 50/50
before and after the migration. Fourteen existing settlement, F06,
departure, Lightning and Diamond runners pass on PostgreSQL 17. Engine: 113
test files, 3,326 tests and the server typecheck pass. The real door output
was read through `readRosterCapsule` and `readReturnedRosterTransport`.

**Still open (Phase 14 later parts).** Nothing signs the roster as
independently qualified evidence yet; the reviewed signer is an owner
dependency. The export query is defined but not executed; that is P14.3. A
retained hand finished at table start is still not observed by the journal.
