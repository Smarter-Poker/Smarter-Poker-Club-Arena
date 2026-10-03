# A tournament table's hand does not wait for its sibling tables (2026-10-03)

Migration: `20261003230910_a_tournament_table_s_hand_does_not_wait_for_its_sibling_tabl`.
Law: `tests/a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.law.test.ts`
(`docs/laws.d/a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.md`).
Harness: `scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py`.

## Why (phase 7, availability and break throughput)

Postgres lock-wait log, 21:05-22:59 UTC 2026-10-03, waits of 1 s or more:

| waiter | waits | on |
| --- | --- | --- |
| `fn_f06_finish_hand` | 1,362 | T(id) of MTT a9901ed2, exclusive |
| `fn_f06_allocate_hand_number` | 1,254 | same key |
| `fn_f06_hand_number_state` | 1,169 | same key |
| `fn_f06_begin_hand` | 825 | same key |
| `fn_f06_discover_breaks`, eliminations, moves, breaks | 330 | same key |
| `fn_ca_share_settlement_lane_for_table` (hand settlement) | 2,360 | behind the same queue |

Every one is the tournament lane of one running 40-table MTT ("Afternoon Free
Buy", started 21:00). It dealt 126 hands in 10 minutes across 40 tables. Each of
the four per-hand F06 calls averaged 55-70 ms (78k calls each since 21:00) against
1-3 ms of work: they all opened with `smarter_private.f06_prefix`, which takes
T(id) exclusively and the tournament row `FOR UPDATE`, so every table waited for
every other table. `2026-09-29-a-tournament-start-locks-the-bank-without-blocking-foreign-keys.md`
had named the cost and left it.

## Change

New `public.fn_ca_f06_share_table_lane(tournament, lease generation, table)`
(service role only): lease fence, G shared, T(id) shared, lease re-check,
tournament row `FOR SHARE`, this table `FOR UPDATE`, its seats `FOR UPDATE`, in
`f06_prefix`'s order and the shape the same table's hand settlement already
takes. It replaces `f06_prefix` in `fn_f06_hand_number_state` (and so in
`fn_f06_allocate_hand_number` and `fn_f06_table_state`), `fn_f06_begin_hand`, and
`fn_f06_finish_hand` for an accepted hand. Nothing else changes:

- `f06_prefix` and every tournament-wide authority (breaks, parks, moves,
  eliminations, custody, generation changes, cancellation) keep T(id)
  exclusive, and an exclusive request still waits for, and is not starved by,
  the shared table calls.
- A `never_started` finish keeps `f06_prefix`: proving that nothing started
  needs the exclusive lane, because hand-start writers only take T(id) shared.
- Calls on one table still serialize on its row.
- Hand numbers come from the global sequence under its own allocation lock; one
  reserved permit per table and one permit per (table, hand number) are unique
  indexes; source exclusion and tournament status are written only under the
  exclusive lane; the lease row fences the generation.

No money moves and no money path changes.

## Proof

The harness installs the exact live definitions of the three functions
(`scripts/ci/fixtures/f06-share-table-lane/preimages.json`, md5 `cfb6d1f8`,
`9dcf2427`, `d5700b1c`) and the live lane authorities on two PG17 clusters,
applies the shipped migration to one, and checks:

| case | result |
| --- | --- |
| migration applies to its pinned post-images (`79c2a20b`, `e498a501`, `f85ee8fb`) | ok |
| before: a sibling table waits 1.5 s behind a held table | ok (the defect) |
| after: the sibling answers in 11 ms | ok |
| after: the same table still waits | ok |
| a table call waits for an exclusive authority, and the reverse | ok |
| begin reserves, replays, refuses a second reserved permit | ok |
| an accepted finish needs its committed hand, then frees the table | ok |
| a `never_started` finish still waits for the exclusive lane | ok |
| a wrong lease generation is refused | ok |
| 8 tables x 6 hands with an exclusive authority interleaved: 48 accepted, 0 deadlocks, 0 errors | ok |

## Applying

The migration contains row-lock clauses, so the owner applies it with
**Apply Merged Migration**, outside the :50-:03 break window. Until then
`scripts/ci/schema-manifest.d/f06-share-table-lane.json` promises the new helper.

## CI wiring

The harness runs locally with `PG_BIN=/usr/lib/postgresql/17/bin python3 -B
scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py`.
Adding it as a step in `.github/workflows/ci.yml` needs a push with the
`workflows` scope (the patch bot's token cannot change workflow files), so it is
listed in the phase 7 report for a workflow-scoped push:

```yaml
      - name: A tournament table's hand does not wait for its sibling tables
        if: matrix.shard == 2
        timeout-minutes: 4
        env:
          PG_BIN: /usr/lib/postgresql/17/bin
        run: python3 -B scripts/ci/test-a-tournament-table-s-hand-does-not-wait-for-its-sibling-tables.py
```
