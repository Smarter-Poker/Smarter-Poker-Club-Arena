# FLH Is Selected Again On The Round-4 Source

## What Was Wrong

- Round 4 (#6700) moved the Phase 12 FLH policy digest (exact sampler kernels, scoped no-limit
  packs), so the generation-1 FLH selection measured on 1235b47a would have been refused
  policy_digest_mismatch. It was set to null and FLH played shadow.

## What Changed

- The locked FLH matrix under contract v1 was re-run on 9d567463 (run 38206776185): 42 of 42
  shards, +1.11 [+0.70, +1.52] bb/100, qualified on condition (a), and it reproduced run
  37969578926 bit for bit in every shard and all 21 cells.
- The predeclared natural completion window on release 9d567463 (2026-10-12 05:02 to 05:50Z)
  meets the 0.95 floor on every street: preflop 504/505 (0.9834), flop 238/239 (0.9653), turn
  178/178 (0.9641), river 130/130 (0.9514).
- `PHASE12_PROTECTED_RELEASE_SELECTIONS.flh` names the new qualification and completion record at
  approval generation 2, issued 2026-10-12T11:00:00.000Z. The qualification, its strength record
  and the completion record ship in the engine image under `server/release-evidence/`.
- Short Deck, Crazy Pineapple and FLO8 stay null.

## Status

Implemented but unverified until FLH natural accepted use is read after the release.

## Record

`docs/horse-brain-phase12-round4-2026-10-11.md`, section 8.
