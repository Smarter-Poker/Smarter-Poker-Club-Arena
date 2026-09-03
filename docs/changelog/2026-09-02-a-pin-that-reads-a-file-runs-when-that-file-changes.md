# A pin that reads a file runs when that file changes

2026-09-02, fix-first. Main was red, the one publisher's client-tests shard
1/4 failed on every merge, and production sat at 19:10 while `main` kept
moving.

## What broke

#2695 was a correct engine fix: `isPausedByDesign()` gained
`|| this.maintenancePaused`, because the maintenance break set a flag the
predicate never read and 1204 hands were dealt inside one break.

`tests/unit/tournamentRakeAndBreaks.test.ts` pins that predicate by reading
`server/src/engine/ServerTableEngineBase.ts` with `readFileSync` and matching
the two-term form. The pin went red the moment the engine was made right.

Nothing ran the pin before merge:

- `ci.yml`'s `changes` job classified the diff as `server/` only and SKIPPED
  `Client Unit Tests (vitest)`. 96 files under `tests/` read `server/src/**`
  that way. The migrations lesson from #2580 (a migrations-only PR skipping
  the suite that reads migration files) applied one directory over and had
  not been generalised.
- `.husky/pre-push` ran `vitest related` on the changed engine file. `related`
  follows imports. A source pin does not import what it pins, so `related` has
  never once run a pin for the file it reads.

## What changed

1. The pin now demands all three terms, bounded by `sliceMethod`, so the
   #2695 bug cannot regress and the pin cannot fight the fix.
2. `ci.yml`: `tests=` now fires on `server/` as well. A server-only pull
   request runs the client suite (about two minutes on the box).
3. `.husky/pre-push`: after `related`, every test under `tests/` that names
   the basename of a changed source file runs too. For the #2695 diff that is
   11 files, one of which was the red one.

Verified: 19 pin files / 364 tests green, including `noFixedSizeSourceWindows`.
