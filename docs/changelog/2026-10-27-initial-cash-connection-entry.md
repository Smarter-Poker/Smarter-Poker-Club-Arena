# Cash View Table Waits For Acknowledged State

Implementation status recorded October 27, 2026: the client correction is in open [PR #8312](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/8312), source head `6035f8c0ed179779e02be958d87bed90beb4cde7`. Required hosted qualification, protected runtime merge, publication and live cash browser acceptance remain pending. This documentation records the implementation and local evidence; it does not certify a live release.

Cash View Table could mount an empty felt while the lobby's subscription was still awaiting authorization. The Details drawer navigated directly, and the row/card action started preparation without awaiting it. Multi-second admission latency therefore exposed the initial connection banner.

Both cash View actions now use the same preparation handler. It awaits the shared roster/token request and actual multiplexed SUBSCRIBED plus SNAPSHOT before opening the table. Refusal or timeout stays in the lobby with a warning. Selected warm state remains protected from speculative eviction until adoption or the existing expiry. Failed roster reads can retry immediately; pending UI state belongs to its current club scope.

The existing signed-out AuthGuard and tournament navigation are preserved. Banner grace, browser deadlines, engine protocol, database and financial behavior are unchanged.

## Regression Protection

- Delayed acknowledgment and missing state do not open a prepared entry; real acknowledged state does.
- Refusal, timeout, token sharing, failed roster retry and competing lobby warm-ups have focused coverage.
- The drawer callback regression fails on the original implementation and passes with preparation.
- A preservation regression verifies that unrelated busy actions retain tournament Details navigation.
- Final normal local pre-push checks passed, including 57 related test files / 699 tests, applicable source contracts and TypeScript compilation.

Production acceptance uses the unchanged live cash WebKit connection/recovery case, matching public client provenance and the approved Club Arena publisher. Actual delivery evidence is retained in the task checkpoint and provider receipts. Runtime change: [PR #8312](https://github.com/Smarter-Poker/Smarter-Poker-Club-Arena/pull/8312).
