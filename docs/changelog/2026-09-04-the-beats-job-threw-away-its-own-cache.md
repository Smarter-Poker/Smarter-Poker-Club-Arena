# The critical-path job restored a 1GB cache and then deleted it

Date: 2026-09-04
Branch: `perf/the-beats-job-throws-away-its-own-cache`
Follows: `docs/changelog/2026-09-04-push-to-live-under-six-minutes.md`

## The find

`CSS Beat E2E` - the longest job in the pipeline and therefore the whole
critical path - had this shape:

```yaml
- name: Restore node_modules (vite + tsbuildinfo ride along)
  uses: actions/cache@v4
  with:
    path: node_modules
    key: nm-beats-...
- name: Install Dependencies
  run: npm ci --ignore-scripts # <- no `if:`
```

**`npm ci` removes `node_modules` before installing.** That is its documented
behaviour and the whole reason it is reproducible. So this job downloaded and
unpacked a roughly 1GB tree on every run, deleted it, and installed from
scratch anyway. The cache was not a cache; it was a download.

It cost more than the install. The restore step's own comment explains why:

> node_modules carries `node_modules/.vite` and
> `node_modules/.tmp/*.tsbuildinfo` with it, so restoring it warms the vite
> transform cache and lets `tsc -b` run incrementally rather than from scratch.

Both of those live INSIDE `node_modules`, so `npm ci` deleted them too. The job
paid for the download, then built cold anyway.

The three sibling installing jobs - `unit`, `build`, `typecheck` - and the
publisher's four test shards have all carried
`if: steps.nm-cache.outputs.cache-hit != 'true'` since the 2026-09-01 cost
audit. This one was missed, and nothing could notice: **a cache that does
nothing looks exactly like a cache that works.** The step is green either way.

## What it costs, measured today rather than argued

An `npm ci` on these boxes is not cheap, because twelve runners share one host
and installs collide. On 2026-09-04, on `estate-ci-eu3-2`, the sibling
typecheck job spent **8.62 minutes** in a single cold
`npm ci --ignore-scripts` while the estate was busy. The beats job was paying
that on every run by construction, plus a cold Vite transform and a cold
`tsc -b` on top of it.

## The law

`tests/every-installing-job-skips-a-warm-install.law.test.ts` sweeps both
workflows: any job that restores `node_modules` and runs `npm ci` must gate the
install on the cache hit. It also asserts it found more than two such jobs, so
it cannot pass by checking nothing - the failure this estate has shipped before,
when sixteen invariant guards printed "all passed" and ran none.

The general form is worth stating: **a cache is only a cache if something uses
what it restored.** Restore and guard, in every job, or neither.
