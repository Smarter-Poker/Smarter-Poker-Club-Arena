# The F06 refusal that would not name its phase (2026-09-23)

The engine had not shipped for four days. This is what actually stopped it,
measured from the run logs and from production, and the one thing in this repo
that was making the next attempt as blind as the last one.

## What production was doing while it was stale

`https://engine.smarter.poker/health`, read 2026-09-23 08:04 UTC:
`liveness: ok`, `tablesExpectedDealing: 117`, `handsInWindow: 176`,
leader `1-3846b8bb`. Players were served throughout. This was a STALENESS
problem, never an outage, and nothing here forces a restart.

Live engine: `8825af51817f379c4261658ca29ecc9d8d81932d`
("Complete pending MTT recovery and recorded financial delivery", #4883),
sealed 2026-09-18 16:16:22 -0500.
Pending engine component on `main`: `0662cc2a3bcf000a4a81b7ad0fde6d2e686a287d`
(2026-09-22 16:09 UTC). Five days apart.

## It was never disk, and it was never the build

Issue #4649 says engine-01 has ~100 MiB free against a 1.15 GiB bounded build.
**That issue was last updated 2026-09-14 and does not describe any failure in
this window.** Of the 30 most recent `auto-deploy-hetzner` runs, every single
one failed, and in the 19 I opened the failing job was:

| failing job                                                                 | runs           |
| --------------------------------------------------------------------------- | -------------- |
| `Publish Through Hetzner Club Arena` (the durable host release transaction) | 18             |
| `Prove The Exact Engine Has Every Production Door`                          | 1 (the newest) |

Not one failed in build or test. The image BUILT and validated on the runs that
reached it, well inside its own boundary:

```
run 35724284646  ENGINE_BUILD_RESOURCE_BOUNDARY=memory:671088640,swap:0
                 ENGINE_BUILD_MEMORY_PEAK_BYTES=77414400      (73.8 MiB of 640)
run 35674810105  ENGINE_BUILD_MEMORY_PEAK_BYTES=659132416     (628.6 MiB of 640)
validated immutable image sha256:cd1e1f6a... at revision 0caf2546...
```

Every one of those 18 died in the same place, the legacy engine checkpoint:

```
[legacy-engine-checkpoint] checkpoint or inspector cleanup refused; do not retry this operation
[engine-release-transaction] FATAL: legacy checkpoint or cleanup refused; release cannot continue
```

with three different reasons across the window: `mixed_original_work_not_drained`
(35601680060, 35577995941, 35529169575), `bank_metadata_without_bank`
(35620115786), and `f06_custody_not_drained` (35724284646).

## The refusal this change is about

Run 35724284646, 2026-09-22 12:05:23 UTC, verbatim:

```
{"ok":false,"reason":"f06_custody_not_drained","failedCheck":"captureEngine.f06_custody_not_drained",
 "failedTable":"6da98abe-94e5-4692-8b90-234bf72f0b5a",
 "observedDetail":"stopped=true,terminal=true,scope=tournament,
   tournament=05c8bb91-2e69-429f-9102-d7437b31249a,seats=3,banks=0,meta=3,
   metaUnseated=0,metaSeatedWithoutBank=3,bankUnseated=0,parked=0,
   f06=true/false,settling=0,postTasks=false,moves=0,boundary=0/true,accounting=0,
   fleet=130,fleetStopped=23,fleetStoppedSeatedMeta=13,fleetLiveSeatedMeta=0,
   fleetDepartedMeta=98,fleetOrphanBank=1,fleetF06=9,fleetBoundary=7",
 "retryAllowed":false}
```

One stopped, terminal tournament table still holds an F06 permit, so
`captureEngine` refuses at `legacy-engine-checkpoint-guard.mjs:2001`:

```js
require(engine.f06CurrentPermit === null &&
  engine.f06RecoveryInFlight === false, 'f06_custody_not_drained');
```

**The refusal is correct and stays.** A permit outstanding on a terminal table
is an unresolved hand, and a release must not restart on top of one.

## What was wrong in this repo

`f06=true/false` says only THAT a permit exists. All six phases produce that
same pair, and they do not share a disposition:

- `attempted` - a hand that may have started. Never restart over it.
- `terminated`, `number_refused` - provably never dealt.
- `new`, `reserved`, `unknown` - a preparation whose fate the database decides,
  and the release transaction already owns that question in
  `engine-release-inflight-hands.py`.

The guard already knows the phase is the deciding datum: it prints
`permitPhase=` on the mixed-original boundary refusal
(`legacy-engine-checkpoint-guard.mjs:1231`) with the comment "the allowance on
this one field turns on the permit phase, so a refusal here is unreadable
without it". It simply did not carry it on the capture refusal that actually
fired in production.

The "A BANK REFUSAL NAMES ITS TABLE" block added on 2026-09-22 exists so that
"ONE refused attempt is enough to design the disposition". For the F06 reason
it was not enough, and the next attempt would have been equally blind.

So `engineRefusalDetail` now carries `permitPhase`, beside `f06=` and never
appended after the fleet census, because the list is truncated to 512
characters and a token added at the end is the first thing a long refusal
drops. Its own try/catch keeps a throwing accessor costing that ONE token
instead of blanking the whole record through `noteRefusal`, and it reports
`unreadable` rather than folding "I could not tell" into `none`, which the
guard uses for "there is no permit at all" (CLAUDE.md 10.86 rule 1). Values go
through the guard's existing `describe`, so the same identifier-only character
class and the same no-player-identity rule hold.

**This is evidence, not the fix** (CLAUDE.md 10.11). The fix is the disposition
that the next refusal's phase will let somebody write, and the root repair for
the leak itself is already merged and undeployed - see below.

Pinned by 8 new cases in `tests/legacyEngineCheckpointGuard.test.ts`: one per
phase, one for an unreadable permit (which also proves the rest of the record
survives), and one for a recovery that refused with no permit at all. 155/155
pass. No code, order, threshold or outcome moves; `f.calls` stays empty in
every one.

## The two blockers this change does NOT clear, and who owns them

**1. The doors gate - the newest attempt, and the outermost blocker now.**
Run 35752228277, 2026-09-22 16:13:40 UTC:

```
fn_ca_commerce_claim_due_renewals() is called by server/src/services/CommerceRenewalConsumer.ts
  and does not exist in production. Apply its migration before this build ships.
fn_ca_commerce_deliver_due_notices() ... does not exist in production.
fn_ca_commerce_execute_renewal() ... does not exist in production.
3 of 210 database functions this build calls are missing in production. Nothing was deployed.
```

Verified directly against production on 2026-09-23: all three are absent from
`pg_proc`, and `20260922143541_club_and_union_diamond_commerce` is absent from
`supabase_migrations.schema_migrations`, which does hold everything up to
`20260923045932`. PR #5077 merged its caller and its 2,063-line migration
together at 16:09:01 UTC and the release lane fired 31 seconds later, so the
build has never had its doors. **Owner: the migration apply, tracked with PR
#5077. Not touched here - another task is carrying it, and it is a 2,063-line
production DDL under the section 2 policy.** Applying it is necessary and not
sufficient: blocker 2 is independent and sits behind it.

**2. The retained permit itself.** The root repairs are already on `main` and
cannot ship, because the thing they repair is what refuses the release:
`56c722f8ec` ("one stuck permit cannot hold the whole platform", #4909, merged
2026-09-18 22:08, six hours after the live engine sealed) and `adf61066b7`
("an abandoned table break can still reach a terminal state", #5035). That is
the deadlock in one line: **the fix for the wedge is behind the wedge.** The
control plane is the only lever that reaches it, because
`legacy-engine-checkpoint-guard.mjs` is staged from the repo at the release SHA
and run inside the running container - which is why this change takes effect on
the next attempt without the engine shipping first.

## One thing that looks broken and is not

No `auto-deploy-hetzner` run has started since 2026-09-22 16:09, through ~20
merges. `stage-engine-release.yml` prints `Engine runtime release required:
false` and skips, because it compares THIS push's diff, not production's
revision, and every push since has been client-only.

That is not a defect and must not be "fixed". Issue #4219 states the design:
"**This watchdog reports; it does not dispatch** (Dan, 2026-09-10: no
watchdogs)." A superseded run and a run its break gate could not serve hand
themselves on; a run that FAILED deliberately does not, because that would be
the retry loop 10.12 forbids. An engine that stays behind means a run failed
and nobody has pushed an engine change since - which is exactly the state.
`.github/scripts/engine-watchdog.sh` was deleted in #4189; do not bring it
back, in the classifier or anywhere else.

The practical consequence: **the lane reopens on the next engine-affecting
commit to `main`.** This change is one, so it re-offers the pending component
on merge without any new dispatch authority.

## What was not established

The phase of the permit on table `6da98abe`. The detail did not carry it, which
is the whole subject of this change, and it cannot be read from outside the
running process. I could not tell, and I have not guessed: the disposition is
deliberately not written here. The next `f06_custody_not_drained` refusal will
name it.
