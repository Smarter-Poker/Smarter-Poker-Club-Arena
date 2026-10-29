# Recover a missing table decision before accepting input

Mongo's October29 screenshot reported intermittent failed folds that needed a
reload. First-party events identify Mongo and seven ACTION_CONTEXT_REQUIRED
refusals on the current7447d54c client,08:53–09:17 Chicago. This is the engine's
missing-token refusal, distinct from an ordinary changed-turn STALE_ACTION.
Transport losses coexist; they do not establish the exact ordering of his frames.

The client previously submitted an optional render-captured decision token and
only refreshed after an unknown delivery outcome. A null token from an input
retention boundary or table update could therefore be posted repeatedly, with
the old-bundle reload message and no request for authoritative state.

The Classic input path now reads its token at the tap, refuses to send an
unbound action and requests one bounded snapshot. Missing/stale/pending decision
refusals use that same state request. It returns control to the player and says
the action was not sent; it never replays or binds that old choice to a new turn.
Lightning's existing contextless fast-fold path is preserved. Scope checks keep
late responses from showing a popup on a different table/account.

Regression coverage exercises all four state-recovery outcomes, no automatic
resubmission, ordinary errors and Lightning compatibility. The existing lost
answer contract follows the extracted helper. A mobile browser case injects an
explicit synthetic missing-token snapshot, checks no Fold POST is sent, observes
RESYNC and verifies a new gesture can act without reload. This is a reproduced
failure mode, not a claim of a recorded wire trace from Mongo's device.

This is a client-only change using the existing RESYNC protocol. No migration,
engine replacement, financial mutation or restart is required.

The missing-token readiness check runs before optimistic action paint. The
combined mobile run exposed why: painting a fold first armed a fence with no
decision, which could keep the refreshed controls hidden. The guard-order
regression and mobile test cover that connected failure too.
