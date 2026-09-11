# Daily Bonus entry request lifetime, September 11

The final realtime closeout review found that DailyBonusEntry could finish a
read after its host unmounted, mark an unseen popup as shown for the day, and
schedule a new retry after cleanup. An account change during a pending read
also inherited the old account's pending flag, preventing the new account's
first read. A table navigation or first-run suspension during the request
could still spend the popup before the host was eligible to show it.

Each mounted account now owns a unique pending-read token and its timers.
Cleanup retires the token, late responses cannot update the popup or release
a newer read, and the current host's route and suspension are checked again
before consuming the day. StrictMode cleanup and setup establish separate
owners. Current-request failures still report and retry through the existing
bounded policy. Claims, RPCs, reward amounts and daily caps are unchanged.

Seven mounted regressions fail against the unchanged component: late success
and failure after unmount, immediate account replacement, old completion
during a newer read, navigation to a table, host suspension, and StrictMode
replay. Baseline: 7 failed and 13 passed. With the repair, 74 tests pass across
the six Daily Bonus entry, service, sheet, hook and ledger suites.

The component remains mounted by the existing HomePage and AppLayout
hosts; no new public entry point or database migration is introduced.
ESLint and the full TypeScript/Vite production build pass. The build reports
zero media failures and behind-main=0. Publication evidence belongs in the
associated PR receipt.

This fixes the reproduced lifecycle defects. It does not by itself establish
the cause of the transient Daily Bonus network error observed in earlier
production smoke runs. That acceptance check remains intact. The wider
programme still requires its engine, physical-device/natural-event, and
detailed Supabase log/egress evidence before it can be called complete.
