# Cashier Canary Directory Readiness

Production run 34447563111 tested `c50dc3abd9` and passed the Cashier database
contract and Trade/reconciliation case. The directory case right-clicked as soon
as the tile was visible, then failed to find its menu within five seconds.

`ClubQuickLinkTile` exposes `aria-haspopup="menu"` only when eligible wallets
exist. The same condition enables right-click, hold, and keyboard opening.
Visibility alone does not promise that capability while membership data loads.
The canary now waits for that existing advertised capability, using the same
30-second live hydration budget as the reconciliation check, before right-click.
The desktop menu, mobile hold, menu items, dismissal, and viewport assertions
remain unchanged. A directory that never becomes available still fails.

Independent review approved the two-line change. `npx tsc --noEmit` exited 0;
Playwright `--list` collected both Cashier cases without executing production
setup. No runtime, gesture queue, cron, database, or timeout-policy change.
The saved logs do not show the tile's exact state at click; this corrects a
proven missing test precondition without claiming a proven runtime regression.
Subsequent normal production acceptance must execute the repaired spec.

Release and fleet qualifications: `docs/audits/2026-09-10-realtime-acceptance-follow-through.md`.
