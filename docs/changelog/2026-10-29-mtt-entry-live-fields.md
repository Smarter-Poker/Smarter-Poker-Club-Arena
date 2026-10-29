# Tournament entries consume the live complete field

EntriesTab repeated its owning TournamentDetails roster read without pagination and on a 20-second timer. Its secondary detail map overrode newer rebuy, add-on and qualifier props. A later duplicate-read error could hide totals even when the owning page supplied all 1,001 entries.

The tab now renders the complete fields already supplied by TournamentDetails and its existing event/reconnect refresh. Registration order, avatars, player numbers, marks, watch actions and artwork remain intact. Missing numeric metadata remains visibly unknown. The redundant query and polling timer are removed.

Two rendered regressions failed before the change. Four rendered cases cover fresh rebuys, 1,001 entrants without a duplicate query, absent metadata and updated add-on/qualifier marks. Connected lobby, prize and snapshot suites passed 149 tests; TypeScript passed. No new engine API or database migration is required. Publication and affected live proof remain separate requirements.
