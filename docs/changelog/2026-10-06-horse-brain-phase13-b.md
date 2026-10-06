# Horse Brain Phase 13 P13-B: the joint economics checked against the real controller

P13-A gave the joint multiway owner one bounded opponent raise on turn and river decisions. P13-B checks that every branch of that tree, and of the one-response model it keeps for preflop and flop, pays exactly what a real hand pays.

- New rigged-hand harness: a real HandController deals fixed cards, so the same hand can be replayed down every branch the joint model enumerates. The controller posts the blinds, antes, straddle and bomb antes, decides legality and turn order, returns uncalled money, splits the boards, takes rake and the BBJ drop and pays the winners.
- 12 controller cases, 407 distinct lines, 1,112 terminal comparisons: for every branch the model's payout to every seat, its rake and its BBJ drop equal the controller's, the joint terminal owner run on the controller's final state agrees, and the independent benchmark reference bounds every payout. Where the one raise slot belongs to the first responder, the row's expected chips, rake and BBJ equal the controller's settlements weighted by the model's own raise probability.
- Covered crossings that no suite exercised before: a raise that creates a side pot with a different winner, a hero-ineligible side pot over hero's all in, refund before fee on an uncalled raise with BBJ and a dealt-count rake tier, the rake cap binding only on raised lines, a quartered low and a tied high on a no-low board in a PLO8 bomb, FLO8 sixths and scoops, tournament and Diamond whole units with odd chips across two and three boards, a one big blind individual ante with a straddle, a big blind ante at the one big blind boundary, a board downgrade from three requested to two dealt, and no flop no drop on preflop fold-outs.
- One coherent distribution reaches Phase 7: for a PKO bomb river, Phase 7 and the Phase 13 bridge both receive the very same joint samples, every player's identity and stack match the controller, and Phase 7's chip EV, win, knockout and bounty values equal an independent per-sample recomputation.
- Timed rake, a one-player cap tier, tournament rake and a Diamond BBJ drop are refused by name before any ranking.
- No defect reproduced, so no source changed. Seven deliberate mutations of the settlement, deduction and bridge code are each caught.
- Still shadow only. Nothing selects; no live decision can change.

Record: [horse-brain-phase13-b-economics-2026-10-06.md](../horse-brain-phase13-b-economics-2026-10-06.md).
