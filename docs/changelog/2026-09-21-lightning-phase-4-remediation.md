# Lightning 2.0 Phase 4 remediation: a threshold reader that never raises, a verdict that can see the pending states, and one plan instead of three

2026-09-21. Migration `20260921142954_lightning_phase_4_remediation_a_threshold_reader_that_never_`.
Branch `agent/claude-lightning-p5/lightning/phase5-conversion`.

An adversarial audit of the merged `20260921064717`, run against the live
catalogue after it had applied, found one blocker and two majors. That file
stays exactly as it was applied; this one repairs what it got wrong.

## Blocker: the threshold reader raises, on the one path it promised not to

`fn_cash_cluster_lightning_thresholds` guarded its configuration read with
`jsonb_typeof(...) = 'number'` and then cast it with `::integer`. **Those two
admit different sets.** The guard admits every JSON number; the cast accepts
only `int4`; everything in between raises, and it was measured raising on a
throwaway backend carrying the live body:

```
{"on_threshold": 18.5}        22P02  invalid input syntax for integer
{"on_threshold": 18.0}        22P02  invalid input syntax for integer
{"on_threshold": 2147483648}  22003  out of range for type integer
{"on_threshold": 1e300}       22003  out of range for type integer
```

`18.0` is the one that matters. jsonb preserves the trailing zero - the error
text is literally `"18.0"` - and `18.0` is what `to_jsonb(numeric)` produces,
what a scaled or derived threshold produces, and what any serializer that does
not special-case whole floats produces. It is not a malformed value. It is the
ordinary spelling of eighteen.

**It does not stop at the reader.** `fn_cash_cluster_lightning_state` calls it
and `fn_cash_game_lobby` embeds that, and the lobby is `SECURITY DEFINER`,
granted to `authenticated`, and polled every five seconds while the must-move
modal is open. The propagation was traced end to end:

```
ERROR:  invalid input syntax for type integer: "18.0"
CONTEXT:  PL/pgSQL function fn_cash_cluster_lightning_thresholds(uuid) line 21
          SQL function "fn_cash_cluster_lightning_state" statement 1
          PL/pgSQL function fn_cash_game_lobby(uuid) line 2
```

One badly-typed configuration value would have 500'd every lobby open for that
Cluster, for every player, until somebody edited jsonb by hand. And the
function's own `COMMENT`, installed in production, said the opposite: that an
invalid configuration is "refused in favour of the defaults rather than raised,
because this is read on the path a tick takes and a reader that raises takes
the tick with it".

**Armed, not detonated.** 0 of 166 Clusters carry `ruleset_snapshot ->
'lightning'` today, so nothing in production could reach it. It arms the moment
anyone uses the configuration mechanism, which is the feature's whole purpose,
and the first person to use it would be an operator typing a number into a
Cluster's ruleset.

The repair is not a wider cast. It is to make the **guard** and the **cast**
admit the same set. `fn_cash_cluster_lightning_thresholds_probe(jsonb,
integer)` is the whole ON/OFF rule as a pure `IMMUTABLE` function of a
configuration and a handedness - so it can be fuzzed with any shape at all,
from a `@live-proof`, against production, writing nothing. Its guard is one
regex over the TEXT form,

```
^-?[0-9]{1,9}(\.0+)?$
```

and its cast is `floor(...::numeric)::integer`. At most nine digits, so `int4`
cannot overflow; an optional run of trailing zeros, so `18.0` is accepted **as
18** - refusing an operator's obviously correct intent is its own defect -
while `18.5`, `1e300` and `2147483648` fall back to the mandated defaults,
which is what the file always claimed it did.

`fn_cash_cluster_lightning_thresholds` is now a row read and a delegation, so
there is exactly one copy of the rule and exactly one place the four mandated
numbers are written. `source` also became per-field: the first cut reported
`ruleset` whenever _either_ half came from configuration, so an operator who
wrote `{"on_threshold": "30", "off_threshold": 5}` - a string and a number -
was told `ruleset` for a pair of 18 and 5, where only the 5 was theirs. A
half-applied configuration now says `ruleset_partial`.

