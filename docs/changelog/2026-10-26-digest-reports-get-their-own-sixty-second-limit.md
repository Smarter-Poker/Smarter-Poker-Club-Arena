# The daily digest's reports get their own 60-second limit

**2026-10-26.** Dan did not receive the Daily Operations Digest for Oct 25.

All three 7 AM Central tries were cancelled by the database's 8-second limit on
the service account: `fn_sp_daily_digest: canceling statement due to statement
timeout`. A cold first run of the digest measured 23 seconds; warm runs take
3-5 seconds. Since the Real Player Totals card (#2568) the digest and the totals
also load side by side, so the cold 7 AM run is slower than before.

Migration `20261026130853` gives `fn_sp_daily_digest` and
`fn_sp_digest_player_totals` their own `statement_timeout` of 60s. PostgREST
applies a function's own timeout to that one call, so the service account keeps
its 8-second limit for everything else.

Any later `CREATE OR REPLACE` of either function must keep
`SET statement_timeout TO '60s'`, or the setting is dropped.
