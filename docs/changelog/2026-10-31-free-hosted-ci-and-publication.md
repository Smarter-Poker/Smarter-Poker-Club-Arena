# Free hosted CI and publication

The owner limits ongoing Actions spend to roughly $300-$500 per month. All Club Arena jobs now select standard GitHub-hosted Ubuntu runners, which are free for this public repository. This replaces paid runner labels, including the native profile toggle, without changing required checks, job conditions, commands, matrices, worker limits, timeouts, permissions, concurrency, isolation or publication authority. Component-native smoke retains Ubuntu 24.04.

Existing successful standard-runner evidence supports the route: CI run 40790620892 passed compiler, build, client tests and browser suites; publisher 40789464467 passed build, tests and origin publication. Normal run 41181688657 passed all four server and four PostgreSQL shards on ubuntu-latest and all six required contexts after the native profile change. Current browser sharding, CPU worker clamping and disk reclamation remain.

Runner contracts are updated to require standard hosted runners and refuse paid or self-hosted substitutions. Current source manifests are refreshed without rewriting historical qualification. No benchmark or manual test workflow is dispatched; normal required submission and publication checks remain mandatory. Historical timing supports migration but does not certify a future revision.

Expected new runner compute charge for these workflows is $0 while the repository remains public and uses standard runners. This does not erase accrued charges or guarantee that storage and other repositories cost zero.
