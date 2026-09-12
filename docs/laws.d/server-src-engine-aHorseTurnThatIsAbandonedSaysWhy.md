# server/src/engine/aHorseTurnThatIsAbandonedSaysWhy.law.test.ts

A horse turn passes six authority checks - abort, supersede, hand replacement,
lifecycle, seat, lease generation - and any one of them can drop the turn on
the floor. Every one of those refusals was silent, so a table where horses had
stopped acting looked identical on every gauge to a table where horses had
nothing to do: fallbacks 0, worker idle at 4.9ms, decision paths perfect, while
timer timeouts ran 19-40 a minute beside 1,652 engine lease losses a minute
across 1,570 tables. Nothing said which check was refusing, so the cause was
diagnosed by guesswork and the first diagnosis was wrong.

The fence now names its reason. `fenceRefusal` returns which of the six
refused and `fenceIsCurrent(stage)` records it as
`poker_horse_turns_abandoned_total{reason,stage}`, seeded across all 36
combinations so a rule reading it is never an empty vector. `stage` says how
far the turn got; `commit` is the expensive one, where the decision was
computed and then thrown away.

This law forbids the bare `fenceIsCurrent()` - a fence that refuses without
saying why is the exact shape of the bug - and requires every call site to
pass a stage, so no refusal path can be added back silently.
