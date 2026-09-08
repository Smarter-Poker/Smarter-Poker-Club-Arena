# The VIP cap, and 51,380 diamonds that were three hours from expiring

2026-09-08, later the same day. Migrations
`20260908144733_the_daily_limit_is_a_real_number.sql` and
`20260908144747_the_vip_cap_and_the_expiring_claims.sql`.

An adversarial review of the morning's diamond work returned seventeen findings.
Four were mine, and one of those had a clock on it. This records all four and
what was done.

## The one with a deadline: 759 rewards, 23 horses, 51,380 diamonds

`DR7` and the caps were the visible work. Underneath, 23 horses were holding
**759 completed, unclaimed, in-window daily-challenge rewards worth 51,380
diamonds**, the oldest completed on 2026-09-01 at 17:20:55 - so **114 of them
expired at 17:20 UTC that afternoon**, about three hours after the review
finished.

The cause is the one CLAUDE.md 10.5 keeps pointing at, arriving by a new route.
A horse claims when the engine reports a new challenge event for it. **A horse
that stops playing stops claiming.** A human who stops playing still has a claim
button, for the whole seven days. Same reward, same window, different outcome -
decided entirely by the fact that a horse has no browser. That is the "equal
outcome by a different mechanism" argument Dan rejected outright in August, in
its exact shape.

759 of 759 were settled, 0 failures, **54,230 diamonds** paid (more than the
51,380 estimate, because a claim can complete a meta-challenge that pays too).
Settled oldest-first, through `claim_daily_challenge_serialized_body` - the
platform's own idempotent path - inside one transaction, with the money identity
asserted after (CLAUDE.md 10.9, all five conditions met).

**The root fix is not in that migration and cannot be.** The engine has to claim
on its own cadence rather than only on an event, and that is HorseLogic, in
TypeScript, in the Club Arena server. The database half already exists: the claim
function accepts the engine naming a player. **This is owed work and it is
recorded here as owed** - not as finished, because a settlement that repairs
today and leaves the cause is exactly what 10.11 and 10.12 forbid. Nothing
scheduled was created; if this is ever needed a second time, the cause came back.

## The cap I raised was not the cap that applies

`diamond_engine_daily_caps` has two columns, and `fn_ca_diamond_earn_ledger`
does not blend them:

```sql
IF v_cap_vip IS NOT NULL THEN ... IF v_is_vip THEN v_cap := v_cap_vip; END IF;
```

For a VIP the VIP column is the **entire** limit. Earlier that day I raised
`daily_challenges.max_per_user_per_day` from 2,000 to 4,000 against a measured
design ceiling of 2,969 - and left `max_per_user_per_day_vip` at 2,000.

**849 horses are lifetime VIPs.** So the raise reached almost nobody. Of 857 VIP
user-days in fourteen days, **801 were over 2,000 and not one was over 4,000**.
`DR7:user_over_daily_cap` arms on 2026-09-14; on its first day it would have
refused 4,547 movements across 801 players, silently, on a limit the headroom
report was calling healthy.

A VIP cap below the standard cap is backwards on its face - it makes paying for
VIP a downgrade - and nothing prevented writing one. `ca_vip_cap_is_never_lower`
does now. The two columns were set **equal**, not VIP-higher: what a VIP should
additionally earn is what players are offered, and 10.9 reserves that to Dan.

## The instrument built that morning to prevent this was blind to it

`fn_ca_diamond_cap_headroom` read only `max_per_user_per_day` and reported

> HEALTHY. 880 user-days, highest 2492, cap 4000 - 1.61x headroom.

for a cap that would refuse 4,547 movements. The flip forecast, built the same
day and reading incidents rather than columns, said 4,547 the whole time. **The
two instruments disagreed by three orders of magnitude and neither said so.**

That is CLAUDE.md 10.86 exactly: a tool whose entire purpose is that nobody arms
a rule blind, itself blind, in the way it exists to prevent. It reads both
columns now, reports which one binds, and says "VIP CAP IS LOWER ... paying for
VIP is a downgrade" in words when they disagree. After the fix it reports 0
refusals across 880 user-days, and the forecast agrees.

## The claim loop silenced more than the cap

The horse claim swallowed any error matching `%daily_cap%` without filing an
incident. Staying silent on the cap is right - a thousand horses meet it daily
and filing that would rebuild an always-on alarm - but `%daily_cap%` is a
substring, so any other error carrying those characters was silenced too. It
matches `DR7:user_over_daily_cap` exactly now, in both copies of the loop.

## Verified live

```
owed_still            0      (was 759)
vip_lower             0      constraint ca_vip_cap_is_never_lower present
headroom reads VIP    true   0 refusals across 880 user-days
loose daily_cap match 0      precise match in both loop copies
identity_ok           true   players + float = register
```

Two other fixes from earlier the same day were confirmed holding by the same
pass: `DR7:ledger_write_failed` stopped at 12:31 (the budget-row serialisation),
and `DR7:engine_over_budget` stopped at 11:24 (ruling 21).
