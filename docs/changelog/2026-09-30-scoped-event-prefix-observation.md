# Preserve the engine's shortened tournament error marker

The bounded runtime reader required a complete event or table UUID, but manager
errors such as `Tournament.entry_window_close_refused` emit only the first eight
event-ID characters immediately after `Error:`. Those existing records vanished
from an explicitly scoped observation, hiding the leaf needed to diagnose a live
elimination backlog.

The reader now recognizes only that exact first-line marker under its existing
Tournament and TournamentManagerBase contexts. A marker matching more than one
selected event is refused. Full UUID matches remain preferred and unchanged;
prefix-only records have empty `scopeIds`, separate `inferredScopeIds`, and an
explicit `canonical_event_prefix_inferred` attribution. An eight-character marker
does not prove globally unique identity, so it is never reported as a full UUID
witness. Arbitrary message mentions, continuation lines, other contexts, malformed
markers and unselected prefixes remain excluded.

The existing symbolic-only output, secret redaction, selected scope, authentication,
fixed log command and byte/line/time/record limits are unchanged. This observation
change does not resolve the elimination defect or change the engine.

Validation uses the maintained native pipe fixture: the canonical emitter case
fails before the repair, then passes with negative scope/position/collision controls
and full-UUID precedence. The normal required wrapper continues to run the fixture.
