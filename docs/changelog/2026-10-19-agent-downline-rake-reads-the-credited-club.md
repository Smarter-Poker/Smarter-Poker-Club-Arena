# Agent Downline Rake Reads The Club The Rake Is Credited To

**Today read 0.00.** The agent Downline Rake panel (`fn_agent_downline_rake`, `fn_agent_downline_rake_summary`) read days not yet rolled up from `rake_records` under the member club. Union play files each hand under the union club, while the rake is credited to the member club in `rake_attributions`. So today showed 0.00 for an agent whose downline had already paid about 1,650 in cash rake. Closed days came from the nightly rollup, which already read `rake_attributions` by the credited club, so closed days and today disagreed.

The live part of the report now reads the same rows, with the same launch-accounting rule, as the nightly rollup and the fee ledger (`ca_club_rake_daily_user`). This is a display-only report: no other database function reads it, and commission calculation and payment are unchanged. It is cash-game rake only. Tournament fees are not included, so it is not the roster's Downline Fees total. Its "hands" are the hands that took rake from the player. The panel now labels both figures.

**The union summary disagreed with the list.** `ca_club_members_summary` chose the viewer's role across the whole union, while the roster list and its live channel require membership of the exact club. An agent of a member club opening the union saw "agent, can view financials, 267 members" over an empty list. The summary now uses the same exact-club rule; platform admins and union overseers keep their access.

Proof (production, rolled back), for one JAQK agent: today 0.00 became 1,670.02, which equals the fee ledger's 1,670.02. The last 7 days went from 10,386.40 to 12,056.42, which equals the ledger's 12,056.42. A window starting mid-day went from 0.00 to 3,273.50, which equals the attribution rows. Each read took about 260 ms. For the JAQK agent on Midway Union, the summary now returns nothing, which agrees with the empty list. The union overseer still sees 267 in both the summary and the list.

Install: `supabase/migrations/20261019145600_agent_rake_funded_live_and_summary_exact.sql`.
