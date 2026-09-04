# Push to live, under six minutes - and the source maps go to the right bundle

Date: 2026-09-04
Branch: `perf/under-six-minutes`

## Why

A change to `src/` took about 10.1 minutes to reach a player, best case. Dan
has called that unacceptable more than once and he is right. The work below
was fully diagnosed by the previous agent from per-line timestamps in real CI
logs; this is the implementation, plus one real bug the diagnosis turned up on
the way.

Nothing was given up to get the time down. No test was deleted, no coverage
reduced, no required check weakened or skipped.

## The two DAGs, and where the time actually went

`ci.yml` on a pull request, best case 6.98m wall:

```
[changes] 4s ─┬─> [unit]           1.27m
              ├─> [server]         1.22m
              ├─> [build]          5.03m
              └─> [css-beats-e2e]  6.88m   <- CRITICAL PATH
[typecheck] 2.88m (ungated)   [stub_gate] 0.20m   [source_windows] 0.28m
```

`publish-club-arena.yml` on merge, 3.33m wall:

```
[publish-needed] 5s ─┬─> [client-tests] x4 shards   end at +50s
                     └─> [build-and-store] 2.53m ─> [publish-to-origin] 0.65m
```

The four test shards finish 109 seconds before the build does. They are not on
the critical path and rebalancing them buys nothing. `npm run build` is, and it
runs three times per merge:

| sub-step              | ci build | css-beats | publisher |
| --------------------- | -------- | --------- | --------- |
| `tsc -b`              | 46.7s    | 47.8s     | 10.2s     |
| `sharp` npm install   | 97.2s    | 76.6s     | 0.75s     |
| `vite build`          | 25.8s    | 17.4s     | 17.1s     |
| `optimize-dist-media` | 88.0s    | 85.2s     | 85.7s     |
| everything else       | 7.9s     | 7.6s      | 5.6s      |
| **total**             | **266s** | **235s**  | **120s**  |

## What changed

### 1. sharp is a dependency now, not a mid-build download

`scripts/lib/sharp-loader.mjs` shelled out to `npm install --no-save sharp`
into `os.tmpdir()` on every build that needed it. 97.2s cold, and still 76.6s
warm, because npm re-resolves over the network either way. It was the single
largest item on the critical path and the largest source of its variance.

The reason it was kept out of `package.json` is real and is recorded in the
loader: `npm install` under `NODE_ENV=production` prunes devDependencies. That
is not how this repo installs. Every workflow runs `npm ci` FIRST and sets
`NODE_ENV=production` only on the build step's own `env:`, so the devDependency
is present before anything imports it. `npm ci --ignore-scripts` (typecheck,
CSS Beat E2E) is fine too - sharp 0.34 ships prebuilt `@img/sharp-*` binaries
and runs no install script. Verified locally: `npm ci --ignore-scripts` then
`require('sharp')` gives sharp 0.34.5 / libvips 8.17.3 and encodes.

**The temp-prefix fallback stays.** If the direct import ever fails on a
runner, the loader installs exactly as it does today. Worst case is no
regression, not a broken build. `tests/sharp-is-installed-not-downloaded.law.test.ts`
pins the declaration, the linux-x64/arm64 entries in `package-lock.json`, and
the fallback.

### 2. `build:ci` - the same build without a typecheck it already did

`package.json` now has `"build": "tsc -b && npm run build:ci"`. One definition,
so the two cannot drift. `ci.yml`'s two builds run `build:ci`.

On this repo `tsc -b` emits nothing, and that is structural rather than lucky:
all three tsconfigs set `"noEmit": true`, none declares `composite` or
`references`, and `vite.config.ts` loads no dts or checker plugin. It writes no
file `vite build` reads - two dists built with and without it hash identically.
It is a typecheck wearing a build's clothes, and it was running three times per
merge to answer a question the required `TypeScript Check` job answers on the
same commit, ungated, on every pull request.

**The publisher keeps the full `npm run build`, `tsc -b` included.** The
asymmetry is the point and both halves are pinned by
`tests/the-build-typechecks-where-it-ships.law.test.ts`: the tree that reaches
players is typechecked on the commit that ships it, and the throwaway PR-head
builds are not, because that tree has already been checked. Dropping it from
the publisher too would buy 10.2s of a 600s pipeline in exchange for the only
typecheck that runs on the merge commit. Not worth it.

### 3. optimize-dist-media: a worker pool and a content-addressed cache

Two things were wrong with `scripts/optimize-dist-media.mjs`.

**It was serial.** One `await pipeline.toFile()` at a time, 496 candidates, on
a 16-core box. It now runs a fixed-width pool with `sharp.concurrency(1)` -
one libvips thread per image, N images at once. That combination was measurably
faster than either extreme; a wide pool of wide encoders oversubscribes the box.

**It had no memory, and it was not idempotent.** Every raster in `dist/` is a
byte-for-byte copy of a committed source asset, so the same input was decoded
and re-encoded on every build of every branch forever. And a second pass over
an already-optimized `dist/` "optimized" 90 more files - generational quality
loss, silently, for anyone who restored a warm dist.

