# The tool that promised not to destroy work could destroy work

**2026-09-03.** Found on the last pass, by noticing that `refs/archive/` already
held **21 refs** before tonight's retention rule wrote a single one.

There are two archivers on this estate:

|                                             |                                                        |
| ------------------------------------------- | ------------------------------------------------------ |
| `.github/scripts/archive-stale-branches.sh` | automated, in the hourly Publish Watchdog, added today |
| `scripts/archive-dead-branches.sh`          | hand-run, `--yes` to apply, older                      |

The hand-run one wrote `refs/archive/<name>` **with `--force`**.

## Why that is a destroy-path, not a detail

Branch names get reused here. `fix/table-freeze-and-dead-actions` was already
sitting in `refs/archive` from August when this was found. Archive a branch of
that name a second time and the force **silently replaced** the first archive:
the August commits became unreachable, with no message, no trace, and no way for
anyone to know an archive had ever existed there.

That is the exact failure the tool exists to prevent, inside the tool itself.
"Archive before you delete" only means something if the archive cannot be
overwritten by the next archive.

## Fixed, and unified

Both archivers now write the same shape:

    refs/archive/<name>@<YYYY-MM-DD>

so a reused name adds a second entry instead of replacing the first, and
restoring from either is the same single command:

    git push origin refs/archive/<name>@<date>:refs/heads/<name>

The `--force` is gone, and **a failed archive now stops before the delete** -
previously the push and the delete were independent statements, so an archive
that failed for any reason was followed by a delete anyway, which is simply
losing the branch.

One convention matters as much as the fix. Two tools with two naming shapes is
how the next agent looks in the wrong place for work the other one archived, and
concludes it is gone.

`tests/an-archive-ref-is-never-overwritten.law.test.ts` pins all three
properties. Each was mutation-verified: restoring `--force`, undating the ref,
and letting a failed archive fall through to the delete each turn a test red.
