# Horse response and showdown audit, September 14

The reference policies now distinguish opponents who still contest the pot from opponents who can answer a new bet. Eight of nine new participant cases failed before the repair. Five further pure and actual PLO bet-calculation cases reproduced invented all-in fold equity or new wagers against a fully committed group.

Satellite coverage retains a large all-in threat after that player sits out. Bubble pressure requires a remaining responder and never treats an all-in raiser as a player that can be bluffed. A smaller live responder can still receive the existing side-pot pressure adjustment. These remain versioned reference heuristics, not proof of optimal tournament strategy.

The actual postflop heads-up overlay and think-time shaping now share the showdown population. Paired present/away all-in fixtures retain the same selected action, amount, overlay and think time for both heads-up and three-player pots.

`HorseMind.tableExploit` uses fold and thin-value reads only from players who can still respond. Its call-down summary retains all contenders' prior aggression, including an away all-in player's wager. Real imported opponent statistics prove both populations; historical ordinary multiway tests remain intact.

The actual PLO reference bet caller now supplies each opponent's response availability to `HorseEvEngine.evaluateSpot`. A nonresponding all-in holding forces whole-pot fold probability to zero. When nobody can respond, the calculator generates only check or fold/call candidates and applies no hypothetical initiative-loss penalty. Effective new-wager depth comes from responders. Paired live caller tests confirm that these inputs reach the real calculator and its computed candidates.

The V38 multiway arithmetic remains an aggregate heuristic. It does not become a complete side-pot outcome distribution from this repair; the Phase 13 joint sampler and pot-specific action model have separate qualification requirements. Full GTO, strength, natural workload and all-fifteen-phase acceptance remain open.

Verification: 106 focused tests in five files passed, the server build passed, and the final complete server suite passed 12,937 tests with 157 declared skips (846 files passed, one skipped). No release safeguards or sampling budgets changed. Evidence is preserved as `horse-participant-semantics-before.log`, `horse-allin-fold-equity-before.log`, `horse-participant-semantics-focused-final.log`, `horse-participant-semantics-build.log` and `horse-participant-semantics-full.log` in the task workspace. The latest native delivery documentation still requires installation and qualification; this source is not claimed published.
