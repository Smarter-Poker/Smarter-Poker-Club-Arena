# A gate that passes by doing nothing

**2026-08-31** — line-by-line audit of everything shipped today, at Dan's
instruction to finish anything still pending and leave nothing unfinished.

The four PRs were correct and are live. Reading the test-quality gate line by
line found three defects in it, two of them the exact failure it was written to
catch: **a required check that reports green while inspecting nothing.**

## 1. An empty scan reported "ratchet OK" — and told you to disable the gate

If `testFiles()` ever returned nothing — a moved directory, a renamed suffix, a
`ROOT` that resolved somewhere unexpected — then `utilViolations` is 0, 0 is
under the baseline of 5, and the gate printed:

```
[source-grep-tests] 0 of 0 test files (NaN%) assert on source TEXT ...
[source-grep-tests] OK - no text-only pin on a src/utils module.
[source-grep-tests] The count fell to 0. Lower BASELINE_UTIL_VIOLATIONS to 0 ...
[source-grep-tests] ratchet OK (0/5).
```

exit 0. Zero findings from zero inputs is the oldest silent pass there is, and
this one went further: it advised the next agent to **lower the baseline to 0**,
which would have locked the gate open permanently while looking like tidy
housekeeping.

A missing `tests/` already threw ENOENT out of `readdirSync`. This is the case
where the directory exists and yields nothing. Scanning zero files is now a hard
failure in `--ratchet` and `--strict`.

## 2. The gate disabled itself when reached through a symlink

`import.meta.url` is always the REAL path. `process.argv[1]` is whatever the
caller typed. Compared as raw strings they diverge the moment a symlink is
involved — and on macOS `/tmp` IS a symlink to `/private/tmp`, which is how
every scratch worktree on this machine reaches the repo.

Reproduced before fixing: `node /tmp/ca-symlink/scripts/ci/...mjs --ratchet`
printed nothing and exited 0. Both sides are `realpathSync`'d now.

**Never inert in practice.** The CI log for #2082 shows the inventory printing
(`204 of 713 test files (29%)`, `ratchet OK (5/5)`) because GitHub runners use
real paths. It was one workflow edit away from being so.

## 3. `NaN%`

`(0 / 0 * 100).toFixed(0)` on the inventory line. Cosmetic, and it only appears
in the state that is now a hard failure, but a report that prints `NaN` teaches
readers to ignore it.

## Pinned, and the pins were checked against the old code

`tests/unit/sourceGrepReporter.test.ts` grew three cases that spawn the CLI
rather than reasoning about it: through a symlinked absolute path, against an
empty `tests/` directory, and end-to-end on this repo. Each was run against the
pre-fix script first and reproduces the old behaviour, so they are regression
pins rather than decoration.

## The rest of the audit, which found nothing

Read line by line, no defects:

- `src/utils/tabSlots.ts` — `pickObserveSlot` handles a negative or
  out-of-range `activeIndex` (undefined tab, falls through), `append` returns
  exactly `tabs.length` so index-writing covers replace and append with one
  path, `pruneStaleSeatedTabs` is kind-independent.
- `MultiTablePage.tsx` — `activeIndexRef` is assigned once, during render, after
  the state it mirrors, with no leftover effect; all seven tab factories set
  `kind`; the rebuild carries `isTournament`; the observe handler routes every
  `pickObserveSlot` action correctly.
- `ci.yml` — `--paginate` in place; the new step sits in the ungated `typecheck`
  job, so it runs on every pull request rather than behind the `changes` filter.

## Publication

#2031, #2048 and #2070 are live: each is an ancestor of the club-arena commit
the production bundle was built from, and `/api/health` serves that World Hub
SHA. #2082 merged at 09:53 and was two commits behind the last sync at the time
of writing; the pipeline published at 09:20, 09:29, 09:39, 09:46 and 09:57 UTC,
so it is a queue, not a break.

## Verification

- `npx tsc --noEmit` clean.
- Reporter spec: 10 tests, all passing; the three new ones fail against the
  pre-fix script.
- CLI exercised on the real path, through a symlinked absolute path, against an
  empty tree, and with a planted sixth violation (exits 1).
- Full client suite on top of `origin/main`.
