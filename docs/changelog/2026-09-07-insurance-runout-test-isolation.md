# Insurance runout tests release their engine instances

The sequencing suite created a new ServerTableEngine for each case under the same table ID and never stopped it. Pending ten-minute offers and asynchronous runouts could outlive their test, while constructing the next engine replaced the process-global owner of that table.

Each case now has its own table ID. afterEach stops all engines created by the harness, including after failed assertions, and checks that they are stopped. Snapshot persistence is stubbed at that external boundary; real stop/dispose and runout dispatch remain in use. The unused sleep helper is removed.

The existing insurance/RIT ordering assertions and wait budgets remain. TypeScript stripping parses the updated test locally; full engine behavior is left to repository CI because the complete server dependency installation is unavailable in this workspace. This fixes a demonstrated isolation omission; it is not yet proof that every observed timing failure is resolved. HorseBoardRanges and HorseV40Omaha latency failures remain separate.