## Major: the verdict is blind in the two states that re-ask the question

`would_turn_on` required `cluster_mode = 'must_move'` and `would_turn_off`
required `'lightning'`. Both are right for the **first** time the question is
asked and wrong for the **second**, and the specification's own conversion
sequence asks it twice:

|     | first asking                                  | second asking                                                     |
| --- | --------------------------------------------- | ----------------------------------------------------------------- |
| ON  | step 5, state becomes `PENDING_ON`            | steps 10-11, recalculate; if below the threshold, abort           |
| OFF | step 2, state is `LIGHTNING` or `PENDING_OFF` | if population rises above the OFF threshold, cancel `PENDING_OFF` |

So spec Phase 5 drives a Cluster to `pending_on`, waits for a conversion-safe
hand boundary, re-reads the verdict - and gets `false` unconditionally, because
the mode is no longer `must_move`. **Every conversion would have aborted at its
own safety re-check.** The mirror holds for `pending_off`, where the spec
explicitly wants the question re-asked so a recovered population can _cancel_
the drain, and a verdict that cannot answer there cannot say so.

Both filters widen by exactly one state, to `IN ('must_move', 'pending_on')`
and `IN ('lightning', 'pending_off')`. `would_turn_off` remains ungated on
`enabled` while `would_turn_on` is gated on it, deliberately and unchanged: a
disabled Cluster must not be allowed **into** Lightning and must always be
allowed to drain **out** of it.

This was undetectable today and undetectable by the proof set. All 166 Clusters
are `must_move`, and `20260921064717`'s own last proof asserts exactly that, so
nothing in that file could discriminate. The harness never built a Cluster in
either pending state.

## Major: the reader cost 3.6 ms of pure call overhead, measured

`20260921064717` argued its shape was cheap because the lobby "pays two extra
statements, not nine". That is true about statement count and is not a cost
claim, and nothing measured it. Measured now, warm, per call, on the busiest
live Cluster (30 eligible players):

|                                                           | ms/call   |
| --------------------------------------------------------- | --------- |
| `fn_cash_cluster_live_eligible`                           | 0.126     |
| `fn_cash_cluster_lightning_thresholds`                    | 0.025     |
| `fn_cash_cluster_lightning_state` (the two above, nested) | **3.746** |
| `fn_cash_game_lobby` (whole)                              | 15.603    |

The children cost 0.151 ms together and their caller costs 3.746 ms, so 3.6 ms
is the `CROSS JOIN LATERAL` into two SQL functions that carry `SET search_path`
and therefore **cannot be inlined** - a fresh plan per call, per level. That
was 24% of every lobby open, on a five-second poll, for an object nothing reads
yet. It is the same class of regression the Phase 3 remediation went back for
(6.13 ms to 13.97 ms on the tick worklist).

The repair keeps one definition and drops one level of planning: `LANGUAGE
plpgsql`, which caches its statement plans per session, calling each child
exactly once into a local. Section 4 of the migration repeats the measurement
and reports it as a `NOTICE` rather than asserting it, because a timing
threshold in a migration is a flake waiting for a busy afternoon - but a cost
claim with no number in it is how the previous cut shipped 3.6 ms of planning
overhead.

All ten top-level keys the lobby embeds survive unchanged: `game_id`,
`cluster_mode`, `cluster_epoch`, `lightning_enabled`, `must_move`, `enabled`,
`handedness`, `open_cluster_sessions`, `thresholds`, `verdict`. The post-apply
read-back asserts the set against every Cluster, because a `CREATE OR REPLACE`
that silently dropped one would compile, apply, and break the lobby.

## The audit was wrong about one thing, and it is worth writing down

It reported that the Lightning harnesses sit in a job that gates nothing,
because "Accounting transactions (PostgreSQL 17)" is not itself a required
check. It is not - and it does gate one:

- `.github/workflows/ci.yml`, the `server` job: `needs: [changes,
server_shards, accounting_postgres]`, `if: always()`, named **"Server Engine
  (typecheck + tests)"**, which **is** a required check;
