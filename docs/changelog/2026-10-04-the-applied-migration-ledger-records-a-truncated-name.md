# The applied-migration ledger records a truncated name (2026-10-04)

`Installed and merged migrations agree` reported two migrations applied against
production since `20260927000000` with no file in this repo, both inside the
24 h grace that `check-applied-migrations-are-recorded.mjs` gives work in
flight:

```
20261004002905  a_certification_fixture_never_queues_in_front_of_the_platform
20261004124500  video_reel_candidate_highlight_engine
```

The grace expires 2026-10-05, after which each becomes `overdue` and fails the
check on every branch. The script offers two repairs, an alias row or a
backfilled export, and says to pick per case from evidence. The evidence here
picks a different answer for each, and for the second it picks neither.

## 20261004002905: an alias, because the filename is one character short

`supabase/migrations/20261004002615_a_certification_fixture_never_queues_in_front_of_the_platfor.sql`
is already on `main`. It is the same change, and the applied SQL is
byte-identical to the part of it that runs:

|                                                | bytes | md5                                |
| ---------------------------------------------- | ----- | ---------------------------------- |
| the file, whole                                | 9503  | `495aff410b59ed9f7d2a403c3f7f4624` |
| the file from `BEGIN;` to `COMMIT;`            | 7213  | `0fd3c7f9e195a0964aaad2bef916d0d8` |
| production's `statements` for `20261004002905` | 7213  | `0fd3c7f9e195a0964aaad2bef916d0d8` |

The 2290-byte difference is the comment header the Supabase MCP strips before it
applies. Both sides declare the one `DO $subs$` block that rewrites the
advisory-gate wait in `fn_ca_prepare_post_reset_welcome_certification_fixture`
and the three `fn_ca_prepare_unused_welcome_certification_board_{leases,games,origins}`
preparers, under the same pre-image and post-image md5 pins and the same
privilege assertions. It was applied at 00:29:05 UTC from that file's own
session, which had reserved `20261004002615` through `new-migration.mjs`.

So nothing was unrecorded. What diverged is the NAME. The filename stem is
truncated at 60 characters and ends `platfor`; the recorded name is 61
characters and ends `platform`. `check-applied-migrations-are-recorded` keys on
the name with no prefix tolerance, so it missed by one character.
`check-migrations-are-live` already matched the pair on its 55-character prefix
(`NAME_PREFIX`), which is why only one of the two gates complained.

Backfilling the applied SQL as a second file would put the same change into a
Midway Union rebuild twice, which is what the alias table exists to prevent, so
this is one row in `scripts/ci/applied-migration-aliases.json`. `sameBytes` is
`false` because of the stripped header, and `appliedMd5` is the hash above, so
`check-recorded-migrations-evidence.mjs` can keep asking production whether the
claim still holds.

## 20261004124500: neither repair. It is not this repo's migration, and its SQL was never recorded

Two things are true about this row and both of them rule out an export.

**Its `statements` are not SQL.** The payload is 100 bytes of prose:

```
installed from exact Phase 5 migration source during qualified preflight; protected delivery pending
```

There is nothing to reconstruct byte-exactly, because the text that ran was
never written to the row. Committing that sentence as a `.sql` file would put a
file into `supabase/migrations/` that cannot run, which is precisely the
hardening-missing-from-a-rebuild failure this check was built to catch, and it
would assert a provenance that no hash can check. It is not the only row of its
shape: `20261003134500 video_enrichment_claim_fairness` carries
`installed by protected Phase 4 delivery 74b2c0ad8ce1bf6d20fefd7cb907ccfd96c89553`,
and that SHA is not an object in this repository.

**It belongs to Smarter-Poker-World-Hub, and it is already authored there.**
The Phase 4 row above is not reported as a gap because
`supabase/migrations/20261003134500_video_enrichment_claim_fairness.sql` is on
World Hub's `main` under its exact applied version, and this check merges the
sibling repo's listing into its index. Phase 5 is the same programme. Its file
exists, under its exact applied version, on World Hub branch
`agent/reels-phase5-candidate-highlights`, in open and mergeable PR
Smarter-Poker/Smarter-Poker-World-Hub#2103, "feat(reels): add Phase 5 candidate
highlight engine":

```
supabase/migrations/20261004124500_video_reel_candidate_highlight_engine.sql   11233 bytes, md5 40e909d515057abf53e6d5743292a914
supabase/migrations/20261004130000_video_reel_candidate_duration_guard.sql
```

It declares exactly the seven objects production holds, with nothing left over
and nothing missing:

| declared by the World Hub file          | present in production |
| --------------------------------------- | --------------------- |
| `public.video_reel_candidates`          | yes                   |
| `video_reel_candidates_review_idx`      | yes                   |
| `video_reel_candidates_diversity_idx`   | yes                   |
| `public.video_reel_candidate_limits`    | yes                   |
| `fn_claim_video_reel_candidate_sources` | yes                   |
| `fn_finish_video_reel_candidate`        | yes                   |
| `fn_review_video_reel_candidate`        | yes                   |

So the DDL really ran, the row's prose note was accurate about its own state
("protected delivery pending"), and the repair is owned by that PR in that
repo. Exporting it here would duplicate a World Hub migration into Club Arena,
collide on version `20261004124500` with the authored file, and record an
`appliedMd5` that production's prose payload can never match. An alias is not
available either: `migration-aliases.mjs` honours a row only when `file` exists
in THIS tree, and no Club Arena file is this change.

Nothing was committed for it here. When #2103 merges, Club Arena's sibling index
picks the file up and the gap closes with no Club Arena change at all.

## What is still open after this

- **World Hub PR #2103 must merge before 2026-10-05**, or `20261004124500`
  ages out of grace and fails this check on every Club Arena branch. That is
  the owning agent's delivery and is not repaired from here.
- **Both `...4500` rows record prose where the estate expects SQL.** A
  `schema_migrations` row whose `statements` cannot be hashed against a file is
  outside what `check-recorded-migrations-evidence.mjs` can verify, so the
  version match is load-bearing on its own for that programme. Raised for the
  owner; a history row is never edited to tidy this up.

## Checked, not changed

Production was read only, inside
`BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`, through
`execute_sql` on `supabase_migrations.schema_migrations` and the catalogs. No
migration was applied or replayed, no history row was touched, and no version
was reserved: an alias exists so that the version a migration actually ran under
stays the version of record.
