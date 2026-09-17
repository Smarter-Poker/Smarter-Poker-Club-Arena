# Horse policy component accounting

The executable outer graph previously retained its node timings only in the returned private witness. The normal telemetry flush could not distinguish node invocation, completion, failure or a retained action. HorseLogic now opts the graph into the existing live telemetry gate, and every entered node records its actual outcome and successful component duration.

Only the eight registered outer nodes can produce keys. The first node produces a reference action; subsequent nodes record changed or retained actions. An invoked node may be disabled or outside its candidate domain, so these counts do not replace each policy's eligibility, firing and unavailable receipts. A failed node records failure without inventing successor completions or latency. The first clock read is now inside the failure boundary, so a clock exception also closes the executing state correctly.

`HorseLogic.decideInternal` supplies the live gate to `HorsePolicyGraph`. The graph calls the existing memory-only `noteFire` and `noteDecisionMs`; `BrainTelemetryFlush` publishes them through the existing bounded atomic batch contract. Offline decisions remain silent. No cards, identities, distributions or random seeds are added to public counters. Policy choices and budget gates are unchanged. Component timing measures the owner's execution and validation; the existing whole-decision timer also includes instrumentation overhead.

Validation:

- Four newly added regressions failed before implementation; the existing offline-silence case passed.
- Initial focused checks passed 64 tests across five files. A subsequent real HorseLogic owner-exception test covers the safety-fallback path as well.
- A counterbalanced real-clock comparison used 36 cash variant/street cases, 20 warmups and 100 measurements per case. Across 3,600 measured paired decisions, actions, wager amounts, think times and final RNG states matched. Aggregate p50 changed from 0.349ms to 0.355ms; p99 remained approximately 3.285ms. The baseline uses the exact prior HorseLogic and graph sources from 92fe5ea8c294361b998f93882c94570703d3fe0a.
- Final server TypeScript build passed. The full suite passed 12,760 tests with 157 skipped; 842 files passed and 1 skipped.

These measurements cover the declared one-board cash reference paths with other phase policies off. They do not certify Phase8 latency, the full fleet or every policy intersection. This change supplies component execution evidence, not the still-required full internal distribution graph, complete durable decision ledger, restart replay, daily silence alarms or natural deployment proof. No schema or policy activation changes are included.
