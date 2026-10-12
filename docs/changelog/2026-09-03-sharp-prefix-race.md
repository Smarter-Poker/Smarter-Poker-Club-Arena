# One /tmp, eight runners: the sharp prefix could be raced

**2026-09-03.** `CSS Beat E2E` - a REQUIRED check - failed on PR #2779 with

    npm error ENOTEMPTY: directory not empty, rename
      '/tmp/ca-webp-sharp/node_modules/sharp' -> '.../.sharp-Xz06ay6F'
    [sharp-loader] Could not install sharp

and blocked the pull request for a reason that had nothing to do with its
diff. The pull request was mine and its content was fine.

## What was actually wrong

`scripts/lib/sharp-loader.mjs` installed sharp into ONE fixed path,
`os.tmpdir()/ca-webp-sharp`. That was safe for as long as every CI job had a
machine to itself - a GitHub-hosted runner gets its own /tmp, so "the" prefix
was per-job by accident.

Moving CI onto self-hosted boxes removed that accident. Eight runners now
share one box and therefore one `/tmp`, so two jobs reaching this line in the
same second are two `npm install` processes writing one `node_modules`. npm
installs by renaming into place; the loser's rename finds a directory that is
no longer what it expected and dies with `ENOTEMPTY`.

Nothing about it was flaky-looking in a useful way. The error names npm and a
temp path, so it reads as an npm bug or a disk problem, and it only appears
when two particular jobs overlap.

## Reproduced before it was fixed

Four cold loads started at once, on the code as it stood:

    job1 -> NULL   (ENOTEMPTY)
    job2 -> NULL   (Cannot find module 'sharp')
    job3 -> NULL
    job4 -> NULL

Four out of four, not one out of four: the loser corrupts the shared directory
badly enough that the others cannot require out of it either. The same test on
the fixed code passes 4 of 4 and leaves no debris.

## The fix

The standard atomic-cache shape:

1. **Stage privately.** `${CACHE}.staging.${pid}.${random}` - pid alone is not
   enough, because pids are reused and two runners on one box can hold the
   same one.
2. **Publish with a single `rename`,** which is atomic.
3. **A lost race is the normal case, not an error.** If the rename fails
   because someone published first, discard our copy and use theirs.

Plus a **warm path**: if the cache is already populated, return it and run no
npm at all. After the first job on a box, there is nothing left to race over
and nothing to install - which also takes an npm install out of most CI runs.

Giving each runner its own directory name would have hidden this rather than
fixed it: two jobs on the same runner, or two agents on a workstation, still
collide. Correctness under concurrency has to come from the atomic operation,
not from hoping the names differ.

`tests/sharp-loader-cannot-race.test.ts` pins all four parts, each
mutation-verified: installing straight into the cache, dropping the
randomness, and removing the warm path each turn exactly one test red.

## The wider lesson

This is the second failure this week caused by self-hosted runners sharing a
`/tmp` that hosted runners never shared - the first was the nightly GC running
`rm -rf /tmp/*` and deleting the systemd PrivateTmp of running services, and
of any CI job in flight. **Anything that assumed a private /tmp is now wrong,
and fails in a way that reads like something else.** Fixed-path temp
directories are the shape to look for.
