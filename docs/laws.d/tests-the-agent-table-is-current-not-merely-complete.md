# tests/the-agent-table-is-current-not-merely-complete.law.test.ts

`fn_ca_rake_by_agent` reads `club_rake_rollup_complete` for which days are finished, `club_rake_daily_user` only for those, and `rake_records` split by `fn_rake_shares_for_record` for the live head, the live tail and any gap day - so the agent table is never silently 0.00 for today; the live window is clamped to now, and `ca_rake_snapshot` declares `breakdown_live` so a live table exceeding an hourly headline is not read as an error
