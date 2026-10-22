# Midway rake cap install waits long enough for a lock gap

Migration `20261021174448_midway_cash_rake_policy_two_point_five_bb.sql` (owner
rule: 2.5 BB maximum cash rake inside the Midway Union) is merged but not
installed. Live Midway cash hands were still raked up to 15 BB at 0.10 stakes.

#7628 replaced the single blocking lock with 200 ms tries that back off, which is
the right shape. The 01:05 UTC install on 2026-10-22 still refused after 100 tries
(37.6 s): scheduled readers hold AccessShare on `clubs` for up to four minutes and
one starts nearly every minute (`union-weekly-rakeback-close` every five minutes,
`rake-bbj-invariant-audit-hourly` at :38 for about 4.5 minutes, others hourly).

The same short tries now run against a 300 s deadline under a 360 s statement
budget, then the 60 s budget is restored. Exhausting the deadline raises and the
whole transaction rolls back. Live requests still wait at most 200 ms behind any
try. No pricing, BBJ, history, ACL or guard logic changes.

Local PostgreSQL 16 proof: against an 8 s reader the block waited about 7.6 s, then
held all three AccessExclusive locks with `lock_timeout` restored to 3 s; with a
2 s deadline it raised and earlier work in the transaction rolled back.
