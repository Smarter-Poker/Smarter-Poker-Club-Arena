# 2026-08-26 — why the Supabase manifests conflict, and why "just generate them in CI" is wrong

## The correction

An earlier note in this repo (mine, `2026-08-26-arena-audit-and-queue-anatomy.md`)
said this about the two committed manifests:

> They are generated artifacts that are committed, so every schema change
> regenerates them and every concurrent schema change collides. Generating them
> in CI rather than committing them removes another ~14 conflicts.

**That advice was wrong, and acting on it would have broken three CI gates.**
Recording the correction here so nobody spends a session discovering it again.

## What the manifests actually are

| file                                        | size                  | role                                       |
| ------------------------------------------- | --------------------- | ------------------------------------------ |
| `scripts/ci/supabase-schema-manifest.json`  | 88 KB / 3,034 lines   | every live public table, view and function |
| `scripts/ci/supabase-columns-manifest.json` | 229 KB / 11,671 lines | every live column, per table               |

They are a **snapshot of the live production schema**, and they are committed on
purpose. `supabase/migrations/` is intentionally stale — schema is applied
straight to production through the Supabase MCP — so migrations cannot answer
"does this table exist". The snapshot can, and it can do so **without handing
live database credentials to every CI check**.

Three gates read them:

- `check-phantom-tables.mjs` — every `.from()` / `.rpc()` resolves to something real
- `check-phantom-columns.mjs` — every column referenced exists
- `check-migrations-applied.mjs` — a migration this branch ADDS is already applied

"Generate them in CI instead" means giving every one of those jobs a
service-role key on every run, and losing the ability to diff what changed.
That is a downgrade, not a cleanup.

## So why do they conflict?

Not because they are committed. Because they have **many concurrent writers**.

Measured on 2026-08-26: 9 commits to the schema manifest and 10 to the columns
manifest **in 24 hours**, and 8 + 6 appearances in the conflict ranking across
the 108 conflicting pull requests.

The cause is in the CI failure text itself. Three separate messages tell the
author to fix it in their own PR:

- `ci.yml:385` — "add the migration (+ regenerate the manifest)"
- `ci.yml:537` — "or regenerate the manifest in this PR"
- `ci.yml:563` — "add the migration + regenerate the manifest, or allowlist it"

So every agent that trips a gate rewrites a 229 KB JSON file, concurrently with
every other agent doing the same. Meanwhile `schema-manifest-refresh.yml`
already regenerates both on a schedule and opens its own PR. The file has one
scheduled owner and N ad-hoc ones.

## The actual fix, and why it is not in this commit

`check-phantom-tables` **already** solved this for itself. From `ci.yml:370-373`:

> Credentials let the check ask the LIVE schema before failing, so a manifest
> that has simply gone stale no longer reds somebody else's unrelated commit.

`check-migrations-applied.mjs` has no such fallback. That is precisely the gate
that forces an author to regenerate: add a migration for a new object, the
manifest has not caught up, the gate fails, and the only offered remedy is to
rewrite the file. Give that gate the same live-schema fallback its sibling
already has, and the scheduled refresh becomes the sole writer. The conflicts go
away without changing what any gate actually enforces.

**Not done here on purpose.** That gate's failure mode is fail-open: it exists
because `20260821_club_tournament_stats.sql` was committed and never applied,
the leaderboard quietly served numbers from half of each club's history, and
nothing went red for a day. A fallback implemented without being able to
exercise the gate could silently permit exactly that. It needs someone who can
run it against a real branch and a real stale manifest.

Whoever picks it up: mirror the pattern in `check-phantom-tables.mjs`, keep it
**fail-closed** when the live schema cannot be reached, and prove it with a
migration that is genuinely unapplied.

## The generalisable point

"This generated file conflicts a lot, stop committing it" is a good instinct and
was wrong here. The question worth asking first is not _should this be
committed_, it is **how many writers does it have**. A generated file with one
writer does not conflict. This one has a scheduled writer plus every agent that
trips a gate, because the gate's own error message tells them to become one.
