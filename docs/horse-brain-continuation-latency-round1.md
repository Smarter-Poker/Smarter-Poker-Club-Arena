# Continuation work audit

This follow-up addresses the remaining budget refusals recorded by the six-objective actual-controller league on the natural-repair source a48ce8b8bc50a60214934ceb1f67c3e80f0fa851. It preserves the four-millisecond deadline, sample counts, exact chip/pot rules and all promotion gates.

Twenty-four captured offline controller decisions across SNG, MTT, Spin, satellite, PKO and mystery tournaments reproduce the expensive paths. Source and compiled-code CPU profiles identify repeated pot partitioning, hypothetical seat/card copies and future-hand refund sorting. Profiler timings are diagnostics and are not claimed as final latency evidence.

The hypothetical-call helper now shares the unchanged read-only seats and copies only the changed caller. The canonical pot partition rounds each seat's unchanged investment once before evaluating its levels. The future-hand refund finds the largest two wagers without allocating/sorting a fresh seat array; static hero and opponent identities are prepared once for its later streets.

All10000 pot partitions and59996 hypothetical calls match the previous implementation exactly with frozen caller inputs. Independent hand conservation checks cover11000 randomized hands. The first focused batch passes76 tests, including short caller eligibility, folded chips, individual and shared antes, and Phase8/9 regressions. A separate5184 funded-future-hand comparison preserves every result. Final integrated tests, exact captured-controller comparisons, isolated timing, actual-controller completion and protected publication remain required.

No activation, promotion, production hand or chip mutation is introduced. Existing failed natural windows and negative benchmarks remain evidence.

The large-field ICM workspace now sanitizes only local trial rates into temporary storage while still validating every remote stack and counting its live state. All3456 complete estimate/error/sample results match the prior estimator across11–1000 players,2–10 local seats, payout curves, bounded/full trials and invalid-local/tolerated-remote numeric boundaries. The additional shared Phase7/8/ICM batch passes106 tests. The first isolated24-case timing improves real-clock completion2074/2400 to2331/2400; remaining timing tails motivate the final expanded field matrix.
