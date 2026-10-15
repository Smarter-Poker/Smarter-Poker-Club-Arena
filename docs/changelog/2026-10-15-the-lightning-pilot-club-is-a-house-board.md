# The Lightning Pilot Club Is A House Board

## Ruling

Dan, 2026-10-14 22:25 Central, in his own words: "add the Lightning pilot club to
the horse allowlist, admit 72 horses, and fund them from its treasury".

## Why

Lightning Phase 3 needs a populated private pilot: 30 nonempty shadow
comparisons and a first real Lightning hand. The pilot club
(`e14bc9f7-736d-425f-8f2c-e78305ebac1d`, games `babb43f1` 6-max at 0.01/0.02
and `3330ff9f` 9-max at 0.02/0.04, both private Must-Move with Lightning off)
held only its owner, and the house-board guard refused every horse. It cannot
become the platform club: one platform club exists (the Diamond Arena), and a
chip club cannot carry `is_platform`. The named-club allowlist is the
sanctioned door, as it was for Deep Stack Society (`20260901091759`).

## What Changed

`20261015032740_the_lightning_pilot_club_is_a_house_board.sql`, one transaction:

- `fn_ca_house_board_allows_automation` keeps its derived `is_platform` half and
  the four legacy boards and names the pilot as a fifth. Every other club still
  refuses a horse, asserted on apply.
- 72 existing active horses join as ordinary active players through the same
  membership source and columns `fn_join_club` writes.
- `fn_seed_horses_to_floor` funds each to 40 chips from the pilot's own treasury:
  2,880 of 99,700, one declared `horse_funding` leg per horse, all or nothing.
  The apply asserts 72 funded horses, no other human, one owner, treasury
  96,820, and no Lightning state change.

`scripts/ops/prepare-lightning-private-pilot.mjs` now accepts the owner plus
admitted horses (active players whose profile is a horse) and still refuses any
human, staff role, pending row or unreadable profile. Its receipt reports
`owner_and_admitted_horses` and the count.

## Pinned

`tests/the-arena-is-one-club-and-it-mints-nothing.law.test.ts` pins the ruling,
the five named boards, the refusal of every other club, the funding path and
that nothing activates. The setup script has five new cases (51 pass).

## Stage Operator

`scripts/ops/lightning-pilot-stage.mjs` and the dispatch-only
`lightning-pilot-stage.yml` (main only) perform one ROLLOUT.md step per run on
the two named private pilot games, through `fn_lightning_operator_control` as
the authenticated service owner:

- `shadow`: Stage 1 (`set_flag lightning_shadow_matcher`, `set_matcher_version
  m1-port shadow`, `set_worker_mode shadow`, `enable_lightning`).
- `form`: Stage 2 (`set_worker_mode form`).
- `drain`: the retreat. `report`: read only.

Readiness is read and recorded first; `no_go`, a blocking reason or any reason
the stage does not exist to produce stops it. Every target is resolved and
gated before the first action, so one size is never half-staged (a test caught
the first draft acting on the 6-max before discovering the 9-max was missing).
Request ids derive from the dispatch's operation id, so a retry replays. 8 node
tests.
