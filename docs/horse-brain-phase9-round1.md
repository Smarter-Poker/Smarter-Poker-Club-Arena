# September 11 parity-backfill update

The independent certification now constructs production refunds/pots separately from reference inputs and includes exact-card wrap/gap, blocker/redraw and counterfeit facts. Reference layers with identical eligibility are independently coalesced before odd-chip allocation. See [the parity acceptance manifest](./horse-brain-phase8-10-backfill-acceptance.md) for remaining proof gates; this source update is not a publication claim.

# Horse Brain Phase 9: basic Omaha reference functionality

The user authorized basic functionality per initial round on September 11,
2026, with deeper rounds later. Phase 8's implemented shadow foundation is
sufficient to proceed; its unsuccessful promotion experiment is not erased.
This branch starts at main `4f25710cb661c4889b4d5228d685e7e79991b9e0`.

## Initial-round scope

- Reusable independent high and eight-or-better low evaluation for PLO4,
  PLO5, PLO6, PLO8 and FLO8, enforcing exactly two hole and three board cards.
- Independent contribution layers, refunds, eligibility, high/low splits,
  ties, board allocation, chip units and pot-limit ceilings.
- A bounded seeded equity calculator with explicit weighted opponent
  combinations or uniform ranges, one shared deck, dead cards and up to three
  boards. Exact river enumeration where bounded; sampled earlier streets.
- High, low, whole-pot share distribution, scoop and quarter-or-less rates,
  conditional side-pot equity, board covariance and explicit uncertainty.
- Factual Omaha hand components and conservative availability of guarantees.
- An executable offline evidence entry point and differential/golden tests
  against the existing production evaluator, settlement and legality helpers.

The reference implementation must not import production scoring, settlement,
shuffle or combination helpers. The comparator may import both implementations.
Reference and equity calls are local analysis, outside the live decision clock.
This round also repairs a reproduced controller defect: tournament pots must
split across boards in whole chips before their high/low and tied winner
allocations. Cash keeps cent units. The split respects the configured indivisible
asset. Current source admission includes all five Omaha variants in Diamond
cash and compatible tournament tables. The table loader separately requires
the corresponding arena cash/tournament switch to be enabled; this phase's
local tests do not establish an installed switch, a live table or publication.
The original September 11 plain-NLH-only note described an earlier boundary
and no longer describes current source. This phase changes settlement
arithmetic, not strategy, and has no database or release-infrastructure changes.

## Functional gate

Inputs reject malformed cards, duplicate physical cards, unsupported variants,
incompatible ranges, invalid pot geometry and exhausted work bounds. Outputs
declare exact versus sampled results, sample count, method, seed and completion.
Sampled minima are never called guaranteed equity. Whole-deal rejection must
condition weighted opponent ranges jointly without seat-order selection bias.
Awards and refunds must conserve all contributed units in deterministic golden
and randomized comparisons. Existing Omaha/hi-lo/fixed-limit tests stay green.

Basic functionality is complete when the implemented calculator executes
successfully through the local evidence command, with independent reference
comparisons, focused tests and a full server gate. This progression label is separate from release
status and any external certification claim.

The basic round passed on September 11, 2026: ten executable evidence scenarios
completed with zero conservation error; the full server suite passed 9,840 tests
(691 files passed, one file and 145 tests skipped under their existing gates);
and the server TypeScript build passed. The new 47 assertions/tests include
independent scoring and settlement comparisons, weighted joint ranges, CLI
batch behavior, tournament/cash allocation and the Diamond capability boundary.
This establishes local basic functionality. Publication is a separate status.

The September 14 source backfill extends the independent multi-board controller
matrix to PLO5/PLO6 with their actual five/six-card deals, including the full
cash seat ceilings, folded money, short all-ins, side pots, refunds and both
cent/whole units. Direct maximum-seat PLO4/FLO8 oracle fixtures use literal
economic expectations for a unique royal and a separately constructed high/low
split. These are bounded local fixtures; the injected settled-state comparisons
do not prove the prior betting trajectory or natural live Horse usage. Actual
The regular `Phase9OmahaRitIndependent.test.ts` suite now compares the actual
RIT consent, deck/runout, refunds, pots, high/low awards and completion with the
independent reference in 60 cases: all five variants × standing board prefixes
0/3/4 × two/three runs × cent/whole-Diamond cash. Another 20 cases verify the
actual configuration refuses tournament and two-seat RIT. The related 127-test
batch and TypeScript check pass. The balanced all-in contribution state remains
injected after legally reaching the standing street; this is not proof of the
prior betting trajectory. Full-seat, nonzero rake/BBJ, event-to-offer dispatch,
UI transport, persisted history, worker usage and installed switch/natural-use
proof remain open. The oracle's one-billion-unit per-player contribution ceiling
also remains explicit; these bounded cases do not expand that domain.

## Running the basic evaluator

From `server/`, run `npm run horse:omaha-evaluate -- --output=/absolute/new/directory`.
The default ten scenarios exercise every supported variant, exact weighted river
ranges, dead-card conditioning, quartering, side pots/refunds, shared-flop runouts
and two/three-board bomb pots. No environment file or network access is needed.

The command writes `scenarios.json` and `evidence.json` once to a new directory.
The latter records source commit and file hashes, input hash, seeds, work limits,
methods, completed samples, share distributions, uncertainty and conservation.
Use `--input=/absolute/scenarios.json` to evaluate a custom batch in the emitted
input format (at most 16 scenarios and one megabyte). Every player range can be
an explicit weighted combination list or uniform unknown cards; equity describes
the named hero participant, conditional on all those ranges. Guarantees apply
only to complete exact river enumeration within the supplied ranges. They are
not claims about opponents outside those ranges or about strategy strength.

An incompatible joint range, exhausted sample-attempt bound or interrupt is
reported incomplete and returns a nonzero exit code. Invalid scenarios fail
without a successful evidence report. Existing directories are never reused.

## Later rounds

Licensed-solver procurement/bakeoffs, vendor accuracy and production-use rights,
calibrated wraps/domination/redraw models, exhaustive preflop/turn range solving,
live strategy integration, external certification and strength promotion remain
later-round work. No vendor corpus is fetched or scraped in this round.

## Rule references

The exact-card and low-qualification reference follows the published
[Omaha rules](https://www.pokerstars.com/poker/games/omaha/) and
[Omaha high/low rules](https://www.pokerstars.com/poker/games/omaha/high-low/),
checked September 11, 2026. Odd-chip and multiboard allocation use Club Arena's
declared house contract and are compared separately with its controller.
