# The one build job with no cache at all

After CSS Beat E2E moved onto the estate it fell from 11.13m to 6.88m. Its step
breakdown showed where the rest sits:

    45s   Install Dependencies
    235s  Build this commit          <- 57% of the job
    26s   Run the beats against this commit's CSS
    77s   Table Studio real-component purchase, sync, accessibility
    11s   Insurance and Rabbit Hunt 375px decision gate

The E2E specs it exists to run are **114 seconds**. The build in front of them is
**235**.

`npm run build` is an eight-step chain — `tsc -b`, two media generators,
`vite build`, font self-hosting, `optimize-dist-media` (463 files, 144MB -> 40MB),
provenance stamping. Locally that is 55s, of which `vite build` is only 10s and
`optimize-dist-media` 19s.

And `css-beats-e2e` was the **only** job that builds with no cache of any kind.
`build` restores `node_modules` and `node_modules/.vite`; `typecheck` and `unit`
restore `node_modules`. This one restored nothing, so every run paid a cold
install and a build with a cold Vite transform cache and no `.tsbuildinfo`,
making `tsc -b` a full typecheck rather than an incremental one.

Restoring `node_modules` fixes all three at once, because both
`node_modules/.vite` and `node_modules/.tmp/*.tsbuildinfo` live inside it.

## Why a separate cache key

`nm-full` belongs to `unit` and `build`, which install with a plain `npm ci`;
this job uses `--ignore-scripts`, so the trees are not interchangeable — the same
class of mistake as reusing a Node 20 cache in a Node 22 job. `nm-lite`
(typecheck) _does_ install identically, but typecheck never builds, so its tree
carries no warm `.vite` and no `.tsbuildinfo` — which is the whole point here.

## Still on the table

The build runs `tsc -b` even though a separate **TypeScript Check** job has
already typechecked the same tree, and it runs in three places per merge (this
job, Production Build, and the publisher). That duplication is the next real
saving, and it is a change to the build contract rather than to caching, so it
is left as its own piece of work rather than folded in here.
