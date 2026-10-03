# Two red workflows on main: a missing aggregate, an open counter, and a freeze read as a defect

2026-10-02. `Telemetry Exposure` and `Club Create Certification` were both red on
`main`. They are unrelated faults and they are fixed separately here.

## 1. Telemetry Exposure: two reel counters answered any logged-in account

Run **37071022389**, job `No unscoped definer answers a browser`, measured what
`public.fn_ca_browser_reachable_telemetry()` measures: routines that are
`SECURITY DEFINER`, executable by `anon` or `authenticated`, and that never look
at who is calling. It found two:

```
decrement_reel_count   volatile  authenticated  (p_reel_id uuid, p_field text)
increment_reel_count   volatile  authenticated  (p_reel_id uuid, p_field text)
```

**Verdict: a real defect.** Both bodies were read before concluding anything.
Neither is a tombstone. Each one is a live `UPDATE public.social_reels SET
<field> = GREATEST(COALESCE(<field>,0) +/- 1, 0)` behind a four-name field
allowlist, with no identity check at all. `SECURITY DEFINER` means RLS does not
apply, so the policy `Users can update own reels` never saw those writes: one
logged-in account could move any reel's `like_count`, `comment_count`,
`share_count` or `view_count`, on anybody's reel, as far as it liked by calling
the RPC in a loop.

