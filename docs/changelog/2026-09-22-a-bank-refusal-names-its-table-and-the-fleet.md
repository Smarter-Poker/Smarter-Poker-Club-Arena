# A Bank Refusal Names Its Table, And The Fleet That Holds The Same Shape

Date: 2026-09-22. `server/scripts/legacy-engine-checkpoint-guard.mjs` and its
tests only. Observability only: no condition, refusal code, order, reserve,
budget or allow-list moves. No migration, no engine change, no workflow
change. Nothing was deployed by this commit.

## What was wrong

Run 35620115786 (control `a6b743e6`) is the only 8825 legacy checkpoint whose
preflight has got past the mixed-custody capture and the drain witnesses. Its
first attempt refused at 15:43:34Z on 2026-09-21, in the host journal of
`club-arena-engine-release-v1@35620115786-1.service`:

```
{"ok":false,"reason":"bank_metadata_without_bank","checkpoint":{"schema":"legacy-engine-checkpoint/v1",
 "ok":false,"reason":"bank_metadata_without_bank","stage":"preflight","attemptedTables":0,...}}
```

and nothing else. (Its second attempt hit the O_EXCL intent file,
`FileExistsError`, which is all the Actions log shows.) `captureEngine`
refuses through the process-wide `require`, which carries no detail, so
nobody could say which of ~150 tables held it, or why. Every attempt since
(16:17, 16:37, 17:07, 17:13, 01:10) refused earlier in the sequence, so this
is the refusal the release is expected to meet next once the qualification
pin in this PR matches the installed prepare.

The 8825 source (`git show 8825af51:...`) has two ways to produce it:

- A DEPARTED player's metadata. 8825 deletes `timeBankMeta` in exactly one
  place, the cash branch of `adoptSeatRoster` (`ServerTableEngineBase.ts:4283`),
  and only for a player still in the previous roster. A voluntary cashout
  (`:3679`, which filters the seat out directly), a seat move (`:4061`), a
  busted release (`:7508`), a sit-out eviction (`:7691`) and
  `tearDownDepartedSeats` (`ServerTableEngineSettlement.ts:3738`) remove the
  bank and keep the metadata. The tournament branch of `adoptSeatRoster`
  returns before any cleanup (`:4260`), and a tournament bust removes no bank
  at all (`ServerTableEngineDealing.ts:448` is cash-only), which leaves a bank
  with no seat as well.
- A STOPPED engine still in the fleet map. 8825 `stop()` disposes every live
  bank (`timeBankEngine.disposeAll()`, `:3579`; `playerBanks.clear()`) and
  keeps `seatedPlayers` and `timeBankMeta`. `TournamentManagerBase` teardown
  stops every engine and then throws "retained an unresolved seat-move UUID"
  (`TournamentManagerBase.ts:5821`) before its
  `unregisterTournamentTableEngine` loop, so those stopped engines stay
  registered. On 2026-09-22 at 03:4xZ the live container logged that error
  about 173 times in ten minutes for each of eight tournaments: 29ee786f,
  45126295, 46fc3d3a, 5a387a75, 615783bf, 7c6277e7, 99271c16 and bfcfaf17.
  Only 5a387a75 and 615783bf are in the checkpoint's retained custody; the
  capture walks the other six.

They need different dispositions and neither may be waved through here.

## What changed

`captureEngine` declares a local `require` with the same signature, the same
conditions and the same codes as the one it shadows. Before refusing it
records, through the existing `noteRefusal` (first refusal only, errors
swallowed):

- `failedCheck`: `captureEngine.<code>`;
- `failedTable`: the table id;
- `observedDetail`: that engine's `stopped`, `terminal`, `scope`, `tournament`,
  `seats`, `banks`, `meta`, `metaUnseated`, `metaSeatedWithoutBank`,
  `bankUnseated` and `parked`; the other per-engine refusal inputs, `f06`
  (permit/recovery), `settling`, `postTasks`, `moves`, `boundary`
  (pending/failed) and `accounting`; then a census of every engine the capture walks
  (the same two exclusions the capture loop makes: retained originals and
  unstarted cash engines): `fleet`, `fleetStopped`, `fleetStoppedSeatedMeta`,
  `fleetLiveSeatedMeta`, `fleetDepartedMeta`, `fleetOrphanBank`, `fleetF06`,
  `fleetBoundary`, and
  `stoppedEvents`, the 8-character prefixes of the tournaments whose stopped
  engines hold seated metadata. A census failure degrades to `fleet=unreadable`
  and never removes the per-table detail.

Sizes, booleans, the lease scope and tournament ids only: no player id, bank
value or seat leaves the guard, and the string stays inside the publisher's
512-character carrier and its character class (`checkpointSummary` already
carries `failedCheck`, `failedTable` and `observedDetail`).

`metaUnseated`/`fleetDepartedMeta` name the departed-player case,
`bankUnseated`/`fleetOrphanBank` the tournament-bust case, and
`stopped=true` with `metaSeatedWithoutBank > 0` (`fleetStoppedSeatedMeta`,
`stoppedEvents`) the quarantined-manager case. One refused attempt is then
enough to write the disposition.

## Verification

`tests/legacyEngineCheckpointGuard.test.ts`, six new tests. A stopped engine
whose banks were disposed, a parked engine whose departed player left
metadata, and a fleet holding all three shapes each still refuse
`bank_metadata_without_bank` with no write, and now name the first refusing
table, its shape and the census, with no player id anywhere in the result; the
production 8825 profile leaves its two retained originals out of the census,
exactly as the capture does; a refusal that is not per-engine
(`insufficient_reserve`) carries no `captureEngine.` detail and no census; an
F06 permit held outside retained custody refuses `f06_custody_not_drained` as
before and is now named and counted the same way.
`npx vitest run` over the guard, admission, break-window law and source-window
law suites: 187 passed. `cd server && npx tsc --noEmit`: clean.