Results are now content-addressed: keyed by the sha256 of the INPUT bytes plus
everything else that can change the output (the rule's max dimension, the
extension, `ENCODER_SETTINGS_VERSION`, and sharp's own version). A hit copies
bytes and never decodes. Idempotency falls out of the same index: when a file
IS optimized, the sha256 of the OUTPUT is recorded as a no-win entry, so
re-running over the produced bytes recognises them and leaves them alone.

Entries are published by `rename(2)`, never written in place, because two pool
workers can hold the same key at once (two paths with identical bytes) and a
reader that saw a half-copied entry would put a truncated image into `dist/`.

Measured locally on the real 197MB pre-optimize `dist/` (496 candidates):

| pass                             | seconds | result                       |
| -------------------------------- | ------- | ---------------------------- |
| old, serial, no cache            | 39      | optimized=463 skipped=33     |
| new, cold cache                  | 9       | optimized=463, 70hit/420miss |
| new, warm cache                  | 0       | optimized=463, 490hit/0miss  |
| new, second pass over its output | 1       | **optimized=0** (was 90)     |

And the output is byte-identical to the old implementation: every file in both
dists hashed and compared, zero differences outside `sw-bus.js`, which carries
a build timestamp by design.

The CI cache key hashes the media that feeds the optimizer plus the script
itself, so on the overwhelmingly common pull request - the one that changes no
image - the key HITS and nothing is re-saved. No cache churn. When an image
does change, `restore-keys` still hands over every other image's result and
only the changed file is encoded.

`tests/the-media-optimizer-remembers-and-is-idempotent.law.test.ts` is
behavioural: it builds a synthetic dist, runs the real script against it, and
asserts the cold miss, the warm hit, the second-pass no-op and the byte
identity of the twice-passed file.

### 4. A real bug: Sentry had maps for the bundle nobody loads

Found while reading the build steps, fixed here because it is the same two
steps.

`sentryVitePlugin` activates on `NODE_ENV === 'production' && SENTRY_AUTH_TOKEN`.
`SENTRY_AUTH_TOKEN` was set on `ci.yml`'s `Production Build` - a pull-request
artifact that is measured and thrown away - and NOT on the publisher's build,
the only bundle a player ever loads. Three consequences, all silent, because
the plugin's `errorHandler` warns rather than failing (correct: a Sentry outage
must not stop a deploy):

1. Production stack traces could not be symbolicated. Maps existed for code
   nobody runs and for none of the code everybody runs.
2. `filesToDeleteAfterUpload` is part of that upload, so it never ran on the
   publishing path: **267 `.map` files, 27MB, were rsync'd to the origin and
   served to players on every deploy.**
3. The plugin tagged its release `club-arena@1.0.1` (from
   `npm_package_version`) while `src/core/SentryInit.ts` tags every event
   `club-arena@${VITE_APP_VERSION}` - the publishing sha. Two different release
   names, so even a successful upload could not have symbolicated one event.

Fixed: the token moved to `publish-club-arena.yml`, the release name is now
`club-arena@${VITE_APP_VERSION}` on both sides, and the publisher strips every
`.map` from `dist/` unconditionally after the build and refuses to publish if
one survives - belt to the plugin's braces, since the plugin only deletes on a
successful upload. Removing the upload from `ci.yml` also takes its latency off
the critical path. Pinned by
`tests/source-maps-go-to-sentry-not-to-players.law.test.ts`.

### 5. One stale comment, corrected

`ci.yml`'s CSS Beat E2E job carried "This job is still pinned to ubuntu-latest
(it failed on the 4-core box)" thirty-seven lines below the
`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` that PR #2937 put there.
The code moved and the comment did not. The branch it introduces is still
correct and still necessary, and now says why.

## Expected effect

| step               | css-beats | ci wall | publish | push to live |
| ------------------ | --------- | ------- | ------- | ------------ |
| before             | 375s      | 6.3m    | 3.3m    | ~10.1m       |
| sharp declared     | 298s      | 5.0m    | 3.3m    | ~8.8m        |
| `build:ci`         | 250s      | 4.2m    | 3.1m    | ~7.8m        |
| media pool + cache | ~165s     | ~2.8m   | ~1.7m   | ~5.0m        |

## What was considered and rejected

- **Feed CSS Beat E2E the `build` job's artifact instead of rebuilding.** The
  two builds run concurrently on different runners, so the beats build costs
  nothing in wall-clock terms; serialising them converts free parallel work
  into serial work and adds an artifact download.
- **Have the publisher reuse CI's artifact.** Unsafe, and structurally
  impossible. `ci.yml`'s build has no `VITE_SENTRY_DSN` (client error reporting
  would go dark with nothing to say so), no `VITE_ANTIGRAVITY_ENABLED`, and
  `VITE_APP_VERSION` is the squash sha, which does not exist when the PR-head
  build runs.
- **Rebalance the publisher's four test shards.** They are 0.57-0.72m and end
  109 seconds before the critical path does. Zero wall-clock gain.

## Two honest caveats

**Six minutes is a best case until it is measured at p95.** The same DAG
produced 6.98m and 12.67m walls on 2026-09-04 with 1-2s queue times. That
spread is on-box contention, amplified by exactly the work removed here, so it
should compress - but it is a projection until three real pushes say otherwise.

**Some tail latency is scheduling, not speed.** `publish-club-arena.yml`'s
concurrency group is `cancel-in-progress: false`, so a third push cancels the
pending run; 5 of the last 20 publish runs were cancelled that way, and one
waited 1.8m between merge and publish start. No build optimisation touches
that. Fixing it means a different queueing discipline, and it is a separate
decision.