- its one step exits 1 unless `ACCOUNTING_RESULT` is `success` or a skip it can
  explain - the diff not touching the server, or a superseded head sha.

All five Lightning harnesses gated merge before this change, and six do after
it. `tests/lightning-phase-4-remediation.test.ts` pins that: it parses the
`server` job out of the workflow and compares the workflow's real `needs` list
against the list the migration header quotes, so the header cannot rot into a
false claim.

The header also carries a **line number** for that job, and a line number is
the one part of the claim that cannot be pinned: wiring this migration's own
harness into `accounting_postgres` moved the `server` job from line 1873 to 1877. The test deliberately asserts the fact and not the integer, because a
proof that goes red for a change making its own claim more true is a proof
people learn to edit rather than believe.

## What this does not do

It converts nothing. There is no table DDL at all - no `ALTER TABLE`, no
`CREATE TABLE`, no column, no row. `cluster_mode` is read and reported and
never written, no epoch moves, and the read-back re-asserts that all 166
Clusters are still `must_move` after it applies. The verdict remains purely
descriptive; spec Phase 5 is what acts on it.

All three functions are `SECURITY INVOKER` with `SET search_path TO 'public',
'pg_temp'`, revoked from `PUBLIC`, `anon` and `authenticated`, and granted to
`service_role` only.

## Qualification

`tests/lightning-phase-4-remediation.test.ts` is 19 static and structural
assertions over the migration: the transaction shape and the absence of table
DDL, the integer pattern verbatim with its digit bound read back out of it and
checked against what `int4` can hold, the guard and the cast asserted **as a
pair** on both keys, the absence of any `RAISE` in the rule, the volatility and
security attributes of all three functions, the `REVOKE`/`GRANT` pair for every
function the file writes - driven off a regex over the file, so a fourth
function added later cannot slip past ungranted - both widened `cluster_mode`
filters, the ten reader keys asserted as a set, the four mandated numbers
counted in exactly one function, every `@live-proof` line parsed for balance,
and the CI claim above compared against the workflow.

`tests/lightning-phase-4-population.test.ts` lost one assertion and gained a
better one. It asserted `not.toContain('RAISE EXCEPTION')` over the threshold
body - and **that assertion was green for the whole life of the blocker**,
because the raise came from a cast and not from a `RAISE` statement. An absence
assertion that cannot name the mechanism it refuses is a comment with an
`expect()` around it. It now parses the guard and the cast out of whichever
migration most recently defines the rule and pins the pair: an anchored pattern
that bounds the digit count at nine or fewer, admits the trailing-zero decimal
form, and a coercion that runs through `numeric` and `floor()` rather than a
bare `::integer`. Pointed at `20260921064717`'s own body it fails on the first
clause - neither key carries a `~` guard at all - which was verified by
temporarily removing this migration from the tree and watching the suite go
red.

`scripts/dev/test-lightning-phase4-remediation.sh` is wired into the
`accounting_postgres` job immediately after
`test-lightning-phase4-population.sh`, and
`tests/lightning-phase-4-remediation.test.ts` asserts both the ordering and that
the path it names is really in the tree - a wired step that points at nothing is
a red CI run and nothing else. The harness applies the real fixture chain and
`20260921064717` to a throwaway PostgreSQL 17 cluster, exercises the blocker
against that pre-remediation body until it raises, then applies `20260921142954`
into the same backend and re-asks every claim of the catalogue. **It is owned by
a separate branch and was not run from here**, so no mutation count is claimed
for it in this entry; the six Lightning harnesses gate merge through the
`server` job either way.

## Rollback

Three function bodies and one new function. Dropping
`fn_cash_cluster_lightning_thresholds_probe(jsonb, integer)` and restoring
`fn_cash_cluster_lightning_thresholds(uuid)` and
`fn_cash_cluster_lightning_state(uuid)` from the `pg_get_functiondef` output
taken before the apply returns the prior behaviour exactly - including the
blocker. No table, no column, no row, no grant. No money moved. Nothing reads
the new numbers yet except the lobby, whose ten keys are unchanged.
