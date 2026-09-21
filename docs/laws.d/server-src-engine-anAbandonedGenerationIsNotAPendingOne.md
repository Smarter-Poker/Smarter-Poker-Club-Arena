# server/src/engine/anAbandonedGenerationIsNotAPendingOne.law.test.ts

An Abandoned Generation Is Not A Pending One, And It Is Proved From Rows:
`terminalBoundaryPendingGenerations` is opened immediately before
`HandController.start()` and resolved only at three sites downstream of
`HAND_COMPLETE`, while `fenceTerminalEngine()` nulls `handController`
synchronously - so after a fence the number was unreachable and the release
guard refused on it for ever, which froze the 2026-09-18 cutover for 59 hours
with 49 seats and 4,908,000 tournament chips behind it. This pins both halves:
the engine names a THIRD outcome, abandoned, at the exact line that makes the
generation unreachable, carrying why, never asserting the failure the guard
checks one step earlier, and still honouring a late failure that arrives from
work in flight at the fence; and the release guard, which cannot read a row
synchronously, DEFERS such a table instead of refusing or waving it through,
gated on the engine being fenced and fully drained, and refuses the whole
checkpoint unless the database proves no hand is in the air for each deferred
table - with the same freshness predicate the in-flight reader uses, "could
not tell" as its own refusing outcome, and no flag, option or argument that
turns that refusal into permission.
