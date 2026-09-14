# A sealed release proves itself with what it publishes

2026-09-11. Every engine release from 15:37 UTC onward failed, the engine
stayed frozen at `14794f7d` while it was healthy and dealing, and four merges'
worth of engine work had no way onto the floor. Found while checking whether
the horse audit had actually deployed. It had not.

## What was happening

`auto-deploy-hetzner.yml` runs at 15:37, 16:00, 16:41 and 16:44 all ended
`failure`, and the workflow's own message was about a transport problem
("could not reattach to the durable Hetzner release transaction"). That was
the symptom, not the cause. On the box the intake had succeeded every time,
installed the control generation, and handed off to
`club-arena-engine-release-v1@<run>.service`, which then looped:

    [engine-supervisor] FATAL: exact desired release 14794f7d... did not
      become live and exact locally and publicly before the recovery deadline
    [engine-release-transaction] FATAL: sealed desired runtime could not be
      restored before release work

Restart counter 9 and climbing. No release work ever started, because the
transaction restores the sealed desired runtime before it touches anything,
and that restore could not prove itself.

## The cause, read from the box

`engine-supervisor.sh`'s `health_identity` requires the health body to carry
`releaseSha` equal to the full 40-character desired commit. Read from the live
engine at 17:07 UTC:

    running    = True
    releaseSha = None
    instanceId = '1-3fc6cd2e'
    liveness   = 'ok'
    version    = '14794f7d'

`releaseSha` arrived with `server/src/releaseIdentity.ts`. The release that
introduced it also introduced the check, and the check is applied to the
release ALREADY RUNNING, which by definition predates the field. So the build
that would publish `releaseSha` was the build that could not ship, and the
loop sustains itself: nothing on this box will ever deploy again on its own.

The container itself was never in doubt. Its image id, `sp.release.sha`
label, `autoheal` label, `sp.role` label and restart policy were all exact and
are proved separately, before `health_identity` is called at all.

## The fix

A sealed release proves itself with what it publishes. When `releaseSha` is
absent entirely, `version` is accepted - the first eight characters of the
same commit, set by the same build from the same environment variable. A
release that DOES publish `releaseSha` must still match it exactly, so a
mismatched new build can never take the short road.

This is recovery only. Every new-candidate and publication proof
(`engine-release-transaction.sh`, `observe-engine-release.sh` and the two in
`auto-deploy-hetzner.yml`) keeps the strict form, because a candidate is built
from source that has the field. `tests/engine-recovery-healthcheck.law.test.ts`
pins both halves: the recovery fallback, and the strictness of the other four.

Behaviour checked directly against the extracted identity check, five cases:

| body                                                | verdict  |
| --------------------------------------------------- | -------- |
| no `releaseSha`, `version` = the right eight        | accepted |
| exact `releaseSha`                                  | accepted |
| wrong `releaseSha`, right `version`                 | refused  |
| no `releaseSha`, wrong `version`                    | refused  |
| no `releaseSha`, right `version`, `liveness` not ok | refused  |

## Why the workflow blamed the transport

The dispatch step reported a reattach failure and said nothing about the
supervisor, so four red runs in a row pointed at SSH. CLAUDE.md 10.86: a
signal that answers when it does not know. The release unit's own journal had
the real answer the whole time. That reporting gap is not fixed here and
should be: the reattach failure path ought to carry the durable unit's last
FATAL line back to the run that is waiting on it.
