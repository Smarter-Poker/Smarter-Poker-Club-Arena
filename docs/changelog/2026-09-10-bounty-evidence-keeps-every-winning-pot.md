# Bounty Evidence Keeps Every Winning Pot

Phase 3 B02 correction, September 10, 2026. This does not close Phase 3.

## Confirmed Defect

The evaluator already emits exact perPotAwards alongside merged winner totals.
A player winning the main pot and a later side pot appears once in the merged
list, with the first potIndex. Settlement persisted that list and the pot
eligibilities, but omitted the later-pot award identities. A bounty on a player
whose last chips were in that side pot therefore had no accepted claimant.
The existing gate refused that incomplete evidence instead of paying a
different pot's winner, leaving the actual obligation unresolved.

The new service test reproduced the missing awards in the real logHandHistory
request. The isolated PostgreSQL baseline independently reproduced the missing
claimant using the installed reader body.

## Correction And Wiring

ServerTableEngineSettlement.postHandTasks passes the captured tournament
perPotAwards to logHandHistory. Each pot's exact awards are stored inside
hand_history.pots in the same atomic hand commit. Only public award identity,
amount, pot index, high/low marker and optional board are copied. Evaluated
cards are excluded. The merged winners and credited stack totals stay intact.

The engine attribution reader and fn_exact_tournament_knockout_claimants use
these exact awards when present. An empty, malformed, wrong-pot, self or
ineligible claimant cannot fall back to a merged first-pot record. Multiple
awards to one person produce one claimant. Equal claimant weights and the
current shared high/low treatment remain unchanged. Null pot indexes use array
position consistently in the engine and database.

The raw hand-row insertion authority uses jsonb_populate_record, preserving
the nested JSON. Read-only production inspection confirmed that insert helper
at MD5 b6eb532e40ba9820643616e70cdeb265. This check is source evidence,
not a production accepted-hand gameplay test.

## Database-First Rollout

Migration: 20260910053723_tournament_bounty_per_pot_evidence.sql.
The current reader was observed read-only at 2026-09-10 05:36:22 UTC.

| Authority                | Body MD5                         |
| ------------------------ | -------------------------------- |
| Required Existing Reader | 193de04c64c285ba0bf0cb20bb38c28d |
| Proposed Reader          | 6ead779d2261848571713f0220953082 |

The migration is one self-contained transaction. It refuses a changed
baseline, replaces the existing function in place, proves the final body hash
and service-only execution grants, and reloads the API schema. The fixed
search path is retained. Apply this reader before the engine rollout. It accepts old
complete pot histories, making the database-first order compatible. No table,
trigger, wallet mutation, payout rail, historical repair or manual backpay is
introduced. Previously incomplete historical hands are not reconstructed.

## Executed Evidence

- 122 server tests passed across the hand-history serializer, tournament
  stack receipt boundary, attribution gate, knockout attribution, activation,
  inventory/shuffle and actual showdown rules.
- One additional real ServerTableEngine.postHandTasks case passed, proving the
  per-pot snapshot reaches the hand commit even when next-hand memory changes.
- Server TypeScript passed.
- Seventeen isolated PostgreSQL 17 cases passed in
  scripts/dev/tournament_bounty_pot_evidence.py. They cover the pre-fix
  reproduction, later-pot scoop, replayed read, equal ties and high/low
  duplicates, old-history compatibility, malformed/outsider/self/wrong-pot
  refusal, null index and execution privileges. The private cluster stopped.
  Exact output is in the companion bounty-pot-evidence JSON.
- B06's separate 58 client tests still passed.

The first PostgreSQL startup needed LC_ALL=C on this Mac; the runner now sets
it. One initial test invocation had conflicting Vitest worker limits; the
executed runs used minWorkers=1/maxWorkers=2. These setup failures are not
counted as passing test cases.

These tests prove evidence capture and claimant identity, not a complete
funded reserve/collect/reveal/pay transaction. B01, B03 and B05 financial
acceptance remains open. B02 still needs release adoption and actual
accepted-hand evidence through the installed payer. B06 still needs
connected reveal/reload/payment replay acceptance. No production mutation or
deployment was performed by this lane.

## Dated Comparison

PokerStars Tournament Rules section 9.1 assigns the bounty to the winner of
the pot containing the eliminated player's final chips. Section 9.3 splits
tied relevant-pot bounties. Retrieved September 10, 2026:
https://www.pokerstars.com/poker/tournaments/rules/

Section 9.2's high-only rule for Hi/Lo differs from the current Smarter
recipient policy. Comparator divergence alone does not authorize changing
that contract, so this correction preserves current recipient sharing while
retaining the missing half identity for review.
