# The original consumer understands bounded capacity and scan continuation

**Files:** `server/src/services/HorseAdaptiveJournalRetention.ts` and `server/src/services/horseAdaptiveJournal/loop.ts`, with their existing tests.
**Before lines:** adapter 12–48; serial-loop deadline selection 249–259.

The adapter accepted only v1/v2, capped v2 at 25 hands/membership registrations, and the original loop inferred continuation from retired counts. Production qualification certificates arrived at 733.5 per minute over the observed 18:26:43–18:52:58 interval, exceeding the old theoretical 300-per-minute cap even before serial work delays. Protected attempts also need a truthful continuation witness.

The maintained adapter now accepts literal v3 with at most 250 hands/scans/membership registrations, 250×4096 observations, 100 completed-work rows/batches and 1000 expired statistics. It rejects missing flags, unsafe counts and retired counts greater than attempted hands. The existing serial owner uses explicit retirementPending/budgetReached flags for the five-second continuation deadline; a completed protected-only pass keeps its slower deadline. v1/v2 compatibility and independent original-owner deadlines remain supported. No new job or loop exists.

**Verified:** re-read the four changed source/test files and inspected their diff. Three connected regression assertions failed before the source change; all six connected suites passed afterward, 75 tests. Server TypeScript compilation passed. Database/native qualification and actual sustained production throughput have separate evidence and are not implied by these consumer tests.
