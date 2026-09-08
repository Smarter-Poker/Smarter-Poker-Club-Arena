# Cashout Departure Receipts

A null or malformed cashout response with no transport error was treated as zero chips successfully cashed out. processLeavePending then returned the user to settlement, which removed disconnect, time-bank, straddle and chip-continuity tracking without proof of departure. markSeatAsLeft also swallowed failures before callers removed tracking.

Both helpers now validate the existing locked SQL receipt. Invalid results retain pending-player tracking through onFailed; markSeatAsLeft rejects so awaiting callers cannot continue cleanup. Confirmed zero-stack and no-active-seat results remain successful, and the voluntary leave clock remains enforced. No wallet mutation or new cashout SQL path is introduced.

Regression verification: 23 failures on the old code; all 28 receipt tests pass after the correction. Five focused suites total 74 passing tests, including chip continuity, pending rebuys and tournament ghost seats. Server TypeScript passes. Runtime adoption must be checked separately after the scheduled engine cutover.
