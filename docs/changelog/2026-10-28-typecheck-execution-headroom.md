# Preserve TypeScript job execution headroom

PR #8445 run `40726879893`, job `122952418582`, passed its compiler, chip-journal native qualification, all repository guards and cleanup. GitHub still cancelled the check after 15 minutes 3 seconds because its outer job budget was 15 minutes. Checkout took 2 minutes 42 seconds, chip-journal qualification 7 minutes 13 seconds and fleet evaluation 1 minute 50 seconds. The latest successful equivalent, run `40714001791`, already required 13 minutes 45 seconds.

Increase only the existing `typecheck_compile` outer budget from 15 to 20 minutes. No check, condition, assertion, financial source, suite deadline or runner changes. Refresh only the six current workflow fingerprints and add an explicit source-binding audit; retain all historical evidence and qualification statuses. Hosted qualification on the corrected exact head remains required.
