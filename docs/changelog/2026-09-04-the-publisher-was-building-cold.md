# The publisher rebuilt from nothing on every publish

CI's `Production Build` caches `node_modules` and `node_modules/.vite`. The
publisher's `build-and-store` cached **neither** - every publish paid a full
`npm ci` and a cold Vite build. Measured: **3.4 minutes of run time**, on top
of its queue wait, directly on the path between a merge and a player seeing
the change.

Both caches are keyed on the lockfile, exactly as CI does it, so a dependency
change invalidates them together and neither can serve a stale tree. **A cache
miss simply builds as before** - this adds no failure mode, only a faster hit.

## The bug this nearly shipped with

The obvious move was to reuse CI's key. That would have been wrong and quietly
destructive: **`build-and-store` runs Node 22 and CI's `Production Build` runs
Node 20.** One shared key would restore a `node_modules` whose native modules
were compiled for the other runtime.

So the keys are version-scoped - `nm-publish-<os>-node22` and
`vite-publish-<os>-node22` - and every cache in both workflows was checked for
the same hazard:

| key                                                                | node                   |
| ------------------------------------------------------------------ | ---------------------- |
| `nm-lite-*-node20`, `nm-full-*-node20`, `vite-*`                   | CI, Node 20            |
| `nm-server-*-node22`                                               | CI server job, Node 22 |
| `nm-bfwh-*-node22`, `nm-publish-*-node22`, `vite-publish-*-node22` | publisher, Node 22     |

No two jobs on different runtimes share a key.

## Why this was worth doing at all

Club Arena is 23-35 minutes push-to-live; World Hub, on the same estate, is
~5-6. The difference is that World Hub merges and Vercel builds once, while
Club Arena runs a second full build-and-test cycle of its own. Three changes
attack that second cycle:

- the tree-hash skip, so an already-proven tree is not tested twice,
- `estate-ci-eu-3`, which took Club Arena from 6 runners to 12 and dropped
  `estate-ci-eu-1` from load 41 to 4.85,
- and this, so the build it does still need is not started from nothing.

Club Arena publishes to its own Caddy origin, not to Vercel, so none of this
can affect a Vercel deployment.
