# A hand settles the seat generation it dealt

**Production expansion:** Applied to `kuklfnapbkmacvwxktbh` on 2026-09-08
(migration ledger version `20260908161534`). The exact-sender engine and strict
contractions remain pending the staged application release and sole-engine
proof described below.

## What was wrong

The accepted-hand transaction identified stack and time-bank recipients with
`table_id + user_id + left_at IS NULL`. That is a current roster lookup, not a
hand identity. A player can leave after being dealt and rejoin before the old
hand commits. The same chair can also be reused in place: `table_seats.id`
stays the same while `joined_at` changes.

The stack core already has a lawful cash-only path for a participant who left
mid-hand. It applies that player's hand delta to the club wallet which received
the cashout. The obligations-aware outer commit did not share that identity. It
looked for an active seat when persisting the time bank and refused the whole
accepted hand with `time_bank_seat_mismatch` when the old participant had left.

## What changed

The engine now carries both `table_seats.id` and the exact PostgREST
`table_seats.joined_at` string from the dealt roster into:

- every `p_stacks` participant;
- the matching `p_post_commit_obligations.time_banks` participant.

The database expansion migration binds all inner stack selection and active
stack writes, plus the outer time-bank write, to the composite generation:

`table_id + user_id + seat_id + seat_joined_at`

The timestamp comparison is `timestamptz` equality in PostgreSQL. Equivalent
offset spellings therefore identify the same instant without a JavaScript Date
round-trip or precision loss.

For an exact departed cash generation, the late delta uses the `club_id` on
that historical row. It never searches for the user's newest seat. A
different-chair rejoin is untouched because its row ID differs. A same-chair
reuse is untouched because its `joined_at` differs; the old generation no
longer exists as a row, so settlement fails closed. Tournament departures
remain fail closed and never touch a cash wallet.

The request canonicalization and immutable receipts include the composite, so
a replay cannot substitute another generation under the same hand identity.

## Rolling release contract

This migration is the expand half of an expand/contract release. It accepts:

- an all-legacy protocol-2 envelope with neither generation field, while the
  old engine drains; or
- an all-exact envelope where every stack and time-bank participant carries
  both fields and both narratives agree semantically.

It refuses partial fields, malformed IDs or timestamps, mixed legacy/exact
rows, mixed stack/time-bank protocols, and cross-narrative generation changes.

Release order:

1. Apply `20260908161534_hand_settlement_targets_exact_seat_generation.sql`.
2. Deploy the engine which sends the composite generation.
3. Prove the exact engine is the sole live process and all legacy requests have
   drained.
4. Only then apply the already-reserved Stage-B contraction
   `20260908230002_tournament_manager_request_fencing_is_strict.sql`, which
   removes the legacy 9- and 11-argument doors. Do not batch that contraction
   ahead of the exact-engine cutover.
5. Apply
   `20260908230003_hand_settlement_requires_exact_seat_generation.sql`. It
   rejects any nonempty 12-argument or direct stack narrative missing either
   generation field, removes every legacy user-only lookup branch, and makes
   the seven-argument stack writer owner-only. The Stage-B door contraction
   alone does not enforce those JSON fields inside the surviving functions.

The contraction is intentionally not folded into expansion. Requiring new
fields before the old process drains would replace the original race with a
deployment race.

## Verification boundary

The migration uses exact one-hit substitutions against the two inspected live
function definitions. It aborts on MD5 drift or on any missing/duplicate anchor
and rechecks function ACLs and the rolling 11-argument door. Its PostgreSQL 17
probe covers different-chair rejoin, same-chair reuse, exact time-bank targeting,
malformed/mixed contracts, request identity, replay, and rolling legacy input.

The strict contraction pins the expanded function hashes, refuses to run while
either legacy hand RPC still exists, removes the remaining active-seat fallback
branches, and revokes the direct stack core from every application role. Its
second PostgreSQL 17 phase proves legacy payload refusal has no write, reused
same-chair generations still fail whole, different-chair historical targeting
still succeeds, and a semantically equivalent timestamp offset still matches.
The expansion, Stage-B and the later strict contraction each take the global
`realtime.subscription` catalog lock first with `NOWAIT`.

No cron, retry queue, watch list, reconciliation loop, or repair write is part
of this fix. Applying the compatible database expansion is not the engine
cutover or the strict-contract completion; those remain separate release and
post-deploy verification steps.
