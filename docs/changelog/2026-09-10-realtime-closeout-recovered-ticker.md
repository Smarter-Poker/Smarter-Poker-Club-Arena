# Realtime Closeout Recovers The Uncommitted Ticker Query

The interrupted real-time continuation left a ticker query draft in its September
7 worktree. It was not included in the published source. That draft is preserved
under the Git snapshot named in the closeout checkpoint and applied narrowly to
current main in a separate worktree.

Completed tournaments cannot display in the operational ticker once their
ended_at is more than ten minutes old. Previously the database still returned
those historical rows before the 80-row limit, consuming query work and slots
that could contain live events. The query now uses the same ten-minute bound
for completed rows while preserving all five existing live/upcoming statuses.
The clock read happens before the request, so a result aging out during the read
can still be rejected by the existing render-time check. No existing eligible
status, club-membership filter, source switch, deadline or polling interval changes.

All 174 existing ticker tests across ten files passed. The full npm run build,
including tsc -b, passed after correcting a local pre-commit variable-order
mistake found by the first build. The public Supabase read endpoint accepted the
composite filter with HTTP 200 and zero anonymous rows. That is parser and
anonymous-access evidence, not an authenticated member visibility certificate.

No migration, financial operation, credential change, timer or new subscription
was introduced. The query is executed by TournamentStartingTicker's existing
operational feed load. Publication is verified separately after the normal
branch/PR pipeline, with the actually referenced compiled bytes.
