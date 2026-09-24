# The publisher says what it refused

2026-09-22

## What it looked like

`publish-club-arena.yml` failed twice on
`91bd8161a1f8d084de8ca2d7dd97020d0c24a3d8`, both inside the step **Publish
through the host-owned immutable transaction**.

Run [35763554815](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/35763554815),
the whole of the step's output:

```
2026-09-22T18:00:52.2858049Z ##[endgroup]
2026-09-22T18:00:55.3312731Z ##[error]Process completed with exit code 1.
```

Three seconds, zero characters. Run
[35764705782](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/actions/runs/35764705782),
the retry, managed one line and then died 59 milliseconds later:

```
2026-09-22T18:08:32.6662765Z reusing the already sealed immutable release for 91bd816
2026-09-22T18:08:32.7255942Z ##[error]Process completed with exit code 1.
```

Fifty-eight guards in that file could produce that log. A bare `test -d X` or
`[ ... ]` used as a statement under `set -e` exits 1 and prints nothing at
all: CLAUDE.md 10.86 rule 1, in its purest form.

## What actually refused, and why it was right

The line was

```bash
test -d "$FINAL/assets" && test -d "$FINAL/fonts"
```

and the half that failed was `test -d "$FINAL/fonts"`. The release really had
no `fonts/` directory. Downloading the run's own artifact confirms it: 1,883
files, 680 under `assets/`, and not one path containing `fonts` - including in
`.release-manifest.sha256`, which is why every integrity check upstream passed.

The refusal was correct and stays. `infra/ca-origin/Caddyfile` serves
`/assets/*` and `/fonts/*` from the append-only pool, and the pool's
`fonts.css` is a symlink into `current/fonts/fonts.css`. Activating a release
with no `fonts/` would have dangled that symlink and 404'd the fonts of every
shell already cached on a player's device.

## The cause, named from the build log

```
2026-09-22T17:58:29.6467263Z [self-host-fonts] Failed (non-fatal, Google Fonts links remain): fetch failed
```

`scripts/self-host-fonts.mjs` downloads the Google Fonts stylesheet and its
woff2 files into `dist/fonts/` after `vite build`. Its own header declared it
best effort: _"ANY failure leaves dist/index.html untouched ... Exit code is
always 0."_ That was a reasonable contract in 2026-08 and stopped being true
when the origin moved to the append-only pool, because the publisher now
requires `dist/fonts/fonts.css` in every release. So a transient
`fetch failed` against `fonts.googleapis.com` produced a bundle that was
_guaranteed_ to be refused, and reported success for it. The build job went
green, uploaded 165 MB, and the refusal arrived four minutes later with an
empty log.

## Measured

60 publisher runs over the 33 hours to 2026-09-22 18:12 UTC: 53 success, 3
cancelled (a newer merge superseding an older run, which is normal), 4 failure.
Two of the four are the silent refusal, and both are this cause, on the same
SHA (the push and its `repository_dispatch` retry). The other two failed in
`build-and-store :: Build Club Arena`, loudly, and their `self-host-fonts`
step had succeeded - as it did on the next publish, 35765700654, which shipped
`e76fa8c6` normally at 18:16:35. So: 2 of 60 runs (3.3%), 2 of 2 silent
failures, one cause.

## The fix

**Root cause.** `scripts/self-host-fonts.mjs` no longer reports success when it
produced nothing. Each of its three outcomes that cannot write
`<dist>/fonts/fonts.css` now names itself and exits 1, and the script verifies
the file exists before it returns. The build fails where the cause is on
screen, in the job that caused it, instead of handing the origin a bundle it
must refuse. This is the line that produced the wrong outcome and it is
changed (CLAUDE.md 10.11); no retry, sweep or repair job was added.

**Legibility.** Every one of the 58 bare guards in `publish-club-arena.yml`
now names the path it checked, what it required and what it found. None of
them was widened: each refuses on exactly the condition it refused on before.
Twenty-one of the 58 were written `A && B`, and under `set -e` only `B` was
ever enforced - `set -e; false && true; echo hi` prints `hi`, so
`test -d "$FINAL/assets"` failing had no effect at all. Those first halves now
refuse for real, which is a strengthening, never a relaxation. The three at
the heart of this incident read:

```
release 91bd8161... has no fonts directory at /srv/club-arena/releases/91bd8161.../fonts;
the pool's fonts.css points into current/fonts/fonts.css, so activating this release
would 404 the fonts of every already-cached shell. A build whose self-host-fonts step
could not reach Google Fonts produces exactly this bundle. The release holds: assets
build-info.json ca-provenance.json cards ... videos
```

**Earlier.** `Verify dist is complete` in the build job only ever looked at
`dist/index.html`. It now requires everything the host transaction requires -
`index.html`, `build-info.json`, `ca-provenance.json`, `assets/`, `fonts/`,
`fonts/fonts.css` - reports all of them in one pass, and prints what `dist`
actually holds. Same refusal, four minutes sooner, in the job that built it.

**Pinned.** `tests/the-publisher-says-what-it-refused.law.test.ts` scans every
`run:` block in the publisher and fails on any logical line whose last command
is a bare `test`/`[`/`[[`, which is the shape that exits without speaking. It
checks the LAST command deliberately: `[ "$A" = "$B" ] || [ "$A" = "$C" ]` has
an `||` and is still silent. Mutation-tested by putting the 2026-09-22 line
back, which reports
`.github/workflows/publish-club-arena.yml:1176  test -d "$FINAL/assets" && test -d "$FINAL/fonts"`.
Its reader is `Client Unit Tests (vitest)`, one of the six required contexts in
the `main protection` ruleset, and the publisher's own `client-tests` job runs
the same suite before the bundle ships (CLAUDE.md 10.86 rule 3).

## And then the fix hit the ceiling above it

Giving 58 guards a voice grew the origin transaction step from 17,304 to
24,626 characters. That is more than GitHub Actions accepts for a single
`run`, and it does not refuse the step: **it refuses the whole workflow**.
Runs 35773582571 (the squash) and 35773709689 created zero jobs, carried
`.github/workflows/publish-club-arena.yml` as their name instead of
`Publish Club Arena`, produced no annotation and no log, and
`GET /actions/workflows` started listing the file path where the workflow's
name had been. A push to a feature branch produced a run for a workflow whose
only trigger is `push: branches: [main]`, which is what GitHub does when it
cannot read the file at all. Nothing published between 19:24 and the repair.

The cause was measured, not guessed. A diagnostic branch carried the
**known-good** workflow with nothing added but 70 padding comment lines inside
that one step, taking it to 24,094 characters: run 35774904430, same empty
failure. So 17,304 characters is accepted and 24,094 is refused, on otherwise
identical bytes.

The transaction is now `.github/scripts/publish-origin-activate.sh`, piped to
`bash -s` on the origin from the same protected-main checkout the step already
makes. Same bytes, same review, same single publisher - the heredoc was never
the security boundary, the checkout is. The largest `run:` step in the
publisher is 7,431 characters again, and
`tests/the-publisher-says-what-it-refused.law.test.ts` refuses any step over
12,000 with both measurements written beside the number, so the next person to
add a diagnostic is told to move the script rather than discovering this the
way I did (10.86 rule 4: a fix that leaves the same trap one level up has not
landed).

## What is fixed and what is not

Fixed at the root: a build step reporting success for work it did not do, and
a publisher refusing without a word. Both were causes; both are gone.

Not fixed: `fonts.googleapis.com` can still be unreachable from a GitHub
runner. That outcome is now a named build failure in about four minutes
instead of an unpublishable artifact plus a silent refusal, but the publish
still does not happen. Removing the dependency entirely means vendoring the
39 woff2 files and the stylesheet into the repository so the build needs no
network. That is a real change with its own review (licence, size, refresh
policy) and it is deliberately not made here.

Left alone on purpose: the append-only asset pool, the atomic `current` swap,
the publisher's concurrency controls, `KEEP_RELEASES` pruning and the rollback
step's behaviour. There is still exactly one publisher.

## Honest accounting of the delivery

The first PR (#5090) merged green and broke the publisher, because nothing in
this repo could see that limit and no local check models GitHub's own parser.
That is the same failure this changelog is about, one level up, and it is
recorded here rather than tidied away. The follow-up carries the script move
and the step budget.
