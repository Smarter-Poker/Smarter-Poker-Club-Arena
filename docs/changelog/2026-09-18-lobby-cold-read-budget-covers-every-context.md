# Each lobby test owns its cold-read budget

The client browser check in production run 35327744756 stopped its first lobby
shell case at the inherited 30-second test deadline. The shared settlement wait
allowed 45 seconds, caught the resulting cancellation, and attempted to register
the invitation handler on the page Playwright had already closed. The later
game-type case alone had a 75-second deadline; its sibling cases had the same
cold-read requirement without that budget. Both source files are unchanged
between the successful d4731272 baseline and 3c12a919.

The Club lobby group now shares the existing 75-second composition: up to 45
seconds for populated rows or a genuine empty state plus the existing 30-second
route/action allowance. A failed settlement wait propagates directly. Global
timeouts, retries, application behavior, assertions and conditional skips are
unchanged.

The existing production profile/preflight regression checks the enclosing group
budget and refuses a caught settlement failure. It fails against the preimage.
Final affected checks and actual Playwright registration evidence are recorded
in the owned delivery evidence; hosted browser publication proof remains required.

No database installation or engine replacement is required by this test repair.
