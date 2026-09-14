# MTT creation validates the ladder that will be played

Scheduled creation accepted zero big blinds, malformed durations, decreasing blinds and text break flags. The manual database creator only required a nonempty array and did not set speed metadata. These defects could publish unusable structures or describe a turbo as standard.

The engine and manual/saved-schedule payloads share a creation validator. A database trigger enforces the same contract for new MTT rows, changed structure/stack values, and conversions into the MTT format. It derives speed from the actual opening clock. Existing funded ladders, stack sizes, entry prices and unrelated progress writes are preserved; short formats retain their own contracts.

Eight actual scheduled-creator regressions reproduced the problem. Native PostgreSQL qualification runs the unchanged current outer and governed creators with structural/authentication stand-ins, checks the same validation vectors as client/engine, preserves all 23 captured live active structure/stack shapes, and proves rollback and metadata behavior. Full service/tournament tests and server typecheck pass. Production installation, protected CI, engine/client release and full live lifecycle verification are separate acceptance facts, recorded in the MTT audit handoff.

R23 installation01:03UTC: migration20260914005233 recorded as history20260914010322. New source hashes f1f0ec57f980e1df361abacfa9efa030 /79d841121011fb3fc55cb335ad8f3b21 /9b8471c860ac00afa814a6553135c95b match; trigger enabled and declared; existing creator source/owner/grants unchanged. Service access and browser denial verified. No historical tournament row was rewritten. Final native11groups/59vectors,111engine-focused/2files and112client/4files pass; full5421/350 and serverTypeScript retained. ClientTypeScript26diagnostics match the preexisting missing-native-package baseline byte for byte. Source/served acceptance remains open.

## Required build gate and lossless preset encoding

Required CI34794727041 built the app but refused whole-app2601kBgz against the unchanged2600kBceiling. Server/client shards, typechecking and accounting passed; skipped live/native jobs are not credited. The full release remains open.

The existing client preset arrays now use compact small-blind/ante tuples and an import-free constructor. All135original levels preserve every field, key order, JSON serialization, duration and break; independent row identity is retained. The original data snapshot is recorded in tests/fixtures/mtt-blind-preset-preimage.json with its exact source hash. Existing Spin and payout exports are untouched. Isolated esbuildmodule measurement:10855→3312minifiedbytes,1397→867gzipbytes. This530bytegzip saving is not a full app gate pass.303client checks/10files pass; client typecheck diagnostics remain exactly the26existing missing-native-package baseline. Required proper-dependency CI must verify the full bundle.
