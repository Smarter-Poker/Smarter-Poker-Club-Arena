# The guard needed a guard

**2026-08-31** — verification pass over the previous three PRs (#2031, #2048,
#2070), after Dan asked whether everything was finished, pushed and published.

Two of the three answers were yes. The third found two defects in the tool I had
just shipped to catch defects, and one honest correction to what "published"
meant.

## 1. The reporter could have failed CI on a correct test

`scripts/ci/report-source-grep-tests.mjs` decides whether a test EXERCISES its
unit or only reads it as text. It recognised `from '../../src/x'` and did not
recognise `from '@/utils/x'` — and this repo aliases `@/` to `src/` in
`vitest.config.ts`, with tests already using it (`from '@/utils/mapEngineSnapshot'`
appears three times today).

So a test that imported its unit PROPERLY through the alias, and also happened to
read a file as text, would have been filed as text-only. If the file it read was
a `src/utils/*` path, that would have counted as a sixth violation, tripped the
ratchet, and failed CI on a test doing exactly the right thing — a false
accusation from the tool whose entire job is telling real coverage from fake.

Nothing was miscounted in practice: none of the five current violations uses the
alias, checked file by file before anything changed. The arm is added so the
first one that does is not punished for it.

## 2. The reporter could not be imported at all

Guarding the CLI so an import would not scan the suite and `process.exit(1)` in
the middle of someone's test run, I used `fileURLToPath(import.meta.url)` at
module scope. Under Vitest that is not a `file:` URL — the transform rewrites it
— so it throws `ERR_INVALID_URL_SCHEME` on load. The spec written to prove the
tool works could not import the tool.

Resolved defensively: the path is computed in a `try`, and a null result simply
means "not a CLI run". The CLI is a real node entry point where the URL is a
genuine `file:`, so it is unaffected — verified by running it both ways.

## 3. It has a behavioural test now, which is the point

`tests/unit/sourceGrepReporter.test.ts` imports `classify` and feeds it real file
bodies: a text-only pin, a relative import, an alias import, a rendering test
that also reads CSS, and a file that reads nothing. A tool that enforces "assert
what it DOES" while being pinned by a regex over its own source would be a joke
told with a straight face.

The alias case is the regression pin. It fails against the version shipped this
morning and passes now.

## 4. "Merged" is not "published", and I had said merged

`main` is not production here. A push to `club-arena` main triggers
`build-for-world-hub.yml`, which builds the bundle into the World Hub repo, and
Vercel deploys that. Checking the chain properly:

- **#2031 and #2048: published.** Both are ancestors of the club-arena commit the
  live bundle was built from, and `/api/health` confirms production is serving
  that World Hub SHA.
- **#2070: merged, and still queued at the time of writing.** The sync is healthy
  — it published at 08:17, 08:27, 08:36, 08:45, 08:55, 09:20 and 09:29 UTC,
  roughly every ten minutes — and simply had not reached my commit yet. Seven
  commits from five different agents sat behind the same point.

That is a lag, not a break, and it resolves itself. But "merged" was the honest
word for it and "published" would not have been, which is exactly the
distinction CLAUDE.md section 1.4 exists to enforce.

## Verification

- `npx tsc --noEmit` clean.
- CLI exercised both directions after the guard: `--ratchet` passes at 5/5, and
  still exits 1 with a planted sixth violation.
- The reporter spec passes (7 tests) — and its existence proves the import path
  works, since the file could not have run at all this morning.
- Full client suite on top of `origin/main`.
- The 119 server-suite "failures" seen while checking main were traced to a
  symlinked `server/node_modules` in my scratch worktree (`Cannot find package
'@sentry/node'`, which is installed and declared in the real clone), not to any
  code change. Server code was untouched by all four PRs.
