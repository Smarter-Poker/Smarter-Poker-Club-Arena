# CI runner topology, and the arithmetic that has to hold

Last changed 2026-09-04. If you are about to add runners, add a box, or move
one, read the arithmetic first - it is the whole point of this file.

## Current fleet

| box                           | type  | location        | role                                                                    | runners |
| ----------------------------- | ----- | --------------- | ----------------------------------------------------------------------- | ------- |
| `estate-ci-1` (5.161.121.210) | cpx41 | **Ashburn, VA** | **player-facing static origin only** (`ca-static.smarter.poker`, Caddy) | **0**   |
| `estate-ci-eu-1` (2.28.34.21) | cpx42 | Falkenstein, DE | Club Arena CI                                                           | 6       |
| `estate-ci-eu-2` (2.28.35.68) | cpx42 | Falkenstein, DE | World Hub CI                                                            | 6       |

Runners carry the label `estate-linux`; both repos set `vars.CI_RUNNER` to it,
which is what `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` resolves.

## Nothing in the player's real-time path is in Europe

The EU boxes are BUILD MACHINES. They have port 22 open and nothing else - no
Caddy, no nginx, no engine. A player never connects to them.

| what a player touches     | where                      | never moves |
| ------------------------- | -------------------------- | ----------- |
| `smarter.poker`           | Vercel edge                | -           |
| `engine.smarter.poker`    | 5.161.252.33, **Ashburn**  | yes         |
| `ca-static.smarter.poker` | 5.161.121.210, **Ashburn** | yes         |
| Supabase realtime         | Cloudflare                 | -           |

The only EU-to-US traffic is the publish rsync, once per publish. It is not on
any gameplay path. **Do not move the engine or the origin to Europe.**

## The arithmetic

Two numbers per box, and both have drawn blood:

**CPU.** `vitest.config.ts` caps CI at 2 threads per job. Six runners on eight
cores is 12 threads - deliberately a little over, because the suite is bound by
per-file environment construction rather than parallel width (measured: 33.2s
uncapped at 28 threads, 37s at 2). Before the cap, eight runners each claimed
eight threads: one run drove an 8-core box to load 12, four concurrent runs to
load 41 with swap, and the box stopped answering ssh.

**RAM.** The World Hub build asks for a 7 GB heap
(`NODE_OPTIONS='--max-old-space-size=7168'`). Two concurrent builds nearly
exhaust a 16 GB box. On 2026-09-03, eight runners on `estate-ci-3` produced
**12 OOM kills in 48 hours** and left three runners dead and unnoticed - World
Hub ran at 70% of its assumed capacity until it was found on 2026-09-04.

So: **do not exceed ~6 runners on an 8-core / 16 GB box**, and if you raise the
runner count, check the heap ceiling in the same change.

## Cost, and the trap in the pricing API

Hetzner charges roughly 3.7x in the US for shared-vCPU boxes:

| type  | cores/RAM | Falkenstein         | Ashburn       |
| ----- | --------- | ------------------- | ------------- |
| cpx41 | 8c / 16G  | (not provisionable) | $141.49       |
| cpx42 | 8c / 16G  | **$81.99**          | (not offered) |
| cpx31 | 4c / 8G   | $20.49              | $73.49        |

**The trap:** the API quotes a `fsn1` price for `cpx41`, but EU datacenters only
offer the newer generation (`cpx12`..`cpx62`) and creating a `cpx41` there fails
with `unsupported location for server type`. Compare against what a datacenter
actually _offers_ (`/v1/datacenters` -> `server_types.available`), not against
what `/v1/pricing` lists.

Dedicated-vCPU `ccx` types are priced almost identically in both regions
(ccx13: $50.49 EU vs $50.99 US) - worth knowing if CPU steal ever becomes the
constraint.

## If you need more throughput

Scale by adding a box, not by stacking runners onto an existing one. The
failure mode of too many runners is not slowness, it is jobs that time out and
report as test failures, plus OOM kills that silently remove capacity.
