# A superseded original hands off its retained hand

2026-09-21 (written 2026-09-22 02:40 UTC). One migration,
`20260922022319_a_superseded_original_hands_off_its_retained_hand`, not
applied to production by this change. One PostgreSQL qualification stage and
one engine unit test pin it.

## What froze

Spins and SNGs dealt 12,940 hands on 2026-09-18 and none on 2026-09-21. One
freeze class behind that, read from production rows and the engine log:

- Engine process `1-3846b8bb` (container started 2026-09-18 21:55:50 UTC,
  release 8825af51) retained the exact settlement request of 69 finished
  tournament hands (51 Spin, 10 SNG, 8 MTT) between 23:08:14 and 23:12:25 UTC
  through `fn_ca_retain_hand_submission`.
- For each of them `financial_alerts` holds
  `atomic hand commit refused (lease_proof_expired)` from
  `ServerTableEngine.authoritative_hand_semantic_refusal`: the in-process lease
  proof expired between retention and dispatch, so
  `fn_ca_commit_hand_submission` was never called. There is no atomic receipt,
  no failure row, no handoff and no `f06_hand_dispatch` row for any of them.
- The same process claimed each of those tournament leases again under a new
  generation between 23:14:08 and 23:14:33 and has heartbeated them since.
- Every new manager calls `fn_ca_resume_hand_submission` at table start and is
  refused with `original_failure_or_handoff_unproven`: the container logged 950
  `retained_hand_submission_pending` lines in the 30 minutes before 02:07 UTC
  on 2026-09-22.

The refusal could never change. The handoff to a successor required a row in
`smarter_private.hand_submission_failures`, and only a database-side rollback
of a dispatched request writes one. `f06_retained_submission_guard` forbids a
no-start disposition for a retained hand, so nothing else could finish it
either. Those 71 events hold 262 seats, horses included.

Three more retained hands are stuck for other reasons and are NOT changed
here: two Spin tables whose original generation still holds the lease (the
original owner itself, whose own door is `fn_ca_commit_hand_submission`), and
one cash table whose roster changed after the hand (3 players in the request,
6 seated now). All three were first refused on 2026-09-19 by a pldbgapi2
debugger error inside the settlement ("cannot find parent statement on
pldbgapi2 call stack"), a separate defect.

## What changed

`fn_ca_resume_hand_submission` now continues a retained original once when
the caller holds the scope lease under a different generation, with or
without a failure row. The proof, read from the installed catalog and pinned
in the migration so it refuses if any premise moved:

1. The only writer of `public.hand_atomic_commits` is the owner-only
   `fn_ca_commit_hand_settlement_before_lease_generation`, reached only
   through the exact-generation core and the twelve-argument public door. That
   door takes this hand's submission lock before its lease check and holds it
   to its end. The resume reads the receipt after taking the same lock, so a
   settlement in flight is waited for and then seen.
2. The exact-generation core refuses any generation the lease row does not
   hold, reading it FOR KEY SHARE. The only writers that change a protocol-2
   generation take FOR UPDATE first, and releases DELETE, so the successor's
   own FOR KEY SHARE keeps the original out for the whole handoff.
3. `hand_atomic_commits` is unique on (table_id, hand_number), hand_number and
   hand_id, and the core replays an existing receipt with the same payload
   hash, which excludes the lease identity, without touching a stack.
4. The handoff settles the retained request byte for byte, only while every
   seat still holds its recorded `stack_before` and no later hand, receipt or
   permit exists, and the one financial claim stays single use.

The same-generation caller is still refused. Every other refusal is unchanged.

A second defect sat on the same path: the handoff admitted only
`tables.lifecycle = 'live'`, which production tournament tables never carry
(199,656 NULL, 65,874 closed, 0 live). The qualification fixture had inserted
its tournament table as `live`. A tournament table is now admitted while its
lifecycle is NULL; cash still needs `live`; opening, breaking and closed are
still refused.

The handoff result records which proof admitted it:
`handoff_evidence` is `canonical_failure` or `superseded_generation`.

## Proof

`scripts/ci/test-hand-submission.py` (Accounting transactions, PostgreSQL 17)
now installs the migration over the qualified journal, proves a replay is
refused, and runs `scripts/ci/probes/hand-submission-superseded.sql` in a
rolled-back transaction (14 assertions): the original generation is refused;
after a real `claim_tournament_lease_v2` takeover and a NULL-lifecycle
tournament table the successor continues the hand once, seats move once from
the recorded before-stacks to the retained result, one receipt, one hand row,
one spent claim, no invented failure row, the permit finishes accepted; a
repeat start has no effect; the fenced original gets `hand_lease_lost`; an
original that held the lease again only replays; a changed seat and a
breaking table still refuse before any claim. Two isolation races
(`superseded-original-in-flight-commit` and `-rollback`) prove the
successor's real claim waits for an in-flight original, acknowledges it when
it landed and hands off once when it rolled back. The existing owner and
maintenance races are re-run against the new definition.

`server/src/services/supabase/ASupersededOriginalHandsOff.test.ts` pins the
engine half: the successor asks with its own generation, the exact receipt the
PostgreSQL stage returned admits the deal, the original generation is still
refused, and the newest migration keeps that shape.

## What to expect after it is applied

At the next start attempt of each affected table its current manager hands
the retained hand off: 68 of the 69 tables whose seats still match the
recorded before-stacks resume dealing from the retained result. One MTT table
(hand 12976717) seated a ninth player after the hand and still refuses with
`HAND_SUBMISSION_HANDOFF_STATE_CHANGED`, as before. No repair job is added:
nothing runs until a current lease holder admits the table through its own
start.
