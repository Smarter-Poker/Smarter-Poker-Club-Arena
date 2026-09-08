# Reduce the CPU cost of Omaha evaluation

The live engine cec6eb4d measured 103.13% container CPU on September 8. Separate event-loop samples showed 434 ms and 223 ms effective median delay. The latter scrape also reported 606 ms sampler lateness. These are distinct readings, not a single latency distribution. Existing production profiles recorded in EquityLoadGovernor identify horse hand evaluation as a major main-thread consumer. No new production CPU profile was collected for this change.

Omaha high evaluation repeatedly invokes the general best-five-of-N evaluator on exactly five cards, up to 150 combinations per player per simulation for PLO6. That repeatedly clears three scratch arrays and scans all ranks. A specialized standard-deck five-card evaluator uses rank bit masks and leading-bit extraction instead. Both full-board and partial-board Omaha high callers use it. Short deck, Holdem best-five-of-seven, Omaha low, card dealing, strategy parameters, and Monte Carlo iteration counts retain their existing paths.

The new implementation matched the original numeric score for all 2,598,960 distinct five-card hands. Additional differential checks covered 900 PLO4/5/6 hands across three-, four-, and five-card boards, preserving exactly two hole cards and three board cards. Governor and reservoir checks passed; chip-conservation tests passed across a fixed 10,000-hand corpus and another 1,000 randomized hands. Server TypeScript passed.

The committed diagnostic `server/scripts/benchmark-omaha-five-card.ts` compares the old combination loop against the optimized production caller. Run from server with `npx tsx scripts/benchmark-omaha-five-card.ts`. On the development Mac, four passes of 10,000 PLO6 evaluations measured reference 297/289/289/287 ms and optimized 98/95/94/94 ms with identical checksums, approximately three times faster for this calculation. Timing is diagnostic, not a shared-runner CI assertion.

This does not establish a threefold whole-engine speedup. Normal production deployment, event-loop measurements, and completion-to-deal timing are still required. The overall next-hand delay remains open until those measurements meet the target.
