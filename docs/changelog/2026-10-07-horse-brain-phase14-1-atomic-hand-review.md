# Horse Brain Phase 14.1 (plan package P14-C): a horse hand review is published all at once (2026-10-07)

**The defect.** `recordHorseHandReviews` wrote a flagged horse hand in two
separate requests: an upsert into `horse_hand_reviews`, then one
`fn_hhr_rollup_add` call per newly inserted horse. If the second request failed
or its answer was lost, the review row stayed and its contribution to the
permanent `horse_review_rollup` never happened, and the loop's `break` dropped
every later horse's rollup with it. A resend could not reconcile it, because
the review insert deduplicated to nothing.

**The root fix.** One database function, `public.fn_hhr_record_atomic(p_rows jsonb)`
(migration `20261007020953_horse_hand_review_atomic_publication.sql`), publishes
one hand's review rows, their permanent receipts
(`public.horse_hand_review_receipts`) and the rollup arithmetic in one
transaction. Either all of it lands or none of it does. A resend answers
`replayed` from the receipt and adds nothing, also after the 30-day review
prune. A resend with different immutable content is refused
(`hhr_identity_conflict`). Rows are locked in horse-uuid order, so two hands
sharing horses cannot deadlock. The function is `SECURITY DEFINER` with
`search_path = pg_catalog, pg_temp` and schema-qualified relations, so a
caller's temp table cannot shadow the real ones. Execution is limited to
`service_role`.

The engine writer (`server/src/services/HorseHandReview.ts`) now makes that
single call. It stays fire-and-forget and never throws; an error is reported
under `HorseHandReview.record_atomic` and nothing is retried additively.

**Deliberately not done.** Rows written by the old split writer have no
receipt, and whether their rollup was applied is unknown. A resend that meets
one answers `historical_unknown` and writes nothing: no backfill, no reset, no
"applied" marker. `fn_hhr_rollup_add` stays installed until the new engine is
verified serving, then a cutover migration retires it. The legacy 20BB review
threshold is unchanged and is not merged with the gross >10BB population rule.
The rollup arithmetic is reproduced exactly, including repeated tags.

**Verification.**

- `scripts/ci/test-horse-hand-review-atomic.py` (new, PostgreSQL 17, CI
  `accounting_postgres` shard 4): 19 cases checking the raw rows, rollup and
  receipts together: first publication, exact replay, replay after prune,
  identity conflict, full rollback on a late invalid row, temp-table shadowing,
  mixed-case duplicate horses, legacy rows, six concurrent writers with
  reversed horse order (no deadlock, exact sums), privileges, and arithmetic
  equal to `fn_hhr_rollup_add` across rounding, repeated tags and UTC day
  edges. Nine deliberately broken copies of the function each fail at least
  one case.
- `server/src/services/HorseHandReview.atomic.test.ts` (new, 13 tests): one
  call per hand with every row, no split writes, errors and unreadable replies
  reported without throwing, the kill switch, and a byte-identical resend.
  `theDeadlineClockBelongsToNoTournament.test.ts` follows the new single call.
