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

## Protected delivery continuation

PR #8182 merged as `4a30c966e150f6edc253ec9c8ccc9e007ace3fea` after
the required engine, accounting, client and type checks passed. The owner's
Detlegend continuation requests publication and activation for all horses,
continuing the supplied immediate-activation handoff. The bounded entry
`2026-10-26-detlegend-all-phases-now` anchors the existing release transaction
to that protected merge. It expires within six hours and grants no further
window once a containing release is serving. The existing maintenance
certificate, drain, database freeze, rollback reserve, thaw and rolling-hour
limit remain authoritative.

Local recovery verification at the original PR head passed 538 activation and
authority tests, 20 exact-replay tests, server TypeScript compilation, and 21
disclosure/release-contract tests. The published Club Arena disclosure assets
contain the AI-opponent sentence; the earlier undisclosed-opponent audit is
historical. Before activation, the live roster held 1,000 distinct active
horses and release-bound telemetry still reported unselected authorities and
baseline retention. These are baseline observations, not post-release proof.

Merge, staging, sealed activation and natural accepted phase-use evidence
remain separate delivery milestones. This entry does not claim measured
strategy strength or that every phase applies to every game or hand.
