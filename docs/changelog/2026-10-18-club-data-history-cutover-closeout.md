# Club Data continuation: history, Report access and screen speed

The Report history from September 16 through October 17 was already rebuilt
by #7319. Production readback on October 18 found zero differences across
108 club/day totals (cash/tournament fees, cash buy-ins/cash-outs, tournament
winnings), all player net rows, and both cash/tournament player sets.
The eight Club Data production browser checks on client 6afa6822 passed;
the enclosing run 39082009441 failed on separate Cashier checks.

The speed migration from #7325 was merged but never installed. The existing
Apply Merged Migration run 39132974675 installed version 20261017221938 at
13:46:37 UTC, committing in 222 ms. Its recorded SQL and live function body
match the source exactly. JAQK's closed 14-day window (September 30 to October 13) returns the same totals and same 200 ordered rows through the fast and
full filtered paths: 1.33 s versus 4.91 s in the first installed measurements.
Both public addresses already serve client 6afa6822, which contains #7319
and #7325. No engine change is involved.

A remaining connected defect affected the Report's rake breakdown:
`fn_ca_rake_by_agent` uses `ca_club_rake_daily`. Six closed club/day cash-rake
rows differed (JAQK and SHARK on September 16, September 17 and October 17).
Recomputing September 16-17 with the installed calculator changed their
split again, because its missing-attribution fallback reads the CURRENT seat
or latest funding receipt, including a receipt after the hand.

Migration 20261018134944 retains the per-hand attribution first, then reads
the latest funding receipt at or before the hand, then the latest seat joined
at or before the hand, then the existing union fallback. This is the same
historical rule the Club Data fact seed already uses. No wallets, ledgers,
settlements, scheduled jobs or live games are changed. The explicit closed-day
rebuild uses the existing operator function after installation and readback.

The maintained native PostgreSQL harness now demonstrates both failures with
the old calculator, installs this migration, then proves both cases pass.
The same scenario covers decimal contributions, malformed contribution data,
rake conservation and precedence of the hand's own attribution.
