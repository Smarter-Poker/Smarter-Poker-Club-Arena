# Declare YOUR entry-chunk additions HERE, not in the big baseline

`entry-chunk-baseline.json` is the machine-generated snapshot of what the
entry chunk contained at the last base refresh. It is **one sorted array**, so
two branches that each legitimately add a module to first paint collide on it
by construction - on a file that has nothing to do with either change.

That is CLAUDE.md 10.9's `MIGRATION-CHANGELOG.md` lesson wearing different
clothes, and it is not theoretical. On 2026-09-08 two branches hit it within
an hour, and resolving one by taking `main`'s copy of the file **silently
dropped the module that branch had recorded** - so CI went red on work that
was correct, naming a module its author had already reviewed and approved.

So write your own file instead. Name it after your branch:

```jsonc
// scripts/ci/entry-chunk.d/fix-club-context.json
{
  "_owner": "fix/club-context - GlobalHeader renders on every page and stamps the club onto Wallet and Messages, so clubScopedPath is first-paint by design",
  "modules": ["src/utils/clubScopedPath.ts"],
}
```

`node scripts/ci/entry-chunk-delta.mjs dist --update` writes exactly that file
for you, named after the branch you are on, containing only what your branch
adds. Then replace the placeholder `_owner` with the real reason - that
sentence is the whole point of the gate. A module in the entry chunk is a cost
every player pays before first paint, and the gate exists to make somebody say
out loud why it is worth paying.

The gate reads the base snapshot UNION every fragment here, so your module is
known immediately and you never touch a file another agent is touching.

**Cleaning up.** `--update-base` rewrites the base snapshot from the current
build; that is the periodic refresh, not something a feature branch runs. Once
a module is in the base, the fragment naming it can be deleted. A fragment
that names a module which has since left the entry chunk is harmless - the
gate only ever uses it to answer "was this reviewed" - and can be deleted too.
