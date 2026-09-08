# Deliver Mini recovery without the old integration revert

PR 3517's older integration commit dc2eae07e reverted the offline subscription coalescing change from PR 3548. The Silent Revert Guard correctly blocks that history. This branch starts from fresh main and reapplies only the six Mini payout and recovery files. EngineStateClient and its recovery test are byte-identical to main, verified with git diff.

Mini payouts use the existing durable jackpot operation, preserving kind, tier and metadata for replay. Transient failures remain queued and emit the pending outcome; explicit business refusals terminate. Recipient lists are deduplicated before table event/cache updates. This does not introduce a new repair loop.

The 42 focused Mini/payment recovery cases and server TypeScript pass on this clean application. Earlier full integration verification passed 6,495 tests and failed an unchanged timing benchmark, which passed alone; this is not a claim of a clean full run. Normal hooks and required CI must pass on the new head before release. This replaces the Mini implementation delivery attempted in PR 3517 and preserves the newer reconnect fix.
