# tests/a-money-audit-gets-the-time-it-declares.law.test.ts

A money audit gets the time it declares (2026-10-02): nine hourly and daily money audits open their pg_cron command with a separate SET statement_timeout (a set_config inside the running statement does not move its timer); rake-attribution-drift reads 2 hours per hourly run instead of 24 and results-without-a-hand reads 1 day per 6-hourly run instead of 7, each still covering every row more than once; the club_treasury legs fn_ca_treasury_positions aggregates are indexed (partial, built concurrently)
