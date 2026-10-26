# Every horse brain phase is active (owner order)

Dan, 2026-10-26: "FORCE ACTIVATE EVERY PHASE NOW WITHOUT QUALIFYING".

## What was off

Phases 8 (tournament postflop), 10 (PLO4 pack), 11 (PLO5/PLO6/PLO8 packs),
12 (Short Deck, Pineapple, FLH, FLO8 packs), 13 (joint multiway) and 14
(river corrective kernel) were computing every decision in shadow and then
handing back the reference decision. A pack could only make live decisions
through a protected release selection naming a qualification file that had
measured the exact running code. Every brain change since October 17 moved
the code digests, every selection was set back to null to wait for
requalification, and none had been requalified. Live telemetry showed
`phaseN_authority_worker_*_unselected` and `phaseN_baseline_retained` on every
decision. Phase 14 had never been switched on.

## What changed

- `server/src/engine/HorseOwnerForcedActivation.ts` records the order and
  issues an authority for the RUNNING code (its own policy digest, pack
  version, domain and contract digest) whenever a phase has no admitted
  release selection.
- Each phase has one live admission (`admitHorsePhase8LiveAuthority`,
  `admitHorsePhase10LiveAuthority`, `admitHorsePhase11LiveAuthority`,
  `admitHorsePhase12LiveAuthority`, `admitHorsePhase13LiveAuthority`,
  `admitHorsePhase14LiveAttachment`). The decision worker, the main-thread
  gates and offline replay all use it, so the worker and the engine admit the
  same authority and the acceptance recheck passes. A committed selection still
  wins, and a committed withdrawal is still honoured.
- Phase 13 is admitted on one, two and three boards.
- Phase 14 gets an owner-issued catalog: the cash river call/fold kernel in
  every cash game, and the tournament river kernel in every hold'em tournament
  format (winner-take-all for spins, the closed heads-up ladder for MTT, SNG and
  heads-up SNG). No tournament kernel exists for the other games' tournaments.

## What did not change

- Each pack still only decides the games and formats it was built for: the
  PLO4, Omaha, remaining-variant and joint packs decide cash games, and
  tournaments stay with the Phase 7 utility owner and the Phase 8 continuation,
  both active. Diamond whole-unit cash stays outside the joint pack, as its
  contract says.
- Every owner rule in `wager_rules` (the paired-board fold, the hold'em premium
  rule, the full-pot sizing and the river nuts raise) runs after every pack and
  the corrective kernel, so none of them can be undone by a pack.
- The safety sentinel and explicit withdrawals still turn a phase off.

## Pinned

`server/src/engine/HorseOwnerForcedActivation.law.test.ts` drives the real
decision worker with its production wiring through PLO4, PLO5, PLO6, PLO8,
Short Deck, Pineapple, FLH, FLO8 and NLH cash hands. It asserts each game's
pack runs as candidate (never shadow), every decision passes the engine's
receipt check, and every applied decision passes the main-thread gate. With
the order switched off the same test fails on every game.

The 2026-10-22 maniac-pressure laws that asserted the live gates were
unselected now assert that the release selections are still null (so a future
requalification is still a reviewed change) while the live gates are usable
under the order.
