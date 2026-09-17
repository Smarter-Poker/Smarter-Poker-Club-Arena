# One Request Per Pause, Not Per Keystroke

**2026-09-17** · Club Arena client and engine hygiene · performance checklist audit, phase 3 of 6

## What Changed

1. **`PurchaseLedger` search is debounced (300 ms).** Every keystroke in the
   club shop's purchase ledger search refetched `/api/club-arena/shop-purchases`
   through the World Hub. It now waits for a 300 ms pause, the same window
   `useDebounce` already gives the roster and hand searches. The `offset`
   reset on typing is unchanged.
2. **`encode zstd gzip` on the engine's Caddy site**, in
   `infra/monitoring/engine-01/Caddyfile` - the template that mirrors the
   live box. The identical line for `server/Caddyfile` is deferred to a
   follow-up: `scripts/ci/classify-ci-changes.mjs` routes any touch of
   `server/` into the real-PostgreSQL accounting job and the four Server
   Engine shards, and that suite is currently red on a spin-expiry refund
   contract that has nothing to do with this change. A Caddy template the
   repository never deploys is not worth holding a client fix behind a red
   suite it alone summons.
   The static origin (`infra/ca-origin/Caddyfile`) has compressed since it
   went up; the engine host never did, so `/health`, `/actions` and lobby
   JSON went out uncompressed. WebSocket frames are unaffected. **The live
   `/etc/caddy/Caddyfile` on engine-01 is operator-managed host state** (see
   `infra/monitoring/deploy.sh` section 4 and
   `server/scripts/install-caddy-websocket-log-redaction.sh`): nothing in the
   repository deploys it, so this reaches production only when the operator
   adds the line to the `engine.smarter.poker` block and runs `caddy reload`.
3. **`@types/md5` to devDependencies: deferred, on purpose.** It was in this
   change and is now not. `scripts/ci/classify-ci-changes.mjs` treats any
   touch of `package.json` or `package-lock.json` as `wide`, which sets every
   CI flag true and runs the full fourteen-job suite including the four
   Server Engine shards. On a repository where `main` advances every few
   minutes and `scripts/stamp-build-provenance.mjs` refuses a build that is
   even one commit behind it, a cosmetic dependency move was the single thing
   forcing the longest possible run, and it lost the race three times while
   the actual change waited behind it. The move is correct and costs nothing;
   it belongs in a dependency-only pull request that can afford the full
   suite, not bolted to a client fix.
4. **334 `server/vitest.config.ts.timestamp-*.mjs` files deleted** from the
   canonical clone and its sibling. Vitest writes one per crashed config load;
   they are gitignored and were never in the repository.

## Verified

- `tsc --noEmit -p tsconfig.app.json`: 0 errors.
- `engine-recovery-healthcheck.law`, `originConfigDeployment`,
  `the-monitoring-deploy-deploys.law`, `migrationVersionUniqueness`: 46 tests
  pass.
- `npm install --package-lock-only`: lockfile delta is the one `dev: true`
  flag.

## Reviewed And Left Alone

The audit's scanner flagged these in Club Arena; each was read and is not a
defect:

- **Loading states**: the seven `src/pages/stats/*Tab.tsx` files are
  presentational children of `PlayerStatsPage`, which owns the skeleton
  (`stats-page-loading`). `HelpPage` and `marketplace/DiamondsTab` are static.
  `TableBombSettingsPage` has `if (loading)`. `DriftGatePanel` renders nothing
  until its first load, by design, inside `DriftIncidentsPage`.
- **`UnionDashboardPage` search**: client-side filters over already-loaded
  rosters, no fetch on type.
- **`<img>` without `loading="lazy"`** (20 pages): hero and chassis art on
  the painted console, single avatars, and the dev showcase. Lazy loading
  would delay the first paint of the very art the page exists to show; the
  list-rendered images in Club Arena already carry `loading="lazy"` (27 tags).
- **`gsap`** is used by `share/HandReplayerPage`; not unused. The Capacitor
  packages are registered natively by `cap sync`, not by import.
- **`select('*')`** in 68 page bundles: over-fetch, but changing column lists
  on money-adjacent reads is not a hygiene change and is left to the owning
  workstreams.
