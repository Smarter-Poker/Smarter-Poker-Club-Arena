# Phase 12 Round 4: One Strength Contract Per Pack, Scoped No-Limit Packs

## What Was Wrong

- Short Deck and Crazy Pineapple failed the trust check only in full-table cells where the
  round-3 pack changed fewer than 1 pair in 600; meeting it by pairs alone needed about 169 and
  956 job-hours.
- FLO8 failed it only in position big blind.
- The one Phase 12 strength contract was rebuilt from the live pack versions with one digest
  for all four packs, so any pack change refused the selected FLH pack.

## What Changed

- `short-deck-round4-v1` and `crazy-pineapple-round4-v1`: big blind defence capped at four dealt
  seats; full tables play the reference exactly, two and four dealt are unchanged (proved on
  development seeds, `docs/evidence/phase12/round4/development-proof-2026-10-11.json`).
- `remainingVariantStrengthContractFor(variant)`: FLH stays on contract v1, frozen byte for byte
  (digest fafbba8d...); Short Deck, Pineapple and FLO8 run contract v2 (digest 6c50e717...) with
  fresh held-out seeds and FLO8 shard counts planned for the trust check.
  `PHASE12_RUNNING_CONTRACT_DIGESTS` replaces the single running digest; the strength workflow,
  runner, league and assembler bind each pack's own contract.
- The FLH selection is null: its evidence measured a policy digest the sampler kernels and
  scoped packs moved. FLH plays shadow until it is re-measured under v1 and selected again.

## Record

`docs/horse-brain-phase12-round4-2026-10-11.md`.
