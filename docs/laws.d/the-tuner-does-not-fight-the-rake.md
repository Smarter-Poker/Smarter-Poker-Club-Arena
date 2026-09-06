# server/src/services/TheTunerDoesNotFightTheRake.law.test.ts

`HorseSelfTuner`'s regression rule judges the rake-adjusted result (`net_bb + rake_bb`, rake accumulated at settlement with `allocateWeightedShareCents`) and touches only a horse under the fleet's first quartile of 1,500-hand horses; leak gates are rates per reviewed hand. On 2026-09-04 the raw rule regressed 221 of 383 horses because the fleet's -32 bb/100 was the rake. `fn_audit_tuner_health` is the production twin (critical over 40% regressed in a night).
