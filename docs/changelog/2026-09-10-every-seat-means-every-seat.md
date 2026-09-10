# Every seat means every seat

2026-09-10

The last player-facing use of the uuid-VERSION regex is out of production, and
the law that keeps it out is written down.

## What was there

`ca_index_every_seat` fills `ca_hand_player_idx`, the index every stats read
goes through. Its seat filter had two clauses:

```sql
WHERE pl->>'userId' ~ '^[0-9a-fA-F]{8}-...-[0-9a-fA-F]{12}$'      -- shape
  AND NOT pl->>'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]...'    -- version
```

The second one indexes ONLY the ids that FAIL a uuid-version check: the 62
horses whose ids are `00000000-0000-0000-0000-0000000000NN`, and the 33 human
accounts that predate the v4 generator. It reads as a horse filter and it is
the opposite of one - it is the catch-up half of a pass whose FIRST half had
the same check the right way round and therefore skipped exactly those 95
people. Two halves of one filter that should never have existed, and the
plainest evidence that this defect had already been band-aided once rather
than fixed.

It is the same defect that this morning froze seven tournaments: the bounty
doors refused those 95 accounts as `invalid_claimants`, the bust pass aborted
on the refusal, and the escrow could not be paid.
`20260910124023_a_player_id_is_a_uuid_not_a_uuid_version` took it out of both
doors. This takes it out of the indexer.

## What was measured before touching it

Over the 35,132 seats dealt between 30 and 10 minutes before the change, ZERO
were missing from the index - horse or human. The live projector
(`trg_ca_stats_live_from_hand`, `fn_project_hand_side_effects_after_post_commit_20260908`)
indexes everyone; `ca_index_every_seat` only ever backfilled history. Nobody's
stats were short. **Doing no damage is not the same as being correct**: the
next person who needs "a uuid regex for a player" copies the nearest one, and
the nearest one was this.

## The change

`20260910134429_every_seat_means_every_seat` - an asserted text substitution on
the live definition:

- the anchor must appear exactly ONCE, or the migration aborts;
- afterwards the version pattern must be gone;
- the uuid SHAPE check must survive (an id that is not a uuid is still refused);
- the insert must still be `ON CONFLICT DO NOTHING`, so indexing the seats the
  other half already covered is idempotent;
- and no production function outside a named nine-function allowlist may carry
  a uuid-version check at all.

Those nine all validate an id the PLATFORM generates - a transcode job, a
bounty obligation read from the caller's own GUC, a solver run, a dataset, a
purchase. Not one of them validates a person.

## What stops it coming back

`tests/a-player-id-is-a-uuid-not-a-uuid-version.law.test.ts`: no NEW migration
may carry `[1-5][0-9a-f]{3}-[89ab]`. The fourteen files that already do are
frozen in a `HISTORICAL` list, and a second test fails if a name in that list
stops carrying the pattern - so the list is an inventory that can only shrink,
never a pile of exemptions that quietly grows.

Use the shape, never the version:

```
'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
```
