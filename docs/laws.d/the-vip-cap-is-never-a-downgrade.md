# tests/the-vip-cap-is-never-a-downgrade.law.test.ts

`diamond_engine_daily_caps` has two columns and the earn ledger SUBSTITUTES the
VIP one, so for a VIP it is the entire limit. Raising the standard cap to 4,000
and leaving the VIP cap at 2,000 reached almost nobody: 849 horses are lifetime
VIPs, 801 of 857 VIP user-days were over 2,000 and none over 4,000, and
DR7:user_over_daily_cap would have refused 4,547 movements on 2026-09-14. Worse,
the headroom report built the same morning to prevent exactly this read only the
standard column and called it healthy while the flip forecast said 4,547. A CHECK
now forbids a VIP cap below the standard one, the report reads both and names the
binding one, and the claim loop silences the cap by its rule name rather than any
error containing the substring. The same migration settles 759 completed,
unclaimed, in-window horse rewards (54,230 diamonds, 114 hours from expiry) that
existed because a horse claims only on a new engine event while a human keeps a
claim button for seven days - a one-time settlement through the platform's own
path, with the engine-side root fix named as owed rather than scheduled.
