# MTT creation validates the ladder that will be played

Scheduled creation accepted zero big blinds, malformed durations, decreasing blinds and text break flags. The manual database creator only required a nonempty array and did not set speed metadata. These defects could publish unusable structures or describe a turbo as standard.

The engine and manual/saved-schedule payloads share a creation validator. A database trigger enforces the same contract for new MTT rows, changed structure/stack values, and conversions into the MTT format. It derives speed from the actual opening clock. Existing funded ladders, stack sizes, entry prices and unrelated progress writes are preserved; short formats retain their own contracts.

Eight actual scheduled-creator regressions reproduced the problem. Native PostgreSQL qualification runs the unchanged current outer and governed creators with structural/authentication stand-ins, checks the same validation vectors as client/engine, preserves all 23 captured live active structure/stack shapes, and proves rollback and metadata behavior. Full service/tournament tests and server typecheck pass. Production installation, protected CI, engine/client release and full live lifecycle verification are separate acceptance facts, recorded in the MTT audit handoff.