No RLS policy calls either routine (checked with the `pg_policy` query the
check's own remediation text prints), and no other database routine does.

The routines come from the World Hub (`social_reels` is Social). Their callers
were read rather than guessed:

| caller                                                       | passes                        |
| ------------------------------------------------------------ | ----------------------------- |
| `pages/hub/reels.js:1535,2153,2212`                          | `view_count`, `share_count`   |
| `src/components/social/Reels.jsx:726,1788,1847`              | `view_count`, `share_count`   |
| `src/components/social/ReelsFeedCarousel.jsx:1642,1679,1802` | `view_count`, `share_count`   |
| `pages/api/social/interactions.js:186,370` (service key)     | `like_count`, `comment_count` |
| `pages/api/social/share-count.js:100` (service key)          | `share_count`                 |

Nine browser call sites, all `+1`, all `view_count` or `share_count`. Not one
browser call site touches `like_count` or `comment_count`, and those two already
have a table of truth and a trigger that keeps them: `trg_sync_like_count` on
`public.social_likes` and `trig_update_reel_comment_count` on
`public.social_comments`.

`20261002225448_a_browser_moves_only_the_reel_counters_it_is_the_evidence_fo.sql`
therefore makes both routines consult the caller: a request arriving with an
`anon` or `authenticated` JWT must be a signed-in viewer (`auth.uid()` not null)
and may move only `share_count` or `view_count`. The service role keeps the full
field set, because the World Hub's own routes are the reconciling writer. The
field allowlist, the `social_reel_aliases` canonicalisation that landed in the
World Hub's `20261001221500` the day before, and the `GREATEST(...,0)` floor are
unchanged.

**Nothing was widened to make the check pass.** `authenticated` keeps exactly the
`EXECUTE` it held; `PUBLIC` and `anon` are revoked again explicitly (`anon` has
held nothing since the 2026-08-31 definer sweep) so a later blanket `GRANT` line
has to be deliberate. Dropping `SECURITY DEFINER` to match the `social_posts`
siblings was considered and rejected: `increment_post_count` is `SECURITY
INVOKER`, which is exactly why a viewer bumping somebody else's _post_ counter
updates zero rows, and `social_reel_aliases` is service-role-only under RLS, so
an invoker routine would silently lose yesterday's canonicalisation.

The function's source of truth lives in the World Hub. The migration header says
so, and says that removing the caller check turns this Club Arena check red
again. That is the reader.

Pinned by `tests/unit/aBrowserMovesOnlyTheReelCountersItIsTheEvidenceFor.test.ts`.

## 2. Club Create Certification: a uuid with no `min()`

Run **37064989099** reported `Atomic Create Failed: 55006 PLATFORM_FROZEN`;
the newest run on `main`, **37073302753**, reported something else entirely:

```
code: '42883'
message: 'function min(uuid) does not exist'
```

Two distinct faults, in sequence, and the second is the one that had the workflow
wedged.

**Verdict: a real defect.** `20261002210559_post_reset_welcome_certification_cleanup`
(applied 21:05:59Z the same day) added the state-B preparer that retires a
reserved certification club _after_ its welcome reset has run. Its third
statement is

```sql
SELECT min(reset_operation_id), ...
  FROM public.club_welcome_package_items i WHERE i.club_id = p_club_id;
```

and `club_welcome_package_items.reset_operation_id` is `uuid`. Postgres has no
`min(uuid)`. plpgsql resolves that at execution, so the preparer raised 42883 on
its first and every call: the branch has never once completed.

The consequence was not local. `scripts/ci/certify-club-create.mjs` clears
residual fixture clubs _before_ it creates its own, so one unretirable club
failed every later run in cleanup rather than in club creation. Three were
stranded behind it (`2ef3c802`, `94d9ac6e`, `32caee5b`), two of them past their
reset and therefore on the broken branch.

The aggregate is the only thing wrong. The intent is "the single operation id
every item shares", and the lineage check three statements later already refuses
any item whose `reset_operation_id IS DISTINCT FROM` it, so any one of the equal
values is the right answer.
`20261002225231_post_reset_welcome_certification_reads_its_one_reset_operati.sql`
replaces the preparer with `20261002210559`'s body and one cast,
`min(reset_operation_id::text)::uuid`, which is how this database already takes a
uuid extremum (`fn_settle_tournament_places`,
`fn_settle_accounting_commission_stage`). Nothing else changes, and the preparer
stays revoked from every role including `service_role`.

No repair job, sweep or backfill is added for the three stranded clubs: the
certification's own cleanup door, once it works, is what retires them, and it
runs at the top of the next run.

Pinned by `tests/unit/postResetWelcomeCertificationReadsItsOneResetOperation.test.ts`.

### The `feature_pricing` lead was checked and is unrelated

`20260922143541_club_and_union_diamond_commerce` did delete the
`feature_pricing` row for `club_creation`. Neither failure touches it: 42883 is
raised in residue cleanup before any pricing is read, and the earlier run's
55006 came from `zz_freeze_guard` on `chip_transactions`. Left alone.

## 3. Club Create Certification: a stop we scheduled is not a broken door

Run **37064989099** failed with `Atomic Create Failed: 55006 PLATFORM_FROZEN:
the platform is on a scheduled maintenance break.`

**Verdict: the check was wrong, and it is fixed without weakening an
assertion.** `fn_create_club_atomic` inserts into `chip_transactions`, so
`zz_freeze_guard` is correct to refuse it for the five-plus minutes of every
hourly break (CLAUDE.md section 13). `public.engine_maintenance_break_log` shows
the break that caught this run: started 21:05:05Z, ended 21:12:54Z, 469 seconds,
`thaw_ok`, 409 tables resumed. It was the extra certified recovery window the
September 17 owner update allows, and the create was attempted at 21:08.

So the only thing wrong was the clock, and the check reported it in the words
"authenticated club creation failed". That is CLAUDE.md 10.86 rule 1: a stop we
scheduled is a third outcome and it has to have its own name.

`scripts/ci/certify-club-create.mjs` now routes both fixture creates through one
helper that, on a freeze refusal, waits on the freeze's own end condition
(`fn_platform_frozen`) with the budget read from `engine_maintenance_break` by
the existing `scripts/ci/platform-freeze-window.mjs`, and keeps three endings
apart:

- thawed, then created: the run continues and says how long it waited;
- thawed, then refused again: a real defect, named as one;
- never thawed, or unreadable: UNKNOWN, named as UNKNOWN, never a pass.

Bounded at two complete freezes, which is every freeze one run can legitimately
meet (the hourly break plus one certified recovery window) and the same bound and
reason as `PLATFORM_FREEZE_MAX_WAITS` in `production-e2e-account.mjs`. This is
not a retry hiding a path that should have worked (10.12): the live path is right
to refuse, and what was corrected is this check's reading of it.

Pinned by `tests/unit/clubCreateCertificationWaitsOutTheFreeze.test.ts`.

## Correction, 23:30Z: two of the three fixes were already landed by other agents

Three pull requests merged inside the same half hour, each from a different
agent, and two of them cover sections 1 and 2 above:

- **#5875** `fix(certification): order reset UUIDs without min`, migration
  `20261002223819_post_reset_cleanup_orders_uuid_values`, applied. It takes the
  same single operation id as `(array_agg(reset_operation_id ORDER BY
reset_operation_id))[1]`, which is equivalent to the cast here and already
  live: `fn_ca_prepare_post_reset_welcome_certification_fixture` no longer
  contains `min(reset_operation_id)`.
- **#5876** `fix(security): a counter is not a public write`, migrations
  `20261002231610` and `20261002232315`, applied. It is a stronger fix than
  section 1's: a browser calling `increment_reel_count` is now routed into
  `fn_count_content_engagement(uuid,text,text)`, which records one view or one
  share for `auth.uid()` at most once a day per piece of content, and any other
  field raises 42501. `fn_ca_browser_reachable_telemetry()` returns zero rows.

`20261002225231` and `20261002225448` were therefore merged in #5878 as duplicate
work and were **never applied**. They are deleted, with their two
migration-text tests, in the follow-up to #5878.

They were not merely redundant, they were a hazard. Both carry a _later_ version
than the migrations that are live, and both are `CREATE OR REPLACE FUNCTION` over
the whole body. Applying `20261002225448` would have replaced #5876's
engagement-receipt routing with this file's field check, silently dropping the
daily cap and the `content_engagement_receipts` writer, and applying
`20261002225231` would have made #5875's `@live-proof` false. Preserving another
agent's work means deleting mine, not shipping the later SHA over it.

What survives from this task is the one thing nobody else had: section 3, the
freeze-aware fixture create in `scripts/ci/certify-club-create.mjs`, with
`tests/unit/clubCreateCertificationWaitsOutTheFreeze.test.ts`.

The lesson for the next agent is narrow and worth the sentence: on this repo a
red workflow is a shared symptom, and between rebasing and merging, three other
agents merged. **Re-read `origin/main` for the defect you are fixing immediately
before you merge, not only before you branch.**

## Second correction, 23:55Z: the reel-counter migration was applied, reconciled

The deletion above was right about `20261002225231` and wrong about
`20261002225448`. While #5885 was in review the install had already applied the
reel-counter migration, as `schema_migrations` version **20261002232859** at
23:28:59Z, and it did not take either fix whole: it **reconciled** them. A
browser caller is admitted the way this file admits it (a signed-in viewer,
share or view only) and is then routed through #5876's
`fn_count_content_engagement` receipt instead of writing the column itself, and
a browser decrement is refused outright. Both protections are live; neither was
lost.

So the file comes back, at its own version, holding the text that actually ran:
4546 bytes, `md5(array_to_string(statements, E';\n')) =
bffd1d417d4472e9bccebd84ebab8e7f`, byte-identical below the header, with the
reconciliation explained in it. That is the same convention #5881 used for
#5876's own file an hour earlier. Deleting it would have left an applied
migration with no file in the repository, which
`scripts/ci/check-applied-migrations-are-recorded.mjs` exists to catch and a
Midway Union rebuild would have silently missed.
`tests/unit/aBrowserMovesOnlyTheReelCountersItIsTheEvidenceFor.test.ts` now pins
the bytes and both halves of the reconciliation.

`20261002225231` stays deleted: it was never applied, and #5875's
`20261002223819` already took the same operation id as
`(array_agg(reset_operation_id ORDER BY reset_operation_id))[1]`.

## 00:10Z: the fourth cause, and the one the aggregate was hiding

With `min(uuid)` fixed (#5875) and the hard twelve-game board relaxed (#5884,
applied from `main` at 00:03Z through `Apply Merged Migration` run 37080417296),
the certification reached the next predicate and refused with
`POST_RESET_CERTIFICATION_SEED_RETURN_LINEAGE_REFUSED` (run 37080553539).

Eight predicates stand in that block. Read from rows rather than guessed, for
both stranded clubs, exactly one fails:

| predicate                                | wanted | got   |
| ---------------------------------------- | ------ | ----- |
| `spin_bonus_pools` row, exact zero state | 1      | 1     |
| `spin_reserve_ledger` rows               | 4      | 4     |
| `seed` / `activation` legs               | 1 / 1  | 1 / 1 |
| `seed_return` / `deactivation` legs      | 1 / 1  | 1 / 1 |
| `bbj_promo_sweep` receipt                | 1      | 1     |
| **`chip_ledger` reversal leg**           | **1**  | **0** |

The reversal leg exists and is right. What does not match is the key it is looked
up by. The live row is

```
from_type spin_reserve  from_entity_id <the club's spin_bonus_pools row>
to_type   club_treasury to_entity_id   <the club>
amount    200.00        category       reversal
idempotency_key  spin-deactivation-seed-return:<club>:200.00
```

and `20261002210559` asks for
`'spin-deactivation-seed-return:'||p_club_id::text||':200'`. The writer builds
that key from a numeric, and numeric 200 renders `200.00`, so the two strings
have never been equal and this predicate has never once passed. It is the same
class of defect as the `min(uuid)` in the same routine: a type's text form assumed
instead of read, and the aggregate was aborting before anything could reach it.

`20261003001046_the_seed_return_lineage_matches_the_key_the_reversal_actuall.sql`
does not swap one literal for another, because hard-coding `:200.00` breaks again
the next time the writer's scale or type moves. The predicate now says what it
means:

```sql
AND l.idempotency_key LIKE 'spin-deactivation-seed-return:'||p_club_id::text||':%'
AND split_part(l.idempotency_key,':',3)::numeric=200
```

The key has three colon-separated parts and a uuid contains no colon, so part 3
is the amount. `from_type`, `from_entity_id`, `to_type`, `to_entity_id`, `amount`,
`category` and the required count of one are untouched: the admission is exactly
as strict as it was meant to be, and no weaker.

It is a guarded rewrite in the idiom `20261002223819` and `20261002231724`
established on this same routine: assert the preimage digest, substitute once,
assert the postimage and the routine's own catalog contract and grants, and abort
if the source moved. An already-rewritten source is a no-op rather than a
failure. Three agents edited this function on 2026-10-02; a blind
`CREATE OR REPLACE` would have discarded whichever of their changes landed last,
which is the mistake the first correction above is about.
