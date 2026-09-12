# Continuation work audit

This follow-up addresses the remaining budget refusals recorded by the six-objective actual-controller league on the natural-repair source a48ce8b8bc50a60214934ceb1f67c3e80f0fa851. It preserves the four-millisecond deadline, sample counts, exact chip/pot rules and all promotion gates.

Twenty-four captured offline controller decisions across SNG, MTT, Spin, satellite, PKO and mystery tournaments reproduce the expensive paths. Source and compiled-code CPU profiles identify repeated pot partitioning, hypothetical seat/card copies and future-hand refund sorting. Profiler timings are diagnostics and are not claimed as final latency evidence.

The hypothetical-call helper now shares the unchanged read-only seats and copies only the changed caller. The canonical pot partition rounds each seat's unchanged investment once before evaluating its levels. The future-hand refund finds the largest two wagers without allocating/sorting a fresh seat array; static hero and opponent identities are prepared once for its later streets.

All 10,000 pot partitions and 59,996 hypothetical calls match the previous implementation exactly with frozen caller inputs. Independent hand conservation checks cover 11,000 randomized hands. The first focused batch passes 76 tests, including short caller eligibility, folded chips, individual and shared antes, and Phase 8/9 regressions. A separate 5,184 funded-future-hand comparison preserves every result. Final integrated tests, actual-controller completion and protected publication remain required.

No activation, promotion, production hand or chip mutation is introduced. Existing failed natural windows and negative benchmarks remain evidence.

The large-field ICM workspace now sanitizes only local trial rates into temporary storage while still validating every remote stack and counting its live state. All 3,456 complete estimate/error/sample results match the prior estimator across 11–1,000 players, 2–10 local seats, payout curves, bounded/full trials and invalid-local/tolerated-remote numeric boundaries. The additional shared Phase 7/8/ICM batch passes 106 tests. The first isolated 24-case timing improves real-clock completion from 2,074/2,400 to 2,331/2,400.

The expanded 36-case matrix preserves every complete Phase 7/8 result and improves real-clock completion from 2,118/3,600 to 2,471/3,600. Fixed-clock worst p99 falls from 17.297ms to 12.420ms, but real-clock worst p99 remains 4.584ms. Large-field timing therefore remains an open acceptance gate. Derived 200/1,000-player Spin inputs are stress cases, not supported production Spin configurations. Source, populations and the failed timing observations remain recorded; this repair does not establish full performance or natural-use certification.
