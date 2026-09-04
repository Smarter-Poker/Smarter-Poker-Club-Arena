# Twelve agents could not write at once. Two mechanisms, not bad code.

Dan asked why a dozen agents shipping in parallel produce so many rejections
when the code itself is fine. The answer, measured on 2026-09-04: the failures
were not in the product. They were **shared mutable state inside the build
system** - two places where doing correct work forced a collision.

910 of 911 unit tests passed in the runs that failed.

## 1. Migration versions: a shared namespace with no allocator

Migrations are `<14-digit version>_<slug>.sql`, and
`migrationVersionUniqueness.test.ts` requires the version to be unique. Agents
picked it by hand and reached for round numbers, so `20260903020000` was taken
twice.

Neither branch was wrong on its own - each held one file. The collision only
appeared when the second branch took main, and then CI failed for work that was
correct when it was written.

**And the real cost is not the red build.** Supabase keys `schema_migrations`
on the version, so of two files sharing one, **the second is silently never
applied**. A migration that never ran is worse than a failing test.

`scripts/new-migration.mjs` reserves the version instead of guessing it. It
asks what is already taken - this tree, `origin/main`, **and every remote
branch** - and steps forward a second at a time until it finds a free one.
Checking the branches is the whole point: the colliding version usually lives
on work nobody has merged yet, which a timestamp cannot see.

Proved by occupying a 40-second band and running it: `reserved 20260904044702
(stepped past 30 taken version(s))`.

The test's failure message now names the script, so the next agent to hit a
collision is told how to avoid the next one.

## 2. The orphan ratchet: improving the code failed the build

`orphanModuleRatchet.test.ts` held two assertions:

- `orphans.length <= baseline` - the real guard, that dead code must not grow.
- `orphans.length === baseline` - an **exact match**.

The second one meant any commit that DELETED a dead module went red until its
author also edited `BASELINE_ORPHANS`. On 2026-09-04 a branch that removed one
orphan failed with _"down to 63 - lower BASELINE_ORPHANS to match"_ while
everything else passed.

Two costs, and the estate paid both:

1. **Improving the code broke CI.**
2. Worse at this scale: every agent who tidied anything had to edit **one
   shared constant on one line**. With a dozen agents in flight that line is a
   conflict magnet - the same shape as the `MIGRATION-CHANGELOG` collisions
   this repo already had to design away (18 of 108 conflicting PRs, until each
   agent got its own changelog file).

The safety property is that the set must not GROW. That assertion is untouched.
Tightening the number is housekeeping, and housekeeping must not be able to
fail a build or serialise twelve agents behind one integer. The exact match is
now a slack of 10: drift a little and nothing happens, drift a lot and someone
is told to reset it.

## The pattern worth remembering

Both bugs have the same shape: **a guard that requires every agent to write to
the same place.** A version namespace with no allocator; a counter that every
improvement must update. Neither is a code-quality problem, and no amount of
care by the agent writing the feature would have avoided either.

When adding a guard, ask what it forces agents to share. If the answer is "one
line in one file", it will become a conflict, and then it will become noise,
and then somebody will stop reading it.
