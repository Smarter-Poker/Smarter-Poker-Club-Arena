# V31 feature subsets avoid repeated SQL planning

R6 built all 107 cells, but the bounded seal timed out in the river feature key's best-five subset loop. Every five-card subset planned separate SQL queries for ranks, rank multiplicities, suits and hole-card contribution.

The feature function now uses bounded arrays for those operations and its other small rank/suit queries while keeping independent best-five enumeration and every output byte unchanged. The migration pins its exact preimage and preserves strictness, volatility, search path, owner and permissions. Build, seal, heldout scoring, promotion, inputs and quality thresholds are unchanged.

The existing PostgreSQL 17 gate compares the previous and new functions over all 1,326 hole-card combinations on 16 flop, turn and river edge boards, including wheels, flushes, quads, paired boards and every hole suit. It requires exact equality including blocked-card NULLs, malformed-input refusal, preserved caller definitions and a measured reduction in execution time. The maintained TypeScript parity vectors also execute the optimized SQL function in the same private gate. The unchanged certification and refusal fixtures then run with the optimized function.
