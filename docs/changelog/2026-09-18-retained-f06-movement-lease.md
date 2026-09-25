# Retained F06 movement preserves the current manager lease

The tournament heartbeat now distinguishes an idle retired dealer from an exact
F06 movement already admitted on that stopped dealer. Both can retain their old
gameplay proof while the current manager and healthy peers renew. An admitted
movement remains pending until its original barrier and custody checks finish;
it never becomes a drained-stop certificate or permission to restart dealing.

## Cause and correction

`executeTournamentMoveAtBoundary` intentionally permits a positively stopped
F06 source to revalidate and replay its existing movement under current manager
custody. During the await it registers a movement barrier. Previously that
barrier made `isTerminalDrainedForTournamentLease` false, so
`renewTournamentLeaseProof` tried to renew the retired dealer's expired gameplay
proof. The refusal fenced the healthy manager and all its other tables.

The existing movement owner now marks only barriers admitted through F06
movement admission or the original no-start custody guard. The heartbeat checks
that every outstanding movement barrier has this provenance before excluding
the retired dealer from gameplay renewal. Successful physical teardown, no live
dealer/hand/settlement/read/snapshot work, exact tournament/generation, a current
manager proof and the two registry ownership checks remain required. Ordinary
stopped movement does not qualify. The marker is removed with its barrier on
success or rejection; existing post-await custody assertions remain in place.

## Evidence and limits

Read-only production inspection on 2026-09-18 found the following sequence on
engine `8825af51817f379c4261658ca29ecc9d8d81932d`:

- Event `5a387a75-754a-416e-8fee-b85b15fc2702`: heartbeat lease loss at
  22:10:26.769 UTC, followed at 22:10:26.796 by F06 admission revalidation
  refusal for break `4d2d4928-f822-4e14-af4c-5063d43b7d59` and request
  `edbe4bdf-e7bf-4099-a035-4fafa9c7f2d9`.
- Event `615783bf-15e3-40b7-9368-75f21b6ac53b`: heartbeat lease loss at
  22:12:31.862 UTC, followed at 22:12:32.216 by the movement's post-await
  owner check refusing request `421cb5c8-3a25-4845-9a68-71355aa1a423`.
- At 23:06 UTC the database retained six and seven unacknowledged F06 breaks,
  respectively. The second request had a committed winner receipt; the first
  request and `48b9a0f7-e40e-4163-845e-1a5244a2dac2` remained active without
  receipts. These are mixed states requiring their exact canonical recovery.

The production sequence supports this cause, but the runtime diagnostics did
not capture the barrier at the exact heartbeat. The defect itself is reproduced
with the actual manager, dealer, retirement custody, movement and renewal code
in isolation; database responses and monotonic time are controlled inputs.
No live mutation, recovery, force-clear, migration, watcher or new timer was
introduced. Existing expired managers are not resurrected by this change.

## Validation and handoff

- Base: `904409f3f0883d791392165757cf7c525f98e625`.
- Four connected regressions fail against the unchanged base: pending F06
  revalidation, pending move RPC, failed move RPC and original no-start custody
  movement. All pass with the correction.
- `npm test --` with the ten lease/movement/custody/lifecycle suites: 144 passed,
  zero skipped. Includes existing fail-closed ownership/deadline cases and a new
  rejection of ordinary stopped movement.
- `npm run build` and `npx tsc --noEmit` in `server`: passed, including test compilation.
- Prettier check on the three changed TypeScript files and `git diff --check`:
  passed. Policy check against canonical sources: passed.
- The regression remains in the existing `TournamentLeaseProofDeadline.test.ts`;
  CI's four server test shards already run it, and their existing required
  `Server Engine (typecheck + tests)` aggregate is unchanged.

Owned checkout: `/Volumes/SmarterWork/agent-work/mtt-retained-break-stop-20260918`;
branch: `work/mtt-retained-break-stop-20260918`. After source review the parent
authorized this helper's normal branch submission and one PR. Parent MTT delivery retains
protected integration, publication, live verification and the
separate canonical recovery. This helper change is source-tested only; no push,
hosted checks or production activation has occurred for it.

Retained evidence:
`/Volumes/SmarterArchives/agent-evidence/mtt-retained-break-stop-20260918/`
contains timestamped runtime events, the exact SQL readback, base regression
failures, passing test/build logs and the tested source hashes.

## Current reference receipt

Fresh full reading on resumption, completed 2026-09-18 at 23:04 UTC: the four
canonical files under `/Users/smarter.poker/Documents` (`AGENTS.md`,
`AGENT-OPERATING-LAW.md`, `AGENT-HARDENING-STANDARD.md`,
`AGENT-REFERENCE-INDEX.md`), their portable policy-reader output, repository
`AGENTS.md`, `AGENT-PLAYBOOK.md`, `CLAUDE.md`,
`.agents/rules/00-agent-playbook.md`, `.agent/architecture/deploy-paths.md`,
`docs/HANDOFF_CURRENT_STATE.md`, `docs/ENGINE-RESTART-PROGRAMME.md` and the
changelog instructions. `PUBLISHING.md` was read at 23:08 UTC when submission
was assigned. No nested server instruction files were found.

Policy version 2.9; reader emitted at `2026-09-18T23:04:47.688Z`; manifest SHA256
`7663cc909626f7e9966931d27166ad8774addc801f7ad1898a2d7564bc13c378`.
The canonical comparison passed for those bytes. Owner policy hash:
`76228d75677eb76ca9dcfbf65fd68ddb7aac3941f61154acc456ae8230a9a4fa`;
operating law: `a8bc3c04dce3354ebdd51a89c0b7d715af3344edcc794d33f6b3ad64506961d5`;
hardening: `d5fc451ce5caf6d6b5e64597a13883e1246581678fe53c962339d0a66136993e`;
reference index: `adce89c3f838f2f373cd504a00329d53906404d1dd42a647f672af6c16f95555`.
