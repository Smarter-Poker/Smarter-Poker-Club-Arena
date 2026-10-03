# The money path walk stops at the first door (2026-10-03)

Phase 5 of 9 (alerts reach a person, and main CI green). Migration `20261003103506_the_money_path_walk_stops_at_the_first_door`, live as schema_migrations `20261003103544`. The recorded statements are byte-identical to the repo file.

## What was wrong

`fn_union_law_selftest` is the nightly proof that the union money law still holds. On 10-01 and 10-02 it did not answer: it was cancelled on its statement timeout, so the law it reports on went two nights with no verdict. Measured cold on 10-03 it took 263 s.

The money path half spent 25 to 51 s of that inside `fn_money_path_reaches_club_scope`. That function was a recursive CTE over `(name, depth)`. A function reachable by several routes was expanded again at every depth it was reached at, and the whole graph below the start was built before `EXISTS` could answer, even when the start function itself touched club scope.

## What changed

`fn_money_path_reaches_club_scope` is now a breadth-first walk in plpgsql:

- each function name is expanded once, recorded in a visited set;
- it returns `true` at the first function that reads `club_members` or calls `fn_pay_player_chips`;
- an edge is still a real call (the name followed by `(`) of a public function whose name is longer than six characters;
- the depth limit is still the caller's (6).

Reachability within the depth limit is the same set either way, so the answer cannot change, only the time it takes.

## Evidence

- The 12 production money paths: 12/12 agree, 4.4 s instead of 45.9 s.
- 54 random production starting points: 54/54 agree.
- 108 cases on a PG17 graph built to break it (a chain that reaches the door one step past the depth limit, a cycle, a diamond, an overloaded name, a short name, and a name mentioned without being called): 108/108 agree.
- Live after apply: `fn_union_money_path_check()` returns no rows in 3.3 s, and the full `fn_union_law_selftest()` reports healthy in 12.1 s warm (100 s cold, against 263 s before).

The migration refuses to run if the function it replaces is not the one measured (`MONEY_PATH_WALK_PREIMAGE_CHANGED`), if ownership or grants differ (`MONEY_PATH_WALK_AUTHORITY_CHANGED`), or if the installed text or the money path check comes out different (`MONEY_PATH_WALK_RESULT_CHANGED`).

No job is added or rescheduled. No chips move.

Pinned by `tests/the-money-path-walk-stops-at-the-first-door.law.test.ts`.
