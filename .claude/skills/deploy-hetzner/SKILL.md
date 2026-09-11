---
name: deploy-hetzner
description: >
  Dispatch and certify the Club Arena poker engine using the repository-owned,
  exact-SHA sealed Hetzner workflow. Use for engine deploy, restart, ship, or
  production-release requests. Never deploy through World Hub or direct SSH.
version: 2.0.0
---

# Club Arena Sealed Hetzner Engine Release

The sole engine release authority is
`.github/workflows/auto-deploy-hetzner.yml` in
`Smarter-Poker/Smarter-Poker-Club-Arena`. It builds immutable images, waits
for the engine-authored maintenance certificate, cuts over the exact target,
proves public and direct health, and commits the durable release seal.

## Credential Boundary

The workflow reads only these Club Arena repository secrets:

- `HETZNER_SSH_PRIVATE_KEY`
- `HETZNER_HOST`
- `HETZNER_HOST_KEY`
- `DATABASE_URL` (append-only deployment receipt only)

Never read, copy, print, or store their values in a workstation `.env`,
Markdown, another repository, or a command. There is no legacy key alias,
World Hub fallback, password path, or local SSH-key fallback.

## Preconditions

1. Resolve one full target SHA that is already reachable from Club Arena
   `origin/main`.
2. Confirm the server tests, typecheck, release-seal law, and required pull
   request checks passed for that merged source.
3. Record a cache-busted baseline from
   `https://engine.smarter.poker/health`; do not mutate production while
   collecting it.

## Dispatch

For a merged SHA that is not yet live, dispatch immediately. This is the
non-forced path: the workflow intentionally exposes no force or maintenance
bypass input.

```bash
TARGET_SHA=<exact-merged-sha>
jq -n --arg sha "$TARGET_SHA" \
  '{event_type:"deploy-club-arena-engine",client_payload:{ref_sha:$sha}}' |
  gh api --method POST \
    repos/Smarter-Poker/Smarter-Poker-Club-Arena/dispatches --input -
```

Do not wait passively for the next hourly schedule once the exact release is
ready to stage. Do not create a second run for the same target while the first
is active; the workflow owns serialization.

## Certification

The run is complete only when all of the following are true:

1. The run is terminal-success for the exact target.
2. Cutover, public/direct verification, runtime-write proof, and release-seal
   steps actually ran; a staged-only or deferred green result does not count.
3. A cache-busted public health response reports the exact target SHA.
4. Liveness is healthy, the leader instance is stable, tables are dealable,
   hands advance, and no new lease-loss/recovery storm appears across the
   required observation windows.

If any gate fails, fix source forward and return through this same workflow.
Never SSH, restart Docker, edit `/opt/club-arena`, prune images, or point a
mutable tag by hand. Never ask the user to run a host command.

## Recovery

The workflow does not expose an operator-selected rollback input. If a cutover
cannot prove the requested release, the host transaction restores only the
previously sealed desired image and records the failed immutable request. Fix
the source forward and dispatch the resulting protected-main SHA through this
same lane; never improvise a direct host rollback.
